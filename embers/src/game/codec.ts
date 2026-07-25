// The share-URL codec. A whole session is (seed, the per-tick brush events) — the sim is
// deterministic, so nothing else exists to encode. Wire shape: binary layout below → deflate-raw
// (native CompressionStream) → base64url in the location hash. Stroke continuations delta-encode
// to 4 bytes, so minutes of drawing land in the low kilobytes.
//
// Layout (little-endian):
//   'W','1'          magic + version
//   u32 seed
//   u32 finalTick
//   u32 finalHash    (state hash at finalTick — the replay verifier's target)
//   u32 eventCount
//   per event: varint dTick, u8 flags (bit0 full-xy, bit1 stroke-start),
//              full-xy ? [u8 elem, u8 r, u16 x, u16 y] : [i8 dx, i8 dy]

import { ELEM_COUNT } from '../sim/elements.js'

export interface RecEvent {
  tick: number
  elem: number
  x: number
  y: number
  r: number
  stroke: boolean
}

export interface SessionRecord {
  seed: number
  finalTick: number
  finalHash: number
  events: RecEvent[]
}

// Decode-side allocation caps. The payload is attacker-controlled (anyone can craft a #r= URL), so
// every size that drives an allocation is bounded BEFORE the allocation.
const MAX_DEFLATED = 96 * 1024
const MAX_INFLATED = 2 * 1024 * 1024
const MAX_EVENTS = 250_000
const MAX_TICKS = 60 * 60 * 40 // 40 minutes

async function pipeThrough(
  bytes: Uint8Array,
  stream: { readable: ReadableStream; writable: WritableStream },
  maxBytes: number,
): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter()
  void writer.write(bytes).catch(() => undefined)
  void writer.close().catch(() => undefined)
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as const)
    if (done === true || value === undefined) break
    total += (value as Uint8Array).length
    if (total > maxBytes) return null
    parts.push(value as Uint8Array)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array | null {
  if (s.length > MAX_DEFLATED * 2) return null
  try {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export async function encodeSession(rec: SessionRecord): Promise<string> {
  const buf: number[] = [0x57, 0x31] // 'W','1'
  const u32 = (v: number): void => {
    buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  }
  u32(rec.seed >>> 0)
  u32(rec.finalTick >>> 0)
  u32(rec.finalHash >>> 0)
  u32(rec.events.length >>> 0)
  let lastTick = 0
  let lastX = 0
  let lastY = 0
  let lastElem = -1
  let lastR = -1
  for (const ev of rec.events) {
    let d = ev.tick - lastTick
    lastTick = ev.tick
    for (;;) {
      if (d < 0x80) {
        buf.push(d)
        break
      }
      buf.push((d & 0x7f) | 0x80)
      d >>>= 7
    }
    const dx = ev.x - lastX
    const dy = ev.y - lastY
    const full = ev.stroke || ev.elem !== lastElem || ev.r !== lastR || dx > 127 || dx < -127 || dy > 127 || dy < -127
    buf.push((full ? 1 : 0) | (ev.stroke ? 2 : 0))
    if (full) {
      buf.push(ev.elem & 0xff, ev.r & 0xff, ev.x & 0xff, (ev.x >>> 8) & 0xff, ev.y & 0xff, (ev.y >>> 8) & 0xff)
    } else {
      buf.push(dx & 0xff, dy & 0xff)
    }
    lastX = ev.x
    lastY = ev.y
    lastElem = ev.elem
    lastR = ev.r
  }
  const raw = Uint8Array.from(buf)
  const deflated = await pipeThrough(raw, new CompressionStream('deflate-raw'), MAX_DEFLATED)
  return b64urlEncode(deflated ?? raw)
}

export async function decodeSession(payload: string): Promise<SessionRecord | null> {
  const deflated = b64urlDecode(payload)
  if (deflated === null || deflated.length > MAX_DEFLATED) return null
  const raw = await pipeThrough(deflated, new DecompressionStream('deflate-raw'), MAX_INFLATED)
  if (raw === null || raw.length < 18 || raw[0] !== 0x57 || raw[1] !== 0x31) return null
  let at = 2
  const u32 = (): number => {
    const v = (raw[at]! | (raw[at + 1]! << 8) | (raw[at + 2]! << 16) | (raw[at + 3]! << 24)) >>> 0
    at += 4
    return v
  }
  const seed = u32()
  const finalTick = u32()
  const finalHash = u32()
  const count = u32()
  if (count > MAX_EVENTS || finalTick > MAX_TICKS) return null
  const events: RecEvent[] = []
  let tick = 0
  let x = 0
  let y = 0
  let elem = 0
  let r = 4
  for (let i = 0; i < count; i++) {
    let d = 0
    let shift = 0
    for (;;) {
      if (at >= raw.length) return null
      const b = raw[at++]!
      d |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 28) return null
    }
    tick += d
    if (tick > MAX_TICKS) return null
    if (at >= raw.length) return null
    const flags = raw[at++]!
    const stroke = (flags & 2) !== 0
    if ((flags & 1) !== 0) {
      if (at + 6 > raw.length) return null
      elem = raw[at]!
      r = raw[at + 1]!
      x = raw[at + 2]! | (raw[at + 3]! << 8)
      y = raw[at + 4]! | (raw[at + 5]! << 8)
      at += 6
    } else {
      if (at + 2 > raw.length) return null
      x += (raw[at]! << 24) >> 24
      y += (raw[at + 1]! << 24) >> 24
      at += 2
    }
    // The payload is attacker-controlled; an out-of-range element id would produce undefined
    // table lookups (NaN temps, broken movement) in the sim, so reject anything past the roster.
    if (elem >= ELEM_COUNT || r > 64 || x < 0 || x > 0xffff || y < 0 || y > 0xffff) return null
    events.push({ tick, elem, x, y, r, stroke })
  }
  return { seed, finalTick, finalHash, events }
}
