// Optional compression at the *Copy() boundary. A pluggable Compressor wraps a finished
// snapshot/delta image in a small envelope; the read side (deserialize / applyDelta / the
// replication receiver) auto-detects the envelope and decompresses. RAW (uncompressed) images are
// left byte-identical and pass straight through — compression is strictly opt-in, so nothing on the
// existing wire changes unless a caller passes a `compressor`.
//
// Naming: this is deliberately "Compressor", not "codec" — the latter already means the low-level
// wire codecs in this package (payload codec, the copy codec). This layer sits OUTSIDE those.
//
// Envelope (12-byte header, 4-aligned):
//   u32 COMPRESSION_MAGIC
//   u8  compressorId        (0 = STORED: payload is the raw image, used when compression didn't help)
//   u8  reserved (0)
//   u16 reserved (0)
//   u32 rawByteLength       (the DECOMPRESSED image length — lets decompress preallocate exactly)
//   ... payload ...
//
// Layering with the replication binary envelope: encodeReplicationMessage wraps
// [REPLICATION header][image]; when a compressor is set the image is itself
// [COMPRESSION header][payload]. The nesting is REPLICATION → COMPRESSION → snapshot/delta image,
// each layer independent.

/** A pluggable compression strategy for the snapshot/delta `*Copy()` boundary. */
export interface Compressor {
  /**
   * Wire id 1..255 written into the envelope so the receiver dispatches to the matching
   * decompressor. Id 0 is RESERVED (STORED — no transform); a Compressor MUST NOT use it.
   */
  readonly id: number
  /** Transform a finished image into a smaller payload. MUST be pure and deterministic. */
  compress(image: Uint8Array): Uint8Array
  /** Inverse of {@link compress}. `rawByteLength` is the exact decompressed length. */
  decompress(payload: Uint8Array, rawByteLength: number): Uint8Array
}

export const COMPRESSION_MAGIC = 0x45435a50 // 'ECZP' — distinct from SNAPSHOT_MAGIC / REPLICATION_MAGIC
export const COMPRESSION_HEADER_BYTES = 12
/** The reserved "stored" id: payload is the raw image (compression made it no smaller). */
export const STORED_COMPRESSOR_ID = 0

