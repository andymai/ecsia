// LiveQuery (queries.md §5.1, §9): the cached runtime object for one canonical query hash. Owns the
// matchingArchetypes pointer cache (kept current by the archetypeCreated hook + the seed), the
// `current` sparse-set result container, and the per-value-signature cursor/element bindings that
// surface the accessor singletons during iteration.
//
// Matching state (current, matchingArchetypes, maintenance) is SHARED across value-signatures by
// hash; only the cursor/element binding is per value-signature (§4.1 subtlety). Iteration walks the
// matchingArchetypes contiguous rows (the hot path, O(A) matched at archetype creation, NOT per
// entity) and pokes the per-(archetype, component) accessor singleton — zero allocation per row.

import type { ArchetypeId, ComponentId, EntityHandle, Schema } from '@ecsia/schema'
import type { ColumnSet } from '../component/index.js'
import type { Archetype } from '../storage/index.js'
import type { CompiledQuery, CompiledValueTerm } from './compile.js'
import type { SparseSetU32 } from './sparse-set.js'

const NO_HANDLE = 0xffffffff as EntityHandle

/** The pooled element handed to each callback: value props (per value term) + the entity handle. */
type PooledElement = Record<string, unknown> & { handle: EntityHandle }

/** The accessor singletons whose __idx/__eid the cursor pokes for an (archetype, value-sig). */
type Accessors = ReadonlyArray<{ __idx: number; __eid: EntityHandle }>

/** A cold value-term binding: its accessor singleton (on the per-type cold block) + its component id,
 * so the cursor can poke __idx to THIS entity's cold row (per (index, componentId), §12). */
interface ColdSlot {
  readonly accessor: { __idx: number; __eid: EntityHandle }
  readonly componentId: ComponentId
}

interface ValueBinding {
  readonly valueTerms: readonly CompiledValueTerm[]
  /** Per-archetype pooled element (props are bound accessor singletons; §9.3). Built at match time. */
  readonly elements: Map<number, PooledElement>
  /**
   * Per-archetype accessor singleton list (§5.3 / §9.2): built ONCE at match time alongside the
   * element, reused across each()/iterator calls so the hot path allocates nothing per call.
   */
  readonly accessors: Map<number, Accessors>
  /** Per-COLD-archetype pooled element (props read the per-type cold blocks). Kept separate from the
   * hot `elements` map so a cold→hot warm promotion (same archetype id) never reuses a stale element. */
  readonly coldElements: Map<number, PooledElement>
  /** Per-COLD-archetype slot list (accessor + componentId) — cold rows are per (index, component). */
  readonly coldSlots: Map<number, readonly ColdSlot[]>
}

/**
 * Transient per-frame flavor lists (queries.md §7.4 / §8). Allocated only when a flavor is declared.
 * `added`/`removed` are net per frame (Q-F1): remove-then-add and add-then-remove within one frame
 * cancel out. The cancellation is achieved by tracking which side a transition is currently on —
 * adding an index that is pending-removed cancels the removal; removing a pending-added one cancels
 * the addition (the single-drain net-effect bitECS gets from toRemove + commitRemovals).
 */
interface DeltaLists {
  readonly added: Set<number>
  readonly removed: Set<number>
  hasAdded: boolean
  hasRemoved: boolean
}

/** The reactivity write-log hooks the Changed flavor drives (reactivity.md §10 ReactivityQueryHooks). */
export interface ReactivityQueryHooks {
  /** §5.1: allocate this query's changed-flavor LogPointer + dedup bitset (idempotent). */
  attachChangedFlavor(q: LiveQuery, componentIds: Iterable<number>): void
  /** §5.3: drain this frame's changed entity indices (deduped, intersected with `current`). */
  drainChanged(q: LiveQuery): Uint32Array
}

export interface LiveQueryDeps {
  /** index → its (archetypeId, row) — the entity record (entity-model.md §4.3). */
  resolveLocation(index: number): { archetypeId: number; row: number }
  /** index → its full EntityHandle (generation from the entity layer). */
  handleOf(index: number): EntityHandle
  /**
   * The entity indices currently resident in cold archetype `archetypeId` (§12). Backed by the
   * ColdStore's per-archetype membership so cold iteration is O(rows in that archetype), NOT
   * O(|current|) per cold archetype.
   */
  coldResidentsOf(archetypeId: number): Iterable<number>
  /** The cold per-TYPE ColumnSet for `componentId` (cold blocks are keyed by component, not archetype). */
  coldColumnSet(componentId: ComponentId): ColumnSet | undefined
  /** The cold-block row holding `componentId`'s fields for entity `index`, or -1 if absent (§12). */
  coldRowOf(index: number, componentId: ComponentId): number
}

