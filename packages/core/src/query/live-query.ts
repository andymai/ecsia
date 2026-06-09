// LiveQuery: the cached runtime object for one canonical query hash. Owns the
// matchingArchetypes pointer cache (kept current by the archetypeCreated hook + the seed), the
// `current` sparse-set result container, and the per-value-signature cursor/element bindings that
// surface the accessor singletons during iteration.
//
// Matching state (current, matchingArchetypes, maintenance) is SHARED across value-signatures by
// hash; only the cursor/element binding is per value-signature. Iteration walks the
// matchingArchetypes contiguous rows (the hot path, O(A) matched at archetype creation, NOT per
// entity) and pokes the per-(archetype, component) accessor singleton — zero allocation per row.

import type {
  ArchetypeId,
  BoundColumnsMeta,
  ComponentDef,
  ComponentId,
  EntityHandle,
  FieldDescriptor,
  QueryTerm,
  Schema,
} from '@ecsia/schema'
import type { ColumnSet } from '../component/index.js'
import type { Archetype } from '../storage/index.js'
import type { Column, TypedArray } from '../memory/index.js'
import { decodeEid } from '../memory/index.js'
import { IS_DEV } from '../env.js'
import type { CompiledQuery, CompiledValueTerm, RowFilterTerm } from './compile.js'
import type { SparseSetU32 } from './sparse-set.js'
import { buildPinnedRunner } from './codegen.js'
import type { PinnedFactory } from './codegen.js'
import { analyzeEachBody } from './compile-each.js'

const NO_HANDLE = 0xffffffff as EntityHandle

/** The reactivity write-path seam a compiled loop needs, read off an accessor singleton's binding. */
interface WorldSeam {
  trackWrite(index: number, componentId: number, fieldIndex?: number): void
  handleIndex(handle: EntityHandle): number
  readonly tracking: { readonly active: boolean }
}

/** Stand-in seam for a read-only compiled body (it is never called; keeps the runner total). */
const NOOP_SEAM: WorldSeam = {
  trackWrite: () => {},
  handleIndex: (h) => h as unknown as number,
  tracking: { active: false },
}

/** The bundle a generated `compile` factory destructures: bound columns + the reactivity seam + count. */
interface CompileArgs {
  readonly views: readonly TypedArray[]
  readonly arch: Archetype
  readonly trackWrite: (index: number, componentId: number, fieldIndex?: number) => void
  readonly tracking: { readonly active: boolean }
  readonly handleIndex: (handle: EntityHandle) => number
  readonly meta: { readonly count: number }
}

/** Recover the ComponentDef a query term carries (`write(C)`/`read(C)` wrap it as `.c`; a bare def is C). */
function termComponentDef(t: unknown): ComponentDef<Schema> | null {
  if (t === null || typeof t !== 'object') return null
  const wrapped = (t as { c?: unknown }).c
  if (wrapped !== undefined && wrapped !== null && (wrapped as { fields?: unknown }).fields !== undefined) {
    return wrapped as ComponentDef<Schema>
  }
  if ((t as { fields?: unknown }).fields !== undefined && typeof (t as { name?: unknown }).name === 'string') {
    return t as ComponentDef<Schema>
  }
  return null
}

/** The pooled element handed to each callback: value props (per value term) + the entity handle. */
type PooledElement = Record<string, unknown> & { handle: EntityHandle }

/** The accessor singletons whose __idx/__eid the cursor pokes for an (archetype, value-sig). */
type Accessors = ReadonlyArray<{ __idx: number; __eid: EntityHandle }>

/** A cold value-term binding: its accessor singleton (on the per-type cold block) + its component id,
 * so the cursor can poke __idx to THIS entity's cold row (per (index, componentId)). */
interface ColdSlot {
  readonly accessor: { __idx: number; __eid: EntityHandle }
  readonly componentId: ComponentId
}

