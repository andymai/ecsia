// Shared wire constants + the structural-op enum. The DeltaOp ordinals
// are the SHARED structural-op numbering: identical to command-buffer Op and
// reactivity ShapeKind — an apply routine dispatches on the same ordinal across all three.

import type { ElementKind } from '@ecsia/core'
import type { FieldDescriptor } from '@ecsia/schema'
import type { WriteCursor, ReadCursor } from './cursor.js'

// v2 added the version-gated RICH section + header offset word; v3 adds the schemaHash word to the
// DELTA header (the gate snapshots have carried since v1), growing it 28→32 bytes; v4 widens the
// delta RICH section's per-row flag to three states (RICH_ROW_*) so a rich field RESET to its
// default propagates to receivers — pre-v4 deltas conflated reset with unchanged, so a mirror kept
// the stale value forever. SNAPSHOT layout is unchanged since v2, so the snapshot reader still
// range-checks `MIN_SUPPORTED_VERSION <= v <= SERIALIZATION_FORMAT_VERSION` and per-section-gates
// the v2-only growth. DELTAS are different: each wire-semantics break is rejected loudly via
// `DELTA_MIN_SUPPORTED_VERSION` (pre-publish, zero compat burden). Old readers reject new images
// via their strict version checks.
export const SERIALIZATION_FORMAT_VERSION = 4
/** Oldest SNAPSHOT wire version a current reader accepts (per-section gated). */
export const MIN_SUPPORTED_VERSION = 1
/** The version in which the RICH section + its header offset word first appear. */
export const RICH_FORMAT_VERSION = 2
/** The version in which the delta RICH row flag gains its reset state; older deltas are rejected
 * (their wire-0 conflates "unchanged" with "reset" — applying one would silently keep stale values). */
export const DELTA_MIN_SUPPORTED_VERSION = 4
export const SNAPSHOT_MAGIC = 0x45435349 // 'ECSI'
/** The full-u32 NO_ENTITY sentinel as written in handle slots. */
export const NO_ENTITY_U32 = 0xffffffff

/** Header flag bits. */
export const FLAG_IS_DELTA = 1
export const FLAG_HAS_RELATIONS = 2
/** Delta header: a non-empty interleaved structural section is present. */
export const FLAG_HAS_STRUCTURAL = 4
/** Snapshot/delta: a RICH (sidecar JSON) section is present. v2+ only. */
export const FLAG_HAS_RICH = 8

// Delta SECTION R per-row states (v4). KEEP carries no information — the receiver's current value
// stands (used ONLY for the onUnserializable skip policy, which must never clobber). RESET is the
// state v4 exists for: the producer's slot reads as the field default, so the receiver re-defaults.
export const RICH_ROW_KEEP = 0
export const RICH_ROW_VALUE = 1
export const RICH_ROW_RESET = 2

export const enum DeltaOp {
  EntityCreate = 0,
  EntityDestroy = 1,
  ComponentAdd = 2,
  ComponentRemove = 3,
  PairAdd = 4,
  PairRemove = 5,
  PairPayload = 6,
}

// ElementKind ⇄ ordinal (`u8 element`). The full enumeration matches @ecsia/core's layout.
const ELEMENT_ORDINALS: readonly ElementKind[] = ['u8', 'u8c', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64']

export function elementOrdinal(element: ElementKind): number {
  const i = ELEMENT_ORDINALS.indexOf(element)
  if (i < 0) throw new Error(`serialization: unknown element kind '${element}'`)
  return i
}

export function ordinalToElement(ordinal: number): ElementKind {
  const e = ELEMENT_ORDINALS[ordinal]
  if (e === undefined) throw new Error(`serialization: unknown element ordinal ${ordinal}`)
  return e
}

/**
 * Indices (within a component's column-backed column list) of the PERSISTED columns, in field
 * order. The SoA wire sections carry persisted columns only — the wire grammar is unchanged
 * (counts are self-describing), and the persisted subset is part of the schemaHash, so both
 * sides derive this identical mapping: wire position `i` ⇒ local column `result[i]`.
 */
export function persistedColumnIndices(fields: readonly FieldDescriptor[]): number[] {
  const out: number[] = []
  let colIndex = 0
  for (const f of fields) {
    if (f.ctor === null) continue
    if (f.persist) out.push(colIndex)
    colIndex += 1
  }
  return out
}

/** One component's persisted-column selection within an archetype: the component's position in
 * `a.components` plus the persisted column indices (in field order) within its column list. */
export interface PersistedComponentColumns {
  readonly compIndex: number
  readonly colIndices: readonly number[]
}

/**
 * A memoizing per-archetype-id persisted-column lookup. Persist flags are define-time constants and
 * an archetype's component/column order is fixed by its signature, so the selection is computed once
 * per archetype and reused — the snapshot/delta emit loops stay allocation-free per call.
 */
export function createPersistedColumnsCache(): (a: {
  readonly id: number
  readonly components: readonly { readonly columns: readonly unknown[]; readonly fields: readonly { readonly persist: boolean }[] }[]
}) => readonly PersistedComponentColumns[] {
  const byArch = new Map<number, readonly PersistedComponentColumns[]>()
  return (a) => {
    let cached = byArch.get(a.id)
    if (cached === undefined) {
      const entries: PersistedComponentColumns[] = []
      for (let compIndex = 0; compIndex < a.components.length; compIndex++) {
        const comp = a.components[compIndex]
        if (comp === undefined) continue
        const colIndices: number[] = []
        for (let i = 0; i < comp.columns.length; i++) {
          if (comp.fields[i]?.persist !== false) colIndices.push(i)
        }
        if (colIndices.length > 0) entries.push({ compIndex, colIndices })
      }
      cached = entries
      byArch.set(a.id, cached)
    }
    return cached
  }
}

/**: the wire is little-endian; raw SoA byte copies assume the platform is LE. */
export function assertPlatformLittleEndian(): void {
  const probe = new Uint8Array(new Uint32Array([1]).buffer)
  if (probe[0] !== 1) {
    throw new Error('serialization: big-endian platform unsupported (the wire format is little-endian)')
  }
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export function writeString(cur: WriteCursor, s: string): void {
  const bytes = ENCODER.encode(s)
  // u16 length framing: silently masking a longer string (& 0xffff) would leave the overflow bytes
  // in the stream to be misparsed by the next read — poisoning the whole image. Pair-payload
  // strings are arbitrary user data, so this is reachable from world state; fail loudly instead.
  if (bytes.length > 0xffff) {
    throw new Error(`serialization: string exceeds the u16 wire limit (${bytes.length} bytes > 65535) — shorten the value or store it in an object<T> field (u32-framed JSON)`)
  }
  cur.u16(bytes.length)
  for (const b of bytes) cur.u8(b)
}

export function readString(cur: ReadCursor): string {
  const len = cur.u16()
  return DECODER.decode(cur.takeBytes(len))
}

/** Encode `s` as u32-length-prefixed UTF-8 (the RICH section's JSON blobs,
 * a rich value's JSON can exceed the u16 staticString cap, so the length is a full u32). */
export function writeJsonBytes(cur: WriteCursor, s: string): void {
  const bytes = ENCODER.encode(s)
  cur.u32(bytes.length)
  cur.copyBytes(bytes)
}

/** Decode a u32-length-prefixed UTF-8 JSON blob written by `writeJsonBytes`. */
export function readJsonBytes(cur: ReadCursor): string {
  const len = cur.u32()
  return DECODER.decode(cur.takeBytes(len))
}
