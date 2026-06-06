// u16-framed strings must reject oversized input loudly: the old `& 0xffff` mask silently
// truncated the length word while writing every byte, leaving the overflow in the stream to be
// misparsed by the next read — one oversized pair-payload string poisoned the whole image.

import { describe, expect, test } from 'vitest'
import { WriteCursor, ReadCursor } from '../src/cursor.js'
import { writeString, readString } from '../src/format.js'

describe('writeString u16 framing', () => {
  test('a string over 65535 utf-8 bytes throws instead of corrupting the stream', () => {
    const cur = new WriteCursor(128)
    expect(() => writeString(cur, 'x'.repeat(70_000))).toThrow(/u16 wire limit/)
  })

  test('a string at the limit round-trips', () => {
    const cur = new WriteCursor(128)
    const s = 'x'.repeat(0xffff)
    writeString(cur, s)
    expect(readString(new ReadCursor(cur.bytesView()))).toBe(s)
  })
})
