// The version-stamp-driven delta serializer. Carries an INTERLEAVED structural
// section followed by the changed-value section (SECTION V). VALUE changes are driven
// PURELY by the per-row changeVersion — NO shadow map. STRUCTURAL changes
// (Create/Destroy/ComponentAdd/ComponentRemove/AddPair/RemovePair) since T come from the persistent
// structural journal (the since-T structural source) — NOT from the per-frame shape-log ring,
// which is recycled. Constructing the serializer registers BOTH stamping
// consumers: changeVersion (for values) and the structural journal (for structure).
//
// Row identity across the boundary: the receiver does NOT trust producer row indices. Each
// changed row carries its entity HANDLE; the receiver resolves the local entity via the remap table
// (the bootstrap snapshot's PASS 1 + the structural section this delta applies first), then writes the
// values into that entity's columns. applyDelta therefore applies the structural ops AND the values, so
// a delta since T applied to a stale copy reconstructs the live world INCLUDING shape changes.

import type { ComponentId, EntityHandle, FieldDescriptor } from '@ecsia/schema'
import { encodeEid, elementBytes } from '@ecsia/core'
import type { ElementKind, SerializeArchetype, World } from '@ecsia/core'
import { WriteCursor, ReadCursor } from './cursor.js'
import {
  DELTA_MIN_SUPPORTED_VERSION,
  FLAG_IS_DELTA,
  FLAG_HAS_RICH,
  FLAG_HAS_STRUCTURAL,
  RICH_ROW_KEEP,
  RICH_ROW_RESET,
  RICH_ROW_VALUE,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
  createPersistedColumnsCache,
  elementOrdinal,
  ordinalToElement,
  readJsonBytes,
  writeJsonBytes,
} from './format.js'
import type { PersistedComponentColumns } from './format.js'
import { applyStructuralOps, writeDeltaStructuralSection } from './structural.js'
import { compressImage, decompressImage, type Compressor, type DecompressOptions } from './compression.js'
import { encodeRichValue, richKindOrdinal, type OnUnserializable } from './rich.js'

export interface DeltaOptions {
  readonly initialOutputBytes?: number
  /** Interleave the since-T STRUCTURAL section before the value section (default TRUE). */
  readonly includeStructural?: boolean
  /** Policy for a rich value JSON cannot encode. Default: SKIP + dev-warn. */
  readonly onUnserializable?: OnUnserializable
  /**
   * Opt-in numeric epsilon tolerance. When set, the serializer allocates ITS OWN
   * shadow of the numeric columns it serializes (core stays shadow-free — RF-SHADOW-FREE); a changed ROW
   * whose every changed NUMERIC field is within `epsilon` of the shadow is DROPPED from SECTION V. The
   * shadow updates to the emitted values on each emit. Rich fields (SECTION R) and structural ops are NOT
   * epsilon-filtered. Default undefined (no shadow, core-pure row selection unchanged).
   *
   * MEMORY COST (honest): the shadow is a Float64Array of Σ (rows × numericColumnElements) over the
   * archetypes this serializer touches — it DOUBLES (in f64 width) their numeric SoA footprint, owned by
   * this serializer instance for its lifetime. Opt-in precisely because the cost is real.
   */
  readonly epsilon?: number
  /**
   * Opt-in compression applied at the `deltaCopy()` boundary only (never `delta()`, which returns a
   * reused-buffer view). Undefined ⇒ raw bytes, byte-identical to before. {@link applyDelta}
   * auto-detects and decompresses; bundled compressors need no receiver config.
   */
  readonly compressor?: Compressor
}

/**
 * A reusable since-T delta serializer (v4 wire). Changed rich fields ride SECTION R, selected by the SAME
 * whole-entity changeVersion stamp as the numeric value section — including a row
 * changed ONLY in a rich field. `epsilon` (opt-in) drops sub-tolerance NUMERIC rows; rich values are
 * never epsilon-filtered.
 *
 * LIMITATION — RF-NOREMAP: an `EntityHandle` stored INSIDE an `object<T>` rich
 * field is NOT remapped on apply (it is opaque JSON). Use an `eid` column or a stable application id for
 * a reference that must survive the wire. See {@link applyDelta}.
 */
