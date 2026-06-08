// The entity-index-keyed dense sidecar store for rich fields. One dense JS value
// array + a parallel generation-stamp array per (componentId, fieldIndex), keyed by HANDLE INDEX (NOT
// archetype row). This is the storage for 'string' and object<T> fields.
//
// Why entity-index-keyed (NOT per-archetype columns): a rich value lives at data[entityIndex], and the
// entity index is invariant across archetype migrations — so RF-MIGRATE (zero migration carry) is
// structural, the same way changeVersion follows an entity across relocations. The generation stamp
// closes RF-HYGIENE: a recycled index never leaks the prior tenant's value (a stale slot reads the
// field default). Main-thread-only by construction (rich components are restrictedToMainThread).
//
// This store also owns the field-kind-AGNOSTIC deferred-despawn window: besides the rich
// pending-clear values it stashes the dying tenant's archetype LOCATION (archId, row), so a dead
// tenant's observer-window ref reading a NUMERIC component it HELD resolves through the stashed
// location rather than the live records — which a same-window re-mint at the index has overwritten.
// The window arms whenever any remove-observer exists (not only when rich columns do), so the numeric
// leg works in rich-free worlds. The divert is PER-READ + per-component (the world's resolver shim):
// it fires only for a component the dying archetype holds whose row still survives, so a read of a
// never-held component keeps the prior rich-default / not-held behavior.
//
// Remaining boundary (PR2): a SAME-archetype spawn into the freed row before the drain (the
// load(…, 'replace') free-then-remint shape) physically overwrites the dense numeric row — the
// row-survival guard then declines the stash and the prior behavior stands. Closing it needs the
// per-archetype deferred-dead-row HOLD (storage, follow-up).

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
  /** The dying tenant's generation. The stash serves ONLY reads carrying this generation, so a
   * same-window re-mint of the index never sees the dead tenant's value (RF-HYGIENE). A rich-free
   * deferred despawn stashes a gen-ONLY entry (empty values) so its events still bind to it. */
  readonly gen: number
  /** key → the dying entity's last value, readable during observerDrain. */
  readonly values: Map<SidecarKey, unknown>
  /** How many despawns of this index preceded this tenant's within the window — pairs the tenant
   * with its Destroy entry in the drain even when stashless (observer-free) despawns interleave. */
  readonly despawnsBefore: number
  /** Set when the drain passes this tenant's Destroy entry. A Create drained at the index BEFORE the
   * Destroy is the tenant's own mint (spawned in the same window); only a Create drained AFTER it is
   * a re-mint that ends the tenant's window and supersedes the entry. */
  destroyDrained: boolean
  /** The dying tenant's archetype location, captured AFTER storage.onDespawn settles the deferred
   * row. -1 until setPendingLocation; the resolver shim serves a dead-tenant ref's NUMERIC reads
   * here when the component is held and the row still survives. */
  archId: number
  row: number
}

export class SidecarStore {
  readonly #cols = new Map<SidecarKey, SidecarColumn>()
  /** index → pending-clear entries while a remove-observer window is open (RF-REMOVE-READ). A list,
   * not a single entry: an index can be despawned, re-minted, and despawned again before one drain. */
  readonly #pending = new Map<number, PendingClear[]>()
  /** index → despawns of that index this window (ALL despawns, stashed or not — the ordinal source
   * for PendingClear.despawnsBefore). Cleared with the window at flushPending. */
  readonly #despawnSeq = new Map<number, number>()
  /** index → Destroy entries the observer drain has passed this window (noteDestroyDrained). */
  readonly #destroysDrained = new Map<number, number>()

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
   * index generation has already been bumped, so a normal generation-guarded read would return the
   * default. A pending-clear entry whose stamped generation MATCHES the reading handle's generation
   * serves the stashed value (the remove-event ref is bound to the dying handle — world wiring); any
   * other generation falls through to the generation-guarded read, so a same-window re-mint at the
   * index reads its own slot, never the dead tenant's stash.
   */
  readForObserver(key: SidecarKey, index: number, gen: number): unknown {
    const list = this.#pending.get(index)
    if (list !== undefined) {
      for (const pend of list) {
        if (pend.gen === gen && pend.values.has(key)) return pend.values.get(key)
      }
    }
    return this.read(key, index, gen)
  }

  /**
   * The generation of the OLDEST un-superseded dying tenant stashed at `index`, or undefined. While
   * the drain cursor is inside a stashed tenant's lifetime (its events, up to the Create that
   * re-minted the index), this is that tenant's generation — the observer dispatch binds the events'
   * refs to it; supersedePending advances it when the drain passes the re-mint.
   */
  pendingGenerationOf(index: number): number | undefined {
    return this.#pending.get(index)?.[0]?.gen
  }

