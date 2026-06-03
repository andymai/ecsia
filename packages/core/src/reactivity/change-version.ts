// Per-ENTITY changeVersion column (reactivity.md §6). A single u32 column addressed by ENTITY INDEX
// (the stable index part of the generational handle), stamped with the world frame tick whenever any
// component of that entity is written. This is the mechanism for the PUBLIC `.changed`-since-tick
// predicate and the delta serializer ONLY — it is NEVER consulted by the Changed query FILTER (that is
// the write log, R-2 / T3).
//
// Why ENTITY INDEX, not (archetype, row): the stamp must FOLLOW the entity across relocations. A value
// written to an entity that THEN migrates (own add/remove) or is relocated by a sibling's swap-remove
// must remain visible to the delta's changed-row scan (serialization.md §6.3/§6.4). A (archetype,row)
// stamp is left behind when the row moves; an entity-index stamp is invariant across every relocation
// (the index is stable for the entity's lifetime — only the archetype/row beneath it move).
//
// LAZILY allocated: the column exists only once `enabled` is true (at least one `.changed` predicate
// consumer or a delta serializer is attached, §6.1). The column is allocated through Buffers.column so
// it inherits the length-tracking resizable-SAB grow path (R-7), keyed by a synthetic id, and is NOT a
// member of any arch.columnSets, so store.ts #ensureRowCapacity never touches it. It SELF-GROWS on
// demand inside stamp() — buffers.grow(col, index+1) on the first out-of-capacity touch.

import type { Buffers, Column, ColumnKey } from '../memory/index.js'
import { makeColumnLayout } from '../memory/index.js'

const VERSION_LAYOUT = makeColumnLayout('u32', 1, 0)

/** Synthetic component id keying the changeVersion column (never in any signature). */
const CHANGE_VERSION_COMPONENT_ID = 0xffff_fffd

export class ChangeVersionStore {
  readonly #buffers: Buffers
  readonly #initialCapacity: number
  /** The single changeVersion column, addressed by entity index (lazily allocated). */
  #column: Column | null = null
  /** Whether trackWrite stamps at all (§6.1 / §13.8): false ⇒ zero stamp memory, zero stamp stores. */
  enabled = false

  constructor(buffers: Buffers, initialCapacity: number) {
    this.#buffers = buffers
    this.#initialCapacity = Math.max(1, initialCapacity)
  }

  #key(): ColumnKey {
    return `${CHANGE_VERSION_COMPONENT_ID}.0` as ColumnKey
  }

  /** The column, allocating it on first touch (§6.1 opt-in). */
  #ensureColumn(): Column {
    let col = this.#column
    if (col === null) {
      col = this.#buffers.column(this.#key(), VERSION_LAYOUT, this.#initialCapacity)
      this.#column = col
    }
    return col
  }

  /** §6.2 stamp: record `tick` at entity `index`. No-op when stamping is disabled. */
  stamp(index: number, tick: number): void {
    if (!this.enabled) return
    const col = this.#ensureColumn()
    if (index >= col.capacity()) this.#buffers.grow(col, index + 1)
    ;(col.view as Uint32Array)[index] = tick >>> 0
  }

  /** §6.3 predicate: the tick at which the entity was last stamped (0 if never / no column). */
  versionAt(index: number): number {
    if (!this.enabled) return 0
    const col = this.#column
    if (col === null) return 0
    if (index >= col.capacity()) return 0
    return (col.view as Uint32Array)[index] as number
  }

  /** §6.3 predicate: `changeVersion[index] > since` (strict — a caller at T ignores its own T). */
  changedSince(index: number, since: number): boolean {
    return this.versionAt(index) > since
  }

  /** §13.4 tick-wrap recovery: reset the column to 0 at a serial flush (once per ~2.27 years). */
  resetAll(): void {
    if (this.#column !== null) (this.#column.view as Uint32Array).fill(0)
  }
}

export { CHANGE_VERSION_COMPONENT_ID }
