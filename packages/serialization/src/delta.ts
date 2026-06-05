// The version-stamp-driven delta serializer (serialization.md §6). Carries an INTERLEAVED structural
// section (§6.2 SECTION S) followed by the changed-value section (SECTION V). VALUE changes are driven
// PURELY by the per-row changeVersion (reactivity.md §6.3) — NO shadow map. STRUCTURAL changes
// (Create/Destroy/ComponentAdd/ComponentRemove/AddPair/RemovePair) since T come from the persistent
// structural journal (the since-T structural source, §6.4) — NOT from the per-frame shape-log ring,
// which is recycled (reactivity.md §3.7/§13.3). Constructing the serializer registers BOTH stamping
// consumers: changeVersion (for values) and the structural journal (for structure).
//
// Row identity across the boundary (§6.4): the receiver does NOT trust producer row indices. Each
// changed row carries its entity HANDLE; the receiver resolves the local entity via the remap table
// (the bootstrap snapshot's PASS 1 + the structural section this delta applies first), then writes the
// values into that entity's columns. applyDelta therefore applies the structural ops AND the values, so
// a delta since T applied to a stale copy reconstructs the live world INCLUDING shape changes.

import type { ComponentId, EntityHandle, FieldDescriptor } from '@ecsia/schema'
import { encodeEid, elementBytes } from '@ecsia/core'
import type { ElementKind, World } from '@ecsia/core'
import { WriteCursor, ReadCursor } from './cursor.js'
import {
  FLAG_IS_DELTA,
  FLAG_HAS_STRUCTURAL,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
  elementOrdinal,
  ordinalToElement,
} from './format.js'
import { applyStructuralOps, writeDeltaStructuralSection } from './structural.js'

export interface DeltaOptions {
  readonly initialOutputBytes?: number
  /** Interleave the since-T STRUCTURAL section before the value section (default TRUE, §6.2 / §6.4). */
  readonly includeStructural?: boolean
}

export interface DeltaSerializer {
  /** Emit a delta covering (sinceTick, currentTick]; advances the internal baseline. */
  delta(): Uint8Array
  deltaCopy(): Uint8Array
  readonly sinceTick: number
}

// §6.2 header: MAGIC u32, VERSION u16, ENDIAN u8, flags u8, baselineTick u32, targetTick u32,
// structuralSectionOffset u32, valueSectionOffset u32.
const DELTA_HEADER_BYTES = 24

export function createDeltaSerializer(world: World, sinceTick: number, opts: DeltaOptions = {}): DeltaSerializer {
  assertPlatformLittleEndian()
  const includeStructural = opts.includeStructural ?? true
  const s = world.__serialize
  // Constructing a delta serializer registers the changeVersion stamping consumer (reactivity.md §6.1):
  // touching changedSince once turns on stamping so subsequent writes stamp the per-row version.
  world.changedSince(0 as EntityHandle, 0)
  // …and (when carrying structure) the persistent structural journal — the since-T STRUCTURAL source
  // that survives the per-frame shape-log recycle (§6.4). Both are the delta's two stamping seams.
  if (includeStructural) s.enableStructuralJournal()
  const cur = new WriteCursor(opts.initialOutputBytes ?? 16 * 1024)
  let baseline = sinceTick

  function write(): void {
    if (world.phase !== 'serial') {
      throw new Error('delta() must run while the world is in its serial phase (outside scheduler.update / worker waves)')
    }
    const target = world.currentTick()
    cur.reset()

    // --- HEADER (24 bytes; section offsets back-patched) ---
    cur.u32(SNAPSHOT_MAGIC)
    cur.u16(SERIALIZATION_FORMAT_VERSION)
    cur.u8(1) // ENDIAN
    const flagsAt = cur.pos
    cur.u8(FLAG_IS_DELTA)
    cur.u32(baseline) // baselineTick
    cur.u32(target) // targetTick
    const structOffAt = cur.pos
    cur.u32(0) // structuralSectionOffset (back-patched)
    const valueOffAt = cur.pos
    cur.u32(0) // valueSectionOffset (back-patched)

    // --- SECTION S: STRUCTURAL OPS since baseline (§6.2 / §6.4) ---
    let flags = FLAG_IS_DELTA
    if (includeStructural) {
      cur.patchU32(structOffAt, cur.pos)
      const drained = s.drainStructuralSince(baseline)
      // A gap means `baseline` predates the bounded journal's live window: the structural section cannot
      // be reconstructed precisely. The delta still emits values; the receiver must resync from a fresh
      // snapshot (the no-partial-apply delta-gap rule, §6.4). We flag it via an empty structural section.
      if (!drained.gap && drained.records.length > 0) {
        writeDeltaStructuralSection(cur, world, drained.records)
        flags |= FLAG_HAS_STRUCTURAL
      }
    }

    // --- SECTION V: CHANGED VALUES, version-stamp driven (§6.3) ---
    cur.patchU32(valueOffAt, cur.pos)
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
          // §6.2 wire: u8 element ordinal + u8 stride, then per CHANGED row the stride elements at the
          // column's NATIVE element width (a raw byte copy — no f64 widening, no per-row allocation).
          cur.u8(elementOrdinal(col.layout.element))
          cur.u8(stride)
          const view = col.view as unknown as { subarray(s: number, e: number): ArrayBufferView }
          for (const r of rows) cur.copyBytes(view.subarray(r * stride, (r + 1) * stride))
        }
      }
    }
    cur.patchU32(archCountAt, changedArchetypeCount)
    cur.patchU32(flagsAt, flags)
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

