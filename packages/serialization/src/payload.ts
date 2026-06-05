// Self-describing relation-pair payload codec. A payload is a list of
// named field values, each value read back from getPair().read() already DECODED. We tag each field
// (0 = f64 numeric, 1 = string, 2 = bool) so the wire round-trips every scalar losslessly without the
// receiver needing the producer's column layout — the receiver writes the named fields back through
// addPair's payload, which re-encodes via its own (code-on-both-sides) relation schema.

import type { WriteCursor, ReadCursor } from './cursor.js'
import { readString, writeString } from './format.js'

export function writePairPayload(cur: WriteCursor, payload: Record<string, unknown> | undefined): void {
  if (payload === undefined) {
    cur.u16(0)
    return
  }
  const keys = Object.keys(payload).sort()
  cur.u16(keys.length)
  for (const k of keys) {
    writeString(cur, k)
    const value = payload[k]
    if (typeof value === 'string') {
      cur.u8(1)
      writeString(cur, value)
    } else if (typeof value === 'boolean') {
      cur.u8(2)
      cur.u8(value ? 1 : 0)
    } else {
      cur.u8(0)
      const tmp = new Float64Array(1)
      tmp[0] = typeof value === 'number' ? value : Number(value)
      cur.copyBytes(tmp)
    }
  }
}

export function readPairPayload(cur: ReadCursor): Record<string, unknown> | undefined {
  const count = cur.u16()
  if (count === 0) return undefined
  const out: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const name = readString(cur)
    const tag = cur.u8()
    if (tag === 1) {
      out[name] = readString(cur)
    } else if (tag === 2) {
      out[name] = cur.u8() !== 0
    } else {
      const bytes = cur.takeBytes(8)
      out[name] = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true)
    }
  }
  return out
}
