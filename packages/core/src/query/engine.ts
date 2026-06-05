// The query engine: the canonical-hash dedup cache (Map<hash, LiveQuery>),
// the per-archetype matching (signatureMatches over matchingArchetypes — O(A), NOT per-entity), the
// archetypeCreated incremental upkeep, the reverse queriesReferencing index, and the single-entity
// incremental matcher (matchEntity over entityShapeWords) used ONLY to re-test one migrated entity.
//
// Wired by the world: it subscribes to storage.onArchetypeCreated and supplies storage's
// maintainEntity / dropEntity hooks. All matching/maintenance is serial / main-thread.

import type { ComponentId, QueryTerm, Schema } from '@ecsia/schema'
import type { Bitmask } from '../bitmask/index.js'
import { sigHas, signatureMatches } from '../storage/index.js'
import type { Archetype, Signature } from '../storage/index.js'
import type { Buffers, RegionKey } from '../memory/index.js'
import { compileQuery } from './compile.js'
import type { CompileContext, CompiledQuery } from './compile.js'
import { LiveQuery } from './live-query.js'
import type { LiveQueryDeps, ReactivityQueryHooks } from './live-query.js'
import { SparseSetU32 } from './sparse-set.js'

export interface QueryEngineDeps extends LiveQueryDeps {
  readonly buffers: Buffers
  readonly bitmask: Bitmask
  readonly maxEntities: number
  /** The dense archetype list (store.byId), walked once to seed a new query. */
  readonly byId: Archetype[]
  /** Subscribe to archetypeCreated so new archetypes join matching live queries. */
  onArchetypeCreated(fn: (arch: Archetype) => void): void
  /** Resolve a registered component's id (and the fixed bitmask bit count) for compilation. */
  readonly compileContext: CompileContext
  /** index → its CURRENT signature (resolveLocation → archetype.signature) for residual terms. */
  signatureOf(index: number): Signature
  /** Full handle (from a dense rows[] slot) → its entity index (low handle bits). */
  indexOfHandle(handle: number): number
}

export class QueryEngine {
  readonly #deps: QueryEngineDeps
  readonly #byHash = new Map<string, LiveQuery>()
  /** componentId → the live queries that reference it (reverse maintenance index). */
  readonly #referencing = new Map<number, Set<LiveQuery>>()
  #reactivity: ReactivityQueryHooks | null = null
  #seq = 0

