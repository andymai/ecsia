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
  FLAG_FIELD_GRANULAR,
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
  /**
   * SECTION V grain. `'component'` (default) emits every persisted column of a changed row — the v4
   * wire, byte-identical. `'field'` emits only the columns whose value moved since that row's last
   * emission: the archetype's changed rows are grouped by their identical change mask and each group
   * becomes one block carrying just that group's columns (FLAG_FIELD_GRANULAR, v5).
   *
   * Per-field change detection needs a baseline, and core stamps changeVersion per ENTITY, so
   * `'field'` allocates the same serializer-owned shadow `epsilon` does — and pays the same memory
   * cost. With `epsilon` unset the comparison is EXACT (tolerance 0).
   */
  readonly granularity?: 'component' | 'field'
}

/**
 * A reusable since-T delta serializer (v5 wire). Changed rich fields ride SECTION R, selected by the SAME
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
   * Snap the epsilon shadow to the CURRENT column values (a no-op unless `epsilon` or
   * `granularity: 'field'` allocated a shadow). The shadow normally holds last-EMITTED values, so a
   * receiver rebased onto an exact full snapshot would otherwise be epsilon-compared against stale
   * emissions — letting it drift up to 2·epsilon before a held-back row re-crosses tolerance. Call
   * at the same serial flush a rebasing snapshot is taken.
   */
  refreshEpsilonShadow(): void
}

// MAGIC u32, VERSION u16, ENDIAN u8, flags u8, schemaHash u32 (v3), baselineTick u32,
// targetTick u32, structuralSectionOffset u32, valueSectionOffset u32, richSectionOffset u32 (v2).
const DELTA_HEADER_BYTES = 32

