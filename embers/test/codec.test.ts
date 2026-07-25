import { describe, expect, it } from 'vitest'
import { decodeSession, encodeSession } from '../src/game/codec.js'
import type { RecEvent } from '../src/game/codec.js'
import { attractProgram } from '../src/game/scripts.js'

describe('session codec', () => {
  it('roundtrips a mixed event stream', async () => {
    const events: RecEvent[] = [
      { tick: 0, elem: 2, x: 100, y: 50, r: 7, stroke: true },
      { tick: 1, elem: 2, x: 104, y: 55, r: 7, stroke: false },
      { tick: 1, elem: 2, x: 110, y: 61, r: 7, stroke: false },
      { tick: 30, elem: 9, x: 600, y: 320, r: 24, stroke: true }, // big jump + elem change
      { tick: 31, elem: 9, x: 473, y: 100, r: 24, stroke: false }, // >127 delta forces full-xy
      { tick: 500, elem: 0, x: 10, y: 10, r: 3, stroke: true },
    ]
    const rec = { seed: 0xdeadbeef, finalTick: 600, finalHash: 0x12345678, events }
    const decoded = await decodeSession(await encodeSession(rec))
    expect(decoded).not.toBeNull()
    expect(decoded!.seed).toBe(rec.seed)
    expect(decoded!.finalTick).toBe(rec.finalTick)
    expect(decoded!.finalHash).toBe(rec.finalHash)
    expect(decoded!.events).toEqual(events)
  })

  it('roundtrips a whole scripted program compactly', async () => {
    const prog = attractProgram()
    const rec = { seed: 7, finalTick: prog.ticks, finalHash: 1, events: prog.events }
    const payload = await encodeSession(rec)
    expect(payload.length).toBeLessThan(8 * 1024)
    const decoded = await decodeSession(payload)
    expect(decoded!.events).toEqual(prog.events)
  })

  it('rejects garbage and truncated payloads', async () => {
    expect(await decodeSession('!!!not-base64url!!!')).toBeNull()
    expect(await decodeSession('AAAA')).toBeNull()
    const good = await encodeSession({ seed: 1, finalTick: 10, finalHash: 2, events: [] })
    expect(await decodeSession(good.slice(0, Math.max(1, good.length - 6)))).toBeNull()
  })
})
