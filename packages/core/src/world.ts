// The World keystone (world.md). M0 lands the scaffold: option resolution, the phase/tick
// contracts, and the module-wiring seam. Later milestones fill the seven owning modules in the
// fixed order registry → buffers → storage → reactivity → queries → scheduler → serialization (§7).

import { resolveOptions } from './config.js'
import type { ResolvedWorldOptions, WorldOptions } from './config.js'
import {
  EntityStore,
  handleIndex,
  makeHandleLayout,
  reserveEntityBlock,
  returnReservedIds,
} from './entity/index.js'
import type {
  EntityGeneration,
  EntityHandle,
  EntityIndex,
  EntityRef,
  EntityReservation,
  HandleLayout,
  HandleStats,
} from './entity/index.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/schema'
import { Buffers, probeCapabilities } from './memory/index.js'
import type { WorkerMode } from './memory/index.js'
import { ComponentRegistry } from './registry.js'
import type { AccessorWorld } from './component/index.js'
import { Bitmask } from './bitmask/index.js'
import { Storage } from './storage/index.js'
import type { Archetype, Signature } from './storage/index.js'
import { QueryEngine } from './query/index.js'
import type { LiveQuery } from './query/index.js'
import { Reactivity, onAdd, onRemove, onChange } from './reactivity/index.js'
import type { ObserverHandle, ObserverHandler, ObserverTerm } from './reactivity/index.js'
import type { ComponentDef as SchemaComponentDef, QueryTerm, WorldQuery } from '@ecsia/schema'

/** world.md §4: 'serial' during the serial slot (and always, single-threaded); 'wave' only while the scheduler dispatches worker waves. */
export type WorldPhase = 'serial' | 'wave'

export interface World {
  /** Fully-resolved, validated configuration (frozen). */
  readonly options: ResolvedWorldOptions
  /** Structural-change phase. Owned by the world; the scheduler is the only component that flips it to 'wave'. */
  readonly phase: WorldPhase
  /** Current frame tick. Advanced by reactivity at frame reset (world.md §8). */
  readonly tick: number
  /** Alias for `tick` (world.md §8). */
  currentTick(): number

  /** Create a new entity with the empty signature. Main-thread/serial. O(1) (entity-model.md §6.2). */
  spawn(): EntityHandle
  /**
   * Create a new entity and add the given components in ONE migration (EMPTY → target signature),
   * never N (archetype-storage.md §5.6; entity-model.md §6.1). Main-thread/serial.
   */
  spawnWith(...defs: readonly ComponentDef<Schema>[]): EntityHandle
  /** Add a component to a live entity (single migration via the cached edge, §5.4). Main-thread/serial. */
  add(handle: EntityHandle, def: ComponentDef<Schema>): void
  /** Remove a component from a live entity (single migration via the cached edge). Main-thread/serial. */
  remove(handle: EntityHandle, def: ComponentDef<Schema>): void
  /** Explicit cold→hot archetype promotion at a serial flush point (archetype-storage.md §10.4). */
  warm(...defs: readonly ComponentDef<Schema>[]): void
  /** Destroy an entity. Main-thread/serial. Idempotent on dead handles (entity-model.md §6.3). */
  despawn(handle: EntityHandle): void
  /** O(1) liveness/staleness check. Never consults the bitmask (Must-Fix #1). */
  isAlive(handle: EntityHandle): boolean
  /**
   * O(1) component membership point-test via the per-entity bitmask (archetype-storage.md §6.4).
   * Main-thread/serial only (BM-1). Returns false for a dead handle (liveness checked first,
   * without reading the bitmask).
   */
  has(handle: EntityHandle, def: ComponentDef<Schema>): boolean
  /**
   * Resolve the pooled EntityRef for `handle`; throws on a dead handle unless `{ lenient: true }`
   * (entity-model.md §6.4). `spawnWith(...defs)` is the other §6.1 public-surface member; it is
   * intentionally deferred to storage (M3), which owns target-signature computation and the
   * single migration — the handle mint here is meaningless without an archetype to land in.
   */
  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRef

  /** Pre-reserve a block of live handles for a worker to consume mid-wave (entity-model.md §5.1). Serial-phase only. */
  reserveEntityBlock(workerIndex: number, count: number): EntityReservation
  /** Reclaim the unconsumed tail of a reservation, LIFO, at bumped generation (entity-model.md §5.1). */
  returnReservedIds(reservation: EntityReservation, consumedCount: number): void

