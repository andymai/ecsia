// Construction wiring for the entity layer: allocate the five
// identity/record flat arrays through memory.allocU32, sized by maxEntities, and assemble the
// EntityIndex + EntityRecord + pooled EntityRef. Lives between the world facade and the
// per-module primitives so world.ts stays a thin delegator.

import { allocU32 } from '../memory/index.js'
import type { U32Region } from '../memory/index.js'
import { handleIndex, makeHandle } from './codec.js'
import type { EntityGeneration, EntityHandle, EntityIndex as EntityIndexBrand, HandleLayout } from './codec.js'
import { EntityIndex } from './index-allocator.js'
import type { EntityIndexArrays, EntityIndexBounds } from './index-allocator.js'
import { ARCHETYPE_NONE, EntityRecord } from './record.js'
import type { EntityRecordArrays } from './record.js'
import { EntityRef } from './ref.js'
import type { AccessorResolver } from './ref.js'

// EMPTY_ARCHETYPE_ID is normatively; the empty-signature archetype is
// dense id 0 (a real archetype, distinct from the ARCHETYPE_NONE sentinel). Storage lands at;
// until then a freshly spawned entity records archetype 0 at row 0.
const EMPTY_ARCHETYPE_ID = 0

export interface EntityStoreConfig {
  readonly layout: HandleLayout
  readonly maxEntities: number
  readonly shared: boolean
}

export interface HandleStats {
  readonly aliveCount: number
  readonly minted: number
  readonly capacity: number
  readonly wrapTimeFormula: string
}

export class EntityStore {
  readonly layout: HandleLayout
  readonly #index: EntityIndex
  readonly #records: EntityRecord
  readonly #ref: EntityRef
  readonly #maxEntities: number
  /** Hard mint ceiling: the index space, minus the reserved NO_ENTITY slot when threaded. */
  readonly #ceiling: number
  /** Current addressable length; doubles on growth up to `#ceiling`. */
  #addressable: number
  #wrapWarned = false

