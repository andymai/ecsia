// Field-word codec for OP_ADD / OP_SET_PAYLOAD / OP_ADD_PAIR payloads (command-buffer.md §4.3, §4.4).
// Each component/relation field contributes `stride` u32 words to a record's payload tail; f64
// contributes two words (low, high). The codec is derived ONCE per component from its FieldDescriptor
// list (declaration order). Encode widens a JS value to its u32 slot bit-pattern; decode narrows back.
// Object<T> fields are NOT encodable (restrictedToMainThread, §4.3) — a component carrying one is
// worker-ineligible upstream, so this path never sees it.

import type { ComponentDef, FieldDescriptor, Schema } from '@ecsia/schema'

// Shared scratch for f32-bit aliasing and f64 two-word split (host-native, consistent within a
// process; the buffer is transferred not re-serialized in the fallback, so byte order is preserved).
const scratch = new ArrayBuffer(8)
const scratchF32 = new Float32Array(scratch)
const scratchF64 = new Float64Array(scratch)
const scratchU32 = new Uint32Array(scratch)
const scratchI32 = new Int32Array(scratch)

interface FieldCodec {
  readonly name: string
  /** Words this field occupies (1, or 2 for f64; `len`/`2*len` for vec). */
  readonly words: number
  /** Encode the JS value into `out[at..at+words)`. */
  readonly encode: (value: unknown, out: Uint32Array, at: number) => void
  /** Decode `words[at..at+words)` back to the JS value the accessor write-view expects. */
  readonly decode: (words: Uint32Array, at: number) => unknown
}

export interface ComponentFieldCodec {
  /** Total payload words for the component (sum of field words; 0 for a tag). */
  readonly totalWords: number
  readonly fields: readonly FieldCodec[]
  /** Encode an `init` object → field words written at `out[at..]`; returns words written. */
  encode(init: Record<string, unknown> | undefined, out: Uint32Array, at: number): number
  /** Decode `words[at..]` → a `{ field: value }` object for the accessor write-view. */
  decode(words: Uint32Array, at: number): Record<string, unknown>
}

function scalarCodec(token: string, d: FieldDescriptor): FieldCodec {
  if (token === 'f32') {
    return {
      name: d.name,
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
      name: d.name,
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
  // Integer / bool / eid / staticString: one word, the encoded slot value. Round-trip through the
  // descriptor's own encode/decode so the apply path stores exactly what a main-thread setter would.
  return {
    name: d.name,
    words: 1,
    encode: (v, out, at) => {
      out[at] = (d.encode(v) as number) >>> 0
    },
    decode: (w, at) => {
      // i32-class slots must round-trip through a signed reinterpret before the descriptor decode.
      scratchU32[0] = w[at]!
      return d.decode(scratchI32[0]!)
    },
  }
}

function fieldCodec(d: FieldDescriptor): FieldCodec {
  const token = d.token
  if (typeof token === 'string') return scalarCodec(token, d)
  const kind = (token as { kind?: string }).kind
  if (kind === 'vec') {
    const elem = (token as { elem: string }).elem
    const len = (token as { len: number }).len
    const per = scalarCodec(elem, { ...d, stride: 1 } as FieldDescriptor)
    const words = per.words * len
    return {
      name: d.name,
      words,
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
    return scalarCodec('u32', d)
  }
  throw new Error(`command-buffer: field '${d.name}' (object token) is not encodable in a command buffer`)
}

export function buildFieldCodec(def: ComponentDef<Schema>): ComponentFieldCodec {
  const fields = (def.fields as readonly FieldDescriptor[]).filter((f) => f.shareable).map(fieldCodec)
  let totalWords = 0
  for (const f of fields) totalWords += f.words
  return {
    totalWords,
    fields,
    encode(init, out, at) {
      let cursor = at
      for (const f of fields) {
        const value = init?.[f.name] ?? defaultFor(def, f.name)
        f.encode(value, out, cursor)
        cursor += f.words
      }
      return cursor - at
    },
    decode(words, at) {
      const obj: Record<string, unknown> = {}
      let cursor = at
      for (const f of fields) {
        obj[f.name] = f.decode(words, cursor)
        cursor += f.words
      }
      return obj
    },
  }
}

function defaultFor(def: ComponentDef<Schema>, fieldName: string): unknown {
  const d = (def.fields as readonly FieldDescriptor[]).find((f) => f.name === fieldName)
  return d?.default ?? 0
}