// A minimal growable byte sink (the shared WriteCursor has no varint and different concerns).
class ByteSink {
  #u8 = new Uint8Array(256)
  #pos = 0
  #ensure(extra: number): void {
    const need = this.#pos + extra
    if (need <= this.#u8.byteLength) return
    let cap = this.#u8.byteLength
    while (cap < need) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.#u8.subarray(0, this.#pos))
    this.#u8 = next
  }
  byte(b: number): void {
    this.#ensure(1)
    this.#u8[this.#pos++] = b & 0xff
  }
  /** LEB128 unsigned varint. Multiplicative (not `<<`) so lengths above 2^31 round-trip. */
  varint(v: number): void {
    while (v >= 0x80) {
      this.byte((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    this.byte(v)
  }
  rawSlice(src: Uint8Array, start: number, end: number): void {
    const n = end - start
    this.#ensure(n)
    this.#u8.set(src.subarray(start, end), this.#pos)
    this.#pos += n
  }
  take(): Uint8Array {
    return this.#u8.subarray(0, this.#pos)
  }
}

function readVarint(src: Uint8Array, at: { p: number }): number {
  let shift = 1
  let result = 0
  let b: number
  do {
    b = src[at.p++] as number
    result += (b & 0x7f) * shift
    shift *= 128
  } while ((b & 0x80) !== 0)
  return result
}

/**
 * The bundled, dependency-free reference compressor (id 1): zero-run + literal-run encoding.
 * SoA columns of sparse/default components are dominated by long zero runs, which this collapses to
 * a varint; arbitrary data is carried in literal runs. Never expands by more than a few varint bytes
 * per block, and {@link compressImage} falls back to STORED if even that loses — so the envelope can
 * never grow the payload beyond the header. Not the best ratio (no entropy coding); the point is a
 * batteries-included default with zero dependencies. Heavier algorithms plug in via {@link Compressor}.
 */
export const zeroRunCompressor: Compressor = {
  id: 1,
  compress(image: Uint8Array): Uint8Array {
    const out = new ByteSink()
    const n = image.byteLength
    let i = 0
    while (i < n) {
      let z = 0
      while (i < n && image[i] === 0) {
        z++
        i++
      }
      const litStart = i
      while (i < n && image[i] !== 0) i++
      out.varint(z)
      out.varint(i - litStart)
      out.rawSlice(image, litStart, i)
    }
    return out.take().slice() // detach from the sink's internal buffer
  },
  decompress(payload: Uint8Array, rawByteLength: number): Uint8Array {
    const out = new Uint8Array(rawByteLength)
    const at = { p: 0 }
    let w = 0
    while (at.p < payload.byteLength) {
      const z = readVarint(payload, at)
      w += z // zeros: the output is already zero-initialised
      const lit = readVarint(payload, at)
      out.set(payload.subarray(at.p, at.p + lit), w)
      at.p += lit
      w += lit
    }
    if (w !== rawByteLength) {
      throw new Error(`serialization: compressed payload decoded to ${w} bytes, expected ${rawByteLength} (corrupt image)`)
    }
    return out
  },
}

/** The compressors this build can decompress without any caller registration. */
export const BUNDLED_COMPRESSORS: readonly Compressor[] = [zeroRunCompressor]

/** True iff `bytes` begins with the compression envelope magic. */
export function isCompressed(bytes: Uint8Array): boolean {
  if (bytes.byteLength < COMPRESSION_HEADER_BYTES) return false
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === COMPRESSION_MAGIC
}

/**
 * Wrap a finished image in the compression envelope. Falls back to STORED (no transform) when the
 * compressor does not shrink the image, so the result never exceeds `image.byteLength + 12`.
 * Returns a fresh detached buffer (this is the *Copy boundary).
 */
export function compressImage(image: Uint8Array, compressor: Compressor): Uint8Array {
  if (compressor.id < 1 || compressor.id > 255 || !Number.isInteger(compressor.id)) {
    throw new Error(`serialization: Compressor.id must be an integer in 1..255 (got ${compressor.id}); 0 is reserved for STORED`)
  }
  const payload = compressor.compress(image)
  const useCompressed = payload.byteLength < image.byteLength
  const id = useCompressed ? compressor.id : STORED_COMPRESSOR_ID
  const body = useCompressed ? payload : image
  const out = new Uint8Array(COMPRESSION_HEADER_BYTES + body.byteLength)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, COMPRESSION_MAGIC, true)
  dv.setUint8(4, id)
  // bytes 5..7 reserved (already 0)
  dv.setUint32(8, image.byteLength, true)
  out.set(body, COMPRESSION_HEADER_BYTES)
  return out
}

/**
 * Inverse of {@link compressImage}. A NON-compressed image (no envelope magic) passes through
 * unchanged — so raw snapshot/delta bytes are handled transparently. `extra` compressors are merged
 * with the bundled set for custom-id lookup.
 */
export function decompressImage(bytes: Uint8Array, extra?: readonly Compressor[]): Uint8Array {
  if (!isCompressed(bytes)) return bytes
  const dv = new DataView(bytes.buffer, bytes.byteOffset, COMPRESSION_HEADER_BYTES)
  const id = dv.getUint8(4)
  const rawByteLength = dv.getUint32(8, true)
  const payload = bytes.subarray(COMPRESSION_HEADER_BYTES)
  if (id === STORED_COMPRESSOR_ID) {
    if (payload.byteLength !== rawByteLength) {
      throw new Error(`serialization: stored image length ${payload.byteLength} != declared ${rawByteLength} (corrupt envelope)`)
    }
    return payload
  }
  const compressor = findCompressor(id, extra)
  if (compressor === undefined) {
    throw new Error(
      `serialization: no Compressor registered for id ${id} — pass it via the deserializer/receiver 'compressors' option (bundled ids: ${BUNDLED_COMPRESSORS.map((c) => c.id).join(', ')})`,
    )
  }
  const image = compressor.decompress(payload, rawByteLength)
  if (image.byteLength !== rawByteLength) {
    throw new Error(`serialization: Compressor id ${id} produced ${image.byteLength} bytes, expected ${rawByteLength} (corrupt image or buggy compressor)`)
  }
  return image
}

function findCompressor(id: number, extra?: readonly Compressor[]): Compressor | undefined {
  if (extra !== undefined) {
    for (const c of extra) if (c.id === id) return c
  }
  for (const c of BUNDLED_COMPRESSORS) if (c.id === id) return c
  return undefined
}
