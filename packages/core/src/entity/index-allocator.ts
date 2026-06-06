// The dense/sparse swap-and-move free-list: the authoritative registry of
// which index slots are alive and at which generation. All mutation here is single-writer
// (main-thread, serial phase). `dense` stores full handles (index ⊕ generation) so recycling
// can reissue the bumped handle with a single read.

import { handleIndex, makeHandle } from './codec.js'
import type { EntityHandle, HandleLayout } from './codec.js'

export class CapacityExceeded extends Error {
  override readonly name = 'CapacityExceeded'
  constructor(capacity: number, aliveCount: number) {
    super(
      `entity index space exhausted: ${aliveCount} alive at capacity ${capacity}; raise indexBits (lower generationBits) or maxEntities`,
    )
  }
}

/**
 * Asked of the store when a brand-new index would exceed the currently-addressable array
 * length. Returns the new addressable length after growth; returns the
 * unchanged length when growth is impossible, which makes `allocEntity` throw CapacityExceeded.
 */
export type GrowHook = (need: number) => number

export interface EntityIndexArrays {
  /** sparse[index] = position of `index` within `dense`. */
  readonly sparse: Uint32Array
  /** dense[pos] = a full EntityHandle; [0, aliveCount) alive, [aliveCount, denseLen) parked-free. */
  readonly dense: Uint32Array
  /** Per-slot generation, addressed by index (only low generationBits used). */
  readonly generation: Uint32Array
}

interface Cursors {
  aliveCount: number
  denseLen: number
  /** Monotonic lifetime totals — every alloc/free passes through this allocator (including
   * worker reservations and unused-reservation releases), so these are the authoritative
   * entity-lifecycle counts; aliveCount === spawned - despawned at all times. */
  spawned: number
  despawned: number
}

/** Tuning for the mint-time bounds: how many indices are addressable now vs. ever allowed. */
export interface EntityIndexBounds {
  /** Current addressable array length (grows via the GrowHook up to `ceiling`). */
  readonly addressable: number
  /**
   * Hard mint ceiling: the largest number of distinct indices that may ever be minted. The
   * allocator throws CapacityExceeded once denseLen reaches this with no free slot. Typically
   * `min(maxEntities, maxIndex + 1)`, minus one when threaded to reserve `maxIndex` for the
   * NO_ENTITY sentinel.
   */
  readonly ceiling: number
}

export class EntityIndex {
  readonly #layout: HandleLayout
  #arrays: EntityIndexArrays
  readonly #cursors: Cursors = { aliveCount: 0, denseLen: 0, spawned: 0, despawned: 0 }
  /** Set once on the first generation wrap of any slot, for the dev-mode warning. */
  #wrapped = false
  #addressable: number
  readonly #ceiling: number
  readonly #grow: GrowHook

  constructor(layout: HandleLayout, arrays: EntityIndexArrays, bounds?: EntityIndexBounds, grow?: GrowHook) {
    this.#layout = layout
    this.#arrays = arrays
    const len = arrays.dense.length
    this.#addressable = bounds?.addressable ?? len
    // Without an explicit ceiling the allocator can only address what it was handed: cap mints
    // at the array length (still never beyond the index space).
    this.#ceiling = bounds?.ceiling ?? Math.min(len, this.#layout.maxIndex + 1)
    // Default hook: no growth — minting past `addressable` is impossible, so it stays put and
    // the ceiling guard throws.
    this.#grow = grow ?? ((): number => this.#addressable)
  }

  /** Re-publish the backing arrays after a growth; positions/cursors are unchanged. */
  rebind(arrays: EntityIndexArrays, addressable: number): void {
    this.#arrays = arrays
    this.#addressable = addressable
  }

  get aliveCount(): number {
    return this.#cursors.aliveCount
  }

  get denseLen(): number {
    return this.#cursors.denseLen
  }

  get totalSpawned(): number {
    return this.#cursors.spawned
  }

  get totalDespawned(): number {
    return this.#cursors.despawned
  }

  get wrapped(): boolean {
    return this.#wrapped
  }

  allocEntity(): EntityHandle {
    const c = this.#cursors
    {
      const { sparse, dense } = this.#arrays
      if (c.aliveCount < c.denseLen) {
        const pos = c.aliveCount
        const handle = dense[pos] as number as EntityHandle
        const index = handleIndex(handle, this.#layout)
        sparse[index] = pos
        c.aliveCount += 1
        c.spawned += 1
        return handle
      }
    }
    // Mint a brand-new index. The ceiling is the real, addressable bound (the backing-array
    // length, capped by the index space); never mint an index we cannot store.
    if (c.denseLen >= this.#ceiling) {
      throw new CapacityExceeded(this.#ceiling, c.aliveCount)
    }
    if (c.denseLen >= this.#addressable) {
      // Ask the store to grow the backing arrays and re-publish via rebind(); if it cannot,
      // addressable is unchanged and we are genuinely exhausted.
      const grown = this.#grow(c.denseLen + 1)
      if (c.denseLen >= grown) {
        throw new CapacityExceeded(this.#ceiling, c.aliveCount)
      }
    }
    const { sparse, dense, generation } = this.#arrays
    const index = c.denseLen
    generation[index] = 0
    const handle = makeHandle(index, 0, this.#layout)
    dense[index] = handle as number
    sparse[index] = index
    c.denseLen += 1
    c.aliveCount += 1
    c.spawned += 1
    return handle
  }

  freeEntity(handle: EntityHandle): void {
    const { sparse, dense, generation } = this.#arrays
    const c = this.#cursors
    const layout = this.#layout
    const index = handleIndex(handle, layout)
    const pos = sparse[index] as number
    const lastAlive = c.aliveCount - 1

    const lastHandle = dense[lastAlive] as number
    const lastIndex = handleIndex(lastHandle as EntityHandle, layout)
    dense[pos] = lastHandle
    sparse[lastIndex] = pos

    const prevGen = generation[index] as number
    const nextGen = (prevGen + 1) & layout.generationMask
    if (nextGen < prevGen) this.#wrapped = true
    generation[index] = nextGen
    const newHandle = makeHandle(index, nextGen, layout)
    dense[lastAlive] = newHandle as number
    sparse[index] = lastAlive

    c.aliveCount = lastAlive
    c.despawned += 1
  }

  /** The full (generational) handle currently occupying `index`, or NO_ENTITY-equivalent if dead. */
  handleOfIndex(index: number): EntityHandle {
    if (index >= this.#cursors.denseLen) return 0xffffffff as EntityHandle
    const gen = this.#arrays.generation[index] as number
    return makeHandle(index, gen, this.#layout)
  }

  isAlive(handle: EntityHandle): boolean {
    const index = handleIndex(handle, this.#layout)
    if (index >= this.#cursors.denseLen) return false
    const pos = this.#arrays.sparse[index] as number
    if (pos >= this.#cursors.aliveCount) return false
    return this.#arrays.dense[pos] === (handle as number)
  }
}
