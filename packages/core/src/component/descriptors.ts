// Field-token → FieldDescriptor resolution (component-schema.md §3). The value-level bodies for
// the type-system.md §1.4 table: ctor, bytesPerElem, stride, shareable, encode/decode, choices,
// default, needsExplicitInit. eid encode/decode forward to the normative memory-buffers helpers.

import type {
  FieldDescriptor,
  FieldToken,
  ScalarToken,
  StaticStringToken,
  TypedArrayCtor,
  VecToken,
} from '@ecsia/schema'
import { encodeEid, decodeEid, EID_NULL } from '../memory/index.js'

interface ScalarRow {
  readonly ctor: TypedArrayCtor
  readonly bytes: number
  readonly encode: (v: unknown) => number
  readonly decode: (slot: number) => unknown
  readonly default: unknown
}

const SCALAR_ROWS: Record<ScalarToken, ScalarRow> = {
  bool: { ctor: Uint8Array, bytes: 1, encode: (v) => (v ? 1 : 0), decode: (s) => s !== 0, default: false },
  i8: { ctor: Int8Array, bytes: 1, encode: (v) => (v as number) | 0, decode: (s) => s, default: 0 },
  u8: { ctor: Uint8Array, bytes: 1, encode: (v) => (v as number) & 0xff, decode: (s) => s, default: 0 },
  u8c: { ctor: Uint8ClampedArray, bytes: 1, encode: (v) => v as number, decode: (s) => s, default: 0 },
  i16: { ctor: Int16Array, bytes: 2, encode: (v) => (v as number) | 0, decode: (s) => s, default: 0 },
  u16: { ctor: Uint16Array, bytes: 2, encode: (v) => (v as number) & 0xffff, decode: (s) => s, default: 0 },
  i32: { ctor: Int32Array, bytes: 4, encode: (v) => (v as number) | 0, decode: (s) => s, default: 0 },
  u32: { ctor: Uint32Array, bytes: 4, encode: (v) => (v as number) >>> 0, decode: (s) => s >>> 0, default: 0 },
  f32: { ctor: Float32Array, bytes: 4, encode: (v) => +(v as number), decode: (s) => s, default: 0 },
  f64: { ctor: Float64Array, bytes: 8, encode: (v) => +(v as number), decode: (s) => s, default: 0 },
  eid: {
    ctor: Int32Array,
    bytes: 4,
    encode: (v) => encodeEid(v as number),
    decode: (s) => decodeEid(s),
    default: EID_NULL,
  },
}

function scalarRow(token: ScalarToken): ScalarRow {
  const row = SCALAR_ROWS[token]
  if (row === undefined) throw new Error(`unknown scalar token: ${String(token)}`)
  return row
}

function stringIndexCtor(n: number): TypedArrayCtor {
  if (n <= 256) return Uint8Array
  if (n <= 65_536) return Uint16Array
  return Uint32Array
}

function isVecToken(t: FieldToken): t is VecToken<ScalarToken, number> {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'vec'
}
function isStaticStringToken(t: FieldToken): t is StaticStringToken<readonly string[]> {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'staticString'
}
function isObjectToken(t: FieldToken): boolean {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'object'
}

function isZeroEquivalentDefault(d: unknown): boolean {
  return d === 0 || d === false
}

export function resolveDescriptor(name: string, token: FieldToken, userDefault?: unknown): FieldDescriptor {
  // The free-form 'string' rich token MUST be matched before the scalar dispatch below (it is a
  // `typeof === 'string'` value that scalarRow would reject as an unknown scalar token, rich-fields.md
  // §3). Sidecar-backed: no column (ctor null), not shareable, identity encode/decode never invoked.
  if (token === 'string') {
    return {
      name,
      token,
      ctor: null,
      bytesPerElem: 0,
      stride: 0,
      shareable: false,
      rich: 'string',
      encode: (v) => v as unknown as number,
      decode: (s) => s as unknown,
      default: userDefault ?? '',
      needsExplicitInit: false,
    }
  }

  if (typeof token === 'string') {
    const row = scalarRow(token)
    const def = userDefault ?? row.default
    // eid is always non-zero-equivalent (its null is -1); other scalars only when user-overridden.
    const needsExplicitInit = token === 'eid' ? true : userDefault !== undefined && !isZeroEquivalentDefault(def)
    return {
      name,
      token,
      ctor: row.ctor,
      bytesPerElem: row.bytes,
      stride: 1,
      shareable: true,
      encode: row.encode,
      decode: row.decode,
      default: def,
      needsExplicitInit,
    }
  }

  if (isVecToken(token)) {
    const row = scalarRow(token.elem)
    const def = userDefault ?? (Array(token.len).fill(row.default) as unknown[])
    const needsExplicitInit =
      userDefault !== undefined && (def as unknown[]).some((axis) => !isZeroEquivalentDefault(axis))
    return {
      name,
      token,
      ctor: row.ctor,
      bytesPerElem: row.bytes,
      stride: token.len,
      shareable: true,
      encode: row.encode,
      decode: row.decode,
      default: def,
      needsExplicitInit,
    }
  }

  if (isStaticStringToken(token)) {
    const choices = token.choices
    const ctor = stringIndexCtor(choices.length)
    const idxOf = new Map<string, number>()
    choices.forEach((c, i) => idxOf.set(c, i))
    const defaultIndex = userDefault !== undefined ? (idxOf.get(userDefault as string) ?? 0) : 0
    return {
      name,
      token,
      ctor,
      bytesPerElem: ctor.BYTES_PER_ELEMENT,
      stride: 1,
      shareable: true,
      encode: (v) => {
        const idx = idxOf.get(v as string)
        if (idx === undefined) throw new Error(`staticString value '${String(v)}' not in choices for field '${name}'`)
        return idx
      },
      decode: (slot) => choices[slot],
      choices,
      default: defaultIndex,
      // The stored slot 0 is choices[0]; only non-zero indices need an explicit fill.
      needsExplicitInit: defaultIndex !== 0,
    }
  }

  // object token (§3.8): no column, not shareable.
  if (isObjectToken(token)) {
    return {
      name,
      token,
      ctor: null,
      bytesPerElem: 0,
      stride: 0,
      shareable: false,
      rich: 'object',
      encode: (v) => v as unknown as number,
      decode: (s) => s as unknown,
      default: userDefault,
      needsExplicitInit: false,
    }
  }

  throw new Error(`unknown field token for field '${name}'`)
}
