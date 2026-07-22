// Optional *Copy()-boundary compression: the bundled zero-run Compressor, the envelope
// (magic / stored-fallback / rawByteLength), transparent pass-through of raw images, and the
// end-to-end snapshot / delta / replication integration where a producer compresses and the receiver
// auto-decodes with no configuration.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createReplicationStream,
  createReplicationReceiver,
  zeroRunCompressor,
  compressImage,
  decompressImage,
  isCompressed,
  COMPRESSION_HEADER_BYTES,
  STORED_COMPRESSOR_ID,
} from '../src/index.js'
import type { Compressor } from '../src/index.js'

const bytesOf = (u: Uint8Array) => Buffer.from(u)

describe('zeroRunCompressor — lossless over every byte shape', () => {
  const cases: Record<string, Uint8Array> = {
    empty: new Uint8Array(0),
    allZero: new Uint8Array(64),
    allLiteral: Uint8Array.from({ length: 64 }, (_, i) => (i % 255) + 1),
    leadingZeros: Uint8Array.from([0, 0, 0, 0, 5, 6, 7]),
    trailingZeros: Uint8Array.from([5, 6, 7, 0, 0, 0, 0]),
    alternating: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]),
    mixedRuns: Uint8Array.from([0, 0, 9, 9, 9, 0, 0, 0, 0, 1, 0, 0]),
  }
  for (const [name, input] of Object.entries(cases)) {
    it(`round-trips '${name}'`, () => {
      const compressed = zeroRunCompressor.compress(input)
      const back = zeroRunCompressor.decompress(compressed, input.byteLength)
      expect(bytesOf(back)).toEqual(bytesOf(input))
    })
  }

  it('a long zero run compresses far below the raw size', () => {
    const input = new Uint8Array(10_000) // all zero
    const compressed = zeroRunCompressor.compress(input)
    expect(compressed.byteLength).toBeLessThan(16)
  })
})

describe('compressImage / decompressImage envelope', () => {
  it('a compressible image is wrapped (magic set) and decodes back exactly', () => {
    const raw = new Uint8Array(4096) // zero-heavy → compresses well
    raw[0] = 1
    raw[4095] = 2
    const wrapped = compressImage(raw, zeroRunCompressor)
    expect(isCompressed(wrapped)).toBe(true)
    expect(wrapped.byteLength).toBeLessThan(raw.byteLength)
    expect(bytesOf(decompressImage(wrapped))).toEqual(bytesOf(raw))
  })

  it('an INCOMPRESSIBLE image falls back to STORED and never exceeds raw + header', () => {
    // A pattern the zero-run scheme expands (no zeros, alternating literal boundaries).
    const raw = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 === 0 ? 1 : 2))
    const wrapped = compressImage(raw, zeroRunCompressor)
    expect(isCompressed(wrapped)).toBe(true)
    // STORED path: id 0, payload is the raw image verbatim.
    expect(wrapped[4]).toBe(STORED_COMPRESSOR_ID)
    expect(wrapped.byteLength).toBe(raw.byteLength + COMPRESSION_HEADER_BYTES)
    expect(bytesOf(decompressImage(wrapped))).toEqual(bytesOf(raw))
  })

  it('a RAW (non-enveloped) image passes through decompressImage unchanged', () => {
    const raw = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4])
    expect(isCompressed(raw)).toBe(false)
    expect(decompressImage(raw)).toBe(raw) // same reference — zero overhead on the existing path
  })

  it('rejects a reserved/invalid Compressor.id', () => {
    const bad: Compressor = { id: 0, compress: (x) => x, decompress: (x) => x }
    expect(() => compressImage(new Uint8Array(4), bad)).toThrow(/id must be an integer in 1\.\.255/)
    const tooBig: Compressor = { id: 256, compress: (x) => x, decompress: (x) => x }
    expect(() => compressImage(new Uint8Array(4), tooBig)).toThrow(/1\.\.255/)
  })

  it('a corrupt declared length is caught (does not silently mis-decode)', () => {
    const raw = new Uint8Array(512)
    raw[0] = 7
    const wrapped = compressImage(raw, zeroRunCompressor)
    // Corrupt the declared rawByteLength word (offset 8).
    const tampered = wrapped.slice()
    new DataView(tampered.buffer).setUint32(8, 999999, true)
    expect(() => decompressImage(tampered)).toThrow(/expected 999999|corrupt/)
  })

  it('an unregistered custom compressor id throws a clear, actionable error', () => {
    // A custom compressor that genuinely shrinks a zero-padded input (strip trailing zeros).
    const stripTrailingZeros: Compressor = {
      id: 77,
      compress(image) {
        let end = image.byteLength
        while (end > 0 && image[end - 1] === 0) end--
        return image.subarray(0, end)
      },
      decompress(payload, rawByteLength) {
        const out = new Uint8Array(rawByteLength)
        out.set(payload)
        return out
      },
    }
    const raw = Uint8Array.from([1, 2, 3, 0, 0, 0, 0, 0])
    const wrapped = compressImage(raw, stripTrailingZeros)
    expect(wrapped[4]).toBe(77) // used the custom id (it shrank)
    expect(() => decompressImage(wrapped)).toThrow(/no Compressor registered for id 77/)
    expect(bytesOf(decompressImage(wrapped, { compressors: [stripTrailingZeros] }))).toEqual(bytesOf(raw))
  })

  it('rejects a declared decompressed size above the cap BEFORE allocating (bomb guard)', () => {
    // A hostile envelope: tiny payload, but the rawByteLength word claims a huge size.
    const raw = new Uint8Array(4096)
    raw[0] = 1
    const wrapped = compressImage(raw, zeroRunCompressor)
    const bomb = wrapped.slice()
    new DataView(bomb.buffer).setUint32(8, 0xffffffff, true) // claim ~4 GiB decompressed
    expect(() => decompressImage(bomb)).toThrow(/above the .* cap — refusing to allocate/)
    // An explicit low cap rejects even a modest legitimate declaration.
    expect(() => decompressImage(wrapped, { maxBytes: 8 })).toThrow(/refusing to allocate/)
    // Raising the cap lets a legitimate image through.
    expect(bytesOf(decompressImage(wrapped, { maxBytes: 1 << 20 }))).toEqual(bytesOf(raw))
  })
})

