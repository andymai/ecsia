// The version-stamp-driven delta serializer (serialization.md §6). Carries ONLY rows whose
// changeVersion > sinceTick (reactivity.md §6.3) — NO shadow map, NO per-field shadow copy. The
// "what changed" question is answered purely by the per-row stamp; the serializer keeps no copy of
// prior values (rejecting the bitECS shadow-map diff). Constructing the serializer registers a
// changeVersion stamping consumer (world.changedSince enables it).
//
// Row identity across the boundary (§6.4): the receiver does NOT trust producer row indices. Each
// changed row carries its entity HANDLE; the receiver resolves the local entity via the remap table
// (built by the bootstrap snapshot's PASS 1) and writes the values into that entity's columns.

import type { ComponentId, EntityHandle, FieldDescriptor } from '@ecsia/schema'
import { encodeEid } from '@ecsia/core'
import type { World } from '@ecsia/core'
import { WriteCursor, ReadCursor } from './cursor.js'
import {
  FLAG_IS_DELTA,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
} from './format.js'

export interface DeltaOptions {
  readonly initialOutputBytes?: number
}

export interface DeltaSerializer {
  /** Emit a delta covering (sinceTick, currentTick]; advances the internal baseline. */
  delta(): Uint8Array
  deltaCopy(): Uint8Array
  readonly sinceTick: number
}

const DELTA_HEADER_BYTES = 16

export function createDeltaSerializer(world: World, sinceTick: number, opts: DeltaOptions = {}): DeltaSerializer {
  assertPlatformLittleEndian()
  // Constructing a delta serializer registers a changeVersion stamping consumer (reactivity.md §6.1):
  // touching changedSince once turns on stamping so subsequent writes stamp the per-row version.
  world.changedSince(0 as EntityHandle, 0)
  const cur = new WriteCursor(opts.initialOutputBytes ?? 16 * 1024)
  let baseline = sinceTick

  function write(): void {
    if (world.phase !== 'serial') {
      throw new Error('delta() must run at a serial flush point (§6.3 / §11 S-11)')
    }
    const s = world.__serialize
    const target = world.currentTick()
    cur.reset()

    // --- HEADER (16 bytes) ---
    cur.u32(SNAPSHOT_MAGIC)
    cur.u16(SERIALIZATION_FORMAT_VERSION)
    cur.u8(1) // ENDIAN
    cur.u8(FLAG_IS_DELTA)
    cur.u32(baseline) // baselineTick
    // targetTick lives in the next u32; written after the value section (it is `target`).
    cur.u32(target)

    // --- VALUE SECTION: per archetype, changed rows only (§6.3) ---
    const archs = s.archetypes()
    const archCountAt = cur.pos
    cur.u32(0) // changedArchetypeCount (back-patched)
    let changedArchetypeCount = 0
    for (const a of archs) {
      const rows: number[] = [...world.changedRows(a.id, baseline)]
      if (rows.length === 0) continue
      changedArchetypeCount += 1
      cur.u32(a.id)
      cur.u32(rows.length)
      // Per changed row: the FULL entity handle (the boundary-stable row identity, §6.4).
      for (const r of rows) cur.u32(a.rows[r] as number)
      cur.u16(a.components.length)
      for (const comp of a.components) {
        cur.u32(comp.componentId as number)
        cur.u16(comp.columns.length)
        for (let ci = 0; ci < comp.columns.length; ci++) {
          const col = comp.columns[ci]
          if (col === undefined) continue
          const stride = col.layout.stride
          // GATHER only the changed rows for this field (§6.2 component-granularity emits all fields).
          cur.u8(stride)
          for (const r of rows) {
            const tmp = new Float64Array(stride)
            for (let lane = 0; lane < stride; lane++) tmp[lane] = col.view[r * stride + lane] as number
            cur.copyBytes(tmp)
          }
        }
      }
    }
    cur.patchU32(archCountAt, changedArchetypeCount)
    baseline = target
  }

  return {
    delta(): Uint8Array {
      write()
      return cur.bytesView()
    },
    deltaCopy(): Uint8Array {
      write()
      return cur.bytesCopy()
    },
    get sinceTick(): number {
      return baseline
    },
  }
}

// --- apply: write the changed values into the receiver entities resolved via the remap table -------
export function applyDelta(world: World, bytes: Uint8Array, remap: ReadonlyMap<EntityHandle, EntityHandle>): number {
  if (world.phase !== 'serial') {
    throw new Error('applyDelta must run at a serial flush point (§6.4 / §11 S-11)')
  }
  const s = world.__serialize
  const cur = new ReadCursor(bytes)
  const magic = cur.u32()
  if (magic !== SNAPSHOT_MAGIC) throw new Error('serialization: bad magic (not an ecsia delta)')
  cur.u16() // version
  cur.u8() // endian
  const flags = cur.u8()
  if ((flags & FLAG_IS_DELTA) === 0) throw new Error('serialization: not a delta image')
  cur.u32() // baselineTick
  const targetTick = cur.u32()

  const changedArchetypeCount = cur.u32()
  for (let ai = 0; ai < changedArchetypeCount; ai++) {
    cur.u32() // producer archetype id (ignored — rows carry handles)
    const rowCount = cur.u32()
    const handles = new Uint32Array(rowCount)
    for (let r = 0; r < rowCount; r++) handles[r] = cur.u32()
    const componentCount = cur.u16()
    for (let ci = 0; ci < componentCount; ci++) {
      const producerCid = cur.u32()
      const fieldCount = cur.u16()
      for (let fi = 0; fi < fieldCount; fi++) {
        const stride = cur.u8()
        for (let r = 0; r < rowCount; r++) {
          const bytes8 = cur.takeBytes(8 * stride)
          const dv = new DataView(bytes8.buffer, bytes8.byteOffset, 8 * stride)
          const producerHandle = handles[r] as number
          const local = remap.get(producerHandle as EntityHandle)
          if (local === undefined) continue
          writeRowField(s, local, producerCid as ComponentId, fi, stride, dv, remap)
        }
      }
    }
  }
  return targetTick
}

function writeRowField(
  s: World['__serialize'],
  handle: EntityHandle,
  componentId: ComponentId,
  fieldColIndex: number,
  stride: number,
  dv: DataView,
  remap: ReadonlyMap<EntityHandle, EntityHandle>,
): void {
  const dst = s.columnsOf(handle, componentId)
  if (dst === null) return
  const col = dst.columns[fieldColIndex]
  if (col === undefined) return
  const view = col.view as unknown as { [i: number]: number }
  // Find the descriptor parallel to this column index to detect eid fields.
  let colIndex = 0
  let descriptor: FieldDescriptor | undefined
  for (const f of dst.fields) {
    if (f.ctor === null) continue
    if (colIndex === fieldColIndex) {
      descriptor = f
      break
    }
    colIndex += 1
  }
  const base = dst.row * stride
  for (let lane = 0; lane < stride; lane++) {
    const value = dv.getFloat64(lane * 8, true)
    if (descriptor?.token === 'eid') {
      const stored = value | 0
      if (stored === -1) view[base + lane] = -1
      else {
        const nh = remap.get((stored >>> 0) as EntityHandle)
        view[base + lane] = nh === undefined ? -1 : encodeEid(nh)
      }
    } else {
      view[base + lane] = value
    }
  }
}

// Re-export the spec-named header byte width so downstream tooling can size buffers.
export { DELTA_HEADER_BYTES }
