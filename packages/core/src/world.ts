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
import type { ComponentDef, ComponentId, RelationDef, RelationId, Schema, SpawnArg, SpawnArgFor } from '@ecsia/schema'
import { Buffers, probeCapabilities } from './memory/index.js'
import type { WorkerMode, SharedHandleManifest, RegionKey } from './memory/index.js'
import { ComponentRegistry } from './registry.js'
import type { AccessorWorld } from './component/index.js'
import { SidecarStore, sidecarKey } from './component/index.js'
import type { SidecarKey } from './component/index.js'
import { Bitmask } from './bitmask/index.js'
import { Storage } from './storage/index.js'
import type { Archetype, Signature } from './storage/index.js'
import { QueryEngine } from './query/index.js'
import type { LiveQuery, ResolvedPair } from './query/index.js'
import { ShapeKind } from './reactivity/index.js'
import type { ColumnSet } from './component/index.js'
import type { Buffers as BuffersType } from './memory/index.js'
import { Reactivity, ObserverCommandBuffer, onAdd, onRemove, onChange } from './reactivity/index.js'
import type { ObserverCommandApply, ObserverHandle, ObserverHandler, ObserverTerm } from './reactivity/index.js'
import type { ComponentDef as SchemaComponentDef, FieldDescriptor, QueryTerm, WorldQuery } from '@ecsia/schema'
import type {
  SerializationSurface,
  SerializeArchetype,
  SerializeComponentColumns,
  SerializeComponentMeta,
  SerializeRichField,
  SerializeRelationProvider,
} from './serialize-surface.js'
import type { Column } from './memory/index.js'
import type { ComponentRuntime } from './component/index.js'

/** world.md §4: 'serial' during the serial slot (and always, single-threaded); 'wave' only while the scheduler dispatches worker waves. */
export type WorldPhase = 'serial' | 'wave'

/**
 * The ComponentId-keyed structural-apply verbs the command-buffer flush path drives (command-buffer.md
 * §9). Built from the world's storage + registry; every call runs serial/main-thread.
 */
export interface WorldApplySurface {
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  addMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  removeMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** Overwrite `def`'s fields on `handle`'s current row + emit the `.changed` write-log entry. */
  writePayload(handle: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  /**
   * Relation apply (relations.md §5.6). Filled by `__installRelations` (M8); undefined in a
   * relation-free world. The scheduler's command-apply path calls these for OP_ADD_PAIR /
   * OP_REMOVE_PAIR — it does NOT import relations (the acyclic boundary holds).
   */
  addPair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined): void
  removePair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
}

/**
 * The minimal core surface the relations runtime drives (relations.md). The world exposes it through
 * `__installRelations` so `@ecsia/relations` attaches WITHOUT @ecsia/core ever importing it (the
 * acyclic dependency direction, M8 seam). Everything here is serial / main-thread (Must-Fix #1).
 */
