// Shared wire constants + the structural-op enum (serialization.md §7.1, §10). The DeltaOp ordinals
// are the SHARED structural-op numbering (world.md §9.4): identical to command-buffer Op and
// reactivity ShapeKind — an apply routine dispatches on the same ordinal across all three.

import type { ElementKind } from '@ecsia/core'
import type { WriteCursor, ReadCursor } from './cursor.js'

// rich-fields.md §7.2 / G-2: P1 bumps the format to 2 (adds the version-gated RICH section + header
// offset word). The bump is GRACEFUL, not a hard wire break: a v2 reader still loads v1 images (it
// range-checks `MIN_SUPPORTED_VERSION <= v <= SERIALIZATION_FORMAT_VERSION` and gates the v2-only header
// growth + RICH section on `version >= 2`). The inverse — a v2 image into a v1 reader — is NOT supported:
// a v1 build's strict `version !== 1` check REJECTS a v2 image with "unsupported format version 2". That
// is the documented one-way compatibility (forward-readers tolerate old images; old readers reject new).
export const SERIALIZATION_FORMAT_VERSION = 2
/** Oldest wire version a current reader accepts. v1 images load in the v2 reader (per-section gated). */
export const MIN_SUPPORTED_VERSION = 1
/** The version in which the RICH section + its header offset word first appear. */
export const RICH_FORMAT_VERSION = 2
export const SNAPSHOT_MAGIC = 0x45435349 // 'ECSI'
/** The full-u32 NO_ENTITY sentinel as written in handle slots (§8.1). */
export const NO_ENTITY_U32 = 0xffffffff

/** Header flag bits (§4.1 / §6.2). */
export const FLAG_IS_DELTA = 1
export const FLAG_HAS_RELATIONS = 2
/** Delta header: a non-empty interleaved structural section is present (§6.2 SECTION S). */
export const FLAG_HAS_STRUCTURAL = 4
/** Snapshot/delta: a RICH (sidecar JSON) section is present (rich-fields.md §7.2). v2+ only. */
export const FLAG_HAS_RICH = 8

export const enum DeltaOp {
  EntityCreate = 0,
  EntityDestroy = 1,
  ComponentAdd = 2,
  ComponentRemove = 3,
  PairAdd = 4,
  PairRemove = 5,
  PairPayload = 6,
}

// ElementKind ⇄ ordinal (§4.1 SoA `u8 element`). The full enumeration matches @ecsia/core's layout.
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

/** §9.4: the wire is little-endian; raw SoA byte copies assume the platform is LE. */
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
  cur.u16(bytes.length)
  for (const b of bytes) cur.u8(b)
}

export function readString(cur: ReadCursor): string {
  const len = cur.u16()
  return DECODER.decode(cur.takeBytes(len))
}

/** Encode `s` as u32-length-prefixed UTF-8 (the RICH section's JSON blobs, rich-fields.md §7.2 —
 *  a rich value's JSON can exceed the u16 staticString cap, so the length is a full u32). */
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
