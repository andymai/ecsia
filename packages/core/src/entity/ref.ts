// The pooled EntityRef identity carrier (entity-model.md §6.4): ONE object per world, NOT per
// entity, NOT a Proxy. This module owns only its identity fields and location resolution; the
// component module installs the read/write accessors on the prototype at M2 — the typed seam
// below declares that contract without implementing it.

import { NO_ENTITY } from './codec.js'
import type { EntityHandle } from './codec.js'
import { ARCHETYPE_NONE } from './record.js'
import type { EntityRecord } from './record.js'

/**
 * The accessor surface the component module installs on `EntityRef` at M2 (declared here for
 * the contract, not implemented). The bare `entity.position` getter shorthand resolves to
 * `read()` and is Readonly (Must-Fix #2).
 */
export interface EntityAccessors {
  read(def: unknown): unknown
  write(def: unknown): unknown
}

export class EntityRef {
  readonly #records: EntityRecord

  __handle: EntityHandle = NO_ENTITY
  __archetypeId: number = ARCHETYPE_NONE
  __row = 0

  constructor(records: EntityRecord) {
    this.#records = records
  }

  /** Re-point this pooled ref at a (validated-alive) handle and resolve its location (§6.4). */
  __bind(handle: EntityHandle): this {
    this.__handle = handle
    const loc = this.#records.resolveLocation(handle)
    this.__archetypeId = loc.archetypeId
    this.__row = loc.row
    return this
  }
}