export interface DeltaSerializer {
  /** Emit a delta covering (sinceTick, currentTick]; advances the internal baseline. */
  delta(): Uint8Array
  deltaCopy(): Uint8Array
  readonly sinceTick: number
  /**
   * Snap the epsilon shadow to the CURRENT column values (no-op when `epsilon` is unset). The
   * shadow normally holds last-EMITTED values, so a receiver rebased onto an exact full snapshot
   * would otherwise be epsilon-compared against stale emissions — letting it drift up to
   * 2·epsilon before a held-back row re-crosses tolerance. Call at the same serial flush a
   * rebasing snapshot is taken.
   */
  refreshEpsilonShadow(): void
}

// MAGIC u32, VERSION u16, ENDIAN u8, flags u8, schemaHash u32 (v3), baselineTick u32,
// targetTick u32, structuralSectionOffset u32, valueSectionOffset u32, richSectionOffset u32 (v2).
const DELTA_HEADER_BYTES = 32

export function createDeltaSerializer(world: World, sinceTick: number, opts: DeltaOptions = {}): DeltaSerializer {
  assertPlatformLittleEndian()
  const includeStructural = opts.includeStructural ?? true
  const epsilon = opts.epsilon
  const s = world.__serialize
  // The serializer-OWNED epsilon shadow (RF-SHADOW-FREE): per (archetypeId, columnIndex) a parallel
  // Float64Array of the last-EMITTED numeric values, sized lazily as archetypes are encountered. Only
  // allocated when epsilon is set; core never sees it.
  const shadow = new Map<number, ArchShadow>()
  // Constructing a delta serializer registers the changeVersion stamping consumer:
  // touching changedSince once turns on stamping so subsequent writes stamp the per-row version.
  world.changedSince(0 as EntityHandle, 0)
  // …and (when carrying structure) the persistent structural journal — the since-T STRUCTURAL source
  // that survives the per-frame shape-log recycle. Both are the delta's two stamping seams.
  if (includeStructural) s.enableStructuralJournal()
  const cur = new WriteCursor(opts.initialOutputBytes ?? 16 * 1024)
  let baseline = sinceTick
  const persistedColumnsOf = createPersistedColumnsCache()

  function write(): void {
    if (world.phase !== 'serial') {
      throw new Error('delta() must run while the world is in its serial phase (outside scheduler.update / worker waves)')
    }
    const target = world.currentTick()
    cur.reset()

    // --- HEADER (32 bytes since v3; section offsets + flags back-patched) ---
    // v2 grew the header with a back-patched `richSectionOffset` word so applyDelta can seek
    // SECTION R directly; v3 adds the schemaHash word (byte 8, mirroring the snapshot header) so
    // applyDelta carries the same fail-loud schema gate as snapshot load. v4 changes no header
    // bytes — it widens SECTION R's per-row flag to the three RICH_ROW_* states.
    cur.u32(SNAPSHOT_MAGIC)
    cur.u16(SERIALIZATION_FORMAT_VERSION)
    cur.u8(1) // ENDIAN
    const flagsAt = cur.pos
    cur.u8(FLAG_IS_DELTA) // FLAG_HAS_STRUCTURAL / FLAG_HAS_RICH back-patched
    cur.u32(s.schemaHash()) // schemaHash
    cur.u32(baseline) // baselineTick
    cur.u32(target) // targetTick
    const structOffAt = cur.pos
    cur.u32(0) // structuralSectionOffset (back-patched)
    const valueOffAt = cur.pos
    cur.u32(0) // valueSectionOffset (back-patched)
    const richOffAt = cur.pos
    cur.u32(0) // richSectionOffset (v2; 0 when no RICH section)

    // --- SECTION S: STRUCTURAL OPS since baseline ---
    let flags = FLAG_IS_DELTA
    if (includeStructural) {
      cur.patchU32(structOffAt, cur.pos)
      const drained = s.drainStructuralSince(baseline)
      // A gap means `baseline` predates the bounded journal's live window: the structural section cannot
      // be reconstructed precisely. The delta still emits values; the receiver must resync from a fresh
      // snapshot (the no-partial-apply delta-gap rule). We flag it via an empty structural section.
      if (!drained.gap && drained.records.length > 0) {
        writeDeltaStructuralSection(cur, world, drained.records)
        flags |= FLAG_HAS_STRUCTURAL
      }
    }

    // --- SECTION V: CHANGED VALUES, version-stamp driven ---
    cur.patchU32(valueOffAt, cur.pos)
    const archs = s.archetypes()
    // The FULL changeVersion-selected row set per archetype (the same scan SECTION R rides). Epsilon
    // filters SECTION V's subset below but NEVER SECTION R, so this is computed once and reused.
    const changedRowsByArch = collectChangedRows(world, baseline)
    const archCountAt = cur.pos
    cur.u32(0) // changedArchetypeCount (back-patched)
    let changedArchetypeCount = 0
    for (const a of archs) {
      const allRows = changedRowsByArch.get(a.id)
      if (allRows === undefined) continue
      // Epsilon (RF-SHADOW-FREE): keep a row only if SOME numeric lane exceeds tolerance vs the
      // serializer-owned shadow; else drop it from SECTION V. NOTE: `baseline` advances to `target`
      // at the end of write(), so a dropped row is re-considered only if a LATER write re-stamps it —
      // a one-shot sub-epsilon change is permanently dropped (bounded by epsilon, within the
      // documented contract). The shadow updates to the EMITTED values after selection.
      const rows = epsilon !== undefined ? filterByEpsilon(a, allRows, shadow, epsilon) : allRows
      if (rows.length === 0) continue
      // PERSISTED columns only. The changeVersion stamp is per-entity and shared with the public
      // `.changed` predicate, so a write to a non-persisted field still stamps the row (reactivity
      // must see it) — the filter happens HERE, at emission. Documented cost: such a row is emitted
      // with its (unchanged) persisted values — a harmless, receiver-idempotent over-send. An
      // archetype with no persisted columns at all contributes nothing to SECTION V.
      const persisted = persistedColumnsOf(a)
      if (persisted.length === 0) continue
      changedArchetypeCount += 1
      writeValueArchBlock(cur, a, rows, persisted)
    }
    cur.patchU32(archCountAt, changedArchetypeCount)

    // --- SECTION R: CHANGED RICH VALUES (after SECTION V) — version-gated, FLAG_HAS_RICH ---
    // Rides the SAME changeVersion selection as SECTION V (the unfiltered set — epsilon never applies to
    // rich values). Per archetype, emit the changed rows' rich values per (component, field), with a
    // three-state flag per row (v4): RICH_ROW_VALUE carries the slot's value (an over-send when only the
    // row's numeric field changed — the stamp is whole-entity — same as the numeric section's over-send);
    // RICH_ROW_RESET re-defaults the receiver slot (a producer slot reading as the default MUST propagate,
    // else a mirror that once saw a value keeps it forever); RICH_ROW_KEEP carries no information and is
    // reserved for the onUnserializable skip policy, which must never clobber the receiver. Sparse: an
    // archetype with no rich fields, or no changed rows, contributes 0.
    const richFields = s.richFields()
    let richWrote = false
    if (richFields.length > 0) {
      type RF = (typeof richFields)[number]
      const byComponent = new Map<number, RF[]>()
      for (const rf of richFields) {
        if (!rf.persist) continue
        let bucket = byComponent.get(rf.componentId as number)
        if (bucket === undefined) {
          bucket = []
          byComponent.set(rf.componentId as number, bucket)
        }
        bucket.push(rf)
      }
      cur.alignTo4()
      const richOffset = cur.pos
      const richArchCountAt = cur.pos
      cur.u32(0) // richArchetypeCount (back-patched)
      let richArchetypeCount = 0
      for (const a of archs) {
        const rows = changedRowsByArch.get(a.id)
        if (rows === undefined) continue
        // Which rich fields does THIS archetype's signature carry?
        const archRich: { componentId: number; fieldIndex: number; name: string; kind: 'string' | 'object' }[] = []
        for (const cid of a.signature) {
          const fields = byComponent.get(cid)
          if (fields === undefined) continue
          for (const rf of fields) archRich.push({ componentId: rf.componentId as number, fieldIndex: rf.fieldIndex, name: rf.name, kind: rf.kind })
        }
        if (archRich.length === 0) continue
        richArchetypeCount += 1
        cur.u32(a.id)
        cur.u32(rows.length)
        for (const r of rows) cur.u32(a.rows[r] as number)
        cur.u16(archRich.length)
        for (const rf of archRich) {
          cur.u32(rf.componentId)
          cur.u16(rf.fieldIndex)
          cur.u8(richKindOrdinal(rf.kind))
          for (const r of rows) {
            const handle = a.rows[r] as number as EntityHandle
            // A never-written slot AND a slot reset via `field = undefined` both read as the default
            // on the producer — encode the STATE (reset), not the change, so a stale receiver value
            // converges. Receiver-idempotent, same philosophy as SECTION V's over-send.
            if (!s.richIsPresent(handle, rf.componentId as ComponentId, rf.fieldIndex)) {
              cur.u8(RICH_ROW_RESET)
              continue
            }
            const value = s.richValueOf(handle, rf.componentId as ComponentId, rf.fieldIndex)
            if (value === undefined) {
              cur.u8(RICH_ROW_RESET) // present but reads as an undefined default — reset semantics
              continue
            }
            const json = encodeRichValue(
              value,
              { componentId: rf.componentId as ComponentId, fieldIndex: rf.fieldIndex, fieldName: rf.name, handle, value },
              opts.onUnserializable,
            )
            if (json === undefined) {
              cur.u8(RICH_ROW_KEEP) // skip policy: the producer HAS a value we can't encode — never clobber
              continue
            }
            cur.u8(RICH_ROW_VALUE)
            writeJsonBytes(cur, json)
          }
        }
      }
      cur.patchU32(richArchCountAt, richArchetypeCount)
      if (richArchetypeCount > 0) {
        cur.patchU32(richOffAt, richOffset)
        richWrote = true
      }
    }
    if (richWrote) flags |= FLAG_HAS_RICH
    cur.patchU8(flagsAt, flags) // flags is a single byte at offset 7 — patchU32 would clobber baselineTick
    baseline = target
  }

  // Only EXISTING shadow cells are snapped: a column with no cells yet is FRESH, and fresh
  // semantics (the first candidate emission always emits) must survive the refresh — seeding it
  // here would silently suppress that first observation for delta-chained receivers.
  function refreshEpsilonShadow(): void {
    if (epsilon === undefined) return
    for (const a of s.archetypes()) {
      const archShadow = shadow.get(a.id)
      if (archShadow === undefined) continue
      // Snap tenants alongside values: a refresh means "the receiver knows the CURRENT state", and
      // that state belongs to the rows' current occupants.
      growTenants(archShadow, a.count)
      for (let r = 0; r < a.count; r++) archShadow.tenants[r] = a.rows[r] as number
      let flatIndex = 0
      for (const comp of a.components) {
        for (let i = 0; i < comp.columns.length; i++) {
          const col = comp.columns[i]
          if (col === undefined || comp.fields[i]?.persist === false) {
            flatIndex += 1
            continue
          }
          const cells = archShadow.cols.get(flatIndex)
          if (cells !== undefined) {
            const view = col.view as unknown as ArrayLike<number>
            const lanes = Math.min(cells.length, a.count * col.layout.stride)
            for (let lane = 0; lane < lanes; lane++) cells[lane] = view[lane] as number
          }
          flatIndex += 1
        }
      }
    }
  }

  return {
    delta(): Uint8Array {
      write()
      return cur.bytesView()
    },
    deltaCopy(): Uint8Array {
      write()
      return opts.compressor !== undefined ? compressImage(cur.bytesView(), opts.compressor) : cur.bytesCopy()
    },
    get sinceTick(): number {
      return baseline
    },
    refreshEpsilonShadow,
  }
}