  /** Frozen handle codec layout, also valid to hand to workers (entity-model.md §2.2). */
  readonly handleLayout: HandleLayout
  encodeHandle(index: number, generation: number): EntityHandle
  decodeHandle(handle: EntityHandle): { index: EntityIndex; generation: EntityGeneration }
  handleStats(): HandleStats

  /**
   * Push (entityIndex, componentId[, fieldIndex]) to the reactivity write log for the `.changed`
   * filter (world.md §9.1; Must-Fix #2). STUBBED as a no-op until M5 — the canonical signature and
   * accessor-setter call sites are in place now so M5 only fills the body.
   */
  trackWrite(index: number, componentId: ComponentId, fieldIndex?: number): void

  /**
   * Register a deferred observer (reactivity.md §7). Fires ONLY at the serial observer slot
   * (observerDrain), NEVER synchronously mid-system (R-3). Mutations inside the handler stage to the
   * command buffer and apply at the next serial flush (R-3 re-entrancy safety).
   */
  observe(term: ObserverTerm, handler: ObserverHandler): ObserverHandle

  /**
   * Did any component on `handle` change strictly after tick `since`? (reactivity.md §6.3). Driven by
   * the per-row changeVersion stamps, NOT the write log (R-2). Lazily enabled the first time a
   * `.changed` query flavor or this predicate is used.
   */
  changedSince(handle: EntityHandle, since: number): boolean
  /** The rows of `archetypeId` whose changeVersion stamp is > since (the delta serializer scan, §6.3). */
  changedRows(archetypeId: number, since: number): Iterable<number>

  /** Advance the frame tick (reactivity.frameReset calls this; world owns the counter, world.md §8). */
  advanceTick(): void
  /** §9.2 — merge per-worker write corrals into the ring (no-op single-threaded). */
  mergeCorrals(): void
  /** §5.2 — drain the shape log, re-testing affected entities against referencing queries. */
  maintainStructural(): void
  /** §7.3 — fire deferred observers at the serial observer slot. */
  observerDrain(): void
  /** §8.2 — drain/merge spill, schedule next-frame ring resize. */
  flushLogs(): void

  /**
   * Compile (or fetch the cached) LiveQuery for `terms` and return it (queries.md §4, §9). Identical
   * term sets share one LiveQuery by canonical hash (order-independent, pair-target-encoded). The
   * arity-cap overload family (1..8 inferred, 9+ → LooseQueryElement) is the WorldQuery type.
   */
  query: WorldQuery

  /**
   * Reset every live query's per-frame transient flavor (added/removed) lists. The kernel-only frame
   * loop calls this at frame start (queries.md §8.2 / world.md §3.4); the scheduler drives it at M6.
   */
  frameReset(): void
}

interface WorldState {
  phase: WorldPhase
  tick: number
}

/**
 * The only world constructor (world.md §2.1). Resolves and validates options fail-fast, then
 * (at later milestones) probes capabilities, allocates bounded buffers, and wires the owning
 * modules. Returns a frozen World facade.
 */
