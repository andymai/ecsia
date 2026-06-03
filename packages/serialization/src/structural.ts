// The structural delta stream (serialization.md §7): a byte-packed, op-enum-tagged record stream that
// carries structure WITH initial values on add (rejecting the bitECS value-less add, §7.2) so a late
// joiner reconstructs full state from the stream alone. Records: [op][...]. On apply, EntityCreate
// spawns + records the producer→local handle in `remap`; ComponentAdd migrates + writes the carried
// values; PairAdd re-mints the receiver-local pair id. Both eids of a pair remap (§8.3).
//
// The DeltaOp ordinals are the SHARED structural-op numbering (world.md §9.4): identical across the
// command-buffer Op, reactivity ShapeKind, and this DeltaOp — one apply-path numbering.

import type { ComponentId, EntityHandle, FieldDescriptor, RelationId } from '@ecsia/schema'
import { encodeEid } from '@ecsia/core'
import type { World } from '@ecsia/core'
import { WriteCursor, ReadCursor } from './cursor.js'
import { DeltaOp, NO_ENTITY_U32, readString, writeString } from './format.js'
import { readPairPayload, writePairPayload } from './payload.js'

export interface DeltaRecord {
  readonly op: DeltaOp
  readonly handle: number
  readonly componentId?: number
  readonly relationId?: number
  readonly target?: number
  readonly fields?: Record<string, number>
  readonly payload?: Record<string, unknown> | undefined
}

// --- encode: a FULL-STATE structural stream (baseline reconstruction, §7 late-joiner source) -------
// For every live entity: EntityCreate, then one ComponentAdd-with-values per column-bearing component,
// then PairAdd for every live pair. A receiver with NO prior state reconstructs the whole world.
export function encodeStructuralOps(world: World, _sinceTick = 0, _targetTick = 0): Uint8Array {
  if (world.phase !== 'serial') {
    throw new Error('encodeStructuralOps must run at a serial flush point (§7.3)')
  }
  const s = world.__serialize
  const cur = new WriteCursor(16 * 1024)
  const archs = s.archetypes()

  // CREATE every entity first (so a forward eid reference in a value resolves on the receiver).
  for (const a of archs) {
    for (let r = 0; r < a.count; r++) {
      cur.u8(DeltaOp.EntityCreate)
      cur.u32(a.rows[r] as number)
    }
  }
  // ComponentAdd with values per column-bearing component.
  for (const a of archs) {
    for (const comp of a.components) {
      const fieldDescs = comp.fields
      for (let r = 0; r < a.count; r++) {
        const handle = a.rows[r] as number
        cur.u8(DeltaOp.ComponentAdd)
        cur.u32(handle)
        cur.u32(comp.componentId as number)
        // Field words: one f64 numeric per column-field slot (lossless across i32/f32/eid/u8). For a
        // vecN field with stride>1 we emit each lane; the receiver writes by field name+lane index.
        writeComponentFieldValues(cur, comp.columns, fieldDescs, r)
      }
    }
  }
  // PairAdd for every live pair.
  const relProvider = s.relations()
  if (relProvider !== undefined) {
    for (const p of relProvider.livePairs()) {
      cur.u8(DeltaOp.PairAdd)
      cur.u32((p.subject as number) >>> 0)
      cur.u16(p.relationId as number)
      cur.u32(p.target === null ? NO_ENTITY_U32 : (p.target as number) >>> 0)
      writePairPayload(cur, p.payload)
    }
  }
  return cur.bytesCopy()
}

function writeComponentFieldValues(
  cur: WriteCursor,
  columns: readonly { view: { [i: number]: number }; layout: { stride: number } }[],
  fields: readonly FieldDescriptor[],
  row: number,
): void {
  // Emit: u16 fieldWordCount, then per word: name + lane + f64 value.
  const words: { name: string; lane: number; value: number }[] = []
  let colIndex = 0
  for (const f of fields) {
    if (f.ctor === null) continue
    const col = columns[colIndex]
    if (col !== undefined) {
      const stride = col.layout.stride
      for (let lane = 0; lane < stride; lane++) {
        words.push({ name: f.name, lane, value: (col.view[row * stride + lane] as number) })
      }
    }
    colIndex += 1
  }
  cur.u16(words.length)
  for (const w of words) {
    writeString(cur, w.name)
    cur.u16(w.lane)
    const tmp = new Float64Array(1)
    tmp[0] = w.value
    cur.copyBytes(tmp)
  }
}