// Epsilon row filter. For each candidate row, compare every numeric lane of every
// column against the serializer-owned shadow; keep the row iff SOME lane differs by more than `epsilon`.
// The shadow is updated to the current values ONLY for kept (emitted) rows, so a sub-epsilon change
// accumulates against the last EMITTED baseline and is emitted once it crosses tolerance. A row never
// seen before has no shadow entry → its lanes differ from 0; to avoid spuriously emitting the initial
// value, a fresh shadow cell is seeded to the current value and the row is kept (the first observation is
// always emitted, matching "the receiver must learn the value at least once").
interface ArchShadow {
  /** Shadow cell owner per row, as the FULL entity handle; NO_TENANT where never seeded. Cells are
   * row-positional, but rows are not stable identities — swap-pop, migration, and despawn/respawn
   * all hand a row to a new entity whose values must not be epsilon-compared against the previous
   * tenant's emissions (divergence would be unbounded, not <= epsilon). A tenant mismatch makes the
   * row FRESH: emitted and reseeded. */
  tenants: Uint32Array
  cols: Map<number, Float64Array>
}

const NO_TENANT = 0xffff_ffff

function growTenants(archShadow: ArchShadow, count: number): void {
  if (archShadow.tenants.length >= count) return
  const grown = new Uint32Array(count).fill(NO_TENANT)
  grown.set(archShadow.tenants)
  archShadow.tenants = grown
}

