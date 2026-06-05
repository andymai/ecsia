// Edge-case unit coverage for the low-level wire codecs. These hit
// the per-tag payload encode/decode paths, the element-ordinal validators, and the ReadCursor seek /
// atEnd accessors — the small but load-bearing primitives the higher serializers build on.

import { describe, it, expect } from 'vitest'
import { WriteCursor, ReadCursor } from '../src/cursor.js'
import { writePairPayload, readPairPayload } from '../src/payload.js'
import { elementOrdinal, ordinalToElement, assertPlatformLittleEndian } from '../src/format.js'

describe('payload codec — every scalar tag round-trips losslessly ', () => {
  it('string, boolean (both polarities), and numeric (incl. negative + fractional) survive', () => {
    const w = new WriteCursor(64)
    const payload = { s: 'héllo', tTrue: true, tFalse: false, n: -3.5, z: 0 }
    writePairPayload(w, payload)
    const out = readPairPayload(new ReadCursor(w.bytesView()))
    expect(out).toEqual(payload)
    // boolean must decode to a real boolean, not a truthy number (tag 2 path).
    expect(out?.tTrue).toBe(true)
    expect(out?.tFalse).toBe(false)
    expect(typeof out?.tTrue).toBe('boolean')
  })

  it('a non-number, non-string, non-boolean value coerces via Number() on the numeric branch', () => {
    // The else-branch coerces with Number(value); a bigint-ish / Date object would NaN, but a numeric
    // String object coerces. Use a boxed numeric to exercise the `Number(value)` fallback (not typeof number).
    const w = new WriteCursor(64)
    writePairPayload(w, { v: new Number(42) as unknown as number })
    const out = readPairPayload(new ReadCursor(w.bytesView()))
    expect(out?.v).toBe(42)
  })

  it('undefined payload writes a zero-count and decodes back to undefined', () => {
    const w = new WriteCursor(16)
    writePairPayload(w, undefined)
    expect(readPairPayload(new ReadCursor(w.bytesView()))).toBeUndefined()
  })

  it('an empty payload object also decodes to undefined (count 0 sentinel)', () => {
    const w = new WriteCursor(16)
    writePairPayload(w, {})
    expect(readPairPayload(new ReadCursor(w.bytesView()))).toBeUndefined()
  })

  it('keys are emitted sorted, so two equal payloads with differing insertion order are byte-identical', () => {
    const w1 = new WriteCursor(64)
    const w2 = new WriteCursor(64)
    writePairPayload(w1, { b: 2, a: 1 })
    writePairPayload(w2, { a: 1, b: 2 })
    expect(Buffer.from(w1.bytesView())).toEqual(Buffer.from(w2.bytesView()))
  })
})

describe('format — element ordinal validators reject out-of-range ', () => {
  it('elementOrdinal round-trips every known kind and throws on an unknown kind', () => {
    for (const e of ['u8', 'u8c', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64'] as const) {
      expect(ordinalToElement(elementOrdinal(e))).toBe(e)
    }
    expect(() => elementOrdinal('weird' as never)).toThrow(/unknown element kind/)
  })

  it('ordinalToElement throws on an ordinal past the table end', () => {
    expect(() => ordinalToElement(99)).toThrow(/unknown element ordinal/)
    expect(() => ordinalToElement(-1)).toThrow(/unknown element ordinal/)
  })

  it('assertPlatformLittleEndian passes on this (LE) platform', () => {
    expect(() => assertPlatformLittleEndian()).not.toThrow()
  })
})

describe('ReadCursor — seek + atEnd accessors ', () => {
  it('seek repositions the cursor and atEnd reports the buffer boundary', () => {
    const w = new WriteCursor(16)
    w.u32(0xdeadbeef)
    w.u32(0x12345678)
    const r = new ReadCursor(w.bytesView())
    expect(r.atEnd).toBe(false)
    expect(r.pos).toBe(0)
    r.seek(4)
    expect(r.pos).toBe(4)
    expect(r.u32()).toBe(0x12345678)
    expect(r.atEnd).toBe(true)
    // seek back and re-read the first word.
    r.seek(0)
    expect(r.u32()).toBe(0xdeadbeef)
  })

  it('WriteCursor grows past its initial capacity preserving earlier bytes (#ensure doubling)', () => {
    const w = new WriteCursor(64) // min capacity
    // Write more than 64 bytes to force at least one doubling, then verify the prefix survived.
    for (let i = 0; i < 40; i++) w.u32(i)
    const r = new ReadCursor(w.bytesView())
    for (let i = 0; i < 40; i++) expect(r.u32()).toBe(i)
  })
})