interface ValueBinding {
  readonly valueTerms: readonly CompiledValueTerm[]
  /** Per-archetype pooled element (props are bound accessor singletons). Built at match time. */
  readonly elements: Map<number, PooledElement>
  /**
   * Per-archetype accessor singleton list: built ONCE at match time alongside the
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
 * Transient per-frame flavor lists. Allocated only when a flavor is declared.
 * `added`/`removed` are net per frame: remove-then-add and add-then-remove within one frame
 * cancel out. The cancellation is achieved by tracking which side a transition is currently on —
 * adding an index that is pending-removed cancels the removal; removing a pending-added one cancels
 * the addition (the single-drain net-effect bitECS gets from toRemove + commitRemovals).
 */
interface DeltaLists {
  readonly added: Set<number>
  // index → the handle the entity carried AT removal time. Captured eagerly because despawn bumps the
  // slot's generation (index-allocator freeEntity) AFTER the removal is recorded — re-deriving the
  // handle via handleOf(index) post-despawn would surface the next slot generation, not the dead one.
  readonly removed: Map<number, EntityHandle>
  hasAdded: boolean
  hasRemoved: boolean
}

/** The reactivity write-log hooks the Changed flavor drives. */
export interface ReactivityQueryHooks {
  /**: allocate this query's changed-flavor LogPointer + dedup bitset (idempotent). */
  attachChangedFlavor(q: LiveQuery, componentIds: Iterable<number>): void
  /**: drain this frame's changed entity indices (deduped, intersected with `current`). */
  drainChanged(q: LiveQuery): Uint32Array
}

export interface LiveQueryDeps {
  /** index → its (archetypeId, row) — the entity record. */
  resolveLocation(index: number): { archetypeId: number; row: number }
  /** index → its full EntityHandle (generation from the entity layer). */
  handleOf(index: number): EntityHandle
  /**
   * Dev-only re-entrancy guard: the world arms a flag for the duration of an each/eachChunk/iterator
   * run so its structural mutators can throw on a mutation that would corrupt the live iteration.
   */
  beginIteration(): void
  endIteration(): void
  /**
   * The entity indices currently resident in cold archetype `archetypeId`. Backed by the
   * ColdStore's per-archetype membership so cold iteration is O(rows in that archetype), NOT
   * O(|current|) per cold archetype.
   */
  coldResidentsOf(archetypeId: number): Iterable<number>
  /** The cold per-TYPE ColumnSet for `componentId` (cold blocks are keyed by component, not archetype). */
  coldColumnSet(componentId: ComponentId): ColumnSet | undefined
  /** The cold-block row holding `componentId`'s fields for entity `index`, or -1 if absent. */
  coldRowOf(index: number, componentId: ComponentId): number
}

export class LiveQuery {
  readonly compiled: CompiledQuery
  readonly terms: readonly unknown[]
  readonly matchingArchetypes: Archetype[] = []
  readonly current: SparseSetU32
  readonly #byId: Archetype[]
  readonly #deps: LiveQueryDeps
  readonly #queryFn: ((terms: readonly QueryTerm[]) => LiveQuery) | null
  readonly #bindings = new Map<string, ValueBinding>()
  #delta: DeltaLists | null = null
  #reactivity: ReactivityQueryHooks | null = null
  #changedDeclared = false
  #chunk: QueryChunk | null = null
  lastMatchTick = 0

  constructor(
    compiled: CompiledQuery,
    terms: readonly unknown[],
    current: SparseSetU32,
    byId: Archetype[],
    deps: LiveQueryDeps,
    queryFn: ((terms: readonly QueryTerm[]) => LiveQuery) | null = null,
  ) {
    this.compiled = compiled
    this.terms = terms
    this.current = current
    this.#byId = byId
    this.#deps = deps
    this.#queryFn = queryFn
  }

  get count(): number {
    return this.current.size
  }

  /**
   * Derive a narrower query: sugar over `world.query([...this.terms, ...terms])`, riding the same
   * canonical-hash dedup — deriving is REFERENCE-identical to writing the combined query directly
   * (the hash is order-independent AND duplicate-tolerant, so chaining order is irrelevant too).
   * No new matching machinery; flavors (.added/.removed/.changed) are per cached query state, NOT
   * inherited from this one. Re-deriving a term already present collapses in the hash — deriving
   * write(P) from [read(P)] IS the cached query for [write(P)] (one shared LiveQuery; the
   * read/write role split stays per value-signature binding).
   */
  derive(...terms: readonly QueryTerm[]): LiveQuery {
    if (this.#queryFn === null) throw new Error('LiveQuery.derive: not attached to a query engine')
    return this.#queryFn([...(this.terms as readonly QueryTerm[]), ...terms])
  }

  // --- flavor declaration ----------------------------------

  #ensureDelta(): DeltaLists {
    if (this.#delta === null) {
      this.#delta = { added: new Set(), removed: new Map(), hasAdded: false, hasRemoved: false }
    }
    return this.#delta
  }

  /** Chainable flavor declarations. Allocate nothing for undeclared flavors. */
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
    // The Changed flavor drains the reactivity WRITE LOG (not changeVersion). The filtered
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

  /** Reset per-frame transient flavor lists (FRAME_RESET). */
  frameReset(): void {
    if (this.#delta !== null) {
      this.#delta.added.clear()
      this.#delta.removed.clear()
    }
  }

  // --- value-signature bindings ------------------------------

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

  /** This query's own value-signature binding (the hot path uses one fixed signature for its lifetime).
   * Resolved once and cached so `each`/iterator never re-sort+join the value signature per call. */
  #hotBindingCache: ValueBinding | null = null
  #hotBinding(): ValueBinding {
    let b = this.#hotBindingCache
    if (b === null) {
      b = this.#binding(LiveQuery.valueSignature(this.compiled))
      this.#hotBindingCache = b
    }
    return b
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

  // --- matching-set maintenance -----------------------

  /** Append a newly-created (or seeded) archetype to the pointer cache. */
  addMatchingArchetype(arch: Archetype): void {
    this.matchingArchetypes.push(arch)
  }

  /**: add an entity index to `current`, recording a NET `added` delta where declared. */
  addEntity(index: number): void {
    if (this.current.has(index)) return
    this.current.add(index)
    const d = this.#delta
    if (d === null) return
    if (d.removed.delete(index)) return // remove-then-add this frame → net no-op
    if (d.hasAdded) d.added.add(index)
  }