function filterByEpsilon(
  a: {
    id: number
    count: number
    rows: ArrayLike<number>
    components: readonly {
      columns: readonly ({ view: ArrayLike<number>; layout: { stride: number; element: ElementKind } } | undefined)[]
      fields: readonly { persist: boolean }[]
    }[]
  },
  rows: readonly number[],
  shadow: Map<number, ArchShadow>,
  epsilon: number,
): number[] {
  let archShadow = shadow.get(a.id)
  if (archShadow === undefined) {
    archShadow = { tenants: new Uint32Array(a.count).fill(NO_TENANT), cols: new Map() }
    shadow.set(a.id, archShadow)
  }
  growTenants(archShadow, a.count)
  // Enumerate the archetype's PERSISTED numeric columns in a stable (component, column) order,
  // assigning each a flat shadow column index. Non-persisted columns are excluded from the compare
  // (they never reach the wire, so a transient-field change must not defeat the epsilon drop) but
  // still consume a flat index, keeping the shadow key space parallel to the column order — persist
  // flags are define-time constants, so the index math is the only invariant that matters.
  interface Col {
    readonly key: number
    readonly view: ArrayLike<number>
    readonly stride: number
    readonly fresh: boolean
    readonly cells: Float64Array
  }
  const cols: Col[] = []
  let flatIndex = 0
  for (const comp of a.components) {
    for (let i = 0; i < comp.columns.length; i++) {
      const col = comp.columns[i]
      if (col === undefined || comp.fields[i]?.persist === false) {
        flatIndex += 1
        continue
      }
      const stride = col.layout.stride
      let cells = archShadow.cols.get(flatIndex)
      const fresh = cells === undefined || cells.length < a.count * stride
      if (fresh) {
        const grown = new Float64Array(a.count * stride)
        if (cells !== undefined) grown.set(cells)
        cells = grown
        archShadow.cols.set(flatIndex, cells)
      }
      cols.push({ key: flatIndex, view: col.view, stride, fresh, cells: cells as Float64Array })
      flatIndex += 1
    }
  }
  const kept: number[] = []
  // Track which shadow cells were "seen" this emit for a fresh column, so a fresh column always emits the
  // row's initial value (otherwise a brand-new column's first values would be silently dropped).
  for (const r of rows) {
    const occupant = a.rows[r] as number
    const tenantChanged = archShadow.tenants[r] !== occupant
    let exceeds = tenantChanged
    if (!exceeds) {
      for (const c of cols) {
        const base = r * c.stride
        for (let lane = 0; lane < c.stride; lane++) {
          const cur = c.view[base + lane] as number
          const prev = c.cells[base + lane] as number
          if (c.fresh || Math.abs(cur - prev) > epsilon) {
            exceeds = true
            break
          }
        }
        if (exceeds) break
      }
    }
    if (exceeds) {
      kept.push(r)
      archShadow.tenants[r] = occupant
      for (const c of cols) {
        const base = r * c.stride
        for (let lane = 0; lane < c.stride; lane++) c.cells[base + lane] = c.view[base + lane] as number
      }
    }
  }
  return kept
}

