// The two reactivity rings: the write log (field-mutation journal) and the
// shape log (structural-change journal). Both are plain SAB|AB rings with a 4-word Atomics-capable
// header, a per-consumer LogPointer cursor protocol, per-worker write corrals merged
// serially, and a recoverable main-thread spill on overflow.
//
// Single-threaded executor: there is one logical "worker" (the main thread). The corral machinery
// is allocated and merged trivially so the multi-worker merge slots in unchanged.

import type { Buffers, Region, RegionKey } from '../memory/index.js'
import { isSharedBacking } from '../memory/buffers.js'

/** ShapeKind ordinals — SHARED across command Op / serialization DeltaOp / reactivity. */
export enum ShapeKind {
  Create = 0,
  Destroy = 1,
  Add = 2,
  Remove = 3,
  AddPair = 4,
  RemovePair = 5,
  SetPayload = 6,
}

/** A consumer scans only entries appended since its last read. One per Changed filter / observer. */
export interface LogPointer {
  readonly log: 'write' | 'shape'
  /** Last ring slot (in WORDS) this consumer has read up to, exclusive. */
  cursor: number
  /** Ring generation observed at last read. */
  generation: number
  /** Spill entries (in WORDS) consumed so far. */
  spillCursor: number
}

/** Sentinel handed to a visit callback when the ring wrapped past a consumer's cursor. */
export const OVERFLOW_SENTINEL = -1

// Header word offsets. The header is an Int32Array of length 4.
const H_HEAD = 0 // next ring slot to write (monotonic within frame, in WORDS)
const H_GENERATION = 1 // ring-rollover counter (the only atomically-read word)
const H_SPILL_COUNT = 2 // entries currently in spill (in WORDS)
const H_PEAK = 3 // high-water mark of words appended this frame

interface ResizeController {
  pendingResize: number
}

/**
 * One log ring. Generic over entry word-count (1 or 2 for write; 2 or 3 for shape — ). The ring
 * length is interpreted in WORDS; `entryWords` is the stride of one logical entry.
 */
export class LogRing {
  readonly kind: 'write' | 'shape'
  readonly entryWords: number
  readonly #buffers: Buffers
  readonly #ringKey: RegionKey
  readonly #headerKey: RegionKey
  readonly #maxLength: number
  #ringRegion: Region<Uint32Array>
  ring: Uint32Array
  readonly header: Int32Array
  /** Main-thread spill: a growable JS array, NOT ring-bounded. Drained after the ring. */
  readonly spill: number[] = []
  /** Words appended this frame across ring + spill (peak tracking). */
  #framePushCount = 0
  readonly #resize: ResizeController = { pendingResize: 0 }
  readonly #shrinkRings: boolean

