// Coverage: commands/fields.ts — the field-word codec for OP_ADD/OP_SET_PAYLOAD payloads
// Round-trips EVERY ElementKind through encode→decode so the apply
// path stores exactly what a main-thread setter would: f64 two-word split, vec stride, and the
// integer/bool/eid/staticString one-word widening (incl. the signed i32 reinterpret boundary).

import { describe, expect, test } from 'vitest'
import { defineComponent, vec, staticString } from '@ecsia/core'
import { buildFieldCodec } from '../src/internal.js'
import type { ComponentDef, Schema } from '@ecsia/schema'

function roundTrip(def: ComponentDef<Schema>, init: Record<string, unknown>): Record<string, unknown> {
  const codec = buildFieldCodec(def)
  const out = new Uint32Array(codec.totalWords + 8)
  const written = codec.encode(init, out, 0)
  expect(written).toBe(codec.totalWords)
  return codec.decode(out, 0)
}

describe('fields.ts codec round-trips every ElementKind (apply stores exactly the main-thread value)', () => {
  test('f32 round-trips with single-precision rounding (1 word)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_f32' }) as ComponentDef<Schema>
    expect(buildFieldCodec(C).totalWords).toBe(1)
    expect(roundTrip(C, { x: 1.5 })).toEqual({ x: 1.5 })
    // 0.1 is not representable in f32 — the codec must reflect the precision LOSS, not the input.
    const r = roundTrip(C, { x: 0.1 }) as { x: number }
    expect(r.x).toBeCloseTo(0.1, 6)
    expect(r.x).toBe(Math.fround(0.1))
  })

  test('f64 splits into two words (low, high) and reassembles full double precision', () => {
    const C = defineComponent({ d: 'f64' }, { name: 'cov_f64' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(2) // f64 is TWO u32 words, not one
    expect(codec.fields[0]!.words).toBe(2)
    // A value that needs full double precision (would be lost in f32) survives the two-word split.
    const v = 0.1 + 0.2 // 0.30000000000000004, exact double
    const r = roundTrip(C, { d: v }) as { d: number }
    expect(r.d).toBe(v)
    expect(r.d).not.toBe(Math.fround(v)) // genuinely double, not f32-rounded
    // A large integer beyond 2^32 also survives (proves both words carry signal).
    expect((roundTrip(C, { d: 9007199254740991 }) as { d: number }).d).toBe(9007199254740991)
  })

  test('i32 widens through a signed two’s-complement reinterpret on decode (negative boundary)', () => {
    const C = defineComponent({ n: 'i32' }, { name: 'cov_i32' }) as ComponentDef<Schema>
    expect(roundTrip(C, { n: -1 })).toEqual({ n: -1 }) // 0xffffffff must decode back to -1, not 4294967295
    expect(roundTrip(C, { n: -2147483648 })).toEqual({ n: -2147483648 }) // INT32_MIN boundary
    expect(roundTrip(C, { n: 2147483647 })).toEqual({ n: 2147483647 }) // INT32_MAX boundary
    expect(roundTrip(C, { n: 0 })).toEqual({ n: 0 })
  })

  test('u32 round-trips the high (sign) bit unsigned', () => {
    const C = defineComponent({ n: 'u32' }, { name: 'cov_u32' }) as ComponentDef<Schema>
    expect(roundTrip(C, { n: 0xffffffff })).toEqual({ n: 0xffffffff })
    expect(roundTrip(C, { n: 0x80000000 })).toEqual({ n: 0x80000000 })
  })

  test('bool round-trips true/false through its 0/1 slot', () => {
    const C = defineComponent({ b: 'bool' }, { name: 'cov_bool' }) as ComponentDef<Schema>
    expect(roundTrip(C, { b: true })).toEqual({ b: true })
    expect(roundTrip(C, { b: false })).toEqual({ b: false })
  })

  test('eid widens a full u32 handle and maps -1 <-> null ( sentinel boundary)', () => {
    const C = defineComponent({ target: 'eid' }, { name: 'cov_eid' }) as ComponentDef<Schema>
    expect(buildFieldCodec(C).totalWords).toBe(1)
    // A handle with the generation high bits set exceeds 2^31 — must survive the unsigned widen.
    const handle = 0x90000005
    expect(roundTrip(C, { target: handle })).toEqual({ target: handle })
    expect(roundTrip(C, { target: 0 })).toEqual({ target: 0 }) // index 0 is a real entity, not null
    // The eid default is the null sentinel: an init that omits the field decodes to null.
    expect(roundTrip(C, {})).toEqual({ target: null })
  })

  test('staticString stores the CHOICE INDEX (one u32 word), round-trips the label', () => {
    const C = defineComponent({ state: staticString('idle', 'run', 'jump') }, { name: 'cov_ss' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(1) // staticString is one word — the index, not the bytes
    expect(roundTrip(C, { state: 'idle' })).toEqual({ state: 'idle' }) // index 0 boundary
    expect(roundTrip(C, { state: 'run' })).toEqual({ state: 'run' }) // index 1
    expect(roundTrip(C, { state: 'jump' })).toEqual({ state: 'jump' }) // index 2

    // The stored word really is the choice INDEX, not the encoded bytes.
    const out = new Uint32Array(1)
    codec.encode({ state: 'jump' }, out, 0)
    expect(out[0]).toBe(2)
  })

  test('vec packs len contiguous slots per element (stride = per-elem words)', () => {
    const C = defineComponent({ v: vec('f32', 3) }, { name: 'cov_vec3' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(3) // 3 * 1 word per f32
    expect(roundTrip(C, { v: [1, 2, 3] })).toEqual({ v: [1, 2, 3] })

    const out = new Uint32Array(3)
    codec.encode({ v: [1, 2, 3] }, out, 0)
    const f32 = new Float32Array(out.buffer)
    expect([...f32]).toEqual([1, 2, 3]) // contiguous, in declared order
  })

  test('vec of f64 strides TWO words per element (per.words propagates into the vec)', () => {
    const C = defineComponent({ v: vec('f64', 2) }, { name: 'cov_vecf64' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(4) // 2 elements * 2 words each — proves the per-elem stride is honored
    expect(roundTrip(C, { v: [0.1 + 0.2, 9007199254740991] })).toEqual({ v: [0.1 + 0.2, 9007199254740991] })
  })

  test('a multi-field component encodes fields in declaration order at the right cursor offsets', () => {
    const C = defineComponent(
      { a: 'i32', d: 'f64', v: vec('f32', 2) },
      { name: 'cov_multi' },
    ) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(1 + 2 + 2) // i32(1) + f64(2) + vec2(2)
    expect(roundTrip(C, { a: -5, d: 1.25, v: [7, 8] })).toEqual({ a: -5, d: 1.25, v: [7, 8] })
  })

  test('encode falls back to each field default when init omits it', () => {
    const C = defineComponent({ a: 'i32', b: 'f32' }, { name: 'cov_default' }) as ComponentDef<Schema>
    // Both omitted → both default to 0 (defaultFor returns d.default ?? 0).
    expect(roundTrip(C, {})).toEqual({ a: 0, b: 0 })
    // Mixed: only `a` provided, `b` defaults.
    expect(roundTrip(C, { a: 42 })).toEqual({ a: 42, b: 0 })
  })

  test('a tag (no fields) is a zero-word codec', () => {
    const C = defineComponent({}, { name: 'cov_tag' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    expect(codec.totalWords).toBe(0)
    expect(codec.fields.length).toBe(0)
    expect(codec.encode({}, new Uint32Array(0), 0)).toBe(0)
    expect(codec.decode(new Uint32Array(0), 0)).toEqual({})
  })

  test('encode writes at a non-zero offset and decode reads from the same offset', () => {
    const C = defineComponent({ a: 'i32', b: 'f32' }, { name: 'cov_offset' }) as ComponentDef<Schema>
    const codec = buildFieldCodec(C)
    const out = new Uint32Array(codec.totalWords + 4)
    out.fill(0xdeadbeef)
    const written = codec.encode({ a: -3, b: 2.5 }, out, 2)
    expect(written).toBe(codec.totalWords)
    expect(codec.decode(out, 2)).toEqual({ a: -3, b: 2.5 })
    expect(out[0]).toBe(0xdeadbeef) // untouched word before the offset
  })
})
