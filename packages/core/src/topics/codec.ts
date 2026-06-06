// Topic payload ↔ u32 field-word codec. An event encodes to fixed-width field words by the exact
// rules of the command-buffer field encoding (f64 two-word low/high, f32 stored as its bit-pattern,
// eid as the full handle word, vec as N consecutive slots, every sub-word integer widened to one
// word) so the worker-side OP_PUBLISH payload and the main-thread `publish()` staging produce
// byte-identical rows — the precondition for the byte-identical canonical stream.

import type { FieldDescriptor } from '@ecsia/schema'

// Shared scratch for f32-bit aliasing and the f64 two-word split (host-native byte order,
// consistent within a process; buffers are shared/transferred, never re-serialized).
const scratch = new ArrayBuffer(8)
const scratchF32 = new Float32Array(scratch)
const scratchF64 = new Float64Array(scratch)
const scratchU32 = new Uint32Array(scratch)
const scratchI32 = new Int32Array(scratch)

export interface TopicFieldCodec {
  readonly name: string
  /** Words this field occupies in a row. */
  readonly words: number
  /** Word offset of this field within the row's payload section. */
  readonly offset: number
  readonly encode: (value: unknown, out: { [i: number]: number }, at: number) => void
  readonly decode: (words: ArrayLike<number>, at: number) => unknown
}

export interface TopicCodec {
  /** Total payload words per event row (sum of field words; 0 for a payload-less topic). */
  readonly fieldWords: number
  readonly fields: readonly TopicFieldCodec[]
  /** Encode an init object into `out[at..at+fieldWords)`; missing fields take schema defaults. */
  encode(init: Record<string, unknown> | undefined, out: { [i: number]: number }, at: number): void
}

type ScalarParts = Pick<TopicFieldCodec, 'words' | 'encode' | 'decode'>

function scalarParts(token: string, d: FieldDescriptor): ScalarParts {
  if (token === 'f32') {
    return {
      words: 1,
      encode: (v, out, at) => {
        scratchF32[0] = +(v as number)
        out[at] = scratchU32[0]!
      },
      decode: (w, at) => {
        scratchU32[0] = w[at]!
        return scratchF32[0]
      },
    }
  }
  if (token === 'f64') {
    return {
      words: 2,
      encode: (v, out, at) => {
        scratchF64[0] = +(v as number)
        out[at] = scratchU32[0]!
        out[at + 1] = scratchU32[1]!
      },
      decode: (w, at) => {
        scratchU32[0] = w[at]!
        scratchU32[1] = w[at + 1]!
        return scratchF64[0]
      },
    }
  }
  // Integer / bool / eid / staticString: one word, round-tripped through the descriptor's own
  // encode/decode so values read back exactly as a component column read would present them.
  return {
    words: 1,
    encode: (v, out, at) => {
      out[at] = (d.encode(v) as number) >>> 0
    },
    decode: (w, at) => {
      // i32-class slots round-trip through a signed reinterpret before the descriptor decode.
      scratchU32[0] = w[at]!
      return d.decode(scratchI32[0]!)
    },
  }
}

function fieldCodec(d: FieldDescriptor, offset: number): TopicFieldCodec {
  const token = d.token
  if (typeof token === 'string') {
    return { name: d.name, offset, ...scalarParts(token, d) }
  }
  const kind = (token as { kind?: string }).kind
  if (kind === 'vec') {
    const elem = (token as { elem: string }).elem
    const len = (token as { len: number }).len
    const per = scalarParts(elem, d)
    return {
      name: d.name,
      offset,
      words: per.words * len,
      encode: (v, out, at) => {
        const arr = v as ArrayLike<number>
        for (let i = 0; i < len; i++) per.encode(arr[i], out, at + i * per.words)
      },
      decode: (w, at) => {
        const arr: number[] = []
        for (let i = 0; i < len; i++) arr.push(per.decode(w, at + i * per.words) as number)
        return arr
      },
    }
  }
  if (kind === 'staticString') {
    // Any non-f32/non-f64 token takes scalarParts' descriptor fallback (one word via d.encode /
    // d.decode — the choice-index mapping); 'u32' only signals "one unsigned word" to the reader.
    return { name: d.name, offset, ...scalarParts('u32', d) }
  }
  // Unreachable for a def produced by defineTopic (object/'string' rejected there).
  throw new Error(`topics: field '${d.name}' is not encodable in a topic ring`)
}

export function buildTopicCodec(fields: readonly FieldDescriptor[]): TopicCodec {
  const codecs: TopicFieldCodec[] = []
  let offset = 0
  for (const d of fields) {
    const c = fieldCodec(d, offset)
    codecs.push(c)
    offset += c.words
  }
  const defaults = new Map<string, unknown>()
  for (const d of fields) defaults.set(d.name, d.default)
  return {
    fieldWords: offset,
    fields: codecs,
    encode(init, out, at) {
      for (const f of codecs) {
        const value = init?.[f.name] ?? defaults.get(f.name)
        f.encode(value, out, at + f.offset)
      }
    },
  }
}