  // Held only so growth re-reads/re-publishes the layout structs from the same regions.
  readonly #regions: {
    sparse: U32Region
    dense: U32Region
    generation: U32Region
    recordArchetypeId: U32Region
    recordArchetypeRow: U32Region
  }

  constructor(config: EntityStoreConfig) {
    this.layout = config.layout
    this.#maxEntities = config.maxEntities
    this.#addressable = config.maxEntities

    // The index space is [0, maxIndex]; when threaded, maxIndex is reserved for the NO_ENTITY
    // sentinel so a minted+wrapped handle can never alias 0xffffffff.
    this.#ceiling = config.shared ? config.layout.maxIndex : config.layout.maxIndex + 1

    const opts = { shared: config.shared, maxLength: config.layout.capacity }
    this.#regions = {
      sparse: allocU32(config.maxEntities, opts),
      dense: allocU32(config.maxEntities, opts),
      generation: allocU32(config.maxEntities, opts),
      recordArchetypeId: allocU32(config.maxEntities, opts),
      recordArchetypeRow: allocU32(config.maxEntities, opts),
    }

    const bounds: EntityIndexBounds = { addressable: this.#addressable, ceiling: this.#ceiling }
    this.#index = new EntityIndex(config.layout, this.#indexArrays(), bounds, (need) => this.#grow(need))
    this.#records = new EntityRecord(config.layout, this.#recordArrays())
    this.#ref = new EntityRef(this.#records)
    this.#ref.__setLiveness((handle) => this.#index.isAlive(handle))
  }

  /**
   * Grow every identity/record region to at least `need` elements (doubling), then
   * re-publish the widened views to the index/record/ref structs and return the new addressable
   * length. Returns the unchanged length when growth is impossible (capped at `#ceiling`), which
   * makes the allocator throw CapacityExceeded. Serial-phase only.
   */
  #grow(need: number): number {
    if (need <= this.#addressable) return this.#addressable
    const cap = Math.min(this.#ceiling, this.layout.capacity)
    if (this.#addressable >= cap) return this.#addressable
    let next = this.#addressable
    while (next < need) next = Math.min(cap, next * 2)
    if (next <= this.#addressable) return this.#addressable
    for (const region of Object.values(this.#regions)) region.grow(next)
    this.#addressable = next
    // Length-tracking views over resizable buffers widen in place, but re-publishing keeps the
    // non-resizable fallback path correct too.
    this.#index.rebind(this.#indexArrays(), next)
    this.#records.rebind(this.#recordArrays())
    return next
  }

  #indexArrays(): EntityIndexArrays {
    return {
      sparse: this.#regions.sparse.view,
      dense: this.#regions.dense.view,
      generation: this.#regions.generation.view,
    }
  }

  #recordArrays(): EntityRecordArrays {
    return {
      recordArchetypeId: this.#regions.recordArchetypeId.view,
      recordArchetypeRow: this.#regions.recordArchetypeRow.view,
    }
  }

  /**
   * Storage hook installed at: places a freshly-minted handle into its initial archetype (via
   * allocRow) and commits the record; on despawn it performs the + bitmask clear
   * BEFORE identity invalidation. Until installed, spawn falls back to the empty-archetype row 0.
   */
  #lifecycle: { onSpawn(handle: EntityHandle): void; onDespawn(handle: EntityHandle): void } | null = null

  setLifecycle(hooks: { onSpawn(handle: EntityHandle): void; onDespawn(handle: EntityHandle): void }): void {
    this.#lifecycle = hooks
  }

  spawn(): EntityHandle {
    const handle = this.#index.allocEntity()
    if (this.#lifecycle !== null) {
      this.#lifecycle.onSpawn(handle)
    } else {
      const index = handleIndex(handle, this.layout)
      this.#records.commitRecord(index, EMPTY_ARCHETYPE_ID, 0)
    }
    this.#warnOnWrap()
    return handle
  }

  despawn(handle: EntityHandle): void {
    if (!this.#index.isAlive(handle)) return
    // Storage runs removeRow + bitmask clear here; identity invalidation (freeEntity) runs
    // LAST so the above could still resolve the dying entity's location.
    this.#lifecycle?.onDespawn(handle)
    this.#index.freeEntity(handle)
    this.#warnOnWrap()
  }

  isAlive(handle: EntityHandle): boolean {
    return this.#index.isAlive(handle)
  }

  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRef {
    if (!this.#index.isAlive(handle)) {
      // Dead handles throw unless the caller opts into lenient resolution (it then binds
      // the stale handle anyway; the location words are whatever the slot last held).
      if (opts?.lenient !== true) throw new Error(`entity(${handle}): handle is not alive`)
    }
    return this.#ref.__bind(handle, opts?.lenient === true)
  }

  encodeHandle(index: number, generation: number): EntityHandle {
    if (index < 0 || index > this.layout.maxIndex) {
      throw new RangeError(`index out of range [0, ${this.layout.maxIndex}]; got ${index}`)
    }
    if (generation < 0 || generation > this.layout.maxGeneration) {
      throw new RangeError(`generation out of range [0, ${this.layout.maxGeneration}]; got ${generation}`)
    }
    return makeHandle(index, generation, this.layout)
  }

  decodeHandle(handle: EntityHandle): { index: EntityIndexBrand; generation: EntityGeneration } {
    return {
      index: ((handle & this.layout.indexMask) >>> 0) as EntityIndexBrand,
      generation: ((handle >>> this.layout.generationShift) & this.layout.generationMask) as EntityGeneration,
    }
  }

  /** Install the read/write accessor resolver onto the pooled ref (world wiring). */
  setAccessorResolver(resolver: AccessorResolver): void {
    this.#ref.__setResolver(resolver)
  }

  get index(): EntityIndex {
    return this.#index
  }

  get records(): EntityRecord {
    return this.#records
  }

  /**
   * The two entity-record region backings (archetypeId, archetypeRow), for the worker bootstrap
   * manifest. A worker resolves an entity's (archetypeId, row) from these shared
   * regions — reading ARCHETYPE TABLES ONLY, never the bitmask. Backings are SAB when
   * threaded + isolation present; otherwise plain AB (the worker path then has nothing to share).
   */
  sharedRecordRegions(): { archetypeId: ArrayBufferLike; archetypeRow: ArrayBufferLike } {
    return {
      archetypeId: this.#regions.recordArchetypeId.backing,
      archetypeRow: this.#regions.recordArchetypeRow.backing,
    }
  }

  /** The full (generational) handle occupying `index` — the query engine's index→handle resolver. */
  handleOfIndex(index: number): EntityHandle {
    return this.#index.handleOfIndex(index)
  }

  /** index → its (archetypeId, row) location — the query engine's resolveLocation seam. */
  locationOfIndex(index: number): { archetypeId: number; row: number } {
    return { archetypeId: this.#records.archetypeIdOf(index), row: this.#records.rowOf(index) }
  }

  handleStats(): HandleStats {
    return {
      aliveCount: this.#index.aliveCount,
      minted: this.#index.denseLen,
      capacity: this.#maxEntities,
      wrapTimeFormula: `2^${this.layout.generationBits} / recycleRate`,
    }
  }

  #warnOnWrap(): void {
    if (this.#wrapWarned || !this.#index.wrapped) return
    this.#wrapWarned = true
    // Dev-mode-only signal so users can raise generationBits; never a production throw.
    if (typeof console !== 'undefined') {
      console.warn(
        `[ecsia] entity generation wrapped (generationBits=${this.layout.generationBits}); stale-handle aliasing window reached — consider raising generationBits`,
      )
    }
  }
}

export { ARCHETYPE_NONE }