export function createDeltaSerializer(world: World, sinceTick: number, opts: DeltaOptions = {}): DeltaSerializer {
  assertPlatformLittleEndian()
  const includeStructural = opts.includeStructural ?? true
  const fieldGranular = opts.granularity === 'field'
  // Field granularity is expressed over the epsilon shadow's change masks, so it turns the shadow on
  // with an EXACT tolerance when no epsilon was asked for.
  const epsilon = opts.epsilon ?? (fieldGranular ? 0 : undefined)
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
    // Set for the whole image, emitted or not: the reader's per-column branch is unconditional, so
    // the flag describes the grammar of every block rather than the presence of a group.
    let flags = fieldGranular ? FLAG_IS_DELTA | FLAG_FIELD_GRANULAR : FLAG_IS_DELTA
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
      const selected = epsilon !== undefined ? selectByEpsilon(a, allRows, shadow, epsilon, fieldGranular) : undefined
      const rows = selected?.rows ?? allRows
      if (rows.length === 0) continue
      // PERSISTED columns only. The changeVersion stamp is per-entity and shared with the public
      // `.changed` predicate, so a write to a non-persisted field still stamps the row (reactivity
      // must see it) — the filter happens HERE, at emission. Documented cost: such a row is emitted
      // with its (unchanged) persisted values — a harmless, receiver-idempotent over-send. An
      // archetype with no persisted columns at all contributes nothing to SECTION V.
      const persisted = persistedColumnsOf(a)
      if (persisted.length === 0) continue
      if (selected !== undefined && fieldGranular) {
        changedArchetypeCount += writeFieldGranularBlocks(cur, a, selected, persisted)
        continue
      }
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
export interface ArchShadow {
  /** Shadow cell owner per row, as the FULL entity handle; NO_TENANT where never seeded. Cells are
   * row-positional, but rows are not stable identities — swap-pop, migration, and despawn/respawn
   * all hand a row to a new entity whose values must not be epsilon-compared against the previous
   * tenant's emissions (divergence would be unbounded, not <= epsilon). A tenant mismatch makes the
   * row FRESH: emitted and reseeded. */
  tenants: Uint32Array
  cols: Map<number, Float64Array>
  /** Per-frame scratch for {@link computeRowFieldMasks}: `maskWords` u32 words per row. Carries no
   * state across calls — only the rows passed to a given call are meaningful after it. */
  masks: Uint32Array
  maskWords: number
}

const NO_TENANT = 0xffff_ffff

export function newArchShadow(count: number): ArchShadow {
  return { tenants: new Uint32Array(count).fill(NO_TENANT), cols: new Map(), masks: new Uint32Array(0), maskWords: 1 }
}

function growTenants(archShadow: ArchShadow, count: number): void {
  if (archShadow.tenants.length >= count) return
  const grown = new Uint32Array(count).fill(NO_TENANT)
  grown.set(archShadow.tenants)
  archShadow.tenants = grown
}

// A persisted numeric column paired with its shadow cells, in the archetype's flat (component, column)
// order. `key` is the flat index — the shadow key space, and the mapping a mask bit position resolves to.
export interface EpsilonCol {
  readonly key: number
  readonly view: ArrayLike<number>
  readonly stride: number
  readonly fresh: boolean
  readonly cells: Float64Array
}

// Enumerate the archetype's PERSISTED numeric columns in a stable (component, column) order, assigning
// each a flat shadow column index. Non-persisted columns are excluded from the compare (they never reach
// the wire, so a transient-field change must not defeat the epsilon drop) but still consume a flat index,
// keeping the shadow key space parallel to the column order — persist flags are define-time constants, so
// the index math is the only invariant that matters.
function epsilonColumns(
  a: {
    count: number
    components: readonly {
      columns: readonly ({ view: ArrayLike<number>; layout: { stride: number; element: ElementKind } } | undefined)[]
      fields: readonly { persist: boolean }[]
    }[]
  },
  archShadow: ArchShadow,
): EpsilonCol[] {
  const cols: EpsilonCol[] = []
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
  return cols
}

function growMasks(archShadow: ArchShadow, count: number, words: number): void {
  if (archShadow.maskWords === words && archShadow.masks.length >= count * words) return
  archShadow.maskWords = words
  archShadow.masks = new Uint32Array(count * words)
}

/**
 * Per-row, per-flat-column change bits vs the epsilon shadow. Bit `i` of row `r` (LSB-first across
 * `archShadow.maskWords` u32 words per row, at `r * maskWords`) is set when `cols[i]` of that row is
 * FRESH, the row's tenant changed (a new occupant's every column is new to the receiver), or some lane
 * differs from the shadow by more than `epsilon`.
 *
 * Reads only — the shadow and tenants are updated by the caller, for EMITTED rows. Writes into a
 * serializer-owned scratch buffer (no per-row allocation); only the rows in `rows` are written, so words
 * for any other row are stale.
 *
 * CALLER CONTRACT — an empty mask does NOT mean "nothing to emit". `cols` covers only column-BACKED
 * persisted fields, so an archetype whose persisted fields are all rich yields `cols.length === 0` and
 * therefore zero mask words: a tenant change on such a row is invisible here and the row would be
 * dropped by a bare `mask !== 0` test, silently stranding the new occupant on the receiver. Callers
 * must test the tenant separately (as the epsilon filter does) rather than reducing to the mask alone.
 */
export function computeRowFieldMasks(
  a: { count: number; rows: ArrayLike<number> },
  rows: readonly number[],
  archShadow: ArchShadow,
  cols: readonly EpsilonCol[],
  epsilon: number,
): Uint32Array {
  const words = Math.max(1, (cols.length + 31) >>> 5)
  growMasks(archShadow, a.count, words)
  const masks = archShadow.masks
  for (const r of rows) {
    const rowBase = r * words
    for (let w = 0; w < words; w++) masks[rowBase + w] = 0
    const tenantChanged = archShadow.tenants[r] !== (a.rows[r] as number)
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci] as EpsilonCol
      let changed = tenantChanged || c.fresh
      if (!changed) {
        const base = r * c.stride
        for (let lane = 0; lane < c.stride; lane++) {
          if (Math.abs((c.view[base + lane] as number) - (c.cells[base + lane] as number)) > epsilon) {
            changed = true
            break
          }
        }
      }
      if (changed) {
        const w = rowBase + (ci >>> 5)
        masks[w] = (masks[w] as number) | (1 << (ci & 31))
      }
    }
  }
  return masks
}

/** The epsilon filter's result: the kept rows plus the masks that justified keeping them, so a
 * field-granular caller can group the rows without recomputing the compare. */
