// Per-row changeVersion columns (reactivity.md §6). One u32 column per archetype, addressed by ROW,
// stamped with the world frame tick whenever any component of the entity in that row is written.
// This is the mechanism for the PUBLIC `.changed`-since-tick predicate and the delta serializer
// ONLY — it is NEVER consulted by the Changed query FILTER (that is the write log, R-2 / T3).
//
// LAZILY allocated: a column exists for an archetype only once `stampingEnabled` is true (at least
// one `.changed` predicate consumer or a delta serializer is attached, §6.1). Columns are allocated
// through Buffers.column so they inherit the length-tracking resizable-SAB grow path (R-7). The
// column is keyed by a synthetic id (CHANGE_VERSION_COMPONENT_ID) and is NOT a member of any
// arch.columnSets, so store.ts #ensureRowCapacity never touches it. It instead SELF-GROWS on demand
// inside stamp() — buffers.grow(col, row+1) on the first out-of-capacity touch — independent of
// ensureRowCapacity.

import type { Buffers, Column, ColumnKey } from '../memory/index.js'
import { makeColumnLayout } from '../memory/index.js'

const VERSION_LAYOUT = makeColumnLayout('u32', 1, 0)

/** Synthetic component id keying each archetype's changeVersion column (never in any signature). */
const CHANGE_VERSION_COMPONENT_ID = 0xffff_fffd

export class ChangeVersionStore {
  readonly #buffers: Buffers
  readonly #initialCapacity: number
  /** archetypeId → its changeVersion column (lazily allocated). */
  readonly #columns = new Map<number, Column>()
  /** Whether trackWrite stamps at all (§6.1 / §13.8): false ⇒ zero stamp memory, zero stamp stores. */
  enabled = false

  constructor(buffers: Buffers, initialCapacity: number) {
    this.#buffers = buffers
    this.#initialCapacity = Math.max(1, initialCapacity)
  }

  #key(archetypeId: number): ColumnKey {
    return `${archetypeId}:${CHANGE_VERSION_COMPONENT_ID}.0` as ColumnKey
  }

  /** The column for `archetypeId`, allocating it on first touch (§6.1 opt-in). */
  #column(archetypeId: number): Column {
    let col = this.#columns.get(archetypeId)
    if (col === undefined) {
      col = this.#buffers.column(this.#key(archetypeId), VERSION_LAYOUT, this.#initialCapacity)
      this.#columns.set(archetypeId, col)
    }
    return col
  }

  /** §6.2 stamp: record `tick` at (archetypeId, row). No-op when stamping is disabled. */
  stamp(archetypeId: number, row: number, tick: number): void {
    if (!this.enabled) return
    const col = this.#column(archetypeId)
    if (row >= col.capacity()) this.#buffers.grow(col, row + 1)
    ;(col.view as Uint32Array)[row] = tick >>> 0
  }

  /** §6.3 predicate: the tick at which the row was last stamped (0 if never / no column). */
  versionAt(archetypeId: number, row: number): number {
    if (!this.enabled) return 0
    const col = this.#columns.get(archetypeId)
    if (col === undefined) return 0
    if (row >= col.capacity()) return 0
    return (col.view as Uint32Array)[row] as number
  }

  /** §6.3 predicate: `changeVersion[arch][row] > since` (strict — a caller at T ignores its own T). */
  changedSince(archetypeId: number, row: number, since: number): boolean {
    return this.versionAt(archetypeId, row) > since
  }

  /** §13.4 tick-wrap recovery: reset every column to 0 at a serial flush (once per ~2.27 years). */
  resetAll(): void {
    for (const col of this.#columns.values()) (col.view as Uint32Array).fill(0)
  }
}

export { CHANGE_VERSION_COMPONENT_ID }
