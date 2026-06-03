// Shared wire constants + the structural-op enum (serialization.md §7.1, §10). The DeltaOp ordinals
// are the SHARED structural-op numbering (world.md §9.4): identical to command-buffer Op and
// reactivity ShapeKind — an apply routine dispatches on the same ordinal across all three.

import type { ElementKind } from '@ecsia/core'
import type { WriteCursor, ReadCursor } from './cursor.js'

export const SERIALIZATION_FORMAT_VERSION = 1
export const SNAPSHOT_MAGIC = 0x45435349 // 'ECSI'
/** The full-u32 NO_ENTITY sentinel as written in handle slots (§8.1). */
export const NO_ENTITY_U32 = 0xffffffff

/** Header flag bits (§4.1 / §6.2). */
export const FLAG_IS_DELTA = 1
export const FLAG_HAS_RELATIONS = 2
/** Delta header: a non-empty interleaved structural section is present (§6.2 SECTION S). */
export const FLAG_HAS_STRUCTURAL = 4

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
    throw new Error('serialization: big-endian platform unsupported (the wire format is little-endian, §9.4)')
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