export interface RelationsHost {
  /** Mint the next dense ComponentId (relations.md §2.2 allocSyntheticComponentId). */
  allocSyntheticId(): ComponentId
  /** Intern a synthetic ComponentDef (presence/overflow) at a minted id so storage can build its columns. */
  registerSynthetic(def: ComponentDef<Schema>, id: ComponentId): void
  /** id → registered def (real or synthetic). */
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  /** ONE migration adding several ids (relations P1 atomicity; archetype-storage §5.6a). */
  migrateAddingMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  migrateRemovingMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** O(1) membership of a (possibly synthetic) component id via the per-entity bitmask. */
  bitmaskHas(index: number, id: ComponentId): boolean
  /** Resolve the live ColumnSet + current row for `def` on `handle`, or null if absent / not hot. */
  columnSetFor(handle: EntityHandle, def: ComponentDef<Schema>): { set: ColumnSet; row: number } | null
  /** Entity-layer helpers. */
  isAlive(handle: EntityHandle): boolean
  handleIndex(handle: EntityHandle): number
  handleOfIndex(index: number): EntityHandle
  /** Re-enter the despawn protocol for a cascaded victim (relations.md §7.1). */
  despawn(handle: EntityHandle): void
  /**
   * M9 deferral seam (reactivity.md §7.4): while an observer drain is running, structural relation
   * ops issued by a handler must STAGE to the world's deferred command buffer rather than mutate the
   * world mid-drain. The relations runtime calls this at the top of addPair/removePair; if it returns
   * true the op was staged (the runtime returns immediately) — else the runtime applies it directly.
   */
  deferRelationOp(op: 'add' | 'remove', subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle, payload?: Record<string, unknown>): boolean
  /** Push a write-log entry for a `.changed`-tracked pair-payload write (relations.md §4.4/§5.4). */
  trackWrite(index: number, componentId: ComponentId): void
  /** Push an ADD_PAIR / REMOVE_PAIR shape-log entry (reactivity.md §4.2; world.md §9.4). */
  trackShapePair(index: number, pairId: ComponentId, targetIndex: number, add: boolean): void
  /**
   * Journal a SET_PAYLOAD structural op for a non-exclusive overflow pair whose payload changed on an
   * already-live pair (serialization.md §6.5: overflow payload changes are explicit OP_PAIR_PAYLOAD
   * records, since they do not live in an archetype column the changed-row scan covers).
   */
  trackShapeSetPayload(index: number, pairId: ComponentId, targetIndex: number): void
  /** The SAB-capable buffers registry, for the non-exclusive overflow payload ColumnSet. */
  readonly buffers: BuffersType
  readonly accessorWorld: AccessorWorld
  /** Register a preDespawn hook fired BEFORE the row is torn down (relations.md §7.1 / §7.4 ordering). */
  setPreDespawn(hook: (dying: EntityHandle) => void): void
  /** Inject the Pair(...) term resolver into the query compiler (queries.md §10; Q-R2). */
  setPairResolver(resolve: (relationId: number, target: number | symbol) => ResolvedPair): void
  /** Fill the OP_ADD_PAIR / OP_REMOVE_PAIR apply seam so the scheduler can drive relations. */
  setApplyPair(
    addPair: (subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined) => void,
    removePair: (subject: EntityHandle, relationId: RelationId, target: EntityHandle) => void,
  ): void
  /**
   * Install the relation snapshot/apply provider the serialization module reads through `world.__serialize`
   * (serialization.md §4.6, §8.3). Lets @ecsia/serialization enumerate live pairs and re-establish them
   * WITHOUT importing @ecsia/relations directly off the world — the relations runtime hands the provider
   * in, core relays it, the acyclic boundary holds.
   */
  setSerializationProvider(provider: SerializeRelationProvider): void
  readonly maxEntities: number
  readonly indexBits: number
}

export interface World {
  /** Fully-resolved, validated configuration (frozen). */
  readonly options: ResolvedWorldOptions
  /** Structural-change phase. Owned by the world; the scheduler is the only component that flips it to 'wave'. */
  readonly phase: WorldPhase
  /**
   * Phase-flip seam (scheduler.md §2.1 PHASE-2). The world OWNS the field and seeds it to 'serial';
   * the scheduler is the SOLE caller of this, flipping to 'wave' across worker dispatch and back to
   * 'serial' for the merge/apply flush slot. @ecsia/core never calls it (the acyclic boundary holds —
   * the scheduler drives the world externally). Not for user code.
   */
  __setPhase(phase: WorldPhase): void
  /**
   * Command-buffer apply seam (command-buffer.md §7.4 `spawnReserved`). Place a handle that was
   * already made alive by `reserveEntityBlock` (entity-model.md §5.1) into the EMPTY archetype and
   * emit its Create shape entry — the deferred analogue of `world.spawn()` whose identity was minted
   * before the wave. Serial-phase only. Called ONLY by the scheduler's flush path. Not for user code.
   */
  __spawnReserved(handle: EntityHandle): void
  /**
   * Command-buffer apply surface (command-buffer.md §9), exposed as ONE seam so the scheduler's flush
   * path drives the same storage primitives a main-thread direct-apply would, keyed by ComponentId.
   * Serial-phase only; called ONLY by the scheduler. Not for user code.
   */
  readonly __apply: WorldApplySurface
  /**
   * Relations attach seam (relations.md M8). `@ecsia/relations` calls this ONCE to obtain the core
   * surface it drives (synthetic id minting, migrate-many, preDespawn hook, pair-resolver injection,
   * OP_ADD_PAIR apply). @ecsia/core never imports @ecsia/relations — the host is handed OUT, keeping
   * the dependency direction acyclic. Not for user code; call createRelations(world) instead.
   */
  __installRelations(): RelationsHost
  /** Export the SAB buffer-set manifest for one-time worker transfer (memory-buffers.md §6.3). */
  __exportShared(): SharedHandleManifest
  /**
   * Serialization seam (serialization.md M10). @ecsia/serialization reads archetype columns + the
   * registry + the relation provider through this, and drives deserialize-side spawn/migrate. Serial /
   * main-thread only; @ecsia/core never imports @ecsia/serialization (acyclic boundary). Not for user code.
   */
  readonly __serialize: SerializationSurface
  /**
   * Merge ONE worker's staged value writes into the reactivity write log (reactivity.md §9.1/§9.2,
   * R-4). `pairs` is the worker's raw `[index, componentId, …]` corral payload and `count` the number
   * of `(index, componentId)` entries. The scheduler drives this in ASCENDING worker-index order in
   * the serial flush slot so onChange observers + `.changed` filters fire for worker writes
   * deterministically. Serial-phase only; called ONLY by the scheduler. Not for user code.
   */
  __mergeWorkerWrites(pairs: Int32Array | Uint32Array, count: number): void
  /** Current frame tick. Advanced by reactivity at frame reset (world.md §8). */
  readonly tick: number
  /** Alias for `tick` (world.md §8). */
  currentTick(): number