  /**: remove an entity index from `current`, recording a NET `removed` delta where declared. */
  removeEntity(index: number): void {
    if (!this.current.has(index)) return
    this.current.remove(index)
    const d = this.#delta
    if (d === null) return
    if (d.added.delete(index)) return // add-then-remove this frame → net no-op
    // Capture the handle now: the entity is still alive (freeEntity runs after this drop), so
    // handleOf(index) resolves the dying entity's own generation rather than the recycled next one.
    if (d.hasRemoved) d.removed.set(index, this.#deps.handleOf(index))
  }

  // --- iteration ---------------------------------------------

  /**
   * (a): an exclusive specific-target pair matches the archetype by `presenceId(R)`
   * (a signature bit) but the target is a COLUMN value — so each row is filtered by
   * `targetColumn[row] === target`. Returns true when the query has no row filters (the common case).
   */
  #passesRowFilters(arch: Archetype, row: number): boolean {
    const filters = this.compiled.rowFilters
    if (filters.length === 0) return true
    for (const rf of filters as readonly RowFilterTerm[]) {
      const cs = arch.columnSets.get(rf.presenceId)
      if (cs === undefined) return false
      const col = cs.columns[rf.targetFieldIndex]
      if (col === undefined) return false
      const stored = col.view[row * col.layout.stride] as number
      const decoded = decodeEid(stored)
      if (decoded === null) return false
      if ((decoded as number) !== (rf.targetEid >>> 0)) return false
    }
    return true
  }

  /** The hot loop: walk matchingArchetypes contiguous rows, poke the accessor singletons, call fn. */
  each(fn: (e: PooledElement) => void): void {
    if (!IS_DEV) return this.#eachImpl(fn)
    this.#deps.beginIteration()
    try {
      this.#eachImpl(fn)
    } finally {
      this.#deps.endIteration()
    }
  }

  #eachImpl(fn: (e: PooledElement) => void): void {
    const binding = this.#hotBinding()
    const hasRowFilters = this.compiled.rowFilters.length !== 0
    const archs = this.matchingArchetypes
    for (let ai = 0; ai < archs.length; ai++) {
      const arch = archs[ai] as Archetype
      if (arch.cold) {
        this.#eachCold(arch, binding, fn)
        continue
      }
      const count = arch.count
      if (count === 0) continue
      const el = this.#elementFor(arch, binding)
      const accessors = this.#accessorsFor(arch, binding)
      const na = accessors.length
      const rows = arch.rows
      for (let row = 0; row < count; row++) {
        if (hasRowFilters && !this.#passesRowFilters(arch, row)) continue
        const handle = (rows[row] as number) as unknown as EntityHandle
        for (let k = 0; k < na; k++) {
          const a = accessors[k] as { __idx: number; __eid: EntityHandle }
          a.__idx = row
          a.__eid = handle
        }
        el.handle = handle
        fn(el)
      }
    }
  }

  /**
   * Opt-in column-cursor iteration (the SoA fast path). Instead of the per-row pooled element +
   * accessor getters/setters, `eachChunk` hands the callback ONE reused {@link QueryChunk} per matched
   * (non-cold) archetype, exposing the raw typed column views + a contiguous row span. The caller indexes
   * `view[row]` directly (stride-1 scalars) — bypassing the accessor decode/encode AND the per-write
   * change-tracking push, so it lands close to a raw SoA loop. Cold archetypes (no contiguous columns)
   * are NOT visited by `eachChunk`; mix `each`/`eachCold` if a query can fragment. Writes through the
   * cursor are NOT recorded in the reactivity write log: a `.changed`/observer consumer will not see them
   * — use `each` when reactivity must observe the write.
   *
   * The chunk and its column lookups are reused across calls/archetypes — do NOT store the chunk or a
   * returned view across iterations.
   */
  eachChunk(fn: (chunk: QueryChunk) => void): void {
    if (!IS_DEV) return this.#eachChunkImpl(fn)
    this.#deps.beginIteration()
    try {
      this.#eachChunkImpl(fn)
    } finally {
      this.#deps.endIteration()
    }
  }

  #eachChunkImpl(fn: (chunk: QueryChunk) => void): void {
    const chunk = this.#chunk ?? (this.#chunk = new QueryChunk())
    const hasRowFilters = this.compiled.rowFilters.length !== 0
    const archs = this.matchingArchetypes
    for (let ai = 0; ai < archs.length; ai++) {
      const arch = archs[ai] as Archetype
      if (arch.cold || arch.count === 0) continue
      // Row filters select a SUBSET of rows; the chunk exposes a contiguous span, so skip those
      // archetypes here (correctness over the fast path) — the caller falls back to `each` for them.
      if (hasRowFilters) {
        let allPass = true
        for (let row = 0; row < arch.count; row++) {
          if (!this.#passesRowFilters(arch, row)) {
            allPass = false
            break
          }
        }
        if (!allPass) continue
      }
      chunk.__bind(arch)
      fn(chunk)
    }
  }

