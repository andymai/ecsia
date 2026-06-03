// A growable little-endian byte cursor over ONE reusable ArrayBuffer (serialization.md §9). The
// snapshot/delta serializers own one cursor each and return a Uint8Array subarray onto the reused
// buffer — zero per-tick allocation. The buffer doubles on overflow; `slice` happens ONLY at the
// process boundary (the *Copy() paths, §9.3). All multi-byte words are written little-endian with an
// explicit littleEndian=true (§9.4).

const LE = true

export class WriteCursor {
  #buffer: ArrayBuffer
  #view: DataView
  #u8: Uint8Array
  #pos = 0

  constructor(initialBytes: number) {
    this.#buffer = new ArrayBuffer(Math.max(64, initialBytes))
    this.#view = new DataView(this.#buffer)
    this.#u8 = new Uint8Array(this.#buffer)
  }

  reset(): void {
    this.#pos = 0
  }

  get pos(): number {
    return this.#pos
  }

  #ensure(extra: number): void {
    const need = this.#pos + extra
    if (need <= this.#buffer.byteLength) return
    let cap = this.#buffer.byteLength
    while (cap < need) cap *= 2
    const next = new ArrayBuffer(cap)
    new Uint8Array(next).set(this.#u8.subarray(0, this.#pos))
    this.#buffer = next
    this.#view = new DataView(next)
    this.#u8 = new Uint8Array(next)
  }

  u8(v: number): void {
    this.#ensure(1)
    this.#view.setUint8(this.#pos, v & 0xff)
    this.#pos += 1
  }

  u16(v: number): void {
    this.#ensure(2)
    this.#view.setUint16(this.#pos, v & 0xffff, LE)
    this.#pos += 2
  }

  u32(v: number): void {
    this.#ensure(4)
    this.#view.setUint32(this.#pos, v >>> 0, LE)
    this.#pos += 4
  }

  /** Back-patch a u32 already written at byte `at` (header offsets/counts, §4.3). */
  patchU32(at: number, v: number): void {
    this.#view.setUint32(at, v >>> 0, LE)
  }

  /** Pad to a 4-byte boundary (SoA sections are word-aligned, §2). */
  alignTo4(): void {
    while ((this.#pos & 3) !== 0) this.u8(0)
  }

  /** Copy a typed-array slice as raw platform-LE bytes (the single set() per column, §4.3). */
  copyBytes(src: ArrayBufferView): void {
    const bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    this.#ensure(bytes.byteLength)
    this.#u8.set(bytes, this.#pos)
    this.#pos += bytes.byteLength
  }

  /** A view onto the reused buffer for [0, pos). Valid only until the next serialize call (§9.2). */
  bytesView(): Uint8Array {
    return this.#u8.subarray(0, this.#pos)
  }

  /** A fresh detached copy safe to transfer/persist (§9.3 — the ONLY slice site). */
  bytesCopy(): Uint8Array {
    return this.#u8.slice(0, this.#pos)
  }
}

export class ReadCursor {
  readonly #view: DataView
  readonly #u8: Uint8Array
  #pos = 0

  constructor(bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.#u8 = bytes
  }

  get pos(): number {
    return this.#pos
  }

  seek(pos: number): void {
    this.#pos = pos
  }

  get atEnd(): boolean {
    return this.#pos >= this.#u8.byteLength
  }

  u8(): number {
    const v = this.#view.getUint8(this.#pos)
    this.#pos += 1
    return v
  }

  u16(): number {
    const v = this.#view.getUint16(this.#pos, LE)
    this.#pos += 2
    return v
  }

  u32(): number {
    const v = this.#view.getUint32(this.#pos, LE)
    this.#pos += 4
    return v >>> 0
  }

  alignTo4(): void {
    while ((this.#pos & 3) !== 0) this.#pos += 1
  }

  /** A zero-copy subarray of `byteLength` raw bytes, advancing the cursor (one set() per column, §5.3). */
  takeBytes(byteLength: number): Uint8Array {
    const out = this.#u8.subarray(this.#pos, this.#pos + byteLength)
    this.#pos += byteLength
    return out
  }
}