  constructor(params: {
    buffers: Buffers
    kind: 'write' | 'shape'
    entryWords: number
    capacityEntries: number
    keyPrefix: string
    shrinkRings: boolean
  }) {
    this.#buffers = params.buffers
    this.kind = params.kind
    this.entryWords = params.entryWords
    this.#shrinkRings = params.shrinkRings
    const capacityWords = Math.max(params.entryWords, params.capacityEntries * params.entryWords)
    this.#maxLength = capacityWords
    this.#ringKey = `${params.keyPrefix}.ring` as RegionKey
    this.#headerKey = `${params.keyPrefix}.header` as RegionKey
    // A generous reservation so the
    this.#ringRegion = params.buffers.region(this.#ringKey, 'u32', capacityWords, {
      maxLength: capacityWords * 16,
    }) as Region<Uint32Array>
    this.ring = this.#ringRegion.view
    const headerRegion = params.buffers.region(this.#headerKey, 'i32', 4, { fixed: true }) as Region<Int32Array>
    this.header = headerRegion.view
  }

  /** Current ring length in words (the capacity the rolling head wraps against). */
  get ringWords(): number {
    return this.ring.length
  }

  /** Append one already-packed entry (1..3 words). Main thread only. Spills on overflow. */
  push(words: readonly number[]): void {
    const h = this.header
    let head = h[H_HEAD] as number
    if (head + this.entryWords > this.ring.length) {
      // Ring full this frame → spill, never throw.
      for (let i = 0; i < this.entryWords; i++) this.spill.push(words[i] as number)
      h[H_SPILL_COUNT] = (h[H_SPILL_COUNT] as number) + this.entryWords
      this.#framePushCount += this.entryWords
      if (this.#framePushCount > (h[H_PEAK] as number)) h[H_PEAK] = this.#framePushCount
      return
    }
    for (let i = 0; i < this.entryWords; i++) this.ring[head + i] = words[i] as number
    head += this.entryWords
    h[H_HEAD] = head
    this.#framePushCount += this.entryWords
    if (this.#framePushCount > (h[H_PEAK] as number)) h[H_PEAK] = this.#framePushCount
  }

  /** Append a raw word directly (the corral-merge fast path). Routes to ring or spill. */
  pushWord(word: number): void {
    const h = this.header
    const head = h[H_HEAD] as number
    if (head >= this.ring.length) {
      this.spill.push(word)
      h[H_SPILL_COUNT] = (h[H_SPILL_COUNT] as number) + 1
    } else {
      this.ring[head] = word
      h[H_HEAD] = head + 1
    }
    this.#framePushCount += 1
    if (this.#framePushCount > (h[H_PEAK] as number)) h[H_PEAK] = this.#framePushCount
  }

  /** A fresh pointer positioned at the CURRENT head (a late subscriber sees only forward events). */
  makePointer(): LogPointer {
    return {
      log: this.kind,
      cursor: this.header[H_HEAD] as number,
      generation: this.header[H_GENERATION] as number,
      spillCursor: this.header[H_SPILL_COUNT] as number,
    }
  }

  /**: does this consumer have anything new to read? */
  hasUpdatesSince(ptr: LogPointer): boolean {
    const h = this.header
    return (
      (h[H_HEAD] as number) !== ptr.cursor ||
      (h[H_GENERATION] as number) !== ptr.generation ||
      (h[H_SPILL_COUNT] as number) !== ptr.spillCursor
    )
  }

  /**
   *: visit each entry (as a contiguous word-window into ring or spill) appended since
   * `ptr`. `visit` receives the BASE offset and a source array. On a generation mismatch it receives
   * the OVERFLOW_SENTINEL once and the pointer is conservatively advanced.
   */
  consume(
    ptr: LogPointer,
    visit: (source: Int32Array | Uint32Array | number[], base: number) => void,
    headLimit?: number,
  ): void {
    const h = this.header
    // The ONE atomic read per consumer per frame. Plain load in single-thread; Atomics on SAB.
    const curGen = Atomics.load(h, H_GENERATION)
    const ringHead = h[H_HEAD] as number
    const spillHead = h[H_SPILL_COUNT] as number
    if (curGen !== ptr.generation) {
      visit([OVERFLOW_SENTINEL], 0)
      ptr.cursor = ringHead
      ptr.generation = curGen
      ptr.spillCursor = spillHead
      return
    }
    // `headLimit` bounds the ring scan to a head snapshotted at drain entry, so
    // entries appended DURING this drain (observer-issued writes) are deferred to the next drain — no
    // intra-drain write-cascade. The spill is likewise pinned to its snapshot, carried via spillCursor
    // semantics (a snapshot below the limit leaves later spill entries unread until the next pass).
    const curHead = headLimit !== undefined && headLimit < ringHead ? headLimit : ringHead
    for (let slot = ptr.cursor; slot < curHead; slot += this.entryWords) {
      visit(this.ring, slot)
    }
    ptr.cursor = curHead
    if (headLimit !== undefined && headLimit < ringHead) {
      // A bounded drain does NOT advance past the spill (the snapshot predates any in-drain spill).
      return
    }
    for (let slot = ptr.spillCursor; slot < spillHead; slot += this.entryWords) {
      visit(this.spill, slot)
    }
    ptr.spillCursor = spillHead
  }

  /**: record this frame's peak and schedule a next-frame resize if it spilled. */
  observePeak(): void {
    const h = this.header
    const peak = Math.max(h[H_PEAK] as number, (h[H_HEAD] as number) + (h[H_SPILL_COUNT] as number))
    const R = this.ring.length
    if (peak > R) {
      this.#resize.pendingResize = nextPow2(peak * 2)
    } else if (this.#shrinkRings && peak < R / 4 && R > this.#minRing()) {
      this.#resize.pendingResize = Math.max(this.#minRing(), nextPow2(Math.floor(R / 2)))
    }
  }

  #minRing(): number {
    return Math.max(this.entryWords, this.#maxLength)
  }

  /**
   * / `minConsumerCursor` is the smallest cursor over all consumers
   * (so the ring is not recycled past a lagging pointer); `minSpillCursor` is the smallest
   * spillCursor. Applies a pending resize first.
   */
  frameReset(minConsumerCursor: number, minSpillCursor?: number): void {
    const h = this.header
    if (this.#resize.pendingResize > 0) {
      this.#applyResize(this.#resize.pendingResize)
      this.#resize.pendingResize = 0
    }
    // The spill cannot be pinned the way the ring is (it is cleared every frame), so discarding
    // words a consumer never drained must bump the generation: that consumer's next consume then
    // takes the conservative OVERFLOW_SENTINEL path instead of silently missing the lost entries.
    // Callers re-sync fully-drained consumers' generations so only laggards pay the sentinel.
    if (minSpillCursor !== undefined && minSpillCursor < (h[H_SPILL_COUNT] as number)) {
      h[H_GENERATION] = (h[H_GENERATION] as number) + 1
    }
    this.spill.length = 0
    h[H_SPILL_COUNT] = 0
    h[H_PEAK] = 0
    this.#framePushCount = 0
    if (minConsumerCursor >= (h[H_HEAD] as number)) {
      // All consumers caught up: recycle the ring from slot 0 with no wrap, no generation bump.
      h[H_HEAD] = 0
    }
    // else: leave entries in place; a lagging consumer reads them before the next reset recycles.
  }

  #applyResize(targetWords: number): void {
    const region = this.#ringRegion
    const required = targetWords * Uint32Array.BYTES_PER_ELEMENT
    if (required <= region.backing.byteLength) {
      this.ring = region.view
      return
    }
    const growable = region.backing as { maxByteLength?: number; grow?: (b: number) => void; resize?: (b: number) => void }
    const resizeFn = growable.grow ?? growable.resize
    const max = growable.maxByteLength
    if (typeof resizeFn === 'function' && typeof max === 'number' && required <= max) {
      try {
        resizeFn.call(growable, required)
        this.ring = new Uint32Array(region.backing as ArrayBufferLike)
        return
      } catch {
        // fall through to re-allocate
      }
    }
    const isShared = isSharedBacking(region.backing)
    const fresh: ArrayBufferLike = isShared
      ? (new SharedArrayBuffer(required) as ArrayBufferLike)
      : (new ArrayBuffer(required) as ArrayBufferLike)
    const freshView = new Uint32Array(fresh)
    freshView.set(region.view)
    region.backing = fresh as typeof region.backing
    region.view = freshView
    this.ring = freshView
  }
}

/**
 * A per-worker write-log staging arena: a plain ArrayBuffer-backed Uint32Array the worker
 * pushes into with no atomics, grown by allocate-copy on its own thread. In single-thread mode there
 * is exactly one corral (the main "worker"); it is merged trivially every wave.
 */
export class WriteCorral {
  #data: Uint32Array
  count = 0

  constructor(initialEntries = 4096) {
    this.#data = new Uint32Array(Math.max(1, initialEntries))
  }

  get data(): Uint32Array {
    return this.#data
  }

  /** O(1) push; grows by allocate-copy if full — never throws, never touches a shared ring. */
  push(word: number): void {
    if (this.count >= this.#data.length) {
      const grown = new Uint32Array(this.#data.length * 2)
      grown.set(this.#data)
      this.#data = grown
    }
    this.#data[this.count++] = word
  }

  reset(): void {
    this.count = 0
  }
}

export function nextPow2(n: number): number {
  if (n <= 1) return 1
  let p = 1
  while (p < n) p *= 2
  return p
}