  /** Create a new entity with the empty signature. Main-thread/serial. O(1) (entity-model.md §6.2). */
  spawn(): EntityHandle
  /**
   * Create a new entity and add the given components in ONE migration (EMPTY → target signature),
   * never N (archetype-storage.md §5.6; entity-model.md §6.1). Main-thread/serial.
   *
   * Each argument is either a bare `ComponentDef` (membership only) or a `[def, values]` tuple that
   * also INITIALIZES the component: `spawnWith([Position, { x: 1, y: 2 }], Velocity)` spawns the entity,
   * migrates it to the target signature once, then writes the supplied values through the normal tracked
   * accessor path (so onChange/write-log fire). The value object is type-inferred from the def's schema.
   */
  spawnWith<const T extends readonly SpawnArg[]>(...specs: { [I in keyof T]: SpawnArgFor<T[I]> }): EntityHandle
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
  // The shared "any write consumer exists" cell the accessor setters read to fast-out the trackWrite
  // chain (P7). Reactivity owns recomputing `.active` on every flavor/observer/changeVersion
  // (de)registration; until reactivity is wired it stays false (no consumers can exist yet).
  const tracking = { active: false }
  // The rich-field sidecar (rich-fields.md §4). Created BEFORE accessorWorld so the accessor's rich
  // getters/setters can delegate through the seam (G-8). Main-thread-only; never shared with workers.
  const sidecar = new SidecarStore()
  // During an observer drain the rich getter must read the DYING entity's value (RF-REMOVE-READ); the
  // sidecar disambiguates via its pending-clear table, so route reads through readForObserver while a
  // pending window is open and through the generation-guarded read otherwise.
  const accessorWorld: AccessorWorld = {
    trackWrite,
    tracking,
    handleIndex: (handle) => handleIndex(handle, handleLayout) as number,
    sidecarRead: (key, index, gen) =>
      sidecar.hasPending() ? sidecar.readForObserver(key, index, gen) : sidecar.read(key, index, gen),
    sidecarWrite: (key, index, gen, value) => sidecar.write(key, index, gen, value),
    generationOf: (index) => entities.decodeHandle(entities.handleOfIndex(index)).generation as number,
  }

  // --- registry (world.md §7 step 1): mint dense user ids, wire accessor factories ---
  const registry = new ComponentRegistry()
  registry.register(resolved.components as readonly ComponentDef<Schema>[])

  // Declare a sidecar column per rich field of every registered component (rich-fields.md §4.6). This
  // is the single place the sidecar learns about a rich column; ensureColumn is idempotent.
  for (const def of resolved.components as readonly ComponentDef<Schema>[]) {
    const id = registry.idOf(def)
    if (id === undefined) continue
    let fieldIndex = 0
    for (const f of def.fields as readonly FieldDescriptor[]) {
      if (f.rich !== undefined) sidecar.ensureColumn(sidecarKey(id as number, fieldIndex), f.rich, f.default)
      fieldIndex += 1
    }
  }

  // --- bitmask + storage (world.md §7 steps 2-3): the per-entity membership index and the
  // archetype tables. The bitmask stride = ceil(nextComponentId/32) (CANON C4); both derive from
  // the SAME registered-component count so sigWords and bitmask layouts align (archetype-storage.md
  // §3.3 / §6.1). Structural mutation is serial; the bitmask asserts world.phase === 'serial'.
  const bitmask = new Bitmask(buffers, registry.nextComponentId, resolved.maxEntities, () => state.phase)
  const stride = bitmask.stride
  const records = entities.records
  const handleIndexOf = (handle: number): number => handleIndex(handle as EntityHandle, handleLayout) as number

