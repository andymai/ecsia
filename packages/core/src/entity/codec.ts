// The generational handle: a packed u32 [generation : high][index : low] (entity-model.md §2).
// Encode/decode are pure, branch-free bit ops; the brand is erased at runtime.

// The handle/index brands are the canonical type-system.md §8 brands, shared with @ecsia/schema so
// the eid field type, accessors, and the entity layer all agree on one EntityHandle/EntityIndex.
import type { EntityHandle as SchemaEntityHandle, EntityIndex as SchemaEntityIndex } from '@ecsia/schema'

/** A packed u32: [generation : generationBits][index : indexBits], generation in the HIGH bits. */
export type EntityHandle = SchemaEntityHandle

/** The low-bits index portion — the slot in the dense/sparse arrays. */
export type EntityIndex = SchemaEntityIndex

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

/** Alias of {@link NO_ENTITY} for call sites that prefer the "null handle" spelling. */
export const NULL_ENTITY = NO_ENTITY

/**
 * True when `handle` is the {@link NO_ENTITY} sentinel (an absent / null handle). Use this to
 * discriminate handles returned from APIs that may yield "no entity" without comparing against the
 * raw `0xffffffff` literal: `if (isNoEntity(h)) { ... }`.
 */
export function isNoEntity(handle: EntityHandle): boolean {
  return (handle as number) === (NO_ENTITY as number)
}

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
  // Dev-mode guard (entity-model.md §2.3): a generation above maxGeneration would overflow the
  // generation field and silently alias another slot's handle. Stripped in production builds.
  if (process.env['NODE_ENV'] !== 'production' && generation > layout.maxGeneration) {
    throw new RangeError(`makeHandle: generation ${generation} exceeds maxGeneration ${layout.maxGeneration}`)
  }
  return (((generation << layout.generationShift) | index) >>> 0) as EntityHandle
}

export function handleIndex(handle: EntityHandle, layout: HandleLayout): EntityIndex {
  return ((handle & layout.indexMask) >>> 0) as EntityIndex
}

export function handleGeneration(handle: EntityHandle, layout: HandleLayout): EntityGeneration {
  return ((handle >>> layout.generationShift) & layout.generationMask) as EntityGeneration
}