  /**
   * Pinned columns — the fastest iteration path, ~0.7× bitECS on the canonical bench (measured).
   * Where {@link eachChunk} re-resolves column views every call, `bindColumns` resolves each
   * `[ComponentDef, fieldName]` spec ONCE per matched hot archetype and mints that archetype's runner
   * — a persistent closure capturing the views as constants, which V8 embeds into optimized code. The
   * returned `run(ctx)` walks the bindings (matching `eachChunk` iteration order: cold archetypes
   * never visited, empty ones skipped) with one cheap safety check per binding per call.
   *
   * Per-archetype runners are CODEGEN'D (each recompiled into a distinct function so it stays a
   * specialized V8 singleton) where the runtime allows `new Function`; under strict CSP / a locked
   * sandbox it transparently falls back to the interpreted factory call. The codegen path is gated on
   * a pre-flight equality check against the interpreted runner, so it is a pure speed win that can
   * never change results. Because codegen recompiles fresh on growth, there is **NO post-growth
   * penalty** — the loop holds ~1.0 ns/entity even after columns re-back, with no pre-sizing required.
   *
   * Contract:
   * 1. The factory must be **self-contained** — it may close over NOTHING from its outer scope (the
   *    recompiled copy only sees globals). Pass per-frame inputs through the runner's `ctx` argument
   *    (hoist them to a local const before the loop: `const dt = ctx.dt`); define fixed constants
   *    inside the factory body. A factory that closes over outer scope fails the pre-flight and falls
   *    back to interpreted (correct, just unspecialized).
   * 2. `meta` is identity-stable; read `meta.count` (the live row count) inside the runner — population
   *    churn (spawn/despawn) never re-invokes the factory.
   *
   * ```ts
   * const run = q.bindColumns<{ dt: number }>(
   *   [Position, 'x'], [Velocity, 'dx'],
   *   ([px, dx], meta) => (ctx) => {
   *     const dt = ctx.dt           // hoist per-frame inputs out of the loop
   *     const count = meta.count
   *     for (let i = 0; i < count; i++) px[i] += dx[i] * dt
   *   },
   * )
   * run({ dt: 1 / 60 }) // per frame
   * ```
   *
   * The factory is re-invoked ONLY when a bound column re-backs (growth) or the matched-archetype set
   * changes (a new archetype matched, or a matched cold archetype was warm-promoted) — never on
   * population change.
   *
   * Vec fields hand their raw view through: row `r` occupies `[r*stride, (r+1)*stride)` where the
   * stride is the declared vec arity (`vec3()` → 3). Hardcode it, or read `meta.strides[specIndex]`
   * ONCE outside the hot loop (`const s = meta.strides[0]`) so the loop never repeats the lookup —
   * the same value the `eachChunk` cursor exposes via `stride()`, def-invariant across archetypes.
   * Rich fields (`'string'`/`object<T>`) carry no column and throw at bind time, as do row-filtered
   * queries (a pinned runner cannot skip rows; `eachChunk` silently skips, but a silently-skipping
   * pinned runner is a footgun) and specs naming a component the query does not REQUIRE (an
   * optional or unreferenced component may be absent from a future matching archetype, which would
   * only surface mid-run). Writes through pinned views are NOT recorded in the reactivity
   * write log: a `.changed`/observer consumer will not see them — use `each` when reactivity must
   * observe the write. Structural changes during `run()` follow the `eachChunk` discipline: collect,
   * then mutate after the loop (despawn swap-removes rows under the runner's feet).
   */
  bindColumns<Ctx = void>(
    ...args: [
      ...specs: ReadonlyArray<readonly [ComponentDef<Schema>, string]>,
      factory: PinnedFactory<Ctx>,
    ]
  ): (ctx: Ctx) => void {
    const factory = args[args.length - 1] as PinnedFactory<Ctx>
    const specs = args.slice(0, -1) as ReadonlyArray<readonly [ComponentDef<Schema>, string]>
    if (this.compiled.rowFilters.length !== 0) {
      throw new Error('bindColumns: row-filtered queries are not supported (a pinned runner cannot skip rows); use each()')
    }
    // Specs must name REQUIRED components: an optional/unreferenced component may be absent from a
    // FUTURE matching archetype, which would surface as a rebuild() throw mid-run. Required ids are
    // recovered from the packed with-words (single-bit entries) + the non-negated residual terms.
    const requiredIds = new Set<number>()
    for (const w of this.compiled.withWords) {
      requiredIds.add(w.wordIndex * 32 + (31 - Math.clz32(w.mask)))
    }
    for (const r of this.compiled.residualWith) {
      if (!r.negate) requiredIds.add(r.componentId as number)
    }
    for (const [def] of specs) {
      if (!requiredIds.has(def.id as number)) {
        throw new Error(
          `bindColumns: '${def.name}' is not a required component of this query — a future matching archetype may lack it`,
        )
      }
    }
    // Per-spec column index within the component's ColumnSet (rich fields contribute no column, so
    // the index counts only ctor-backed fields — same skip rule as the ColumnSet build order).
    const colIndices = specs.map(([def, field]) => {
      let idx = 0
      for (const f of def.fields as readonly FieldDescriptor[]) {
        if (f.name === field) {
          if (f.ctor === null) {
            throw new Error(`bindColumns: '${def.name}.${field}' is a rich field ('string'/object<T>) and has no column`)
          }
          return idx
        }
        if (f.ctor !== null) idx += 1
      }
      throw new Error(`bindColumns: component '${def.name}' has no column-backed field '${field}'`)
    })

    interface PinnedBinding {
      readonly arch: Archetype
      readonly cols: readonly Column[]
      views: readonly TypedArray[]
      runner: (ctx: Ctx) => void
      readonly meta: BoundColumnsMeta
      readonly strides: readonly number[]
    }

    // Bindings are keyed by archetype id and PRESERVED across rebuilds: a rebuild only mints
    // bindings for archetypes it has not seen, so an archetype-set change never re-invokes the
    // factories of already-bound archetypes (re-invocation would disable their specialization).
    const byArch = new Map<number, PinnedBinding>()
    let bindings: PinnedBinding[] = []
    // The matched cold archetypes at last rebuild: warm promotion flips `arch.cold` IN PLACE
    // (same object, same matchingArchetypes slot), so neither the array length nor element identity
    // signals it — the promoted archetype's own flag is the only observable.
    let coldMatched: Archetype[] = []
    let boundMatchCount = -1

    const reinvoke = (b: PinnedBinding): void => {
      // Re-build through codegen on growth: a FRESH recompiled factory keeps the new runner a
      // specialized singleton (re-invoking the same factory would forfeit specialization).
      b.views = b.cols.map((c) => c.view)
      b.runner = buildPinnedRunner(factory, b.views, b.meta, b.strides)
    }

    const makeBinding = (arch: Archetype): PinnedBinding => {
      const cols = specs.map(([def, field], i) => {
        const cs = arch.columnSets.get(def.id as ComponentId)
        if (cs === undefined) {
          throw new Error(`bindColumns: archetype lacks component '${def.name}' (not in this query?)`)
        }
        const col = cs.columns[colIndices[i] as number]
        if (col === undefined) throw new Error(`bindColumns: missing column for '${def.name}.${field}'`)
        return col
      })
      const views = cols.map((c) => c.view)
      // Per-spec slots-per-row (1 scalar, N for vecN), in spec order — the same value the eachChunk
      // cursor exposes via `c.stride(def, field)`. Def-invariant across archetypes (the vec arity is
      // a property of the field), so every binding's array is equal; read it ONCE outside the hot
      // loop (`const s = meta.strides[0]`) to index a vec view without hardcoding the arity, keeping
      // the loop specialization-friendly.
      const strides: readonly number[] = cols.map((c) => c.layout.stride)
      const meta: BoundColumnsMeta = {
        get count(): number {
          return arch.count
        },
        strides,
      }
      return { arch, cols, views, runner: buildPinnedRunner(factory, views, meta, strides), meta, strides }
    }

    // Builds into locals and commits at the end so a makeBinding throw (defensive backstop; the
    // bind-time required-component check makes it unreachable for absent-component causes) never
    // leaves bindings/coldMatched/boundMatchCount mutually inconsistent.
    const rebuild = (): void => {
      const archs = this.matchingArchetypes
      const nextBindings: PinnedBinding[] = []
      const nextColdMatched: Archetype[] = []
      for (let ai = 0; ai < archs.length; ai++) {
        const arch = archs[ai] as Archetype
        if (arch.cold) {
          nextColdMatched.push(arch)
          continue
        }
        let b = byArch.get(arch.id as number)
        if (b === undefined) {
          b = makeBinding(arch)
          byArch.set(arch.id as number, b)
        }
        nextBindings.push(b)
      }
      bindings = nextBindings
      coldMatched = nextColdMatched
      boundMatchCount = archs.length
    }

    rebuild()

    return (ctx: Ctx) => {
      // Archetype-set check: matchingArchetypes is append-only (lastMatchTick is never bumped), so
      // a length change is the complete new-match signal; the cold flags cover warm promotion.
      if (this.matchingArchetypes.length !== boundMatchCount) {
        rebuild()
      } else {
        for (let i = 0; i < coldMatched.length; i++) {
          if (!(coldMatched[i] as Archetype).cold) {
            rebuild()
            break
          }
        }
      }
      const bs = bindings
      for (let bi = 0; bi < bs.length; bi++) {
        const b = bs[bi] as PinnedBinding
        // View-identity check: Column records are stable; only a fallback grow replaces `.view`
        // (the resizable primary path auto-widens the SAME view, and the SAB #growGeneration never
        // bumps on the serial grow-patch path — col.view identity is the one correct signal).
        const cols = b.cols
        const views = b.views
        for (let i = 0; i < cols.length; i++) {
          if ((cols[i] as Column).view !== views[i]) {
            reinvoke(b)
            break
          }
        }
        if (b.arch.count !== 0) b.runner(ctx)
      }
    }
  }