// Fresh but structurally-identical defs → equal schemaHash on producer and receiver (the same
// convention the replication suite relies on for cross-world apply).
function makeDefs() {
  return {
    Position: defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' }),
    Velocity: defineComponent({ dx: 'f32', dy: 'f32', dz: 'f32' }, { name: 'velocity' }),
  }
}

describe('integration — compressed snapshot decodes with no receiver config and shrinks', () => {
  it('snapshotCopy(compressor) → load() matches the raw round-trip and is smaller', () => {
    const D = makeDefs()
    const src = createWorld({ components: [D.Position, D.Velocity] as readonly ComponentDef<Schema>[] })
    const handles: EntityHandle[] = []
    for (let i = 0; i < 300; i++) {
      const e = src.spawnWith(D.Position, D.Velocity) as EntityHandle
      if (i % 50 === 0) (src.entity(e).write(D.Position) as { x: number }).x = i // i=100 → x=100 (probed below)
      handles.push(e)
    }

    const raw = createSnapshotSerializer(src).snapshotCopy()
    const compressed = createSnapshotSerializer(src, { compressor: zeroRunCompressor }).snapshotCopy()
    expect(isCompressed(raw)).toBe(false)
    expect(isCompressed(compressed)).toBe(true)
    expect(compressed.byteLength).toBeLessThan(raw.byteLength) // zero-heavy SoA compresses

    const Draw = makeDefs()
    const wRaw = createWorld({ components: [Draw.Position, Draw.Velocity] as readonly ComponentDef<Schema>[] })
    const Dcmp = makeDefs()
    const wCmp = createWorld({ components: [Dcmp.Position, Dcmp.Velocity] as readonly ComponentDef<Schema>[] })

    const resRaw = createSnapshotDeserializer(wRaw).load(raw)
    const resCmp = createSnapshotDeserializer(wCmp).load(compressed) // auto-decompress, NO compressors opt
    expect(resCmp.entitiesCreated).toBe(300)
    expect(resCmp.entitiesCreated).toBe(resRaw.entitiesCreated)

    const probe = handles[100] as EntityHandle
    const localRaw = resRaw.remap.get(probe) as EntityHandle
    const localCmp = resCmp.remap.get(probe) as EntityHandle
    expect((wCmp.entity(localCmp).read(Dcmp.Position) as { x: number }).x).toBe(
      (wRaw.entity(localRaw).read(Draw.Position) as { x: number }).x,
    )
  })
})

describe('integration — replication stream with a compressor, receiver auto-decodes', () => {
  it('a compressed broadcast converges on a receiver created with default options', () => {
    const D = makeDefs()
    const server = createWorld({ components: [D.Position, D.Velocity] as readonly ComponentDef<Schema>[] })
    const handles: EntityHandle[] = []
    for (let i = 0; i < 40; i++) handles.push(server.spawnWith(D.Position, D.Velocity) as EntityHandle)
    ;(server.entity(handles[0] as EntityHandle).write(D.Position) as { x: number }).x = 7

    const stream = createReplicationStream(server, { compressor: zeroRunCompressor })
    const Dc = makeDefs()
    const client = createWorld({ components: [Dc.Position, Dc.Velocity] as readonly ComponentDef<Schema>[] })
    const receiver = createReplicationReceiver(client) // no compressors option — bundled auto-decode

    const base = stream.baseline()
    expect(isCompressed(base.bytes)).toBe(true)
    expect(receiver.apply(base).applied).toBe(true)

    const localZero = receiver.remap.get(handles[0] as EntityHandle) as EntityHandle
    expect((client.entity(localZero).read(Dc.Position) as { x: number }).x).toBeCloseTo(7)

    server.advanceTick()
    ;(server.entity(handles[0] as EntityHandle).write(D.Position) as { x: number }).x = 8
    const d = stream.tick()
    expect(isCompressed(d.bytes)).toBe(true) // the envelope is present even when STORED
    expect(receiver.apply(d).applied).toBe(true)
    expect((client.entity(localZero).read(Dc.Position) as { x: number }).x).toBeCloseTo(8)
  })
})