  // Relations attach late (M8): the pair-resolver feeds the query compiler, the preDespawn hook runs
  // before storage tears the row down, and the apply-pair fns back __apply for the scheduler. All are
  // mutable so the relations runtime injects them post-construction without a core→relations import.
  let pairResolver: ((relationId: number, target: number | symbol) => ResolvedPair) | null = null
  let preDespawnHook: ((dying: EntityHandle) => void) | null = null
  let applyAddPair:
    | ((s: EntityHandle, r: RelationId, t: EntityHandle, p: Record<string, unknown> | undefined) => void)
    | null = null
  let applyRemovePair: ((s: EntityHandle, r: RelationId, t: EntityHandle) => void) | null = null
  let serializationProvider: SerializeRelationProvider | null = null

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
        if (id === undefined) throw new Error(`component '${def.name}' is not registered with this world — register it in createWorld({ components: [...] })`)
        return id
      },
      fixedBitCount: stride * 32,
      resolvePair: (relationId, target) => {
        if (pairResolver === null) return { componentId: 0 as ComponentId, unsatisfiable: true }
        return pairResolver(relationId, target)
      },
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

  // Rich-field despawn clear (rich-fields.md §4.3 / §4.3a). Walk the dying entity's signature for rich
  // fields and decide whether to DEFER the clear: when any held component has a remove-observer, the
  // R-8 deferred row reclaim keeps numeric values readable in onRemove, so the sidecar must stash the
  // dying rich values for the same observer window (RF-REMOVE-READ). The decision mirrors storage's
  // `defer` gate exactly so rich and numeric parity holds.
  const sidecarOnDespawn = (handle: EntityHandle): void => {
    const index = handleIndexOf(handle as number)
    const archId = records.archetypeIdOf(index)
    const arch = storage.archetypes.byId[archId] as Archetype | undefined
    if (arch === undefined) return
    const richKeys: SidecarKey[] = []
    let defer = false
    for (let i = 0; i < arch.signature.length; i++) {
      const c = arch.signature[i] as number as ComponentId
      const def = registry.defOf(c) as ComponentRuntime<Schema> | undefined
      if (def !== undefined && def.hasRichFields) {
        let fieldIndex = 0
        for (const f of def.fields as readonly FieldDescriptor[]) {
          if (f.rich !== undefined) richKeys.push(sidecarKey(c as number, fieldIndex))
          fieldIndex += 1
        }
      }
      if (reactivity?.hasRemoveObserver(c as number) === true) defer = true
    }
    if (richKeys.length > 0) sidecar.onDespawn(index, richKeys, defer)
  }

  entities.setAccessorResolver(storage)
  entities.setLifecycle({
    onSpawn: (handle) => storage.onSpawn(handle),
    onDespawn: (handle) => {
      // relations.md §7.4 ordering: preDespawn (cascade + pair teardown) runs WHILE `dying` is still
      // alive/resolvable, BEFORE storage.onDespawn shuffle-pops the row and the entity layer frees it.
      preDespawnHook?.(handle)
      // The rich clear runs BEFORE storage.onDespawn so the dying entity's signature is still resolvable
      // (storage.onDespawn shuffle-pops the row; the entity index record is unchanged either way).
      sidecarOnDespawn(handle)
      storage.onDespawn(handle)
    },
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
      if (id === undefined) throw new Error(`component '${def.name}' is not registered with this world — register it in createWorld({ components: [...] })`)
      return id
    },
    holdsAll: (index, componentIds) => {
      for (const c of componentIds) if (!bitmask.bitmaskHas(index, c)) return false
      return true
    },
    refOf: (index) => entities.entity(entities.handleOfIndex(index), { lenient: true }),
    resolveHandle: (index) => entities.handleOfIndex(index) as number,
    tracking,
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

  // --- M9 deferred-observer command buffer (reactivity.md §7.4) ---
  // While observerDrain runs, the world's structural verbs (spawn/spawnWith/add/remove/despawn and
  // the relations apply-pair seam) STAGE here instead of direct-applying, so an observer handler that
  // mutates structure cannot corrupt the wave the drain is replaying (R-3). The staged ops apply at
  // the start of the NEXT drain — i.e. the next serial flush. applyAddPair/applyRemovePair are the
  // SAME relation seams the scheduler's command-apply path drives (filled by __installRelations, M8).
  const observerCommands = new ObserverCommandBuffer()
  const observerApply: ObserverCommandApply = {
    placeReserved(handle, defs) {
      // The handle was reserved-alive when the observer called spawn; place it into the EMPTY archetype
      // (emitting Create), then migrate it to the requested signature in one move (spawnWith semantics).
      storage.onSpawn(handle)
      if (defs.length > 0) storage.addMany(handle, defs)
    },
    add: (handle, def) => storage.add(handle, def),
    remove: (handle, def) => storage.remove(handle, def),
    despawn: (handle) => entities.despawn(handle),
    isAlive: (handle) => entities.isAlive(handle),
    writePayload: (handle, def, values) => {
      const view = entities.entity(handle).write(def) as Record<string, unknown>
      for (const k of Object.keys(values)) view[k] = values[k]
    },
    addPair: (subject, relationId, target, payload) => applyAddPair?.(subject, relationId, target, payload),
    removePair: (subject, relationId, target) => applyRemovePair?.(subject, relationId, target),
  }

  // --- serialization surface (serialization.md M10) -------------------------
  // Reads archetype columns/signatures + the registry + the relation provider; drives deserialize-side
  // spawn/migrate. The user-component metadata is the registered defs in dense-id order. Synthetic ids
  // (pair/presence/overflow) are intentionally excluded from `components()` — they are reconstructed by
  // re-minting on the receiver (serialization.md §3.2), never shipped as schema.
  const userComponents = resolved.components as readonly ComponentDef<Schema>[]
  const componentIdByName = new Map<string, ComponentId>()
  for (const def of userComponents) {
    const id = registry.idOf(def)
    if (id !== undefined) componentIdByName.set(def.name, id)
  }

  // Rich-field enumeration for the serialization sidecar section (rich-fields.md §7.1 / G-4). Built once
  // from the registered defs in (componentId, fieldIndex) order; the snapshot/delta writers join this
  // with each entity's signature — they MUST NOT read `archetypeView().components`, which strips rich
  // fields (and drops rich-only components entirely).
  const richFieldList: SerializeRichField[] = []
  for (const def of userComponents) {
    const id = registry.idOf(def)
    if (id === undefined) continue
    let fieldIndex = 0
    for (const f of def.fields as readonly FieldDescriptor[]) {
      if (f.rich !== undefined) richFieldList.push({ componentId: id, fieldIndex, name: f.name, kind: f.rich })
      fieldIndex += 1
    }
  }

  const computeSchemaHash = (): number => {
    // FNV-1a over the canonical (componentName, fieldName, token)* + relation names (§3.2). The receiver
    // recomputes it from ITS defineComponent set and must match — a fail-fast guard against stale code.
    let h = 0x811c9dc5
    const fnv = (s: string): void => {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
    }
    for (const def of userComponents) {
      fnv(def.name)
      for (const f of def.fields as readonly FieldDescriptor[]) {
        fnv(f.name)
        fnv(typeof f.token === 'string' ? f.token : JSON.stringify(f.token))
      }
    }
    const prov = serializationProvider
    if (prov !== null) for (const r of prov.relations()) fnv(r.name)
    return h >>> 0
  }

  const archetypeView = (arch: Archetype): SerializeArchetype => {
    const components: SerializeComponentColumns[] = []
    // Iterate the signature in canonical (sorted) order so column order is deterministic (§4.4).
    for (let i = 0; i < arch.signature.length; i++) {
      const c = arch.signature[i] as number as ComponentId
      const set = arch.columnSets.get(c)
      if (set === undefined) continue // tag / pair / no column (§4.5)
      const def = registry.defOf(c)
      if (def === undefined) continue
      const fields: FieldDescriptor[] = []
      for (const f of def.fields as readonly FieldDescriptor[]) if (f.ctor !== null) fields.push(f)
      components.push({ componentId: c, columns: set.columns, fields })
    }
    return {
      id: arch.id as number,
      signature: arch.signature as unknown as readonly number[],
      count: arch.count,
      rows: arch.rows,
      components,
    }
  }

  const serialize: SerializationSurface = {
    schemaHash: computeSchemaHash,
    components(): readonly SerializeComponentMeta[] {
      const out: SerializeComponentMeta[] = []
      for (const def of userComponents) {
        const id = registry.idOf(def)
        if (id === undefined) continue
        const rt = def as ComponentRuntime<Schema>
        out.push({ name: def.name, id, fieldCount: def.fields.length, storage: rt.options.storage })
      }
      return out
    },
    fieldsOf(id) {
      return registry.defOf(id)?.fields as readonly FieldDescriptor[] | undefined
    },
    componentIdByName(name) {
      return componentIdByName.get(name)
    },
    numComponentTypes() {
      return registry.nextComponentId
    },
    archetypes(): readonly SerializeArchetype[] {
      const out: SerializeArchetype[] = []
      for (const arch of storage.archetypes.byId as Archetype[]) {
        if (arch.cold || arch.count === 0) continue
        out.push(archetypeView(arch))
      }
      // id-ascending (byId is already in id order, but tag/cold gaps are filtered above).
      out.sort((a, b) => a.id - b.id)
      return out
    },
    relations() {
      return serializationProvider ?? undefined
    },
    richFields() {
      return richFieldList
    },
    richValueOf(handle, componentId, fieldIndex) {
      if (!entities.isAlive(handle)) return undefined
      const index = handleIndexOf(handle as number)
      const key = sidecarKey(componentId as number, fieldIndex)
      if (!sidecar.hasColumn(key)) return undefined
      const gen = entities.decodeHandle(entities.handleOfIndex(index)).generation as number
      return sidecar.read(key, index, gen)
    },
    richIsPresent(handle, componentId, fieldIndex) {
      if (!entities.isAlive(handle)) return false
      const index = handleIndexOf(handle as number)
      const key = sidecarKey(componentId as number, fieldIndex)
      if (!sidecar.hasColumn(key)) return false
      const gen = entities.decodeHandle(entities.handleOfIndex(index)).generation as number
      return sidecar.isPresent(key, index, gen)
    },
    setRichValue(handle, componentId, fieldIndex, value) {
      if (!entities.isAlive(handle)) return
      const index = handleIndexOf(handle as number)
      const key = sidecarKey(componentId as number, fieldIndex)
      if (!sidecar.hasColumn(key)) return
      const gen = entities.decodeHandle(entities.handleOfIndex(index)).generation as number
      sidecar.write(key, index, gen, value)
      // Mark the loaded value changed identically to a live write so a delta from THIS receiver re-emits
      // it (parity with the column path, which writes through tracked accessor setters). Whole-entity
      // changeVersion stamp; fieldIndex forwarded but discarded downstream as for numeric fields (§5.3).
      trackWrite(index, componentId as ComponentId, fieldIndex)
    },
    enableStructuralJournal() {
      ;(reactivity as Reactivity).enableStructuralJournal()
    },
    drainStructuralSince(since) {
      return (reactivity as Reactivity).drainStructuralSince(since)
    },
    relationIdOfPair(pairId) {
      return serializationProvider?.relationIdOfPair(pairId)
    },
    spawn() {
      return entities.spawn()
    },
    spawnInto(handle, componentIds) {
      if (componentIds.length === 0) return
      const defs: ComponentDef<Schema>[] = []
      for (const c of componentIds) {
        const def = registry.defOf(c as ComponentId)
        if (def !== undefined) defs.push(def)
      }
      storage.addMany(handle, defs)
    },
    removeComponents(handle, componentIds) {
      if (componentIds.length === 0 || !entities.isAlive(handle)) return
      const defs: ComponentDef<Schema>[] = []
      for (const c of componentIds) {
        const def = registry.defOf(c as ComponentId)
        if (def !== undefined) defs.push(def)
      }
      if (defs.length > 0) storage.removeMany(handle, defs)
    },
    despawn(handle) {
      if (entities.isAlive(handle)) entities.despawn(handle)
    },
    columnsOf(handle, componentId) {
      if (!entities.isAlive(handle)) return null
      const index = handleIndexOf(handle as number)
      const archId = records.archetypeIdOf(index)
      const arch = storage.archetypes.byId[archId] as Archetype | undefined
      if (arch === undefined || arch.cold) return null
      const set = arch.columnSets.get(componentId as ComponentId)
      if (set === undefined) return null
      const def = registry.defOf(componentId as ComponentId)
      if (def === undefined) return null
      const fields: FieldDescriptor[] = []
      for (const f of def.fields as readonly FieldDescriptor[]) if (f.ctor !== null) fields.push(f)
      return { columns: set.columns as readonly Column[], fields, row: records.rowOf(index) }
    },
    clearAll() {
      // Collect alive handles from every hot archetype first (despawn shuffle-pops rows mid-iteration).
      const handles: EntityHandle[] = []
      for (const arch of storage.archetypes.byId as Archetype[]) {
        if (arch.cold) continue
        for (let r = 0; r < arch.count; r++) handles.push((arch.rows[r] as number) as EntityHandle)
      }
      for (const h of handles) if (entities.isAlive(h)) entities.despawn(h)
    },
    aliveCount() {
      return entities.handleStats().aliveCount
    },
    indexBits: handleLayout.indexBits,
    handleIndex: (handle) => handleIndexOf(handle as number),
    capabilities: () => capabilities,
  }

  const world: World = {
    get options() {
      return resolved
    },
    get phase() {
      return state.phase
    },
    __setPhase(phase) {
      state.phase = phase
    },
    __spawnReserved(handle) {
      storage.onSpawn(handle)
    },
    __apply: {
      defOf(id) {
        return registry.defOf(id)
      },
      addMany(handle, defs) {
        storage.addMany(handle, defs)
      },
      removeMany(handle, defs) {
        storage.removeMany(handle, defs)
      },
      writePayload(handle, def, values) {
        const view = entities.entity(handle).write(def) as Record<string, unknown>
        for (const k of Object.keys(values)) view[k] = values[k]
      },
      addPair(subject, relationId, target, payload) {
        applyAddPair?.(subject, relationId, target, payload)
      },
      removePair(subject, relationId, target) {
        applyRemovePair?.(subject, relationId, target)
      },
    },
    __installRelations() {
      return {
        allocSyntheticId: () => registry.allocSyntheticId(),
        registerSynthetic: (def, id) => registry.registerSynthetic(def, id),
        defOf: (id) => registry.defOf(id),
        migrateAddingMany: (handle, defs) => storage.addMany(handle, defs),
        migrateRemovingMany: (handle, defs) => storage.removeMany(handle, defs),
        bitmaskHas: (index, id) => bitmask.bitmaskHas(index, id),
        columnSetFor: (handle, def) => {
          if (!entities.isAlive(handle)) return null
          const index = handleIndexOf(handle as number)
          const archId = records.archetypeIdOf(index)
          const arch = storage.archetypes.byId[archId] as Archetype | undefined
          if (arch === undefined || arch.cold) return null
          const set = arch.columnSets.get(registry.idOf(def) as ComponentId)
          if (set === undefined) return null
          return { set, row: records.rowOf(index) }
        },
        isAlive: (handle) => entities.isAlive(handle),
        handleIndex: (handle) => handleIndexOf(handle as number),
        handleOfIndex: (index) => entities.handleOfIndex(index),
        despawn: (handle) => entities.despawn(handle),
        deferRelationOp: (op, subject, relation, target, payload) => {
          if (!observerCommands.deferring) return false
          const relationId = relation.id as RelationId
          if (op === 'add') observerCommands.stageAddPair(subject, relation, relationId, target, payload)
          else observerCommands.stageRemovePair(subject, relation, relationId, target)
          return true
        },
        trackWrite: (index, componentId) => trackWrite(index, componentId),
        trackShapePair: (index, pairId, targetIndex, add) => {
          ;(reactivity as Reactivity).trackShapePair(
            index,
            pairId,
            targetIndex,
            add ? ShapeKind.AddPair : ShapeKind.RemovePair,
          )
        },
        trackShapeSetPayload: (index, pairId, targetIndex) => {
          ;(reactivity as Reactivity).trackShapeSetPayload(index, pairId, targetIndex)
        },
        buffers,
        accessorWorld,
        setPreDespawn: (hook) => {
          preDespawnHook = hook
        },
        setPairResolver: (resolve) => {
          pairResolver = resolve
        },
        setApplyPair: (addPair, removePair) => {
          applyAddPair = addPair
          applyRemovePair = removePair
        },
        setSerializationProvider: (provider) => {
          serializationProvider = provider
        },
        maxEntities: resolved.maxEntities,
        indexBits: handleLayout.indexBits,
      }
    },
    __exportShared() {
      const base = buffers.exportSharedHandles()
      // The entity-record regions are owned by EntityStore (allocU32), not the Buffers registry, so
      // merge them into the manifest here — a worker needs them to resolve (archetypeId, row).
      const rec = entities.sharedRecordRegions()
      const extra: SharedHandleManifest['regions'][number][] = []
      if (rec.archetypeId instanceof SharedArrayBuffer) {
        extra.push({ key: 'entity.archetypeId' as RegionKey, backing: rec.archetypeId, element: 'u32' })
      }
      if (rec.archetypeRow instanceof SharedArrayBuffer) {
        extra.push({ key: 'entity.archetypeRow' as RegionKey, backing: rec.archetypeRow, element: 'u32' })
      }
      return { columns: base.columns, regions: [...base.regions, ...extra] }
    },
    __serialize: serialize,
    __mergeWorkerWrites(pairs, count) {
      ;(reactivity as Reactivity).mergeWorkerWrites(pairs, count)
    },
    get tick() {
      return state.tick
    },
    currentTick() {
      return state.tick
    },
    spawn() {
      if (observerCommands.deferring) {
        // §7.4: a spawn inside an observer reserves a live handle NOW (so the handler can configure it)
        // but defers archetype placement to the next flush — the command-buffer reserved-spawn model.
        const handle = reserveEntityBlock(entities.index, -1, 1).handles[0] as EntityHandle
        observerCommands.stageSpawnWith(handle, [])
        return handle
      }
      return entities.spawn()
    },
    spawnWith(...specs) {
      // Split each arg into its def (for the single EMPTY→target migration) and any `[def, values]`
      // initializer (Item 8). Values are written AFTER placement through the tracked accessor path so
      // onChange/write-log fire exactly as a post-spawn write would.
      const defs: ComponentDef<Schema>[] = []
      const values: (readonly [ComponentDef<Schema>, Record<string, unknown>])[] = []
      for (const spec of specs as readonly (ComponentDef<Schema> | readonly [ComponentDef<Schema>, Record<string, unknown>])[]) {
        if (Array.isArray(spec)) {
          const [def, vals] = spec as readonly [ComponentDef<Schema>, Record<string, unknown>]
          defs.push(def)
          values.push([def, vals])
        } else {
          defs.push(spec as ComponentDef<Schema>)
        }
      }
      if (observerCommands.deferring) {
        const handle = reserveEntityBlock(entities.index, -1, 1).handles[0] as EntityHandle
        observerCommands.stageSpawnWith(handle, defs, values)
        return handle
      }
      const handle = entities.spawn()
      storage.spawnWith(handle, defs)
      for (const [def, vals] of values) {
        const view = entities.entity(handle).write(def) as Record<string, unknown>
        for (const k of Object.keys(vals)) view[k] = vals[k]
      }
      return handle
    },
    add(handle, def) {
      if (observerCommands.deferring) {
        observerCommands.stageAdd(handle, def)
        return
      }
      storage.add(handle, def)
    },
    remove(handle, def) {
      if (observerCommands.deferring) {
        observerCommands.stageRemove(handle, def)
        return
      }
      storage.remove(handle, def)
    },
    warm(...defs) {
      storage.warm(defs)
    },
    despawn(handle) {
      if (observerCommands.deferring) {
        observerCommands.stageDespawn(handle)
        return
      }
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
      const arch = storage.archetypes.byId[archetypeId] as Archetype | undefined
      const count = arch === undefined ? 0 : arch.count
      const rows = arch?.rows
      return (reactivity as Reactivity).changedRows(archetypeId, since, count, (row) =>
        rows === undefined ? 0 : handleIndexOf(rows[row] as number),
      )
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
      // R-3 re-entrancy guard: a drain must never re-enter itself (the flush below can trigger query
      // maintenance / structural ops that must not recursively re-drain). If already draining, return.
      if (!observerCommands.enterDrain()) return
      try {
        // §7.4 "applied at the NEXT serial flush": apply the ops staged by the PREVIOUS drain's
        // observers before reading this drain's frozen log snapshot. For 'frame-end' cadence this is the
        // next frame; for 'per-system' it is the next wave's slot. Applying here (not synchronously
        // mid-handler) is what makes a spawned entity observable by onAdd NEXT drain, deterministically.
        observerCommands.flush(observerApply)
        // Structural ops the handlers issue during THIS drain stage to the buffer instead of mutating
        // the world mid-drain (so no observer ever sees a partially-applied wave).
        observerCommands.beginDeferring()
        try {
          ;(reactivity as Reactivity).observerDrain()
        } finally {
          observerCommands.endDeferring()
        }
      } finally {
        observerCommands.exitDrain()
        // rich-fields.md §4.3a: flush the deferred rich-field clears now that onRemove handlers have run
        // — the same post-observer point storage's deferred row reclaim ceases to be readable. After this
        // the dying entity's rich values are gone (RF-REMOVE-READ window closes); a recycled index reads
        // the default via the generation guard regardless.
        sidecar.flushPending()
      }
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