  /**
   * Compile an ergonomic `.each` body into the fast column loop `bindColumns` runs — without you naming
   * columns or restating the math. `compile` reads the callback's own source, rewrites `e.<comp>.<field>`
   * to direct typed-array indexing, and codegens a specialized per-archetype loop. The result keeps the
   * readable accessor syntax but lands near `eachChunk` (~1.5 ns/entity) instead of paying the per-row
   * proxy tax (~10 ns/entity).
   *
   * Unlike `bindColumns`, this path PRESERVES reactivity: a component the body writes is recorded in the
   * write log exactly as the accessor setter would, so `.changed()` filters and observers see it — for
   * free when no consumer is registered (the same gate the accessor uses), at write-log cost when one is.
   *
   * It is a pure SPEEDUP: the analyzer is conservative and falls back to the unchanged proxy `.each` (so
   * results are always identical) whenever it cannot prove the rewrite safe — a non-straight-line body
   * (`if`/`?`/`&&`/`return`/loops/nested fns), a string/comment/template, a non-numeric-scalar field
   * (vec/bool/eid/bigint/rich), a component the query does not REQUIRE, any `e` use other than
   * `e.<comp>.<field>`, a per-row `ctx` write, a row-filtered query, or a runtime that blocks `new
   * Function` (strict CSP). Call it ONCE and reuse the returned runner per frame.
   *
   * ```ts
   * const run = q.compile<{ dt: number }>((e, ctx) => {
   *   e.position.x += e.velocity.dx * ctx.dt
   *   e.position.y += e.velocity.dy * ctx.dt
   * })
   * run({ dt: 1 / 60 }) // per frame — same result as q.each(e => ...), faster
   * ```
   */
  compile<Ctx = void>(body: (e: PooledElement, ctx: Ctx) => void): (ctx: Ctx) => void {
    const proxyRun = (ctx: Ctx): void => this.each((e) => body(e, ctx))
    // A flat compiled loop cannot skip rows; row-filtered queries stay on the proxy (which can).
    if (this.compiled.rowFilters.length !== 0) return proxyRun

    const valueKeys = new Set(this.compiled.valueTerms.map((vt) => vt.key))
    const defByName = new Map<string, ComponentDef<Schema>>()
    for (const t of this.terms) {
      const def = termComponentDef(t)
      if (def !== null && valueKeys.has(def.name)) defByName.set(def.name, def)
    }
    const requiredIds = this.#requiredComponentIds()
    const plan = analyzeEachBody(body as unknown as (...a: never[]) => unknown, {
      defByName: (n) => defByName.get(n),
      idOf: (d) => ((d.id as number) >= 0 ? (d.id as number) : undefined),
      isRequired: (d) => requiredIds.has(d.id as number),
    })
    if (plan === null) return proxyRun

    // Probe up front, then SCRATCH pre-flight, both gating a proxy fallback:
    //  1. compile the generated source — a transform bug that produced malformed code (or a runtime that
    //     blocks `new Function`) throws here, deterministically.
    //  2. run the runner ONCE on 1-row throwaway typed arrays with the tracked path forced on. A body that
    //     is not self-contained — it closes over an outer variable (`const G = 9.8; … += G`) — throws a
    //     ReferenceError here, where it can be caught and demoted to the proxy, instead of crashing the
    //     first real frame (or, worse, half-integrating a row before throwing). The scratch arrays mean a
    //     mutating body can never touch real data during the probe.
    let makeFactory: () => (args: CompileArgs) => (ctx: Ctx) => void
    try {
      makeFactory = () =>
        new Function('return (' + plan.factorySource + ')')() as (args: CompileArgs) => (ctx: Ctx) => void
      const scratchViews = plan.specs.map((s) => {
        const fd = (s.def.fields as readonly FieldDescriptor[]).find((f) => f.name === s.field)
        const Ctor = fd?.ctor ?? Float64Array
        return new Ctor(1) as TypedArray
      })
      const probeArch = { rows: new Uint32Array(1), count: 1 } as unknown as Archetype
      const probeArgs: CompileArgs = {
        views: scratchViews,
        arch: probeArch,
        trackWrite: () => {},
        tracking: { active: true },
        handleIndex: () => 0,
        meta: { count: 1 },
      }
      makeFactory()(probeArgs)(new Proxy({}, { get: () => 1 }) as Ctx)
    } catch {
      return proxyRun
    }

    interface CompiledBinding {
      readonly arch: Archetype
      readonly cols: readonly Column[]
      views: readonly TypedArray[]
      runner: (ctx: Ctx) => void
      readonly meta: { readonly count: number }
    }

    let seam: WorldSeam | null = null
    const seamOf = (arch: Archetype): WorldSeam => {
      if (seam !== null) return seam
      for (const spec of plan.specs) {
        const cs = arch.columnSets.get(spec.def.id as ComponentId)
        const w = cs && (cs.accessor as { __binding?: { world?: WorldSeam } }).__binding?.world
        if (w) return (seam = w)
      }
      // Read-only bodies never call the seam; a no-op keeps the runner total even if one is unreachable.
      return (seam = NOOP_SEAM)
    }

    const argsFor = (arch: Archetype, views: readonly TypedArray[], meta: { readonly count: number }): CompileArgs => {
      const s = seamOf(arch)
      return { views, arch, trackWrite: s.trackWrite.bind(s), tracking: s.tracking, handleIndex: s.handleIndex.bind(s), meta }
    }

    const byArch = new Map<number, CompiledBinding>()
    let bindings: CompiledBinding[] = []
    let coldMatched: Archetype[] = []
    let boundMatchCount = -1

    const colsOf = (arch: Archetype): Column[] =>
      plan.specs.map((spec) => {
        const cs = arch.columnSets.get(spec.def.id as ComponentId)
        const col = cs && cs.columns[spec.colIndex]
        if (!col) throw new Error(`compile: missing column for '${spec.def.name}.${spec.field}'`)
        return col
      })

    const makeBinding = (arch: Archetype): CompiledBinding => {
      const cols = colsOf(arch)
      const views = cols.map((c) => c.view)
      const meta = {
        get count(): number {
          return arch.count
        },
      }
      return { arch, cols, views, runner: makeFactory()(argsFor(arch, views, meta)), meta }
    }

    const reinvoke = (b: CompiledBinding): void => {
      b.views = b.cols.map((c) => c.view)
      b.runner = makeFactory()(argsFor(b.arch, b.views, b.meta))
    }

    const rebuild = (): void => {
      const archs = this.matchingArchetypes
      const nextBindings: CompiledBinding[] = []
      const nextCold: Archetype[] = []
      for (let ai = 0; ai < archs.length; ai++) {
        const arch = archs[ai] as Archetype
        if (arch.cold) {
          nextCold.push(arch)
          continue
        }
        let b = byArch.get(arch.id as number)
        if (b === undefined) {
          b = makeBinding(arch)
          byArch.set(arch.id as number, b)
        }
        nextBindings.push(b)
      }
      bindings = nextBindings
      coldMatched = nextCold
      boundMatchCount = archs.length
    }

    rebuild()

    // Cold archetypes have no contiguous columns: the compiled loop cannot visit them, so a query that
    // fragments into cold storage runs those rows through the proxy (correctness over the fast path).
    return (ctx: Ctx): void => {
      if (this.matchingArchetypes.length !== boundMatchCount) {
        rebuild()
      } else {
        for (let i = 0; i < coldMatched.length; i++) {
          if (!(coldMatched[i] as Archetype).cold) {
            rebuild()
            break
          }
        }
      }
      const bs = bindings
      for (let bi = 0; bi < bs.length; bi++) {
        const b = bs[bi] as CompiledBinding
        const cols = b.cols
        const views = b.views
        for (let i = 0; i < cols.length; i++) {
          if ((cols[i] as Column).view !== views[i]) {
            reinvoke(b)
            break
          }
        }
        if (b.arch.count !== 0) b.runner(ctx)
      }
      for (let i = 0; i < coldMatched.length; i++) {
        const arch = coldMatched[i] as Archetype
        if (arch.cold) this.#eachCold(arch, this.#hotBinding(), (e) => body(e, ctx))
      }
    }
  }

