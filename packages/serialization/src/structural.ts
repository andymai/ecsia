// The structural delta stream: a byte-packed, op-enum-tagged record stream that
// carries structure WITH initial values on add (rejecting the bitECS value-less add) so a late
// joiner reconstructs full state from the stream alone. Records: [op][...]. On apply, EntityCreate
// spawns + records the producer→local handle in `remap`; ComponentAdd migrates + writes the carried
// values; PairAdd re-mints the receiver-local pair id. Both eids of a pair remap.
//
// The DeltaOp ordinals are the SHARED structural-op numbering: identical across the
// command-buffer Op, reactivity ShapeKind, and this DeltaOp — one apply-path numbering.

import type { ComponentId, EntityHandle, FieldDescriptor, RelationId } from '@ecsia/schema'
import { encodeEid, ShapeKind } from '@ecsia/core'
import type { SerializeStructuralRecord, World } from '@ecsia/core'
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

// --- encode: a FULL-STATE structural stream (baseline reconstruction) -------
// For every live entity: EntityCreate, then one ComponentAdd-with-values per column-bearing component,
// then PairAdd for every live pair. A receiver with NO prior state reconstructs the whole world.
//
// This is the FULL-state late-joiner baseline, NOT a windowed since-T stream — it intentionally
// takes no (sinceTick, targetTick]. The windowed since-T structural section of a delta is produced by
// writeDeltaStructuralSection below (driven by the structural journal's drainSince); this function
// is the from-nothing reconstruction source and emits every live entity unconditionally.
export function encodeStructuralOps(world: World): Uint8Array {
  if (world.phase !== 'serial') {
    throw new Error('encodeStructuralOps must run while the world is in its serial phase (outside scheduler.update / worker waves)')
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

// --- delta structural section: encode the since-T journal records into an OPEN cursor
// The interleaved structural section of a delta. The records come from the
// core structural journal (drainStructuralSince) — the persistent since-T source that survives the
// per-frame shape-log recycle (the journal is the structural twin of changeVersion). Each record
// is written with the component's CURRENT field words (values-on-add) so a stale receiver
// reconstructs the post-add state. PairAdd/PairRemove map the synthetic
// pair id back to the logical relationId; both eids stay full handles, remapped on apply.
export function writeDeltaStructuralSection(cur: WriteCursor, world: World, records: readonly SerializeStructuralRecord[]): void {
  const s = world.__serialize
  const rel = s.relations()
  for (const rec of records) {
    switch (rec.kind as number) {
      case ShapeKind.Create:
        cur.u8(DeltaOp.EntityCreate)
        cur.u32(rec.handle >>> 0)
        break
      case ShapeKind.Destroy:
        cur.u8(DeltaOp.EntityDestroy)
        cur.u32(rec.handle >>> 0)
        break
      case ShapeKind.Add: {
        const dst = s.columnsOf(rec.handle as EntityHandle, rec.componentId as ComponentId)
        cur.u8(DeltaOp.ComponentAdd)
        cur.u32(rec.handle >>> 0)
        cur.u32(rec.componentId >>> 0)
        if (dst === null) {
          cur.u16(0) // entity no longer holds it (removed again after this Add since T) — no values
        } else {
          writeComponentFieldValues(cur, dst.columns as readonly { view: { [i: number]: number }; layout: { stride: number } }[], dst.fields, dst.row)
        }
        break
      }
      case ShapeKind.Remove:
        cur.u8(DeltaOp.ComponentRemove)
        cur.u32(rec.handle >>> 0)
        cur.u32(rec.componentId >>> 0)
        break
      case ShapeKind.AddPair:
      case ShapeKind.SetPayload: {
        const relationId = rel?.relationIdOfPair(rec.componentId as ComponentId)
        if (relationId === undefined) break // relation-free world or unmapped pair id — skip
        cur.u8(rec.kind === ShapeKind.AddPair ? DeltaOp.PairAdd : DeltaOp.PairPayload)
        cur.u32(rec.handle >>> 0)
        cur.u16(relationId as number)
        cur.u32(rec.target >>> 0)
        // Values-on-add: read the pair's CURRENT payload at emit time so a stale receiver
        // reconstructs the post-add (or post-set) state. undefined for a tag relation.
        const payload = rel?.pairPayloadOf(rec.handle as EntityHandle, relationId, rec.target as EntityHandle)
        writePairPayload(cur, payload)
        break
      }
      case ShapeKind.RemovePair: {
        const relationId = rel?.relationIdOfPair(rec.componentId as ComponentId)
        if (relationId === undefined) break // relation-free world or unmapped pair id — skip
        cur.u8(DeltaOp.PairRemove)
        cur.u32(rec.handle >>> 0)
        cur.u16(relationId as number)
        cur.u32(rec.target >>> 0)
        break
      }
      default:
        break
    }
  }
}

function writeComponentFieldValues(
  cur: WriteCursor,
  columns: readonly { view: { [i: number]: number }; layout: { stride: number } }[],
  fields: readonly FieldDescriptor[],
  row: number,
): void {
  // Emit: u16 fieldWordCount, then per word: name + lane + f64 value. The wire is name-keyed
  // (self-describing), so non-persisted fields are simply omitted and re-default on apply.
  const words: { name: string; lane: number; value: number }[] = []
  let colIndex = 0
  for (const f of fields) {
    if (f.ctor === null) continue
    const col = columns[colIndex]
    if (col !== undefined && f.persist) {
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
    SCRATCH_F64[0] = w.value
    cur.copyBytes(SCRATCH_F64)
  }
}

const SCRATCH_F64 = new Float64Array(1)

// --- apply: replay records into the receiver world through validate-then-apply --------------
export function applyStructuralOps(world: World, bytes: Uint8Array, remap: Map<EntityHandle, EntityHandle>): void {
  if (world.phase !== 'serial') {
    throw new Error('applyStructuralOps must run while the world is in its serial phase (outside scheduler.update / worker waves)')
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
        const old = cur.u32()
        // Apply the destroy on the receiver via the remap (the producer handle → local handle).
        const local = remap.get(old as EntityHandle)
        if (local !== undefined) s.despawn(local)
        // Prune the entry: a stream-lifetime remap that never forgets destroyed entities grows
        // without bound under entity churn. A reused producer u32 handle is re-`set` on its
        // EntityCreate, so dropping the dead pair is safe.
        remap.delete(old as EntityHandle)
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
        const old = cur.u32()
        const producerCid = cur.u32()
        const local = remap.get(old as EntityHandle)
        if (local !== undefined) s.removeComponents(local, [producerCid as ComponentId])
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
        const subjectOld = cur.u32()
        const relationId = cur.u16()
        const targetOld = cur.u32()
        const subject = remap.get(subjectOld as EntityHandle)
        const target = targetOld === NO_ENTITY_U32 ? null : remap.get(targetOld as EntityHandle) ?? null
        if (subject !== undefined && target !== null && relProvider !== undefined) {
          relProvider.removePair(subject, relationId as RelationId, target)
        }
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
  // Map field name → (column index, descriptor). RECEIVER-side persist enforcement: a field the
  // receiver declares transient is excluded even when the producer (whose descriptor lacks the flag)
  // carried a value for it — the receiver's declaration is honored unilaterally, so the spawnInto
  // default above stands.
  let colIndex = 0
  const colByName = new Map<string, { col: { view: { [i: number]: number }; layout: { stride: number } }; field: FieldDescriptor }>()
  for (const f of dst.fields) {
    if (f.ctor === null) continue
    const col = dst.columns[colIndex]
    if (col !== undefined && f.persist) colByName.set(f.name, { col, field: f })
    colIndex += 1
  }
  for (const w of values) {
    const entry = colByName.get(w.name)
    if (entry === undefined) continue
    const { col, field } = entry
    // Untrusted-input guard: lane comes off the wire. For a schema-matched honest peer it's always
    // 0..stride-1; a malformed/corrupt stream could otherwise write into an adjacent row.
    if (w.lane < 0 || w.lane >= col.layout.stride)
      throw new Error(
        `serialization: corrupt structural stream — field '${w.name}' lane ${w.lane} is out of range for stride ${col.layout.stride}`,
      )
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

// --- createObserverLog: a decoder cursor over a byte stream (the SAB-ring view) --------------
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
