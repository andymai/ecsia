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

export class EntityRef {
  readonly #records: EntityRecord
  #resolver: AccessorResolver | null = null

  __handle: EntityHandle = NO_ENTITY
  __archetypeId: number = ARCHETYPE_NONE
  __row = 0

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

  /** Re-point this pooled ref at a (validated-alive) handle and resolve its location (§6.4). */
  __bind(handle: EntityHandle): this {
    this.__handle = handle
    const loc = this.#records.resolveLocation(handle)
    this.__archetypeId = loc.archetypeId
    this.__row = loc.row
    return this
  }

  /**
   * Deeply-`Readonly` view of `def`'s fields for this entity (entity-model.md §6.4; type-system.md §4.2,
   * Must-Fix #2 / PA-2). The `const C` parameter recovers the inferred `ReadOf<C>` so a random-access
   * read is typed without caller casts; assignment through it is a TS2540 compile error.
   */
  read<const C extends ComponentDef<Schema>>(def: C): ReadOf<C> {
    if (this.#resolver === null) throw new Error('EntityRef.read: no accessor resolver installed')
    return this.#resolver.resolveRead(this.__handle, this.__archetypeId, this.__row, def) as ReadOf<C>
  }

  /**
   * Mutable, write-tracked `WriteView<S>` of `def`'s fields for this entity (Must-Fix #2 / PA-2). The
   * `const C` parameter recovers the inferred `WriteOf<C>` so a random-access write is typed without
   * caller casts; every setter additionally drives the write log (the only tracked-mutation path).
   */
  write<const C extends ComponentDef<Schema>>(def: C): WriteOf<C> {
    if (this.#resolver === null) throw new Error('EntityRef.write: no accessor resolver installed')
    return this.#resolver.resolveWrite(this.__handle, this.__archetypeId, this.__row, def) as WriteOf<C>
  }
}