  constructor(deps: QueryEngineDeps) {
    this.#deps = deps
    deps.onArchetypeCreated((arch) => this.#onArchetypeCreated(arch))
  }

  /** Late-bind the reactivity write-log hooks so the Changed flavor works (world wiring). */
  setReactivity(hooks: ReactivityQueryHooks): void {
    this.#reactivity = hooks
    for (const lq of this.#byHash.values()) lq.__setReactivity(hooks)
  }

  /**: compile, dedup by canonical hash, seed on a miss. */
  query(terms: readonly QueryTerm[]): LiveQuery {
    const compiled = compileQuery(terms, this.#deps.compileContext)
    const existing = this.#byHash.get(compiled.hash)
    if (existing !== undefined) {
      existing.ensureValueSignature(compiled)
      return existing
    }
    const lq = this.#createLiveQuery(compiled, terms)
    this.#byHash.set(compiled.hash, lq)
    return lq
  }

  /** Exposed for the world facade / tests: iterate every live query (e.g. for frameReset). */
  get liveQueries(): IterableIterator<LiveQuery> {
    return this.#byHash.values()
  }

  // ---: allocate the result container, seed all existing archetypes ----------

  #createLiveQuery(compiled: CompiledQuery, terms: readonly QueryTerm[]): LiveQuery {
    const id = this.#seq++
    const denseKey = `query.${id}.dense` as RegionKey
    const sparseKey = `query.${id}.sparse` as RegionKey
    const current = new SparseSetU32(this.#deps.buffers, denseKey, sparseKey, 64, this.#deps.maxEntities)
    const lq = new LiveQuery(compiled, terms, current, this.#deps.byId, this.#deps)
    lq.ensureValueSignature(compiled)
    if (this.#reactivity !== null) lq.__setReactivity(this.#reactivity)

    if (!compiled.unsatisfiable) {
      for (const arch of this.#deps.byId) {
        if (this.#archetypeMatches(arch, compiled)) {
          lq.addMatchingArchetype(arch)
          this.#seedCurrentFromArchetype(lq, arch)
        }
      }
    }
    // Register in the reverse maintenance index for incremental upkeep.
    for (const cid of compiled.referencedIds) {
      let set = this.#referencing.get(cid as number)
      if (set === undefined) {
        set = new Set()
        this.#referencing.set(cid as number, set)
      }
      set.add(lq)
    }
    lq.lastMatchTick = 0
    return lq
  }

  // --- (one AND per signature word) ------------------------------

  #archetypeMatches(arch: Archetype, q: CompiledQuery): boolean {
    if (q.unsatisfiable) return false
    if (!signatureMatches(arch.sigWords, q.withWords, q.notWords, [])) return false
    for (const r of q.residualWith) {
      const present = sigHas(arch.signature, r.componentId)
      if (r.negate ? present : !present) return false
    }
    return true
  }

  /**
   * (a) row filter for the single-entity matcher: an exclusive specific-target pair
   * matches the archetype by presence, then this checks the entity's own eid target column value so
   * `current` stays precise (count/has agree with the iteration filter in LiveQuery).
   */
  #passesRowFilters(index: number, q: CompiledQuery): boolean {
    if (q.rowFilters.length === 0) return true
    const loc = this.#deps.resolveLocation(index)
    const arch = this.#deps.byId[loc.archetypeId]
    if (arch === undefined || arch.cold) return q.rowFilters.length === 0
    for (const rf of q.rowFilters) {
      const cs = arch.columnSets.get(rf.presenceId)
      if (cs === undefined) return false
      const col = cs.columns[rf.targetFieldIndex]
      if (col === undefined) return false
      const stored = col.view[loc.row * col.layout.stride] as number
      if (stored === -1 || (stored >>> 0) !== (rf.targetEid >>> 0)) return false
    }
    return true
  }

  /**: add every live row's entity index to `current`. New archetypes start empty. */
  #seedCurrentFromArchetype(lq: LiveQuery, arch: Archetype): void {
    if (arch.cold) {
      // Cold rows are index-keyed in the overflow store; seed from the cold archetype's residents so
      // a query created AFTER cold entities exist sees them ( cold transparency), matching the
      // per-entity maintenance path that adds residents as they migrate in.
      for (const index of this.#deps.coldResidentsOf(arch.id as number)) lq.addEntity(index)
      return
    }
    const count = arch.count
    const filters = lq.compiled.rowFilters
    for (let row = 0; row < count; row++) {
      const handle = arch.rows[row] as number
      const index = this.#handleIndex(handle)
      if (filters.length > 0 && !this.#rowPasses(arch, row, lq.compiled)) continue
      lq.addEntity(index)
    }
  }

  /** Row-filter test against a known (archetype, row) for seeding ((a)). */
  #rowPasses(arch: Archetype, row: number, q: CompiledQuery): boolean {
    for (const rf of q.rowFilters) {
      const cs = arch.columnSets.get(rf.presenceId)
      if (cs === undefined) return false
      const col = cs.columns[rf.targetFieldIndex]
      if (col === undefined) return false
      const stored = col.view[row * col.layout.stride] as number
      if (stored === -1 || (stored >>> 0) !== (rf.targetEid >>> 0)) return false
    }
    return true
  }

  #handleIndex(handle: number): number {
    // The dense rows store full handles; the entity index is the low handle bits. The engine resolves
    // it via the same bitmask stride the rest of the world uses — but here we only need the index, and
    // the record's resolveLocation already addresses by index, so derive it from the handle directly.
    return this.#deps.indexOfHandle(handle)
  }

  // ---

  #onArchetypeCreated(arch: Archetype): void {
    for (const lq of this.#byHash.values()) {
      if (this.#archetypeMatches(arch, lq.compiled)) {
        lq.addMatchingArchetype(arch)
        // A brand-new archetype starts with count 0 (entities migrate in afterward), so nothing to
        // seed here; the per-entity migration path populates `current` as entities enter. A
        // non-empty new archetype only arises via warm promotion, which re-seeds separately.
        this.#seedCurrentFromArchetype(lq, arch)
      }
    }
  }

  // --- (the ONLY per-entity AND) -------------------------

  /**: re-test ONE migrated entity against only the queries referencing the changed component. */
  maintainEntity(index: number, componentId: ComponentId): void {
    const set = this.#referencing.get(componentId as number)
    if (set === undefined) return
    for (const lq of set) {
      const wasMatch = lq.current.has(index)
      const isMatch = this.#matchesEntityNow(lq, index)
      if (isMatch && !wasMatch) lq.addEntity(index)
      else if (!isMatch && wasMatch) lq.removeEntity(index)
    }
  }

  /**
   *: a freshly spawned entity lands in the EMPTY archetype. It carries no component, so
   * the per-component `maintainEntity` path never fires for it — yet a constraint-less query (empty
   * withWords/notWords/residualWith) DOES match the empty signature and the seed already
   * includes such entities. To keep the incremental path symmetric with the seed (so a query created
   * BEFORE a plain spawn agrees with one created after), re-test the new index against every query
   * that matches the empty archetype and add it.
   */
  onEntitySpawned(index: number, emptyArchetype: Archetype): void {
    for (const lq of this.#byHash.values()) {
      if (this.#archetypeMatches(emptyArchetype, lq.compiled)) lq.addEntity(index)
    }
  }

  /**: evict a despawned entity from EVERY live query (constraint-less queries included). */
  dropEntity(index: number): void {
    for (const lq of this.#byHash.values()) lq.removeEntity(index)
  }

  /**: AND the entity's shape words against the query masks. */
  #matchesEntityNow(lq: LiveQuery, index: number): boolean {
    const q = lq.compiled
    if (q.unsatisfiable) return false
    const shape = this.#deps.bitmask.entityShapeWords(index)
    for (const t of q.notWords) if (((shape[t.wordIndex] as number) & t.mask) !== 0) return false
    for (const t of q.withWords) if (((shape[t.wordIndex] as number) & t.mask) !== t.mask) return false
    if (q.residualWith.length > 0) {
      const sig = this.#deps.signatureOf(index)
      for (const r of q.residualWith) {
        const present = sigHas(sig, r.componentId)
        if (r.negate ? present : !present) return false
      }
    }
    if (!this.#passesRowFilters(index, q)) return false
    return true
  }

  /** Reset every live query's per-frame transient flavor lists (FRAME_RESET). */
  frameReset(): void {
    for (const lq of this.#byHash.values()) lq.frameReset()
  }
}