  /** Required component ids: single-bit with-words + non-negated residual terms (the bindColumns rule). */
  #requiredComponentIds(): Set<number> {
    const ids = new Set<number>()
    for (const w of this.compiled.withWords) ids.add(w.wordIndex * 32 + (31 - Math.clz32(w.mask)))
    for (const r of this.compiled.residualWith) if (!r.negate) ids.add(r.componentId as number)
    return ids
  }

  *[Symbol.iterator](): Iterator<PooledElement> {
    if (!IS_DEV) {
      yield* this.#iterateImpl()
      return
    }
    this.#deps.beginIteration()
    try {
      yield* this.#iterateImpl()
    } finally {
      this.#deps.endIteration()
    }
  }

  *#iterateImpl(): Generator<PooledElement, void, unknown> {
    // A simple eager collection of (archetype,row) snapshots would allocate; instead drive `each`
    // through a buffered generator that yields the SAME pooled element per archetype. Single active
    // iteration is the contract — do not store the element across yields.
    const binding = this.#hotBinding()
    for (const arch of this.matchingArchetypes) {
      if (arch.cold) {
        yield* this.#eachColdGen(arch, binding)
        continue
      }
      if (arch.count === 0) continue
      const el = this.#elementFor(arch, binding)
      const accessors = this.#accessorsFor(arch, binding)
      const na = accessors.length
      for (let row = 0; row < arch.count; row++) {
        if (!this.#passesRowFilters(arch, row)) continue
        const handle = (arch.rows[row] as number) as unknown as EntityHandle
        for (let k = 0; k < na; k++) {
          const a = accessors[k] as { __idx: number; __eid: EntityHandle }
          a.__idx = row
          a.__eid = handle
        }
        el.handle = handle
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
    for (const [index, handle] of d.removed) fn(index, handle)
  }

  /**
   *: the Changed filter reads the reactivity WRITE LOG, not changeVersion. The write log lands
   * at; until then there are no recorded writes, so the changed set is empty. The matching surface
   * (binding the cursor per changed index) is in place for to fill the index source.
   */
  eachChanged(fn: (e: PooledElement) => void): void {
    // Drain the write-log changed set (deduped, intersected with `current`), then bind the
    // cursor per scattered index. The changed set spans multiple archetypes, so reuse #eachScattered.
    if (this.#reactivity === null || !this.#changedDeclared) return
    const indices = this.#reactivity.drainChanged(this)
    this.#eachScattered(indices, fn)
  }

  // --- internals -------------------------------------------------------------

  /**: bind the cursor per scattered index (added set spans multiple archetypes). */
  #eachScattered(indices: Iterable<number>, fn: (e: PooledElement) => void): void {
    const binding = this.#hotBinding()
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

  /** Bind a cold row: each value-term's accessor lands on its own per-component cold-block row. */
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
   * Cold archetypes carry no contiguous columns; resolve each resident through the record.
   * O(rows in this cold archetype) — driven by the ColdStore's per-archetype membership, NOT by a
   * filter over the whole `current` set (which would be O(cold archetypes × |current|)).
   */
  #eachCold(arch: Archetype, binding: ValueBinding, fn: (e: PooledElement) => void): void {
    for (const index of this.#deps.coldResidentsOf(arch.id as number)) {
      fn(this.#bindColdRow(arch, binding, index, this.#deps.handleOf(index)))
    }
  }

  /** Generator twin of #eachCold for the [Symbol.iterator] surface ( cold transparency). */
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
      // has/without contribute no value term, hence no prop (handled at compile time).
    }
    binding.elements.set(archId, el)
    return el
  }

  /**
   * The accessor singletons whose __idx/__eid the cursor pokes for this (archetype, value-sig).
   * Built ONCE per (archetype, value-sig) at first touch and cached on the binding, so
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

/**
 * The reused per-archetype cursor handed to {@link LiveQuery.eachChunk}. Exposes one matched archetype's
 * raw SoA columns + its contiguous row span. Resolve each column ONCE before the inner row loop:
 *
 * ```ts
 * q.eachChunk((c) => {
 * const px = c.column(Position, 'x'), py = c.column(Position, 'y')
 * const dx = c.column(Velocity, 'dx'), dy = c.column(Velocity, 'dy')
 * for (let i = 0; i < c.count; i++) { px[i] += dx[i] * dt; py[i] += dy[i] * dt }
 * })
 * ```
 *
 * `column` returns the live typed view; `stride` is the slots-per-row (>1 for vec fields, where row `r`
 * starts at `r * stride`). The cursor (and every returned view) is reused across archetypes/calls — do NOT
 * store either across iterations. Writes here bypass the reactivity write log (see `eachChunk`).
 */
export class QueryChunk {
  #arch: Archetype | null = null
  /** componentId → (fieldName → columnIndex within that component's ColumnSet). Built lazily, reused. */
  readonly #colIndex = new Map<number, Map<string, number>>()

  /** @internal — point the chunk at one matched archetype (the cursor loop owns this). */
  __bind(arch: Archetype): void {
    this.#arch = arch
  }

  /** Rows in this chunk (the archetype's dense row count). Iterate `0..count`. */
  get count(): number {
    return this.#arch === null ? 0 : this.#arch.count
  }

  /** The dense row→EntityHandle list for this chunk (row `r`'s entity is `entities[r]`). */
  get entities(): Uint32Array {
    return this.#arch === null ? EMPTY_ROWS : this.#arch.rows
  }

  #resolveColumnIndex(def: ComponentDef<Schema>, field: string): number {
    const cid = def.id as number
    let byName = this.#colIndex.get(cid)
    if (byName === undefined) {
      byName = new Map()
      let colIdx = 0
      for (const f of def.fields as readonly FieldDescriptor[]) {
        // object<T> contributes no column; skip it so column indices match the ColumnSet build order.
        if (f.ctor !== null) {
          byName.set(f.name, colIdx)
          colIdx += 1
        }
      }
      this.#colIndex.set(cid, byName)
    }
    const idx = byName.get(field)
    if (idx === undefined) {
      throw new Error(`QueryChunk.column: component '${def.name}' has no column-backed field '${field}'`)
    }
    return idx
  }

  #columnOf(def: ComponentDef<Schema>, field: string): { view: TypedArray; stride: number } {
    if (this.#arch === null) throw new Error('QueryChunk: not bound')
    const cs = this.#arch.columnSets.get(def.id as ComponentId)
    if (cs === undefined) {
      throw new Error(`QueryChunk.column: archetype lacks component '${def.name}' (not in this query?)`)
    }
    const col = cs.columns[this.#resolveColumnIndex(def, field)]
    if (col === undefined) throw new Error(`QueryChunk.column: missing column for '${def.name}.${field}'`)
    return { view: col.view, stride: col.layout.stride }
  }

  /** The live typed column view for `def.field` in this chunk. Stride-1 scalars index by row directly. */
  column<S extends Schema>(def: ComponentDef<S>, field: string): TypedArray {
    return this.#columnOf(def as unknown as ComponentDef<Schema>, field).view
  }

  /** Slots per row for `def.field` (1 scalar, N vec): row `r` starts at `r * stride`. */
  stride<S extends Schema>(def: ComponentDef<S>, field: string): number {
    return this.#columnOf(def as unknown as ComponentDef<Schema>, field).stride
  }
}

const EMPTY_ROWS = new Uint32Array(0)

export type { PooledElement }
export { NO_HANDLE }
export type { ArchetypeId, ComponentId, Schema }