export function createWorld(options: WorldOptions = {}): World {
  const resolved = resolveOptions(options)

  // --- Module wiring seam (world.md §7) ---
  // registry → buffers → storage → reactivity → queries → scheduler → serialization.
  // M1 lands the entity layer; later layers fill in around it.
  const state: WorldState = { phase: 'serial', tick: 0 }

  const handleLayout = makeHandleLayout(resolved.generationBits)
  const entities = new EntityStore({
    layout: handleLayout,
    maxEntities: resolved.maxEntities,
    shared: resolved.threaded,
  })

  // --- buffers (world.md §7 step 2): one capability probe, one SAB-vs-AB decision (B-1) ---
  const workerMode: WorkerMode = resolved.threaded
    ? resolved.scheduler.workers === 'postMessage-fallback'
      ? 'postMessage-fallback'
      : 'auto'
    : 'single'
  const capabilities = probeCapabilities(workerMode, (message) => {
    if (typeof console !== 'undefined') console.warn(`[ecsia] ${message}`)
  })
  const buffers = new Buffers({ capabilities, maxEntities: resolved.maxEntities })

  // The accessor seam: a setter calls world.trackWrite. handleIndex strips the generation so the LOW
  // handle bits index the write log (world.md §9.1, W-8). Routes to the reactivity module once built
  // (late-bound so the acyclic construction order registry → buffers → storage → reactivity holds).
  let reactivity: Reactivity | null = null
  const trackWrite = (index: number, componentId: ComponentId, fieldIndex?: number): void => {
    reactivity?.trackWrite(index, componentId, fieldIndex)
  }
  const accessorWorld: AccessorWorld = {
    trackWrite,
    handleIndex: (handle) => handleIndex(handle, handleLayout) as number,
  }

  // --- registry (world.md §7 step 1): mint dense user ids, wire accessor factories ---
  const registry = new ComponentRegistry()
  registry.register(resolved.components as readonly ComponentDef<Schema>[])

  // --- bitmask + storage (world.md §7 steps 2-3): the per-entity membership index and the
  // archetype tables. The bitmask stride = ceil(nextComponentId/32) (CANON C4); both derive from
  // the SAME registered-component count so sigWords and bitmask layouts align (archetype-storage.md
  // §3.3 / §6.1). Structural mutation is serial; the bitmask asserts world.phase === 'serial'.
  const bitmask = new Bitmask(buffers, registry.nextComponentId, resolved.maxEntities, () => state.phase)
  const stride = bitmask.stride
  const records = entities.records
  const handleIndexOf = (handle: number): number => handleIndex(handle as EntityHandle, handleLayout) as number

  // The query engine is created AFTER storage (it subscribes to storage.onArchetypeCreated), but
  // storage's single-entity maintenance hooks must call into the engine. Late-bind through a mutable
  // reference so the wiring stays acyclic (storage → engine, set once below).
  let engine: QueryEngine | null = null

  const storage = new Storage({
    buffers,
    accessorWorld,
    bitmask,
    record: records,
    registry,
    maxHotArchetypes: resolved.maxHotArchetypes,
    stride,
    maxEntities: resolved.maxEntities,
    enqueueRemoveLog: (index, c) => reactivity?.enqueueRemoveLog(index, c),
    hasRemoveObserver: (c) => reactivity?.hasRemoveObserver(c as number) ?? false,
    trackShape: (index, c, kind) => reactivity?.trackShape(index, c as ComponentId, kind),
    maintainEntity: (index, c) => engine?.maintainEntity(index, c),
    onEntitySpawned: (index) => engine?.onEntitySpawned(index, storage.archetypes.emptyArchetype),
    dropEntity: (index) => engine?.dropEntity(index),
    tick: () => state.tick,
    handleIndex: handleIndexOf,
  })

  // --- queries (world.md §7 step 5): the canonical-hash dedup cache + per-archetype matching, kept
  // current by the archetypeCreated hook. fixedBitCount = stride*32 (ids below it pack into the
  // signature words; larger pair ids are residual — queries.md §3.5).
  engine = new QueryEngine({
    buffers,
    bitmask,
    maxEntities: resolved.maxEntities,
    byId: storage.archetypes.byId as Archetype[],
    onArchetypeCreated: (fn) => storage.onArchetypeCreated(fn),
    compileContext: {
      idOf: (def) => {
        const id = registry.idOf(def)
        if (id === undefined) throw new Error(`component '${def.name}' is not registered with this world`)
        return id
      },
      fixedBitCount: stride * 32,
    },
    resolveLocation: (index) => entities.locationOfIndex(index),
    handleOf: (index) => entities.handleOfIndex(index),
    indexOfHandle: handleIndexOf,
    coldResidentsOf: (archetypeId) => storage.coldResidentsOf(archetypeId),
    coldColumnSet: (componentId) => storage.coldColumnSet(componentId),
    coldRowOf: (index, componentId) => storage.coldRowOf(index, componentId),
    signatureOf: (index) => {
      const archId = records.archetypeIdOf(index)
      return (storage.archetypes.byId[archId] as Archetype).signature as Signature
    },
  })

  entities.setAccessorResolver(storage)
  entities.setLifecycle({
    onSpawn: (handle) => storage.onSpawn(handle),
    onDespawn: (handle) => storage.onDespawn(handle),
  })

  // --- reactivity (world.md §7 step 4): the write/shape rings, changeVersion stamps, deferred
  // observers, and the query-flavor hooks. Wired AFTER storage + queries so trackWrite/trackShape and
  // observer dispatch can resolve locations and re-test entities (reactivity.md §15 dependencies).
  reactivity = new Reactivity({
    buffers,
    maxEntities: resolved.maxEntities,
    indexBits: handleLayout.indexBits,
    logEntryWords: resolved.reactivity.logEntryWords,
    maxWritesPerFrame: resolved.reactivity.maxWritesPerFrame,
    maxShapeChangesPerFrame: resolved.reactivity.maxShapeChangesPerFrame,
    shrinkRings: resolved.reactivity.shrinkRings,
    dev: process.env['NODE_ENV'] !== 'production',
    resolveLocation: (index) => entities.locationOfIndex(index),
    tick: () => state.tick,
    advanceTick: () => {
      state.tick = (state.tick + 1) >>> 0
    },
    idOf: (def) => {
      const id = registry.idOf(def)
      if (id === undefined) throw new Error(`component '${def.name}' is not registered with this world`)
      return id
    },
    holdsAll: (index, componentIds) => {
      for (const c of componentIds) if (!bitmask.bitmaskHas(index, c)) return false
      return true
    },
    refOf: (index) => entities.entity(entities.handleOfIndex(index), { lenient: true }),
  })
  // The shape-log drain re-runs the same idempotent single-entity maintenance the M4 synchronous
  // hook performs; the conservative overflow path needs a "current matches" source for change
  // observers (§3.6).
  reactivity.setMaintainHook((index, c) => engine?.maintainEntity(index, c as ComponentId))
  reactivity.setCurrentMembersSource(() => collectCurrentMembers(engine as QueryEngine))
  ;(engine as QueryEngine).setReactivity({
    attachChangedFlavor: (q, ids) => (reactivity as Reactivity).attachChangedFlavor(q, ids),
    drainChanged: (q) => (reactivity as Reactivity).drainChanged(q),
  })

  const world: World = {
    get options() {
      return resolved
    },
    get phase() {
      return state.phase
    },
    get tick() {
      return state.tick
    },
    currentTick() {
      return state.tick
    },
    spawn() {
      return entities.spawn()
    },
    spawnWith(...defs) {
      const handle = entities.spawn()
      storage.spawnWith(handle, defs)
      return handle
    },
    add(handle, def) {
      storage.add(handle, def)
    },
    remove(handle, def) {
      storage.remove(handle, def)
    },
    warm(...defs) {
      storage.warm(defs)
    },
    despawn(handle) {
      entities.despawn(handle)
    },
    isAlive(handle) {
      return entities.isAlive(handle)
    },
    has(handle, def) {
      // Liveness first, WITHOUT the bitmask (Must-Fix #1); a dead handle is never a member.
      if (!entities.isAlive(handle)) return false
      return storage.has(handle, def)
    },
    entity(handle, opts) {
      return entities.entity(handle, opts)
    },
    reserveEntityBlock(workerIndex, count) {
      return reserveEntityBlock(entities.index, workerIndex, count)
    },
    returnReservedIds(reservation, consumedCount) {
      returnReservedIds(entities.index, reservation, consumedCount)
    },
    handleLayout,
    encodeHandle(index, generation) {
      return entities.encodeHandle(index, generation)
    },
    decodeHandle(handle) {
      return entities.decodeHandle(handle)
    },
    handleStats() {
      return entities.handleStats()
    },
    trackWrite(index, componentId, fieldIndex) {
      trackWrite(index, componentId, fieldIndex)
    },
    observe(term, handler) {
      return (reactivity as Reactivity).observe(term, handler)
    },
    changedSince(handle, since) {
      ;(reactivity as Reactivity).enableChangeVersion()
      return (reactivity as Reactivity).changedSince(handle, since)
    },
    changedRows(archetypeId, since) {
      const arch = storage.archetypes.byId[archetypeId]
      const count = arch === undefined ? 0 : arch.count
      return (reactivity as Reactivity).changedRows(archetypeId, since, count)
    },
    advanceTick() {
      state.tick = (state.tick + 1) >>> 0
    },
    mergeCorrals() {
      ;(reactivity as Reactivity).mergeCorrals()
    },
    maintainStructural() {
      ;(reactivity as Reactivity).maintainStructural()
    },
    observerDrain() {
      ;(reactivity as Reactivity).observerDrain()
    },
    flushLogs() {
      ;(reactivity as Reactivity).flushLogs()
    },
    query: ((...terms: QueryTerm[]): LiveQuery => {
      // The LiveQuery structurally satisfies Query<T> (terms, each, [Symbol.iterator], flavors,
      // count); the WorldQuery overload family supplies the element typing per the actual terms.
      return (engine as QueryEngine).query(terms)
    }) as unknown as WorldQuery,
    frameReset() {
      // §10.1: reactivity.frameReset advances the world tick + recycles the rings; then the query
      // engine clears its per-frame added/removed delta lists.
      ;(reactivity as Reactivity).frameReset()
      ;(engine as QueryEngine).frameReset()
    },
  }

  return Object.freeze(world)
}

/** Collect the union of every live query's current matching indices (the §3.6 conservative source). */
function collectCurrentMembers(engine: QueryEngine): Iterable<number> {
  const seen = new Set<number>()
  for (const lq of engine.liveQueries) {
    for (const index of lq.current) seen.add(index)
  }
  return seen
}
