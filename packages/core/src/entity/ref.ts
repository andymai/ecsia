// The pooled EntityRef identity carrier (entity-model.md §6.4): ONE object per world, NOT per
// entity, NOT a Proxy. This module owns its identity fields and location resolution; the
// read/write accessor split (Must-Fix #2) is installed on the prototype here (M2) but its body
// delegates to a pluggable AccessorResolver the world injects, so this module stays free of any
// dependency on the component/storage layers.

import { NO_ENTITY } from './codec.js'
import type { EntityHandle } from './codec.js'
import { ARCHETYPE_NONE } from './record.js'
import type { EntityRecord } from './record.js'
import type { ComponentDef, ReadOf, Schema, WriteOf } from '@ecsia/schema'

/**
 * Resolves the (archetype, component) accessor singleton for an entity, pokes its row/handle, and
 * returns it. The world installs one resolver per world; M2 binds against a directly-allocated
 * column set, M3 binds against the entity's real archetype (the archetype-binding seam).
 */
export interface AccessorResolver {
  resolveRead(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown
  resolveWrite(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown
}

/**
 * The accessor surface installed on `EntityRef`. The bare `entity.<comp>` getter shorthand
 * resolves to `read()` and is Readonly (Must-Fix #2); `write()` returns the mutable singleton whose
 * setters call world.trackWrite.
 */
export interface EntityAccessors {
  read(def: unknown): unknown
  write(def: unknown): unknown
}

/**
 * EntityRef is a POOLED SINGLETON: there is exactly ONE instance per world, and `world.entity(h)`
 * re-points (rebinds) that one object at `h` and returns it — it does NOT allocate a fresh ref per
 * call. The pooling contract is therefore:
 *
 *   - The handle you bind is valid only until the NEXT `world.entity(...)` call, or until the bound
 *     entity is despawned / structurally moved. A reference captured in a local and used across
 *     either event aliases the wrong row.
 *   - Do NOT hold the ref across a `world.entity()` call. Re-resolve with `world.entity(h)` at the
 *     point of use, or extract the plain field values you need into locals first.
 *
 * To turn the classic silent-corruption footgun into a loud failure, the RANDOM-ACCESS read()/write()
 * accessors verify on every call that the currently-bound handle is still alive and still occupies the
 * location this ref cached at bind time; a stale/recycled/moved binding THROWS instead of reading or
 * writing the wrong entity's row. (Query-iteration element accessors are a separate, hot path and are
 * intentionally NOT guarded here.)
 */
export class EntityRef {
  readonly #records: EntityRecord
  #resolver: AccessorResolver | null = null
  #isAlive: ((handle: EntityHandle) => boolean) | null = null

  __handle: EntityHandle = NO_ENTITY
  __archetypeId: number = ARCHETYPE_NONE
  __row = 0
  /** Set when bound via `{ lenient: true }` (e.g. an onRemove observer resolving a just-despawned entity). */
  __lenient = false

  constructor(records: EntityRecord) {
    this.#records = records
  }

  /** Public, frozen-surface accessor for the bound handle (the non-`__` form referenced by public-api.md §9.3). */
  get handle(): EntityHandle {
    return this.__handle
  }

  /** Inject the world's accessor resolver (world wiring, §7). */
  __setResolver(resolver: AccessorResolver): void {
    this.#resolver = resolver
  }

  /** Inject the world's liveness probe so random-access read/write can fail loud on a stale binding. */
  __setLiveness(isAlive: (handle: EntityHandle) => boolean): void {
    this.#isAlive = isAlive
  }

  /** Re-point this pooled ref at a (validated-alive) handle and resolve its location (§6.4). */
  __bind(handle: EntityHandle, lenient = false): this {
    this.__handle = handle
    this.__lenient = lenient
    const loc = this.#records.resolveLocation(handle)
    this.__archetypeId = loc.archetypeId
    this.__row = loc.row
    return this
  }

  /**
   * Assert the ref's cached binding still names the SAME live entity at the SAME location. Throws an
   * actionable error if the bound entity was despawned/recycled (liveness) or structurally moved since
   * bind (location drift) — both of which mean a held ref would otherwise read/write the wrong row.
   */
  #assertFresh(verb: 'read' | 'write'): void {
    // A lenient binding deliberately resolves a possibly-dead/shuffled slot (e.g. an onRemove observer
    // reading the just-despawned entity's last values); the caller has opted out of the guard.
    if (this.__lenient) return
    const isAlive = this.#isAlive
    if (isAlive !== null && !isAlive(this.__handle)) {
      throw new Error(
        `EntityRef.${verb}(): entity ${this.__handle} is no longer alive. The pooled EntityRef is rebound by ` +
          `world.entity(...) and invalidated on despawn — do not hold it across calls; re-resolve via world.entity(h).`,
      )
    }
    const loc = this.#records.resolveLocation(this.__handle)
    if (loc.archetypeId !== this.__archetypeId || loc.row !== this.__row) {
      throw new Error(
        `EntityRef.${verb}(): stale binding for entity ${this.__handle} — it moved since this ref was resolved ` +
          `(another world.entity(...) call or a structural change rebound the pooled ref). Re-resolve via world.entity(h).`,
      )
    }
  }

  /**
   * Deeply-`Readonly` view of `def`'s fields for this entity (entity-model.md §6.4; type-system.md §4.2).
   * The `const C` parameter recovers the inferred `ReadOf<C>` so a random-access read is typed without
   * caller casts; assignment through it is a TS2540 compile error. RANDOM-ACCESS path: guarded against a
   * stale/recycled/moved pooled binding (see class jsdoc).
   */
  read<const C extends ComponentDef<Schema>>(def: C): ReadOf<C> {
    if (this.#resolver === null) throw new Error('EntityRef.read: no accessor resolver installed')
    this.#assertFresh('read')
    return this.#resolver.resolveRead(this.__handle, this.__archetypeId, this.__row, def) as ReadOf<C>
  }

  /**
   * Mutable, write-tracked `WriteView<S>` of `def`'s fields for this entity. The `const C` parameter
   * recovers the inferred `WriteOf<C>` so a random-access write is typed without caller casts; every
   * setter additionally drives the write log (the only tracked-mutation path). RANDOM-ACCESS path:
   * guarded against a stale/recycled/moved pooled binding (see class jsdoc).
   */
  write<const C extends ComponentDef<Schema>>(def: C): WriteOf<C> {
    if (this.#resolver === null) throw new Error('EntityRef.write: no accessor resolver installed')
    this.#assertFresh('write')
    return this.#resolver.resolveWrite(this.__handle, this.__archetypeId, this.__row, def) as WriteOf<C>
  }
}