interface EpsilonSelection {
  readonly rows: number[]
  readonly masks: Uint32Array
  readonly words: number
}

function selectByEpsilon(
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
  perField: boolean,
): EpsilonSelection {
  let archShadow = shadow.get(a.id)
  if (archShadow === undefined) {
    archShadow = newArchShadow(a.count)
    shadow.set(a.id, archShadow)
  }
  growTenants(archShadow, a.count)
  const cols = epsilonColumns(a, archShadow)
  const masks = computeRowFieldMasks(a, rows, archShadow, cols, epsilon)
  const words = archShadow.maskWords
  const kept: number[] = []
  for (const r of rows) {
    const occupant = a.rows[r] as number
    // A tenant change is checked separately, not read off the mask: an archetype whose only persisted
    // fields are rich (column-less) has NO mask bits at all, and its new occupant must still emit.
    let exceeds = archShadow.tenants[r] !== occupant
    if (!exceeds) {
      const rowBase = r * words
      for (let w = 0; w < words; w++) {
        if (masks[rowBase + w] !== 0) {
          exceeds = true
          break
        }
      }
    }
    if (exceeds) {
      kept.push(r)
      archShadow.tenants[r] = occupant
      const rowBase = r * words
      for (let ci = 0; ci < cols.length; ci++) {
        // At field grain the shadow may only advance for the columns this row actually TRANSMITS:
        // snapping a column the block omits would reset its sub-tolerance drift baseline without the
        // receiver ever seeing the value, and the divergence would then accumulate past epsilon.
        if (perField && ((masks[rowBase + (ci >>> 5)] as number) & (1 << (ci & 31))) === 0) continue
        const c = cols[ci] as EpsilonCol
        const base = r * c.stride
        for (let lane = 0; lane < c.stride; lane++) c.cells[base + lane] = c.view[base + lane] as number
      }
    }
  }
  return { rows: kept, masks, words }
}

// Rows sharing a change mask share a column set, so ONE block per distinct mask keeps SECTION V
// field-major and pays zero per-row overhead. Below this many rows per group the per-block header
// (arch id, row count, handles, component/field framing) outweighs the columns it drops, so the
// archetype falls back to a single whole-row block — legal because blocks are self-describing.
const FIELD_GROUP_MIN_ROWS = 4

function writeFieldGranularBlocks(
  cur: WriteCursor,
  a: SerializeArchetype,
  selected: EpsilonSelection,
  persisted: readonly PersistedComponentColumns[],
): number {
  const { rows, masks, words } = selected
  // Grouping allocates per GROUP, never per row: a row's mask words hash to a numeric bucket key and
  // ties are resolved by comparing the words themselves. `groups` is in first-occurrence order, which
  // is the emission order — the wire depends on it.
  const groups: number[][] = []
  const buckets = new Map<number, number[]>()
  for (const r of rows) {
    const base = r * words
    let hash = masks[base] as number
    for (let w = 1; w < words; w++) hash = (Math.imul(hash, 0x01000193) ^ (masks[base + w] as number)) | 0
    let bucket = buckets.get(hash)
    if (bucket === undefined) {
      bucket = []
      buckets.set(hash, bucket)
    }
    let group: number[] | undefined
    for (const gi of bucket) {
      const candidate = groups[gi] as number[]
      const other = (candidate[0] as number) * words
      let same = true
      for (let w = 0; w < words; w++) {
        if (masks[base + w] !== masks[other + w]) {
          same = false
          break
        }
      }
      if (same) {
        group = candidate
        break
      }
    }
    if (group === undefined) {
      bucket.push(groups.length)
      groups.push([r])
    } else group.push(r)
  }
  const all = restrictToMask(persisted, masks, 0, 0)
  if (groups.length * FIELD_GROUP_MIN_ROWS > rows.length) {
    writeValueArchBlock(cur, a, rows, persisted, undefined, all.ordinals)
    return 1
  }
  for (const grouped of groups) {
    // An all-clear mask means the row was kept for a reason the columns cannot express (a tenant
    // change in a column-less archetype); emit the whole row rather than an empty block.
    const sub = restrictToMask(persisted, masks, (grouped[0] as number) * words, words)
    const cols = sub.entries.length > 0 ? sub : { entries: persisted, ordinals: all.ordinals }
    writeValueArchBlock(cur, a, grouped, cols.entries, undefined, cols.ordinals)
  }
  return groups.length
}

