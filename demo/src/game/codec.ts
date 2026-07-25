// The replay-URL codec. A whole multi-life run is (seed, overdrive, the per-life input streams,
// outcome numbers, final state hash) — because the sim is deterministic and all progression is
// positional, nothing else exists to encode. Wire shape: binary layout below → deflate-raw
// (native CompressionStream) → base64url in the location hash. Streams RLE-compress first (held
// keys make runs long), so even a full 8-life run lands around a few hundred bytes.
//
// Layout (little-endian):
//   'E','1'            magic + version
//   u32 seed
//   u8  overdrive      (1, 2 or 4)
//   u8  outcome        (0 died-out, 1 survived, 2 boss-down-and-survived)
//   u8  lifeCount
//   per life: u32 rleByteLength, then RLE pairs [dir u8, run u16]
//   u32 finalHash      (state hash at the recorded end — the replay verifier's target)
//   u32 finalTick
//   u32 kills

import { LOOP_TICKS, MAX_LIVES } from '../sim/shared.js'

export interface RunRecord {
  seed: number
  overdrive: number
  outcome: number
  streams: Uint8Array[]
  finalHash: number
  finalTick: number
  kills: number
}

// Decode-side allocation caps. The payload is attacker-controlled (anyone can craft a #r= URL), so
// every size that drives an allocation is bounded BEFORE the allocation: a legit run tops out
// around 130 KB uncompressed (8 lives × 5400 ticks × 3 RLE bytes) and ~200 bytes deflated.
const MAX_DEFLATED = 64 * 1024
const MAX_INFLATED = 512 * 1024

function rleEncode(dirs: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < dirs.length) {
    const d = dirs[i]!
    let run = 1
    while (i + run < dirs.length && dirs[i + run] === d && run < 0xffff) run++
    out.push(d, run & 0xff, (run >> 8) & 0xff)
    i += run
  }
  return Uint8Array.from(out)
}

function rleDecode(bytes: Uint8Array, maxTotal: number): Uint8Array | null {
  let total = 0
  for (let i = 0; i + 3 <= bytes.length; i += 3) {
    total += bytes[i + 1]! | (bytes[i + 2]! << 8)
    if (total > maxTotal) return null
  }
  const out = new Uint8Array(total)
  let at = 0
  for (let i = 0; i + 3 <= bytes.length; i += 3) {
    const d = bytes[i]!
    const run = bytes[i + 1]! | (bytes[i + 2]! << 8)
    out.fill(d, at, at + run)
    at += run
  }
  return out
}

async function pipeThrough(
  bytes: Uint8Array,
  stream: { readable: ReadableStream; writable: WritableStream },
  maxBytes: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  // Fire-and-forget (awaiting before the read loop can deadlock on backpressure), but swallow the
  // rejections: on malformed input the transform errors, the read side throws for the caller, and
  // these writer promises reject too — unhandled, they'd surface as spurious global errors.
  void writer.write(bytes.slice()).catch(() => {})
  void writer.close().catch(() => {})
  const chunks: Uint8Array[] = []
  const reader = stream.readable.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += (value as Uint8Array).length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('payload exceeds size cap')
    }
    chunks.push(value as Uint8Array)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function encodeRun(rec: RunRecord): Promise<string> {
  const rles = rec.streams.map(rleEncode)
  let size = 2 + 4 + 1 + 1 + 1 + 12
  for (const r of rles) size += 4 + r.length
  const buf = new Uint8Array(size)
  const dv = new DataView(buf.buffer)
  let at = 0
  buf[at++] = 0x45 // 'E'
  buf[at++] = 0x31 // '1'
  dv.setUint32(at, rec.seed >>> 0, true)
  at += 4
  buf[at++] = rec.overdrive
  buf[at++] = rec.outcome
  buf[at++] = rec.streams.length
  for (const r of rles) {
    dv.setUint32(at, r.length, true)
    at += 4
    buf.set(r, at)
    at += r.length
  }
  dv.setUint32(at, rec.finalHash >>> 0, true)
  at += 4
  dv.setUint32(at, rec.finalTick >>> 0, true)
  at += 4
  dv.setUint32(at, rec.kills >>> 0, true)
  at += 4
  const deflated = await pipeThrough(buf, new CompressionStream('deflate-raw'), MAX_DEFLATED)
  return toBase64Url(deflated)
}

export async function decodeRun(payload: string): Promise<RunRecord | null> {
  try {
    if (payload.length > (MAX_DEFLATED * 4) / 3 + 4) return null
    const deflated = fromBase64Url(payload)
    const buf = await pipeThrough(deflated, new DecompressionStream('deflate-raw'), MAX_INFLATED)
    if (buf.length < 21 || buf[0] !== 0x45 || buf[1] !== 0x31) return null
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let at = 2
    const seed = dv.getUint32(at, true)
    at += 4
    const overdrive = buf[at++]!
    const outcome = buf[at++]!
    const lifeCount = buf[at++]!
    if (lifeCount > MAX_LIVES) return null
    const streams: Uint8Array[] = []
    for (let l = 0; l < lifeCount; l++) {
      const len = dv.getUint32(at, true)
      at += 4
      const decoded = rleDecode(buf.subarray(at, at + len), LOOP_TICKS)
      if (decoded === null) return null
      streams.push(decoded)
      at += len
    }
    const finalHash = dv.getUint32(at, true)
    at += 4
    const finalTick = dv.getUint32(at, true)
    at += 4
    const kills = dv.getUint32(at, true)
    return { seed, overdrive, outcome, streams, finalHash, finalTick, kills }
  } catch {
    return null
  }
}
