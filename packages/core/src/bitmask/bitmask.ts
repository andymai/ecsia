// The per-entity bitmask membership index. MAIN-THREAD / SERIAL-ONLY:
// every read and write asserts world.phase === 'serial' (Invariant). It is the
// O(1) entity.has(C) point-test substrate and the single-entity incremental query matcher — NOT
// the iteration path (that is per-archetype). Coherence with the archetype tables is one-way:
// bitmaskApplyDelta refreshes it immediately after each serial migration commit.
//
// Layout: bitmask.words is a u32 region of length capacity*stride, addressed by ENTITY INDEX (low
// handle bits, stable across swap-pop). stride = ceil(N/32) where N = registered component-type
// count ( C4). Pair ids beyond the fixed stride live in a lazily-grown sparse vector.

import type { ComponentId } from '@ecsia/schema'
import type { Buffers, Region, RegionKey } from '../memory/index.js'
import type { Signature } from '../storage/signature.js'
import { sigHas } from '../storage/signature.js'

const BITMASK_REGION_KEY = 'bitmask.words' as RegionKey

/** Main-thread / serial-phase gate. Workers establish membership from the archetype signature. */
export type PhaseGate = () => 'serial' | 'wave'

export class Bitmask {
  readonly #region: Region<Uint32Array>
  #words: Uint32Array
  readonly #stride: number
  /** Fixed bit count covered by the dense words; ids at/above this use the sparse vector. */
  readonly #fixedBitCount: number
  readonly #phase: PhaseGate
  /** Out-of-stride pair bits, lazily grown per entity index (unbounded pair-id space). */
  readonly #sparse = new Map<number, Set<number>>()

  constructor(buffers: Buffers, componentCount: number, maxEntities: number, phase: PhaseGate) {
    // stride = ceil(N/32) exactly per ( C4). N (registered component count) is always >= 1
    // (FIRST_USER_COMPONENT_ID), so this is >= 1 without a max(1,...) floor; ids beyond fixedBitCount
    // fall through to the sparse vector. The backing region reserves at least one word so a
    // degenerate N=0 world still has a valid (length-tracking) allocation.
    this.#stride = Math.ceil(componentCount / 32)
    this.#fixedBitCount = this.#stride * 32
    this.#phase = phase
    const regionWords = Math.max(1, maxEntities * this.#stride)
    this.#region = buffers.region(BITMASK_REGION_KEY, 'u32', regionWords, {
      maxLength: regionWords,
    }) as Region<Uint32Array>
    this.#words = this.#region.view
  }

  get stride(): number {
    return this.#stride
  }

  #assertSerial(): void {
    if (this.#phase() !== 'serial') {
      throw new Error(
        'component bitmask access is main-thread / serial-phase only; perform structural reads or mutations ' +
          'outside worker waves (before scheduler.update() or in a serial system), not from a worker-wave system',
      )
    }
  }

  /** O(1) membership point test for a single entity index. */
  bitmaskHas(index: number, c: ComponentId): boolean {
    this.#assertSerial()
    const cid = c as number
    if (cid >= this.#fixedBitCount) return this.#sparse.get(index)?.has(cid) ?? false
    return ((this.#words[index * this.#stride + (cid >>> 5)] as number) & (1 << (cid & 31))) !== 0
  }

  /** Coherence with the table: set added bits, clear removed bits, after a serial migration. */
  bitmaskApplyDelta(index: number, fromSig: Signature, toSig: Signature): void {
    this.#assertSerial()
    const base = index * this.#stride
    for (let i = 0; i < toSig.length; i++) {
      const c = toSig[i] as number
      if (c < this.#fixedBitCount) {
        this.#words[base + (c >>> 5)] = ((this.#words[base + (c >>> 5)] as number) | (1 << (c & 31))) >>> 0
      } else {
        this.#sparseSet(index, c)
      }
    }
    for (let i = 0; i < fromSig.length; i++) {
      const c = fromSig[i] as number
      if (sigHas(toSig, c)) continue
      if (c < this.#fixedBitCount) {
        this.#words[base + (c >>> 5)] = ((this.#words[base + (c >>> 5)] as number) & ~(1 << (c & 31))) >>> 0
      } else {
        this.#sparse.get(index)?.delete(c)
      }
    }
  }

  /** Clear all of an entity's membership words on despawn. O(stride). */
  bitmaskClear(index: number): void {
    this.#assertSerial()
    const base = index * this.#stride
    for (let w = 0; w < this.#stride; w++) this.#words[base + w] = 0
    this.#sparse.delete(index)
  }

  /** Zero-copy view of one entity's fixed-stride shape words (for the single-entity matcher ). */
  entityShapeWords(index: number): Uint32Array {
    this.#assertSerial()
    return this.#words.subarray(index * this.#stride, index * this.#stride + this.#stride)
  }

  /** Re-publish the region view after a fallback grow (the region length-tracks on the primary path). */
  rebind(): void {
    this.#words = this.#region.view
  }

  #sparseSet(index: number, c: number): void {
    let s = this.#sparse.get(index)
    if (s === undefined) {
      s = new Set<number>()
      this.#sparse.set(index, s)
    }
    s.add(c)
  }
}
