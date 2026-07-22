// PROPERTY: the *Copy()-boundary compression is lossless and bounded. These fail if the bundled
// zero-run codec or the envelope regresses — decompress∘compress must be the identity over ARBITRARY
// bytes (not just zero-heavy ones), and the envelope must never expand the payload beyond a fixed
// header (the STORED fallback guarantees this).

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { zeroRunCompressor, compressImage, decompressImage, isCompressed, COMPRESSION_HEADER_BYTES } from '../src/index.js'

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i])

describe('compression — property: lossless + bounded', () => {
  it('zeroRunCompressor.decompress ∘ compress is the identity over arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (arr) => {
        const back = zeroRunCompressor.decompress(zeroRunCompressor.compress(arr), arr.byteLength)
        return equalBytes(back, arr)
      }),
    )
  })

  it('the envelope round-trips and never expands beyond raw + header', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (arr) => {
        const wrapped = compressImage(arr, zeroRunCompressor)
        expect(isCompressed(wrapped)).toBe(true)
        expect(wrapped.byteLength).toBeLessThanOrEqual(arr.byteLength + COMPRESSION_HEADER_BYTES)
        return equalBytes(decompressImage(wrapped), arr)
      }),
    )
  })

  it('a raw (non-enveloped) buffer that happens NOT to start with the magic passes through untouched', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (arr) => {
        // isCompressed only reports true for our magic; anything else is returned by reference.
        if (isCompressed(arr)) return true // skip the astronomically-unlikely magic collision
        return decompressImage(arr) === arr
      }),
    )
  })
})