// --- apply: replay records into the receiver world through validate-then-apply (§7.3) --------------
export function applyStructuralOps(world: World, bytes: Uint8Array, remap: Map<EntityHandle, EntityHandle>): void {
  if (world.phase !== 'serial') {
    throw new Error('applyStructuralOps must run at a serial flush point (§7.3)')
  }
  const s = world.__serialize
  const relProvider = s.relations()
  const cur = new ReadCursor(bytes)
  while (!cur.atEnd) {
    const op = cur.u8() as DeltaOp
    switch (op) {
      case DeltaOp.EntityCreate: {
        const old = cur.u32()
        const nh = s.spawn()
        remap.set(old as EntityHandle, nh)
        break
      }
      case DeltaOp.EntityDestroy: {
        cur.u32() // handle — destroy is applied by the caller's world surface if needed; dropped here.
        break
      }
      case DeltaOp.ComponentAdd: {
        const old = cur.u32()
        const producerCid = cur.u32()
        const values = readComponentFieldValues(cur)
        const handle = remap.get(old as EntityHandle)
        // Producer ids are remapped by registry name through componentsById built from the snapshot
        // registry — but a pure structural stream carries no registry, so the producer id IS the local
        // id when sender and receiver share defineComponent order (the documented late-joiner case).
        if (handle === undefined) break
        applyComponentAdd(world, handle, producerCid as ComponentId, values, remap)
        break
      }
      case DeltaOp.ComponentRemove: {
        cur.u32()
        cur.u32()
        break
      }
      case DeltaOp.PairAdd:
      case DeltaOp.PairPayload: {
        const subjectOld = cur.u32()
        const relationId = cur.u16()
        const targetOld = cur.u32()
        const payload = readPairPayload(cur)
        const subject = remap.get(subjectOld as EntityHandle)
        if (subject === undefined || relProvider === undefined) break
        const target = targetOld === NO_ENTITY_U32 ? null : remap.get(targetOld as EntityHandle) ?? null
        if (targetOld !== NO_ENTITY_U32 && target === null) break
        relProvider.addPair(subject, relationId as RelationId, target, payload)
        break
      }
      case DeltaOp.PairRemove: {
        cur.u32()
        cur.u16()
        cur.u32()
        break
      }
    }
  }
}

function readComponentFieldValues(cur: ReadCursor): { name: string; lane: number; value: number }[] {
  const count = cur.u16()
  const out: { name: string; lane: number; value: number }[] = []
  for (let i = 0; i < count; i++) {
    const name = readString(cur)
    const lane = cur.u16()
    const bytes = cur.takeBytes(8)
    const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
    out.push({ name, lane, value })
  }
  return out
}

function applyComponentAdd(
  world: World,
  handle: EntityHandle,
  componentId: ComponentId,
  values: { name: string; lane: number; value: number }[],
  remap: Map<EntityHandle, EntityHandle>,
): void {
  const s = world.__serialize
  s.spawnInto(handle, [componentId])
  const dst = s.columnsOf(handle, componentId)
  if (dst === null) return
  // Map field name → (column index, descriptor).
  let colIndex = 0
  const colByName = new Map<string, { col: { view: { [i: number]: number }; layout: { stride: number } }; field: FieldDescriptor }>()
  for (const f of dst.fields) {
    if (f.ctor === null) continue
    const col = dst.columns[colIndex]
    if (col !== undefined) colByName.set(f.name, { col, field: f })
    colIndex += 1
  }
  for (const w of values) {
    const entry = colByName.get(w.name)
    if (entry === undefined) continue
    const { col, field } = entry
    const slot = dst.row * col.layout.stride + w.lane
    if (field.token === 'eid') {
      const stored = w.value | 0
      if (stored === -1) {
        col.view[slot] = -1
      } else {
        const nh = remap.get((stored >>> 0) as EntityHandle)
        col.view[slot] = nh === undefined ? -1 : encodeEid(nh)
      }
    } else {
      col.view[slot] = w.value
    }
  }
}

// --- createObserverLog: a decoder cursor over a byte stream (the SAB-ring view, §7.4) --------------
export interface ObserverLog {
  drain(bytes: Uint8Array): Iterable<DeltaRecord>
}

export function createObserverLog(_world: World): ObserverLog {
  return {
    *drain(bytes: Uint8Array): Iterable<DeltaRecord> {
      const cur = new ReadCursor(bytes)
      while (!cur.atEnd) {
        const op = cur.u8() as DeltaOp
        if (op === DeltaOp.EntityCreate || op === DeltaOp.EntityDestroy) {
          yield { op, handle: cur.u32() }
        } else if (op === DeltaOp.ComponentAdd) {
          const handle = cur.u32()
          const componentId = cur.u32()
          const fields: Record<string, number> = {}
          const count = cur.u16()
          for (let i = 0; i < count; i++) {
            const name = readString(cur)
            const lane = cur.u16()
            const bytes2 = cur.takeBytes(8)
            fields[`${name}.${lane}`] = new DataView(bytes2.buffer, bytes2.byteOffset, 8).getFloat64(0, true)
          }
          yield { op, handle, componentId, fields }
        } else if (op === DeltaOp.ComponentRemove) {
          yield { op, handle: cur.u32(), componentId: cur.u32() }
        } else if (op === DeltaOp.PairAdd || op === DeltaOp.PairPayload) {
          const handle = cur.u32()
          const relationId = cur.u16()
          const target = cur.u32()
          const payload = readPairPayload(cur)
          yield { op, handle, relationId, target, payload }
        } else {
          yield { op, handle: cur.u32(), relationId: cur.u16(), target: cur.u32() }
        }
      }
    },
  }
}