  /** The observer drain passed a Destroy entry for `index`: when it is the head stash's tenant's own
   * (matched by despawn ordinal — stashless despawns at the index consume ordinals too), mark the
   * stash so the NEXT Create at the index supersedes it. */
  noteDestroyDrained(index: number): void {
    // Mutations stage during a drain, so an empty #pending stays empty for the whole window — the
    // ordinal this would record could never be consulted before flushPending clears it anyway.
    if (this.#pending.size === 0) return
    const n = (this.#destroysDrained.get(index) ?? 0) + 1
    this.#destroysDrained.set(index, n)
    const head = this.#pending.get(index)?.[0]
    if (head !== undefined && n > head.despawnsBefore) head.destroyDrained = true
  }

  /**
   * Drop the oldest pending-clear entry for `index` when the observer drain encounters a Create
   * entry AFTER that tenant's Destroy: the log is ordered, so every remove/destroy event of the
   * tenant that died before this re-mint has already dispatched; later remove events at the index
   * belong to a newer tenant. A Create drained before the Destroy (the tenant's own same-window
   * mint) leaves the entry in place.
   */
  supersedePending(index: number): void {
    // Same staging argument as noteDestroyDrained: empty stays empty mid-drain — skip the lookup.
    if (this.#pending.size === 0) return
    const list = this.#pending.get(index)
    if (list === undefined || list.length === 0) return
    if (!(list[0] as PendingClear).destroyDrained) return
    list.shift()
    if (list.length === 0) this.#pending.delete(index)
  }

  /**
   * Despawn handler. When no held component has a remove-observer, clear
   * data[index] eagerly so the JS reference is released for GC. When one does, DEFER: stash the
   * dying values (gen-only when the tenant held no rich field) so an onRemove handler can read them
   * during the drain (RF-REMOVE-READ), then flush at the post-observer point (flushPending).
   *
   * Called for EVERY despawn (the per-index despawn ordinal must count every deferred despawn —
   * noteDestroyDrained pairs drain-side Destroy entries by it). `gen` is the dying handle's
   * generation (stamped into the stash so observer-window reads can be keyed to the dead tenant).
   * `richKeysOnEntity` are the sidecar keys the entity actually held (its signature's rich fields);
   * only those are stashed/cleared. `defer` is true iff any held component has a remove-observer.
   */
  onDespawn(index: number, gen: number, richKeysOnEntity: readonly SidecarKey[], defer: boolean, windowArmed: boolean): void {
    // Inert when the world has neither rich columns NOR any remove-observer: no stash can exist, so
    // neither the despawn ordinal nor a pending entry would be consulted — skip, keeping the
    // no-observer numeric-only despawn free of all window cost.
    if (this.#cols.size === 0 && !windowArmed) return
    // Count EVERY despawn at the index while armed — despawnsBefore pairs a tenant with its
    // drain-side Destroy entry, and an interleaved non-deferred despawn consumes an ordinal too.
    const despawnsBefore = this.#despawnSeq.get(index) ?? 0
    this.#despawnSeq.set(index, despawnsBefore + 1)
    if (defer) {
      // EVERY deferred despawn stashes — a rich-free tenant gets a values-empty entry whose
      // generation + location still bind its drained events to its OWN dead handle (eventRefOf):
      // a rich read hits the generation guard (default), a numeric read resolves the stashed
      // location, and neither sees a same-window successor.
      const values = new Map<SidecarKey, unknown>()
      for (const key of richKeysOnEntity) {
        const col = this.#cols.get(key)
        if (col === undefined) continue
        const v = index < col.written.length && col.written[index] === 1 ? col.data[index] : col.def
        values.set(key, v === undefined ? col.def : v)
      }
      const entry: PendingClear = { gen, values, despawnsBefore, destroyDrained: false, archId: -1, row: -1 }
      const list = this.#pending.get(index)
      if (list === undefined) this.#pending.set(index, [entry])
      else list.push(entry)
    }
    // Whether deferred or not, the live slot is invalidated now: a recycled index must not read this
    // tenant's value. The generation guard already protects correctness; clearing releases the GC ref.
    for (const key of richKeysOnEntity) this.#clearSlot(key, index)
  }

  /**
   * Stamp the dying tenant's final archetype location onto the entry its `onDespawn` just created —
   * called AFTER storage.onDespawn (the deferred swap-pop has settled the dying row), only for a
   * deferred despawn. The latest entry for `index` is that tenant's.
   */
  setPendingLocation(index: number, archId: number, row: number): void {
    const list = this.#pending.get(index)
    const entry = list?.[list.length - 1]
    if (entry !== undefined && entry.archId === -1) {
      entry.archId = archId
      entry.row = row
    }
  }

  /**
   * The dying tenant's stashed (archId, row) for `index` at generation `gen`, or undefined. The
   * resolver shim consults this for a dead-tenant ref before resolving through the live records that
   * a same-window re-mint has overwritten. Mirrors readForObserver's gen match.
   */
  locationForObserver(index: number, gen: number): { archId: number; row: number } | undefined {
    const list = this.#pending.get(index)
    if (list === undefined) return undefined
    for (const pend of list) {
      if (pend.gen === gen && pend.archId !== -1) return { archId: pend.archId, row: pend.row }
    }
    return undefined
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
    this.#despawnSeq.clear()
    this.#destroysDrained.clear()
  }

  hasPending(): boolean {
    return this.#pending.size > 0
  }

  columns(): IterableIterator<[SidecarKey, SidecarColumn]> {
    return this.#cols.entries()
  }
}
