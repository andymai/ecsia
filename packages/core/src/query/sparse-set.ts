// The per-query result container (queries.md §7.1): a SAB-capable Uint32Array sparse set storing
// ENTITY INDICES (not full handles — the index is the stable maintenance key, matching the bitmask
// and the entity record addressing). O(1) add/remove/has, dense iteration, no duplicates.
//
// `dense`/`sparse` are u32 regions allocated through Buffers.region so they are SAB-backed when
// threaded and length-track on the primary grow path (V-1). `current` is read-only to workers (they
// iterate matchingArchetypes rows, §9.4), so no atomics on the iteration path. Sizing is lazy: the
// set grows to the entity-index high-water as entities are added, never eagerly to maxEntities (§7.3).

import type { Buffers, Region, RegionKey } from '../memory/index.js'
import { isSharedBacking } from '../memory/buffers.js'

const GROWTH = 2

export class SparseSetU32 {
  #dense: Uint32Array
  #sparse: Uint32Array
  #size = 0
  #capacity: number
  readonly #denseRegion: Region<Uint32Array>
  readonly #sparseRegion: Region<Uint32Array>
  readonly #buffers: Buffers
  readonly #maxEntities: number

  constructor(buffers: Buffers, denseKey: RegionKey, sparseKey: RegionKey, initialCapacity: number, maxEntities: number) {
    this.#buffers = buffers
    this.#maxEntities = maxEntities
    const cap = Math.max(1, Math.min(initialCapacity, maxEntities))
    this.#capacity = cap
    this.#denseRegion = buffers.region(denseKey, 'u32', cap, { maxLength: maxEntities }) as Region<Uint32Array>
    this.#sparseRegion = buffers.region(sparseKey, 'u32', cap, { maxLength: maxEntities }) as Region<Uint32Array>
    this.#dense = this.#denseRegion.view
    this.#sparse = this.#sparseRegion.view
  }

  get size(): number {
    return this.#size
  }

  /** sparse[index] points into dense; the slot is valid iff dense[pos] === index AND pos < size. */
  has(index: number): boolean {
    if (index >= this.#capacity) return false
    const pos = this.#sparse[index] as number
    return pos < this.#size && (this.#dense[pos] as number) === index
  }

  /** O(1); idempotent (has-guarded so no dup). Grows the addressable space lazily (§7.3). */
  add(index: number): void {
    if (this.has(index)) return
    this.#ensureCapacity(index + 1)
    const pos = this.#size
    this.#dense[pos] = index
    this.#sparse[index] = pos
    this.#size = pos + 1
  }

  /** O(1) swap-and-pop within dense. No-op if absent. */
  remove(index: number): void {
    if (!this.has(index)) return
    const pos = this.#sparse[index] as number
    const last = this.#size - 1
    const lastIndex = this.#dense[last] as number
    this.#dense[pos] = lastIndex
    this.#sparse[lastIndex] = pos
    this.#size = last
  }

  clear(): void {
    this.#size = 0
  }

  /** Dense iteration over dense[0..size). Values are entity indices. */
  *[Symbol.iterator](): Iterator<number> {
    for (let i = 0; i < this.#size; i++) yield this.#dense[i] as number
  }

  /** A live view of the dense prefix [0..size) — zero-copy; callers must not mutate it. */
  denseView(): Uint32Array {
    return this.#dense.subarray(0, this.#size)
  }

  #ensureCapacity(need: number): void {
    if (need <= this.#capacity) return
    let next = this.#capacity
    while (next < need) next = Math.min(this.#maxEntities, next * GROWTH)
    if (next < need) next = need
    // Both regions length-track on the primary path; re-publish the view for the fallback path too.
    growRegion(this.#buffers, this.#denseRegion, next)
    growRegion(this.#buffers, this.#sparseRegion, next)
    this.#dense = this.#denseRegion.view
    this.#sparse = this.#sparseRegion.view
    this.#capacity = next
  }
}

// Region growth: Buffers.grow takes a Column; a Region is grown by re-wrapping through the same
// doubling backing. The region's backing is resizable on the primary path, so we resize in place and
// re-read the (auto-widening) length-tracking view. On a non-resizable backing we re-allocate + copy.
function growRegion(buffers: Buffers, region: Region<Uint32Array>, newLength: number): void {
  const bytesPerElem = Uint32Array.BYTES_PER_ELEMENT
  const required = newLength * bytesPerElem
  if (required <= region.backing.byteLength) return
  const growable = region.backing as { maxByteLength?: number; grow?: (b: number) => void; resize?: (b: number) => void }
  const resizeFn = growable.grow ?? growable.resize
  const max = growable.maxByteLength
  if (typeof resizeFn === 'function' && typeof max === 'number') {
    let target = region.backing.byteLength > 0 ? region.backing.byteLength : required
    while (target < required) target = target * GROWTH
    target = Math.min(target, max)
    if (target >= required) {
      try {
        resizeFn.call(growable, target)
        region.view = new Uint32Array(region.backing as ArrayBufferLike)
        return
      } catch {
        // fall through to the re-allocate path
      }
    }
  }
  // Fallback: re-allocate a fresh backing and copy. Serial-flush only (V-2); workers never maintain.
  const isShared = isSharedBacking(region.backing)
  const fresh: ArrayBufferLike = isShared
    ? (new SharedArrayBuffer(required) as ArrayBufferLike)
    : (new ArrayBuffer(required) as ArrayBufferLike)
  const freshView = new Uint32Array(fresh)
  freshView.set(region.view)
  region.backing = fresh as typeof region.backing
  region.view = freshView
}