// --- apply: structural ops first, then the changed values, all resolved via the remap table ---------
// `remap` is the producer→receiver entity table from the bootstrap snapshot. A delta whose structural
// section CREATES entities since T must extend the table so the value section (and subsequent deltas)
// resolve those new entities — so we work on a MUTABLE copy and copy newly-minted handles BACK into the
// caller's table when it is mutable (the snapshot result exposes a ReadonlyMap; a caller that wants the
// new handles passes a real Map). §6.4.
export function applyDelta(world: World, bytes: Uint8Array, remap: ReadonlyMap<EntityHandle, EntityHandle>): number {
  if (world.phase !== 'serial') {
    throw new Error('applyDelta must run while the world is in its serial phase (outside scheduler.update / worker waves)')
  }
  const s = world.__serialize
  const work = new Map(remap)
  const cur = new ReadCursor(bytes)
  const magic = cur.u32()
  if (magic !== SNAPSHOT_MAGIC) throw new Error('serialization: bad magic (not an ecsia delta)')
  cur.u16() // version
  cur.u8() // endian
  const flags = cur.u8()
  if ((flags & FLAG_IS_DELTA) === 0) throw new Error('serialization: not a delta image')
  cur.u32() // baselineTick
  const targetTick = cur.u32()
  const structOff = cur.u32()
  const valueOff = cur.u32()

  // --- SECTION S: apply structural ops FIRST (creates/destroys/adds/removes), so the value section's
  //     handles resolve to live receiver entities (§6.4 ordering). ---
  if ((flags & FLAG_HAS_STRUCTURAL) !== 0 && structOff < valueOff) {
    applyStructuralOps(world, bytes.subarray(structOff, valueOff), work)
  }
  // Propagate newly-created handles back to a mutable caller table (no-op for a ReadonlyMap caller).
  if (work.size !== remap.size) {
    const mutable = remap as Map<EntityHandle, EntityHandle>
    if (typeof mutable.set === 'function') for (const [k, v] of work) if (!remap.has(k)) mutable.set(k, v)
  }

  // --- SECTION V: write the changed values into the receiver entities resolved via the remap. ---
  cur.seek(valueOff)
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
        const element = ordinalToElement(cur.u8())
        const stride = cur.u8()
        const widthBytes = elementBytes(element) * stride
        for (let r = 0; r < rowCount; r++) {
          const raw = cur.takeBytes(widthBytes)
          const local = work.get(handles[r] as number as EntityHandle)
          if (local === undefined) continue
          writeRowField(s, local, producerCid as ComponentId, fi, element, stride, raw, work)
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
  element: ElementKind,
  stride: number,
  raw: Uint8Array,
  remap: Map<EntityHandle, EntityHandle>,
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
  // Reinterpret the raw native-width bytes as the column's typed array (copied to a zero-offset buffer
  // so the typed-array view is validly aligned regardless of the source subarray's byteOffset).
  const copy = raw.slice()
  const values = reinterpret(element, copy.buffer, copy.byteOffset, stride)
  const base = dst.row * stride
  for (let lane = 0; lane < stride; lane++) {
    const value = values[lane] as number
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

function reinterpret(element: ElementKind, buffer: ArrayBufferLike, off: number, elems: number): ArrayLike<number> {
  switch (element) {
    case 'u8':
      return new Uint8Array(buffer, off, elems)
    case 'u8c':
      return new Uint8ClampedArray(buffer, off, elems)
    case 'i8':
      return new Int8Array(buffer, off, elems)
    case 'u16':
      return new Uint16Array(buffer, off, elems)
    case 'i16':
      return new Int16Array(buffer, off, elems)
    case 'u32':
      return new Uint32Array(buffer, off, elems)
    case 'i32':
      return new Int32Array(buffer, off, elems)
    case 'f32':
      return new Float32Array(buffer, off, elems)
    case 'f64':
      return new Float64Array(buffer, off, elems)
    default:
      throw new Error(`serialization: unknown element '${element as string}'`)
  }
}

// Re-export the spec-named header byte width so downstream tooling can size buffers.
export { DELTA_HEADER_BYTES }
