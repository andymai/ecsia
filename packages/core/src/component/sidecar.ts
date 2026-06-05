// The entity-index-keyed dense sidecar store for rich fields. One dense JS value
// array + a parallel generation-stamp array per (componentId, fieldIndex), keyed by HANDLE INDEX (NOT
// archetype row). This is the storage for 'string' and object<T> fields.
//
// Why entity-index-keyed (NOT per-archetype columns): a rich value lives at data[entityIndex], and the
// entity index is invariant across archetype migrations — so RF-MIGRATE (zero migration carry) is
// structural, the same way changeVersion follows an entity across relocations. The generation stamp
// closes RF-HYGIENE: a recycled index never leaks the prior tenant's value (a stale slot reads the
// field default). Main-thread-only by construction (rich components are restrictedToMainThread).

const FIELD_BITS = 8 // up to 256 fields per component; schema arity is far below.

export type SidecarKey = number & { readonly __sidecarKey: unique symbol }

export const sidecarKey = (componentId: number, fieldIndex: number): SidecarKey =>
  (((componentId << FIELD_BITS) | (fieldIndex & 0xff)) >>> 0) as SidecarKey

export type RichKind = 'string' | 'object'

interface SidecarColumn {
  /** Dense JS array indexed by entity index (handleIndex), NOT archetype row. */
  data: unknown[]
  /** Generation stamp per entity index (RF-HYGIENE). Parallel to `data`, grows on demand. */
  gen: Uint32Array
  /** Whether `gen[index]` was ever stamped — distinguishes "written gen 0" from "never written". */
  written: Uint8Array
  readonly def: unknown
  readonly kind: RichKind
}

/** A deferred-clear entry for the observer window. */
interface PendingClear {
  readonly index: number
  /** key → the dying entity's last value, readable during observerDrain regardless of generation. */
  readonly values: Map<SidecarKey, unknown>
}

export class SidecarStore {
  readonly #cols = new Map<SidecarKey, SidecarColumn>()
  /** index → its pending-clear entry while a remove-observer window is open (RF-REMOVE-READ). */
  readonly #pending = new Map<number, PendingClear>()

  /** Allocate a column for a (componentId, fieldIndex) rich field (idempotent). */
  ensureColumn(key: SidecarKey, kind: RichKind, def: unknown): void {
    if (this.#cols.has(key)) return
    this.#cols.set(key, { data: [], gen: new Uint32Array(0), written: new Uint8Array(0), def, kind })
  }

  hasColumn(key: SidecarKey): boolean {
    return this.#cols.has(key)
  }

  #grow(col: SidecarColumn, index: number): void {
    if (index < col.gen.length) return
    let next = col.gen.length === 0 ? 16 : col.gen.length
    while (next <= index) next *= 2
    const g = new Uint32Array(next)
    g.set(col.gen)
    col.gen = g
    const w = new Uint8Array(next)
    w.set(col.written)
    col.written = w
  }

  /** Read entity `index`'s value for `key`, applying the lazy default + generation guard (RF-HYGIENE). */
  read(key: SidecarKey, index: number, gen: number): unknown {
    const col = this.#cols.get(key)
    if (col === undefined) return undefined
    if (index < col.written.length && col.written[index] === 1 && col.gen[index] === gen) {
      const v = col.data[index]
      return v === undefined ? col.def : v
    }
    return col.def
  }

  /**
   * Whether entity `index` has a WRITTEN value at `key` for its current generation (vs the lazy default).
   * The serializer uses this to emit only present rich values (empty slots
   * are skipped and re-defaulted on the receiver). A recycled index reads as not-present (RF-HYGIENE).
   */
  isPresent(key: SidecarKey, index: number, gen: number): boolean {
    const col = this.#cols.get(key)
    if (col === undefined) return false
    return index < col.written.length && col.written[index] === 1 && col.gen[index] === gen
  }

  /** Write entity `index`'s value, stamping the current generation. */
  write(key: SidecarKey, index: number, gen: number, value: unknown): void {
    const col = this.#cols.get(key)
    if (col === undefined) return
    this.#grow(col, index)
    if (index >= col.data.length) col.data.length = index + 1
    col.data[index] = value
    col.gen[index] = gen >>> 0
    col.written[index] = 1
  }

  /**
   * Observer-window read: during an onRemove/preDespawn drain the dying entity's
   * generation has already been bumped, so a normal generation-guarded read would return the default.
   * If a pending-clear entry exists for `index`, return its stashed value regardless of generation; else
   * fall back to the generation-guarded read.
   */
  readForObserver(key: SidecarKey, index: number, gen: number): unknown {
    const pend = this.#pending.get(index)
    if (pend !== undefined && pend.values.has(key)) return pend.values.get(key)
    return this.read(key, index, gen)
  }

  /**
   * Despawn handler. When no rich-carrying held component has a
   * remove-observer, clear data[index] eagerly so the JS reference is released for GC. When one does,
   * DEFER: stash the dying values so an onRemove handler can read them during the drain (RF-REMOVE-READ),
   * then flush at the post-observer point (flushPending).
   *
   * `richKeysOnEntity` are the sidecar keys the entity actually held (its signature's rich fields); only
   * those are stashed/cleared. `defer` is true iff any held component has a remove-observer.
   */
  onDespawn(index: number, richKeysOnEntity: readonly SidecarKey[], defer: boolean): void {
    if (richKeysOnEntity.length === 0) return
    if (defer) {
      const values = new Map<SidecarKey, unknown>()
      for (const key of richKeysOnEntity) {
        const col = this.#cols.get(key)
        if (col === undefined) continue
        const v = index < col.written.length && col.written[index] === 1 ? col.data[index] : col.def
        values.set(key, v === undefined ? col.def : v)
      }
      this.#pending.set(index, { index, values })
    }
    // Whether deferred or not, the live slot is invalidated now: a recycled index must not read this
    // tenant's value. The generation guard already protects correctness; clearing releases the GC ref.
    for (const key of richKeysOnEntity) this.#clearSlot(key, index)
  }

  #clearSlot(key: SidecarKey, index: number): void {
    const col = this.#cols.get(key)
    if (col === undefined) return
    if (index < col.data.length) col.data[index] = undefined
    if (index < col.written.length) col.written[index] = 0
  }

  /**
   * Flush the deferred-clear window. Called at the post-observerDrain serial slot,
   * mirroring where storage's deferred row reclaim is finalized — after onRemove handlers have read the
   * dying values, before the index is re-minted for a new tenant.
   */
  flushPending(): void {
    this.#pending.clear()
  }

  hasPending(): boolean {
    return this.#pending.size > 0
  }

  columns(): IterableIterator<[SidecarKey, SidecarColumn]> {
    return this.#cols.entries()
  }
}