// The persisted columns whose mask bit is set, plus each kept column's PER-COMPONENT persisted
// ordinal — the index the receiver resolves against its own descriptors. `words === 0` selects
// everything (the fallback block's ordinals are just each column's position).
function restrictToMask(
  persisted: readonly PersistedComponentColumns[],
  masks: Uint32Array,
  maskBase: number,
  words: number,
): { entries: PersistedComponentColumns[]; ordinals: number[][] } {
  const entries: PersistedComponentColumns[] = []
  const ordinals: number[][] = []
  let bit = 0
  for (const pc of persisted) {
    const colIndices: number[] = []
    const ords: number[] = []
    for (let j = 0; j < pc.colIndices.length; j++) {
      const set = words === 0 || (((masks[maskBase + (bit >>> 5)] as number) >>> (bit & 31)) & 1) === 1
      if (set) {
        colIndices.push(pc.colIndices[j] as number)
        ords.push(j)
      }
      bit += 1
    }
    if (colIndices.length > 0) {
      entries.push({ compIndex: pc.compIndex, colIndices })
      ordinals.push(ords)
    }
  }
  return { entries, ordinals }
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
  const fieldGranular = (flags & FLAG_FIELD_GRANULAR) !== 0
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
        // A field-granular block carries a SUBSET of the component's columns, so each one names its
        // wire field index; a v4 block's columns are the whole set, in order.
        const wireFi = fieldGranular ? cur.u16() : fi
        const element = ordinalToElement(cur.u8())
        const stride = cur.u8()
        const widthBytes = elementBytes(element) * stride
        for (let r = 0; r < rowCount; r++) {
          const raw = cur.takeBytes(widthBytes)
          const local = work.get(handles[r] as number as EntityHandle)
          if (local === undefined) continue
          writeRowField(s, local, producerCid as ComponentId, wireFi, element, stride, raw, work)
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
// `wireOrdinals` (field-granular blocks) is parallel to `persisted`: per component, the wire field
// index of each kept column, written ahead of the element/stride pair. Absent ⇒ the v4 grammar, where
// a column's wire field index is its position in the block.
export function writeValueArchBlock(
  cur: WriteCursor,
  a: SerializeArchetype,
  rows: readonly number[],
  persisted: readonly PersistedComponentColumns[],
  isHidden?: (handle: number) => boolean,
  wireOrdinals?: readonly (readonly number[])[],
): void {
  cur.u32(a.id)
  cur.u32(rows.length)
  // Per changed row: the FULL entity handle (the boundary-stable row identity).
  for (const r of rows) cur.u32(a.rows[r] as number)
  cur.u16(persisted.length)
  for (let pi = 0; pi < persisted.length; pi++) {
    const pc = persisted[pi] as PersistedComponentColumns
    const comp = a.components[pc.compIndex]
    if (comp === undefined) continue
    cur.u32(comp.componentId as number)
    cur.u16(pc.colIndices.length)
    const ords = wireOrdinals?.[pi]
    for (let j = 0; j < pc.colIndices.length; j++) {
      const ci = pc.colIndices[j] as number
      const col = comp.columns[ci]
      if (col === undefined) continue
      const stride = col.layout.stride
      // U8 element ordinal + u8 stride, then per row the stride elements at the column's NATIVE
      // element width (a raw byte copy — no f64 widening, no per-row allocation). A field-granular
      // block prefixes the column's wire field index, since its columns are a subset.
      if (ords !== undefined) cur.u16(ords[j] as number)
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
      // Take the column's byte view ONCE, then copy each row's slice alloc-free (no per-row subarray).
      const tv = col.view as unknown as { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }
      const srcU8 = new Uint8Array(tv.buffer, tv.byteOffset, tv.byteLength)
      const strideBytes = stride * col.layout.elementBytes
      for (const r of rows) cur.copyRawBytes(srcU8, r * strideBytes, strideBytes)
    }
  }
}

// Re-export the spec-named header byte width so downstream tooling can size buffers.
export { DELTA_HEADER_BYTES }
