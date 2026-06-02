// The generational handle: a packed u32 [generation : high][index : low] (entity-model.md §2).
// Encode/decode are pure, branch-free bit ops; the brand is erased at runtime.

/** A packed u32: [generation : generationBits][index : indexBits], generation in the HIGH bits. */
export type EntityHandle = number & { readonly __ecsiaEntityHandle: unique symbol }

/** The low-bits index portion — the slot in the dense/sparse arrays. */
export type EntityIndex = number & { readonly __ecsiaEntityIndex: unique symbol }

/** The generation (version) counter for a slot. */
export type EntityGeneration = number & { readonly __ecsiaEntityGeneration: unique symbol }

export interface HandleLayout {
  readonly indexBits: number
  readonly generationBits: number
  /** Low-bits mask isolating the index. */
  readonly indexMask: number
  /** Unshifted generation mask (`(1 << generationBits) - 1`). */
  readonly generationMask: number
  /** `=== indexBits`. */
  readonly generationShift: number
  /** Largest valid index (`indexMask`). */
  readonly maxIndex: number
  /** Generation value just before wrap to 0 (`generationMask`). */
  readonly maxGeneration: number
  /** Number of addressable slots (`maxIndex + 1`). */
  readonly capacity: number
}

/** Sentinel for "no entity" in eid fields and APIs that may return absent. NOT a live handle. */
export const NO_ENTITY = 0xffffffff as EntityHandle

/**
 * Build the immutable handle layout from a generation-bit split. `indexBits = 32 -
 * generationBits`. `1 << 32` is 1 in JS (shift is mod-32), so the all-ones index mask is
 * special-cased for `generationBits === 0` (entity-model.md §2.2 edge case).
 */
export function makeHandleLayout(generationBits: number): HandleLayout {
  if (!Number.isInteger(generationBits) || generationBits < 0 || generationBits > 31) {
    throw new RangeError(`generationBits must be an integer in [0, 31]; got ${generationBits}`)
  }
  const indexBits = 32 - generationBits
  const indexMask = generationBits === 0 ? 0xffffffff : ((1 << indexBits) - 1) >>> 0
  const generationMask = generationBits === 0 ? 0 : ((1 << generationBits) - 1) >>> 0
  return Object.freeze({
    indexBits,
    generationBits,
    indexMask,
    generationMask,
    generationShift: indexBits,
    maxIndex: indexMask,
    maxGeneration: generationMask,
    capacity: indexMask + 1,
  })
}

export function makeHandle(index: number, generation: number, layout: HandleLayout): EntityHandle {
  return (((generation << layout.generationShift) | index) >>> 0) as EntityHandle
}

export function handleIndex(handle: EntityHandle, layout: HandleLayout): EntityIndex {
  return ((handle & layout.indexMask) >>> 0) as EntityIndex
}

export function handleGeneration(handle: EntityHandle, layout: HandleLayout): EntityGeneration {
  return ((handle >>> layout.generationShift) & layout.generationMask) as EntityGeneration
}