export class LiveQuery {
  readonly compiled: CompiledQuery
  readonly terms: readonly unknown[]
  readonly matchingArchetypes: Archetype[] = []
  readonly current: SparseSetU32
  readonly #byId: Archetype[]
  readonly #deps: LiveQueryDeps
  readonly #bindings = new Map<string, ValueBinding>()
  #delta: DeltaLists | null = null
  #reactivity: ReactivityQueryHooks | null = null
  #changedDeclared = false
  lastMatchTick = 0

  constructor(
    compiled: CompiledQuery,
    terms: readonly unknown[],
    current: SparseSetU32,
    byId: Archetype[],
    deps: LiveQueryDeps,
  ) {
    this.compiled = compiled
    this.terms = terms
    this.current = current
    this.#byId = byId
    this.#deps = deps
  }

  get count(): number {
    return this.current.size
  }

  // --- flavor declaration (queries.md §8.1) ----------------------------------

  #ensureDelta(): DeltaLists {
    if (this.#delta === null) {
      this.#delta = { added: new Set(), removed: new Set(), hasAdded: false, hasRemoved: false }
    }
    return this.#delta
  }

  /** Chainable flavor declarations (queries.md §8.1). Allocate nothing for undeclared flavors. */
  added(): this {
    this.#ensureDelta().hasAdded = true
    return this
  }
  removed(): this {
    this.#ensureDelta().hasRemoved = true
    return this
  }
  /** Install the reactivity write-log hooks (world wiring); enables the Changed flavor. */
  __setReactivity(hooks: ReactivityQueryHooks): void {
    this.#reactivity = hooks
    if (this.#changedDeclared) this.#attachChanged()
  }

  changed(...components: ReadonlyArray<unknown>): this {
    // §8.3: the Changed flavor drains the reactivity WRITE LOG (not changeVersion — R-2). The filtered
    // component set is the explicit `components` argument, or the query's whole referenced set when
    // omitted.
    this.#ensureDelta()
    this.#changedDeclared = true
    this.#changedComponents = this.#resolveChangedComponents(components)
    this.#attachChanged()
    return this
  }

  #changedComponents: readonly number[] = []

  #resolveChangedComponents(components: ReadonlyArray<unknown>): readonly number[] {
    if (components.length === 0) return this.compiled.referencedIds as unknown as readonly number[]
    const out: number[] = []
    for (const c of components) {
      const id = (c as { id?: number }).id
      if (typeof id === 'number') out.push(id)
    }
    return out
  }

  #attachChanged(): void {
    if (this.#reactivity === null || !this.#changedDeclared) return
    this.#reactivity.attachChangedFlavor(this, this.#changedComponents)
  }

  /** Reset per-frame transient flavor lists (FRAME_RESET, queries.md §8.2). */
  frameReset(): void {
    if (this.#delta !== null) {
      this.#delta.added.clear()
      this.#delta.removed.clear()
    }
  }

  // --- value-signature bindings (§4.1 subtlety) ------------------------------

  /** The value-role signature: the P/W-tagged value subset, read-vs-write distinguished. */
  static valueSignature(compiled: CompiledQuery): string {
    if (compiled.valueTerms.length === 0) return ''
    const parts = compiled.valueTerms.map((vt) => vt.role + ':' + (vt.componentId as number))
    parts.sort()
    return parts.join('|')
  }

  ensureValueSignature(compiled: CompiledQuery): void {
    const sig = LiveQuery.valueSignature(compiled)
    if (this.#bindings.has(sig)) return
    this.#bindings.set(sig, {
      valueTerms: compiled.valueTerms,
      elements: new Map(),
      accessors: new Map(),
      coldElements: new Map(),
      coldSlots: new Map(),
    })
  }

  #binding(sig: string): ValueBinding {
    let b = this.#bindings.get(sig)
    if (b === undefined) {
      b = {
        valueTerms: this.compiled.valueTerms,
        elements: new Map(),
        accessors: new Map(),
        coldElements: new Map(),
        coldSlots: new Map(),
      }
      this.#bindings.set(sig, b)
    }
    return b
  }

  // --- matching-set maintenance (queries.md §5.3 / §6) -----------------------

  /** Append a newly-created (or seeded) archetype to the pointer cache. */
  addMatchingArchetype(arch: Archetype): void {
    this.matchingArchetypes.push(arch)
  }

  /** §6.1: add an entity index to `current`, recording a NET `added` delta (Q-F1) where declared. */
  addEntity(index: number): void {
    if (this.current.has(index)) return
    this.current.add(index)
    const d = this.#delta
    if (d === null) return
    if (d.removed.delete(index)) return // remove-then-add this frame → net no-op
    if (d.hasAdded) d.added.add(index)
  }

  /** §6.1: remove an entity index from `current`, recording a NET `removed` delta (Q-F1) where declared. */
  removeEntity(index: number): void {
    if (!this.current.has(index)) return
    this.current.remove(index)
    const d = this.#delta
    if (d === null) return
    if (d.added.delete(index)) return // add-then-remove this frame → net no-op
    if (d.hasRemoved) d.removed.add(index)
  }

  // --- iteration (queries.md §9) ---------------------------------------------

  /** The hot loop: walk matchingArchetypes contiguous rows, poke the accessor singletons, call fn. */
  each(fn: (e: PooledElement) => void): void {
    const sig = LiveQuery.valueSignature(this.compiled)
    const binding = this.#binding(sig)
    for (const arch of this.matchingArchetypes) {
      if (arch.cold) {
        this.#eachCold(arch, binding, fn)
        continue
      }
      const count = arch.count
      if (count === 0) continue
      const el = this.#elementFor(arch, binding)
      const accessors = this.#accessorsFor(arch, binding)
      for (let row = 0; row < count; row++) {
        for (const a of accessors) {
          a.__idx = row
        }
        const handle = (arch.rows[row] as number) as unknown as EntityHandle
        el.handle = handle
        for (const a of accessors) {
          a.__eid = handle
        }
        fn(el)
      }
    }
  }

  *[Symbol.iterator](): Iterator<PooledElement> {
    // A simple eager collection of (archetype,row) snapshots would allocate; instead drive `each`
    // through a buffered generator that yields the SAME pooled element per archetype. Single active
    // iteration is the contract (§9.1) — do not store the element across yields.
    const sig = LiveQuery.valueSignature(this.compiled)
    const binding = this.#binding(sig)
    for (const arch of this.matchingArchetypes) {
      if (arch.cold) {
        yield* this.#eachColdGen(arch, binding)
        continue
      }
      if (arch.count === 0) continue
      const el = this.#elementFor(arch, binding)
      const accessors = this.#accessorsFor(arch, binding)
      for (let row = 0; row < arch.count; row++) {
        for (const a of accessors) a.__idx = row
        const handle = (arch.rows[row] as number) as unknown as EntityHandle
        el.handle = handle
        for (const a of accessors) a.__eid = handle
        yield el
      }
    }
  }

  eachAdded(fn: (e: PooledElement) => void): void {
    const d = this.#delta
    if (d === null || !d.hasAdded) return
    this.#eachScattered([...d.added], fn)
  }

  eachRemoved(fn: (index: number, handle: EntityHandle) => void): void {
    const d = this.#delta
    if (d === null || !d.hasRemoved) return
    for (const index of d.removed) fn(index, this.#deps.handleOf(index))
  }

  /**
   * §8.3: the Changed filter reads the reactivity WRITE LOG, not changeVersion. The write log lands
   * at M5; until then there are no recorded writes, so the changed set is empty. The matching surface
   * (binding the cursor per changed index, §9.5) is in place for M5 to fill the index source.
   */
  eachChanged(fn: (e: PooledElement) => void): void {
    // §5.3: drain the write-log changed set (deduped, intersected with `current`), then bind the
    // cursor per scattered index. The changed set spans multiple archetypes, so reuse #eachScattered.
    if (this.#reactivity === null || !this.#changedDeclared) return
    const indices = this.#reactivity.drainChanged(this)
    this.#eachScattered(indices, fn)
  }

  // --- internals -------------------------------------------------------------

  /** §9.5: bind the cursor per scattered index (added set spans multiple archetypes). */
  #eachScattered(indices: Iterable<number>, fn: (e: PooledElement) => void): void {
    const sig = LiveQuery.valueSignature(this.compiled)
    const binding = this.#binding(sig)
    for (const index of indices) {
      const loc = this.#deps.resolveLocation(index)
      const arch = this.#byId[loc.archetypeId]
      if (arch === undefined) continue
      const handle = this.#deps.handleOf(index)
      // A cold archetype carries no per-archetype columns; its accessor singletons live on the cold
      // per-type blocks, resolved per (index, component) rather than a single hot row.
      const el = arch.cold
        ? this.#bindColdRow(arch, binding, index, handle)
        : this.#bindRow(arch, binding, loc.row, handle)
      fn(el)
    }
  }

  /** Bind a hot (archetype, value-sig) element + accessors to one row and entity, returning the element. */
  #bindRow(arch: Archetype, binding: ValueBinding, row: number, handle: EntityHandle): PooledElement {
    const el = this.#elementFor(arch, binding)
    const accessors = this.#accessorsFor(arch, binding)
    for (const a of accessors) {
      a.__idx = row
      a.__eid = handle
    }
    el.handle = handle
    return el
  }

  /** Bind a cold row: each value-term's accessor lands on its own per-component cold-block row (§12). */
  #bindColdRow(arch: Archetype, binding: ValueBinding, index: number, handle: EntityHandle): PooledElement {
    const el = this.#coldElementFor(arch, binding)
    for (const slot of this.#coldSlotsFor(arch, binding)) {
      slot.accessor.__idx = this.#deps.coldRowOf(index, slot.componentId)
      slot.accessor.__eid = handle
    }
    el.handle = handle
    return el
  }

  /**
   * Cold archetypes carry no contiguous columns; resolve each resident through the record (§12).
   * O(rows in this cold archetype) — driven by the ColdStore's per-archetype membership, NOT by a
   * filter over the whole `current` set (which would be O(cold archetypes × |current|), §12 penalty).
   */
  #eachCold(arch: Archetype, binding: ValueBinding, fn: (e: PooledElement) => void): void {
    for (const index of this.#deps.coldResidentsOf(arch.id as number)) {
      fn(this.#bindColdRow(arch, binding, index, this.#deps.handleOf(index)))
    }
  }

  /** Generator twin of #eachCold for the [Symbol.iterator] surface (Q-C1 cold transparency). */
  *#eachColdGen(arch: Archetype, binding: ValueBinding): Generator<PooledElement> {
    for (const index of this.#deps.coldResidentsOf(arch.id as number)) {
      yield this.#bindColdRow(arch, binding, index, this.#deps.handleOf(index))
    }
  }

  #elementFor(arch: Archetype, binding: ValueBinding): PooledElement {
    const archId = arch.id as number
    let el = binding.elements.get(archId)
    if (el !== undefined) return el
    el = { handle: NO_HANDLE }
    for (const vt of binding.valueTerms) {
      const cs = arch.columnSets.get(vt.componentId)
      if (cs !== undefined) {
        const accessor = cs.accessor
        Object.defineProperty(el, vt.key, {
          enumerable: true,
          configurable: true,
          get: () => accessor,
        })
      } else if (vt.role === 'optional') {
        Object.defineProperty(el, vt.key, {
          enumerable: true,
          configurable: true,
          get: () => undefined,
        })
      }
      // With/Without contribute no value term, hence no prop (handled at compile time).
    }
    binding.elements.set(archId, el)
    return el
  }

  /**
   * The accessor singletons whose __idx/__eid the cursor pokes for this (archetype, value-sig).
   * Built ONCE per (archetype, value-sig) at first touch and cached on the binding (§5.3 / §9.2), so
   * the hot each()/iterator loop reuses it with zero per-call allocation.
   */
  #accessorsFor(arch: Archetype, binding: ValueBinding): Accessors {
    const archId = arch.id as number
    let cached = binding.accessors.get(archId)
    if (cached !== undefined) return cached
    const out: Array<{ __idx: number; __eid: EntityHandle }> = []
    for (const vt of binding.valueTerms) {
      const cs: ColumnSet | undefined = arch.columnSets.get(vt.componentId)
      if (cs !== undefined) out.push(cs.accessor as unknown as { __idx: number; __eid: EntityHandle })
    }
    cached = out
    binding.accessors.set(archId, cached)
    return cached
  }

  /** The pooled element for a COLD archetype — value props read the per-type cold-block accessors. */
  #coldElementFor(arch: Archetype, binding: ValueBinding): PooledElement {
    const archId = arch.id as number
    let el = binding.coldElements.get(archId)
    if (el !== undefined) return el
    el = { handle: NO_HANDLE }
    for (const vt of binding.valueTerms) {
      const cs = this.#deps.coldColumnSet(vt.componentId)
      if (cs !== undefined) {
        const accessor = cs.accessor
        Object.defineProperty(el, vt.key, { enumerable: true, configurable: true, get: () => accessor })
      } else if (vt.role === 'optional') {
        Object.defineProperty(el, vt.key, { enumerable: true, configurable: true, get: () => undefined })
      }
    }
    binding.coldElements.set(archId, el)
    return el
  }

  /** The (cold accessor, componentId) slots whose __idx the cursor pokes to each entity's cold row. */
  #coldSlotsFor(arch: Archetype, binding: ValueBinding): readonly ColdSlot[] {
    const archId = arch.id as number
    let cached = binding.coldSlots.get(archId)
    if (cached !== undefined) return cached
    const out: ColdSlot[] = []
    for (const vt of binding.valueTerms) {
      const cs = this.#deps.coldColumnSet(vt.componentId)
      if (cs !== undefined) {
        out.push({
          accessor: cs.accessor as unknown as { __idx: number; __eid: EntityHandle },
          componentId: vt.componentId,
        })
      }
    }
    cached = out
    binding.coldSlots.set(archId, cached)
    return cached
  }
}

export type { PooledElement }
export { NO_HANDLE }
export type { ArchetypeId, ComponentId, Schema }
