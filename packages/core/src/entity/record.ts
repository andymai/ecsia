// The two-word entity record: two parallel flat arrays addressed by the
// handle's index. Writing both words is the structural commit point (INVARIANT C1). The
// commit is wrapped in `commitRecord` so a future v2 can swap the two plain stores for an
// Atomics pair without touching callers.

import { handleIndex } from './codec.js'
import type { EntityHandle, HandleLayout } from './codec.js'

/**
 * Record sentinel for an index not yet placed into any archetype. Normatively owned by
 * declared here as the value the record arrays carry pre-placement.
 */
export const ARCHETYPE_NONE = 0xffffffff

export interface EntityRecordArrays {
  /** recordArchetypeId[index] = the ArchetypeId the entity currently lives in. */
  readonly recordArchetypeId: Uint32Array
  /** recordArchetypeRow[index] = the row within that archetype's SoA columns. */
  readonly recordArchetypeRow: Uint32Array
}

export interface EntityLocation {
  readonly archetypeId: number
  readonly row: number
}

export class EntityRecord {
  readonly #layout: HandleLayout
  #arrays: EntityRecordArrays

  constructor(layout: HandleLayout, arrays: EntityRecordArrays) {
    this.#layout = layout
    this.#arrays = arrays
  }

  rebind(arrays: EntityRecordArrays): void {
    this.#arrays = arrays
  }

  // Row word first, id word second; v1 stores are plain.
  commitRecord(index: number, archetypeId: number, row: number): void {
    this.#arrays.recordArchetypeRow[index] = row
    this.#arrays.recordArchetypeId[index] = archetypeId
  }

  resolveLocation(handle: EntityHandle): EntityLocation {
    const index = handleIndex(handle, this.#layout)
    return {
      archetypeId: this.#arrays.recordArchetypeId[index] as number,
      row: this.#arrays.recordArchetypeRow[index] as number,
    }
  }

  /** The archetype id of an entity by its (already-decoded) index — the storage RecordSurface. */
  archetypeIdOf(index: number): number {
    return this.#arrays.recordArchetypeId[index] as number
  }

  /** The row of an entity within its archetype by its index — the storage RecordSurface. */
  rowOf(index: number): number {
    return this.#arrays.recordArchetypeRow[index] as number
  }
}