// --- apply: structural ops first, then the changed values, all resolved via the remap table ---------
// `remap` is the producer→receiver entity table from the bootstrap snapshot. A delta whose structural
// section CREATES entities since T must extend the table so the value section (and subsequent deltas)
// resolve those new entities — so we work on a MUTABLE copy and copy newly-minted handles BACK into the
// caller's table when it is mutable (the snapshot result exposes a ReadonlyMap; a caller that wants the
// new handles passes a real Map).
//
// Apply order (load-bearing): SECTION S structural ops FIRST (so the value/rich
// handles resolve to live receiver entities, and `work` gains the newly-created handles), THEN SECTION V
// numeric values, THEN SECTION R rich values — so a rich value for an entity created by THIS delta lands
// on the already-spawned receiver. eid/pair remap is unaffected by the rich section.
//
// LIMITATION — RF-NOREMAP: an `EntityHandle` inside an `object<T>` is applied as a
// raw producer number, NOT remapped. Use an `eid` column or a stable application id instead.
export function applyDelta(
  world: World,
  bytes: Uint8Array,
  remap: ReadonlyMap<EntityHandle, EntityHandle>,
  decompress?: DecompressOptions,
): number {
  if (world.phase !== 'serial') {
    throw new Error('applyDelta must run while the world is in its serial phase (outside scheduler.update / worker waves)')
  }
  const s = world.__serialize
  const work = new Map(remap)
  // Transparently decompress a compression-wrapped image; a raw delta passes through unchanged.
  const cur = new ReadCursor(decompressImage(bytes, decompress))
  const magic = cur.u32()
  if (magic !== SNAPSHOT_MAGIC) throw new Error('serialization: bad magic (not an ecsia delta)')
  // Pre-v4 deltas are rejected loudly: v3 changed the header layout (schemaHash word at byte 8 —
  // misparsing tick/offset words), and v4 changed SECTION R's row-flag semantics (a v3 stream
  // encodes a rich reset as "unchanged", which would silently keep stale values).
  const version = cur.u16()
  if (version < DELTA_MIN_SUPPORTED_VERSION || version > SERIALIZATION_FORMAT_VERSION) {
    throw new Error(
      `serialization: delta format version ${version} can't be read by this build (it reads ` +
        `${DELTA_MIN_SUPPORTED_VERSION}..${SERIALIZATION_FORMAT_VERSION}) — upgrade the receiver to match the sender, or have the sender start a fresh stream with a new baseline snapshot`,
    )
  }
  cur.u8() // endian
  const flags = cur.u8()
  if ((flags & FLAG_IS_DELTA) === 0) throw new Error('serialization: not a delta image')
  const schemaHash = cur.u32()
  if (schemaHash !== s.schemaHash()) {
    throw new Error(
      'serialization: schemaHash mismatch — refusing to apply. The delta was produced by a different ' +
        'component schema; apply it to a world built with the same components.',
    )
  }
  cur.u32() // baselineTick
  const targetTick = cur.u32()
  const structOff = cur.u32()
  const valueOff = cur.u32()
  const richOff = cur.u32()

  // Receiver-local handles this delta creates or writes. Fed to the relations reindex below so
  // exclusive-relation backrefs (which ride the eid column, not a journaled PairAdd) are rebuilt.
  const touched = new Set<EntityHandle>()

  // --- SECTION S: apply structural ops FIRST (creates/destroys/adds/removes), so the value section's
  // handles resolve to live receiver entities. ---
  if ((flags & FLAG_HAS_STRUCTURAL) !== 0 && structOff < valueOff) {
    applyStructuralOps(world, bytes.subarray(structOff, valueOff), work, touched)
  }
  // Propagate creates AND destroys back to a mutable caller table (no-op for a ReadonlyMap caller):
  // without destroy propagation, a stream-lifetime remap (replication G4) grows without bound under
  // entity churn. Equal sizes can mask paired create+destroy, so diff both directions whenever the
  // structural section ran.
  if ((flags & FLAG_HAS_STRUCTURAL) !== 0 || work.size !== remap.size) {
    const mutable = remap as Map<EntityHandle, EntityHandle>
    if (typeof mutable.set === 'function' && typeof mutable.delete === 'function') {
      for (const [k, v] of work) if (!remap.has(k)) mutable.set(k, v)
      for (const k of remap.keys()) if (!work.has(k)) mutable.delete(k)
    }
  }

  // --- SECTION V: write the changed values into the receiver entities resolved via the remap. ---
  cur.seek(valueOff)
  const changedArchetypeCount = cur.u32()
  for (let ai = 0; ai < changedArchetypeCount; ai++) {
    cur.u32() // producer archetype id (ignored — rows carry handles)
    const rowCount = cur.u32()
    const handles = new Uint32Array(rowCount)
    for (let r = 0; r < rowCount; r++) handles[r] = cur.u32()
    // A re-target is an in-place eid-column write with no structural op, so collect value-section
    // rows too — otherwise the reindex would miss exclusive pairs that only changed target.
    for (let r = 0; r < rowCount; r++) {
      const local = work.get(handles[r] as number as EntityHandle)
      if (local !== undefined) touched.add(local)
    }
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

  // --- SECTION R: apply changed rich values AFTER SECTION V — same post-structural
  // `work` remap, so a rich value for an entity CREATED by this delta lands on the spawned receiver.
  // FLAG_HAS_RICH-gated; seeked via richOff (no cursor drift past SECTION V). ---
  if ((flags & FLAG_HAS_RICH) !== 0 && richOff !== 0) {
    cur.seek(richOff)
    const richArchetypeCount = cur.u32()
    for (let ai = 0; ai < richArchetypeCount; ai++) {
      cur.u32() // producer archetype id (ignored — rows carry handles)
      const rowCount = cur.u32()
      const handles = new Uint32Array(rowCount)
      for (let r = 0; r < rowCount; r++) handles[r] = cur.u32()
      const richFieldCount = cur.u16()
      for (let fi = 0; fi < richFieldCount; fi++) {
        const producerCid = cur.u32()
        const fieldIndex = cur.u16()
        cur.u8() // kind ordinal — receiver re-derives from its own descriptor
        for (let r = 0; r < rowCount; r++) {
          const state = cur.u8()
          if (state === RICH_ROW_KEEP) continue // no information — receiver keeps its current value
          if (state === RICH_ROW_RESET) {
            const local = work.get(handles[r] as number as EntityHandle)
            // setRichValue(undefined) reproduces the producer's post-reset sidecar state exactly
            // (written, data=undefined → reads the default) AND stamps the row, so a chained
            // mirror re-propagates the reset downstream.
            if (local !== undefined) s.setRichValue(local, producerCid as ComponentId, fieldIndex, undefined)
            continue
          }
          if (state !== RICH_ROW_VALUE) {
            throw new Error(`serialization: unknown rich row state ${state} — the delta stream is corrupt`)
          }
          const json = readJsonBytes(cur)
          // RF-ROUNDTRIP /: a rich value for an unremapped producer entity is DROPPED, not misapplied.
          const local = work.get(handles[r] as number as EntityHandle)
          if (local === undefined) continue
          s.setRichValue(local, producerCid as ComponentId, fieldIndex, JSON.parse(json) as unknown)
        }
      }
    }
  }

  // Rebuild exclusive-relation backrefs from the eid columns just applied. Exclusive pairs serialize
  // via that column rather than a journaled PairAdd, so a delta updates the forward target but not the
  // in-memory reverse index — subjectsOf/targetsOf would otherwise be empty for delta-applied pairs.
  const rel = s.relations()
  if (rel !== undefined && touched.size > 0) rel.reindexAfterApply(touched)

  return targetTick
}

function writeRowField(
  s: World['__serialize'],
  handle: EntityHandle,
  componentId: ComponentId,
  wireFieldIndex: number,
  element: ElementKind,
  stride: number,
  raw: Uint8Array,
  remap: Map<EntityHandle, EntityHandle>,
): void {
  const dst = s.columnsOf(handle, componentId)
  if (dst === null) return
  // The wire carries PERSISTED columns only: the wireFieldIndex-th persisted column-backed field
  // maps to a local column index through the receiver's own descriptors (parallel on both sides).
  let colIndex = 0
  let persistedSeen = -1
  let localColIndex = -1
  let descriptor: FieldDescriptor | undefined
  for (const f of dst.fields) {
    if (f.ctor === null) continue
    if (f.persist) {
      persistedSeen += 1
      if (persistedSeen === wireFieldIndex) {
        descriptor = f
        localColIndex = colIndex
        break
      }
    }
    colIndex += 1
  }
  if (descriptor === undefined) return
  const col = dst.columns[localColIndex]
  if (col === undefined) return
  // Untrusted-input guard: stride comes off the wire. base must use the LOCAL column stride so a
  // schema-matched peer lands on the right row; a mismatch is a corrupt stream, not a silent misalign.
  if (stride !== col.layout.stride)
    throw new Error(
      `serialization: corrupt delta stream — field stride ${stride} does not match the receiver's ${col.layout.stride}`,
    )
  const view = col.view as unknown as { [i: number]: number }
  // Reinterpret the raw native-width bytes as the column's typed array (copied to a zero-offset buffer
  // so the typed-array view is validly aligned regardless of the source subarray's byteOffset).
  const copy = raw.slice()
  const values = reinterpret(element, copy.buffer, copy.byteOffset, stride)
  const base = dst.row * stride // guarded equal to col.layout.stride above
  for (let lane = 0; lane < stride; lane++) {
    const value = values[lane] as number
    if (descriptor.token === 'eid') {
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

// The changeVersion-selected changed-row set per hot archetype (id-ascending), for the SECTION V +
// SECTION R scan. Non-destructive (version compare), so the filtered view stream (interest.ts) can
// share ONE call across all views per tick (invariant IM-5). Only archetypes with >=1 changed row
// appear; the caller epsilon-filters / masks the subset it emits.
export function collectChangedRows(world: World, baseline: number): Map<number, number[]> {
  const s = world.__serialize
  const map = new Map<number, number[]>()
  for (const a of s.archetypes()) {
    const rows: number[] = [...world.changedRows(a.id, baseline)]
    if (rows.length > 0) map.set(a.id, rows)
  }
  return map
}

// One SECTION V archetype block: id, the changed-row handles, then per PERSISTED component the SoA
// column bytes for those rows. `rows` and `persisted` are already the selected/masked subsets — the
// filtered view stream (interest.ts) passes a visible-row subset and a non-concealed-column subset,
// and may emit several blocks with the same archetype id (the receiver keys rows by handle, ignoring
// the id), so this stays byte-identical for the unfiltered whole-archetype call.
// `isHidden`, when supplied (filtered view stream), masks any `eid` lane whose stored handle is not
// visible to the client to NO_ENTITY — an eid holds the target's RAW producer handle (encodeEid is
// identity), so emitting one bulk would leak a concealed entity's existence. Absent (the unfiltered
// serializer) the eid column is bulk-copied exactly as before, so shipped output stays byte-identical.
export function writeValueArchBlock(
  cur: WriteCursor,
  a: SerializeArchetype,
  rows: readonly number[],
  persisted: readonly PersistedComponentColumns[],
  isHidden?: (handle: number) => boolean,
): void {
  cur.u32(a.id)
  cur.u32(rows.length)
  // Per changed row: the FULL entity handle (the boundary-stable row identity).
  for (const r of rows) cur.u32(a.rows[r] as number)
  cur.u16(persisted.length)
  for (const pc of persisted) {
    const comp = a.components[pc.compIndex]
    if (comp === undefined) continue
    cur.u32(comp.componentId as number)
    cur.u16(pc.colIndices.length)
    for (const ci of pc.colIndices) {
      const col = comp.columns[ci]
      if (col === undefined) continue
      const stride = col.layout.stride
      // U8 element ordinal + u8 stride, then per row the stride elements at the column's NATIVE
      // element width (a raw byte copy — no f64 widening, no per-row allocation).
      cur.u8(elementOrdinal(col.layout.element))
      cur.u8(stride)
      if (isHidden !== undefined && comp.fields[ci]?.token === 'eid') {
        const eview = col.view as unknown as { [i: number]: number }
        for (const r of rows) {
          for (let lane = 0; lane < stride; lane++) {
            const stored = eview[r * stride + lane] as number
            cur.u32(stored !== -1 && isHidden(stored >>> 0) ? 0xffffffff : stored >>> 0)
          }
        }
        continue
      }
      const view = col.view as unknown as { subarray(s: number, e: number): ArrayBufferView }
      for (const r of rows) cur.copyBytes(view.subarray(r * stride, (r + 1) * stride))
    }
  }
}

// Re-export the spec-named header byte width so downstream tooling can size buffers.
export { DELTA_HEADER_BYTES }
