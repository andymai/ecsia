// The single length-tracking-view primitive the entity-identity flat arrays need
// (memory-buffers.md §5.5, §7.1). This is the minimal slice of the memory layer for M1: it
// owns the one branch that decides SharedArrayBuffer vs ArrayBuffer and constructs the view
// WITH NO LENGTH ARGUMENT so it widens automatically on `.grow()` (Invariant V-1).

export interface AllocU32Options {
  /** When true and the runtime allows it, back the array with a SharedArrayBuffer. */
  readonly shared?: boolean
  /**
   * Reserve a resizable backing whose view widens on `.grow()` up to `maxLength` elements.
   * Omit for a fixed-size, non-resizable buffer.
   */
  readonly maxLength?: number
}

export interface U32Region {
  /**
   * Length-tracking on a resizable backing (re-derives its length on `.grow()`), or fixed-size
   * over a non-resizable backing. Never constructed with an explicit length argument over a
   * resizable buffer (memory-buffers.md V-1).
   */
  readonly view: Uint32Array
  readonly backing: ArrayBufferLike
  readonly shared: boolean
  /** Current element capacity (`backing.byteLength / 4`). */
  capacity(): number
  /** Grow the backing to at least `length` elements. No-op if already large enough. */
  grow(length: number): void
}

const BYTES = Uint32Array.BYTES_PER_ELEMENT

// Shareable iff the SharedArrayBuffer ctor exists AND cross-origin isolation is not explicitly off.
// Node/worker_threads report `crossOriginIsolated === undefined` and CAN share SABs, so the gate is
// `!== false` (matching the Buffers capability probe, memory-buffers.md §4.2 step 2/3) rather than
// `=== true` — otherwise the entity-record regions would be AB in Node while columns are SAB, and a
// worker could not read an entity's (archetypeId, row) from the shared record region (M7).
const canShare = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false

// Resizable {Shared}ArrayBuffer is ES2024; lib is ES2023, so the maxByteLength option is typed
// through these ctor shims rather than the global lib type.
type ResizableCtor<B> = new (byteLength: number, options: { maxByteLength: number }) => B
// SharedArrayBuffer does not EXIST as a global in non-cross-origin-isolated browsers — referencing
// it at module scope would throw on load. Resolve it lazily behind a typeof guard.
const sabCtor = (): ResizableCtor<SharedArrayBuffer> | undefined =>
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : (SharedArrayBuffer as unknown as ResizableCtor<SharedArrayBuffer>)
const plainSabCtor = (): (new (byteLength: number) => SharedArrayBuffer) | undefined =>
  typeof SharedArrayBuffer === 'undefined' ? undefined : SharedArrayBuffer
const missingSab = (): never => {
  throw new Error('shared backing requested but SharedArrayBuffer is unavailable (page not cross-origin isolated)')
}
const ResizableAb = ArrayBuffer as unknown as ResizableCtor<ArrayBuffer>

const tryResizableSab = (byteLen: number, maxBytes: number): SharedArrayBuffer | undefined => {
  try {
    const Sab = sabCtor()
    if (!Sab) return undefined
    return new Sab(byteLen, { maxByteLength: maxBytes })
  } catch {
    return undefined
  }
}

const tryResizableAb = (byteLen: number, maxBytes: number): ArrayBuffer | undefined => {
  try {
    return new ResizableAb(byteLen, { maxByteLength: maxBytes })
  } catch {
    return undefined
  }
}

export function allocU32(length: number, opts: AllocU32Options = {}): U32Region {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`allocU32 length must be a non-negative integer; got ${length}`)
  }
  const wantShared = opts.shared === true && canShare()
  const hasMax = opts.maxLength !== undefined
  if (hasMax && (!Number.isInteger(opts.maxLength) || (opts.maxLength as number) < length)) {
    throw new RangeError(`allocU32 maxLength must be an integer >= length (${length}); got ${opts.maxLength}`)
  }

  const byteLen = length * BYTES
  const maxBytes = hasMax ? (opts.maxLength as number) * BYTES : byteLen

  let backing: ArrayBufferLike
  let shared = false
  if (hasMax) {
    const sab = wantShared ? tryResizableSab(byteLen, maxBytes) : undefined
    if (sab !== undefined) {
      backing = sab
      shared = true
    } else {
      const ab = tryResizableAb(byteLen, maxBytes)
      backing = ab ?? new ArrayBuffer(byteLen)
    }
  } else {
    backing = wantShared ? new (plainSabCtor() ?? missingSab())(byteLen) : new ArrayBuffer(byteLen)
    shared = wantShared
  }

  // No length argument: the view length-tracks the (possibly resizable) backing (V-1).
  return {
    view: new Uint32Array(backing),
    backing,
    shared,
    capacity(): number {
      return this.backing.byteLength / BYTES
    },
    grow(target: number): void {
      if (target <= this.capacity()) return
      const buf = this.backing as {
        maxByteLength?: number
        // SharedArrayBuffer grows in place via grow(); resizable ArrayBuffer via resize().
        grow?: (byteLength: number) => void
        resize?: (byteLength: number) => void
      }
      const resizeFn = buf.grow ?? buf.resize
      const max = buf.maxByteLength
      if (typeof resizeFn === 'function' && typeof max === 'number') {
        const needBytes = target * BYTES
        if (needBytes > max) {
          throw new RangeError(`allocU32 cannot grow to ${target} elements; reserved max is ${max / BYTES}`)
        }
        resizeFn.call(buf, needBytes)
        return
      }
      throw new RangeError('allocU32 region is not resizable (allocate with { maxLength } to enable growth)')
    },
  }
}
