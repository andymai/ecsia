// The World keystone: option resolution, the phase/tick contracts, and the module-wiring seam.
// The seven owning modules attach in the fixed order
// registry → buffers → storage → reactivity → queries → scheduler → serialization.

import { ConfigError, resolveOptions } from './config.js'
import type { ResolvedWorldOptions, WorldOptions } from './config.js'
import {
  EntityStore,
  handleGeneration,
  handleIndex,
  makeHandle,
  makeHandleLayout,
  reserveEntityBlock,
  returnReservedIds,
} from './entity/index.js'
import type {
  AccessorResolver,
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
import { SidecarStore, defineTag, sidecarKey } from './component/index.js'
import type { SidecarKey } from './component/index.js'
import { Bitmask } from './bitmask/index.js'
import { Storage } from './storage/index.js'
import type { Archetype, Signature } from './storage/index.js'
import { QueryEngine } from './query/index.js'
import type { LiveQuery, ResolvedPair } from './query/index.js'
import { ShapeKind } from './reactivity/index.js'
import type { ColumnSet } from './component/index.js'
import type { Buffers as BuffersType, ColumnGrowthLog } from './memory/index.js'
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
import type { InspectSurface, InspectArchetype, InspectQuery } from './inspect-surface.js'
import type { ComponentRuntime } from './component/index.js'
import { Topics } from './topics/index.js'
import type { TopicDef, TopicEventInit } from './topics/index.js'
import { IS_DEV } from './env.js'
import { isSharedBacking } from './memory/buffers.js'

/**: 'serial' during the serial slot (and always, single-threaded); 'wave' only while the scheduler dispatches worker waves. */
export type WorldPhase = 'serial' | 'wave'

/**
 * The ComponentId-keyed structural-apply verbs the command-buffer flush path drives.
 * Built from the world's storage + registry; every call runs serial/main-thread.
 */
export interface WorldApplySurface {
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  addMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  removeMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** Overwrite `def`'s fields on `handle`'s current row + emit the `.changed` write-log entry. */
  writePayload(handle: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  /**
   * Relation apply. Filled by `__installRelations`; undefined in a
   * relation-free world. The scheduler's command-apply path calls these for OP_ADD_PAIR /
   * OP_REMOVE_PAIR — it does NOT import relations (the acyclic boundary holds).
   */
  addPair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined): void
  removePair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
}

/**
 * The minimal core surface the relations runtime drives. The world exposes it through
 * `__installRelations` so `@ecsia/relations` attaches WITHOUT @ecsia/core ever importing it (the
 * acyclic dependency direction, seam). Everything here is serial / main-thread.
 */
export interface RelationsHost {
  /** Mint the next dense ComponentId. */
  allocSyntheticId(): ComponentId
  /** Intern a synthetic ComponentDef (presence/overflow) at a minted id so storage can build its columns. */
  registerSynthetic(def: ComponentDef<Schema>, id: ComponentId): void
  /** id → registered def (real or synthetic). */
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  /** ONE migration adding several ids (relations atomicity; archetype-storage ). */
  migrateAddingMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  migrateRemovingMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** O(1) membership of a (possibly synthetic) component id via the per-entity bitmask. */
  bitmaskHas(index: number, id: ComponentId): boolean
  /** Resolve the live ColumnSet + current row for `def` on `handle`, or null if absent / not hot. */
  columnSetFor(handle: EntityHandle, def: ComponentDef<Schema>): { set: ColumnSet; row: number } | null
  /**
   * Like columnSetFor, but COLD-capable: a cold resident resolves to its per-type overflow block +
   * cold row (the same resolution storage's migrate path uses). Null only for dead handles, tags,
   * or components the entity does not hold. The prefab copy path reads/writes through this so
   * templates and instances parked in cold archetypes copy correctly.
   */
  fieldLocationFor(handle: EntityHandle, def: ComponentDef<Schema>): { set: ColumnSet; row: number } | null
  /** Entity-layer helpers. */
  isAlive(handle: EntityHandle): boolean
  handleIndex(handle: EntityHandle): number
  handleOfIndex(index: number): EntityHandle
  /** Re-enter the despawn protocol for a cascaded victim. */
  despawn(handle: EntityHandle): void
  /**
   * The auto-registered `Prefab` tag def when the world was created with `prefabs: true`; null
   * otherwise. The relations runtime keys the prefab API (definePrefab / spawnFrom / IsA) off it.
   */
  readonly prefabDef: ComponentDef<Schema> | null
  /** The component ids in `handle`'s current archetype signature (a copy); [] for a dead handle. */
  componentIdsOf(handle: EntityHandle): readonly number[]
  /** Mint a live handle in the EMPTY archetype — the spawn step of definePrefab / spawnFrom. */
  spawnEmpty(): EntityHandle
  /**
   * Copy `componentId`'s rich (sidecar) fields from src's slot to dst's. Only PRESENT (written)
   * slots copy, so a never-touched field stays defaulted on dst. object<T> fields copy the
   * REFERENCE — sidecar assignment semantics, same as a plain write.
   */
  copyRichFields(src: EntityHandle, dst: EntityHandle, componentId: ComponentId): void
  /**
   * Template-spawn deferral seam (definePrefab / spawnFrom): while an observer drain is running,
   * reserve a live handle NOW (so the handler gets a usable handle back — the spawnWith staging
   * model) and stage `build` to run against it at the next serial flush, after placement into the
   * EMPTY archetype. Returns null when no drain is in flight — the caller spawns and builds
   * directly.
   */
  deferTemplateSpawn(build: (handle: EntityHandle) => void): EntityHandle | null
  /**
   * True while an observer drain is deferring OR staged ops await the next serial flush. Lets the
   * relations dev errors distinguish a reserved (staged, not-yet-materialized) template handle —
   * alive but with an empty signature — from a genuinely untagged entity.
   */
  hasPendingDeferred(): boolean
  /**
   * deferral seam: while an observer drain is running, structural relation
   * ops issued by a handler must STAGE to the world's deferred command buffer rather than mutate the
   * world mid-drain. The relations runtime calls this at the top of addPair/removePair; if it returns
   * true the op was staged (the runtime returns immediately) — else the runtime applies it directly.
   */
  deferRelationOp(op: 'add' | 'remove', subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle, payload?: Record<string, unknown>): boolean
  /** Push a write-log entry for a `.changed`-tracked pair-payload write. */
  trackWrite(index: number, componentId: ComponentId): void
  /** Push an ADD_PAIR / REMOVE_PAIR shape-log entry. `journal: false` = observer-only carrier
   * (the exclusive valve's pair events on the presence id) — shape log yes, structural journal no. */
  trackShapePair(index: number, pairId: ComponentId, targetIndex: number, add: boolean, journal?: boolean): void
  /**
   * Journal a SET_PAYLOAD structural op for a non-exclusive overflow pair whose payload changed on an
   * already-live pair (overflow payload changes are explicit OP_PAIR_PAYLOAD
   * records, since they do not live in an archetype column the changed-row scan covers).
   */
  trackShapeSetPayload(index: number, pairId: ComponentId, targetIndex: number): void
  /** The SAB-capable buffers registry, for the non-exclusive overflow payload ColumnSet. */
  readonly buffers: BuffersType
  readonly accessorWorld: AccessorWorld
  /** Register a preDespawn hook fired BEFORE the row is torn down. */
  setPreDespawn(hook: (dying: EntityHandle) => void): void
  /** Inject the Pair(...) term resolver into the query compiler. */
  setPairResolver(resolve: (relationId: number, target: number | symbol) => ResolvedPair): void
  /**
   * Inject the pair-observer resolver (synthetic pair ComponentId → RelationId, -1 = not a pair)
   * so the deferred drain can dispatch relation-level onPairAdded/onPairRemoved terms.
   */
  setPairObserverResolver(resolve: (pairComponentId: number) => number): void
  /** Fill the OP_ADD_PAIR / OP_REMOVE_PAIR apply seam so the scheduler can drive relations. */
  setApplyPair(
    addPair: (subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined) => void,
    removePair: (subject: EntityHandle, relationId: RelationId, target: EntityHandle) => void,
  ): void
  /**
   * Install the relation snapshot/apply provider the serialization module reads through `world.__serialize`
   * Lets @ecsia/serialization enumerate live pairs and re-establish them
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
   * Phase-flip seam. The world OWNS the field and seeds it to 'serial';
   * the scheduler is the SOLE caller of this, flipping to 'wave' across worker dispatch and back to
   * 'serial' for the merge/apply flush slot. @ecsia/core never calls it (the acyclic boundary holds —
   * the scheduler drives the world externally). Not for user code.
   */
  __setPhase(phase: WorldPhase): void
  /**
   * Command-buffer apply seam (`spawnReserved`). Place a handle that was
   * already made alive by `reserveEntityBlock` into the EMPTY archetype and
   * emit its Create shape entry — the deferred analogue of `world.spawn()` whose identity was minted
   * before the wave. Serial-phase only. Called ONLY by the scheduler's flush path. Not for user code.
   */
  __spawnReserved(handle: EntityHandle): void
  /**
   * Command-buffer apply surface, exposed as ONE seam so the scheduler's flush
   * path drives the same storage primitives a main-thread direct-apply would, keyed by ComponentId.
   * Serial-phase only; called ONLY by the scheduler. Not for user code.
   */
  readonly __apply: WorldApplySurface
  /**
   * Relations attach seam. `@ecsia/relations` calls this ONCE to obtain the core
   * surface it drives (synthetic id minting, migrate-many, preDespawn hook, pair-resolver injection,
   * OP_ADD_PAIR apply). @ecsia/core never imports @ecsia/relations — the host is handed OUT, keeping
   * the dependency direction acyclic. Not for user code; call createRelations(world) instead.
   */
  __installRelations(): RelationsHost
  /** Export the SAB buffer-set manifest for one-time worker transfer. */
  __exportShared(): SharedHandleManifest
  /**
   * Column re-backing journal. The scheduler reads
   * `.generation` once per wave (a cheap monotonic int) and only `.drain()`s when it advanced — the
   * notices it gets are the new SAB backings the worker pool must re-wrap at the wave fence before the
   * next dispatch. In-place `.grow()` never bumps the generation (length-tracking views auto-widen).
   * Serial / main-thread; called ONLY by the scheduler. Not for user code.
   */
  __columnGrowth(): ColumnGrowthLog
  /**
   * Serialization seam. @ecsia/serialization reads archetype columns + the
   * registry + the relation provider through this, and drives deserialize-side spawn/migrate. Serial /
   * main-thread only; @ecsia/core never imports @ecsia/serialization (acyclic boundary). Not for user code.
   */
  readonly __serialize: SerializationSurface
  /**
   * Read-only introspection seam (@ecsia/devtools). Exposes the FULL archetype census (cold +
   * empty included) and the live-query enumeration — the two data an inspector needs that `__serialize`
   * (snapshot-shaped: hot, non-empty only) and the public query surface do not reach. Pure reads, serial
   * / main-thread; @ecsia/core never imports @ecsia/devtools (acyclic boundary). Not for user code.
   */
  readonly __inspect: InspectSurface
  /**
   * Merge ONE worker's staged value writes into the reactivity write log (   * ). `pairs` is the worker's raw `[index, componentId, …]` corral payload and `count` the number
   * of `(index, componentId)` entries. The scheduler drives this in ASCENDING worker-index order in
   * the serial flush slot so onChange observers + `.changed` filters fire for worker writes
   * deterministically. Serial-phase only; called ONLY by the scheduler. Not for user code.
   */
  __mergeWorkerWrites(pairs: Int32Array | Uint32Array, count: number): void
  /**
   * Topic store seam. The scheduler registers `publish:`/`consume:`-declared topics, stages
   * `ctx.publish` events, drives the per-wave canonical merge, and routes OP_PUBLISH records here.
   * Serial / main-thread; not for user code — the public surfaces are `world.publish` and the
   * system context's `publish`/`consume`.
   */
  readonly __topics: Topics
  /** Current frame tick. Advanced by reactivity at frame reset. */
  readonly tick: number
  /** Alias for `tick`. */
  currentTick(): number

  /** Create a new entity with the empty signature. Main-thread/serial. O(1). */
  spawn(): EntityHandle
  /**
   * Create a new entity and add the given components in ONE migration (EMPTY → target signature),
   * never N. Main-thread/serial.
   *
   * Each argument is either a bare `ComponentDef` (membership only) or a `[def, values]` tuple that
   * also INITIALIZES the component: `spawnWith([Position, { x: 1, y: 2 }], Velocity)` spawns the entity,
   * migrates it to the target signature once, then writes the supplied values through the normal tracked
   * accessor path (so onChange/write-log fire). The value object is type-inferred from the def's schema.
   */
  spawnWith<const T extends readonly SpawnArg[]>(...specs: { [I in keyof T]: SpawnArgFor<T[I]> }): EntityHandle
  /** Add a component to a live entity (single migration via the cached edge). Main-thread/serial. */
  add(handle: EntityHandle, def: ComponentDef<Schema>): void
  /** Remove a component from a live entity (single migration via the cached edge). Main-thread/serial. */
  remove(handle: EntityHandle, def: ComponentDef<Schema>): void
  /** Explicit cold→hot archetype promotion at a serial flush point. */
  warm(...defs: readonly ComponentDef<Schema>[]): void
  /** Destroy an entity. Main-thread/serial. Idempotent on dead handles. */
  despawn(handle: EntityHandle): void
  /** O(1) liveness/staleness check. Never consults the bitmask. */
  isAlive(handle: EntityHandle): boolean
  /**
   * O(1) component membership point-test via the per-entity bitmask.
   * Main-thread/serial only. Returns false for a dead handle (liveness checked first,
   * without reading the bitmask).
   */
  has(handle: EntityHandle, def: ComponentDef<Schema>): boolean
  /**
   * Resolve the pooled EntityRef for `handle`; throws on a dead handle unless `{ lenient: true }`
   * `spawnWith(...defs)` is the other; it is
   * intentionally deferred to storage, which owns target-signature computation and the
   * single migration — the handle mint here is meaningless without an archetype to land in.
   */
  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRef

  /** Pre-reserve a block of live handles for a worker to consume mid-wave. Serial-phase only. */
  reserveEntityBlock(workerIndex: number, count: number): EntityReservation
  /** Reclaim the unconsumed tail of a reservation, LIFO, at bumped generation. */
  returnReservedIds(reservation: EntityReservation, consumedCount: number): void

  /** Frozen handle codec layout, also valid to hand to workers. */
  readonly handleLayout: HandleLayout
  encodeHandle(index: number, generation: number): EntityHandle
  decodeHandle(handle: EntityHandle): { index: EntityIndex; generation: EntityGeneration }
  handleStats(): HandleStats

  /**
   * Push (entityIndex, componentId[, fieldIndex]) to the reactivity write log for the `.changed`
   * filter. STUBBED as a no-op until — the canonical signature and
   * accessor-setter call sites are in place now so only fills the body.
   */
  trackWrite(index: number, componentId: ComponentId, fieldIndex?: number): void

  /**
   * Register a deferred observer. Fires ONLY at the serial observer slot
   * (observerDrain), NEVER synchronously mid-system. Mutations inside the handler stage to the
   * command buffer and apply at the next serial flush ( re-entrancy safety).
   */
  observe(term: ObserverTerm, handler: ObserverHandler): ObserverHandle

  /**
   * Publish one event from OUTSIDE systems (input handlers, network code) — main thread, serial
   * phase, between frames. The event orders ahead of wave 0 of the next frame, in call order, and
   * every system sees it next update. Inside a system body use the context's `publish` instead, so
   * the event enters the canonical (frame, wave, SystemId, FIFO) order; calling this mid-update
   * throws. Values are copied at call time; missing fields take their schema defaults.
   */
  publish<S extends Schema>(topic: TopicDef<S>, init?: TopicEventInit<S>): void

  /**
   * Did any component on `handle` change strictly after tick `since`?. Driven by
   * the per-row changeVersion stamps, NOT the write log. Lazily enabled the first time a
   * `.changed` query flavor or this predicate is used.
   */
  changedSince(handle: EntityHandle, since: number): boolean
  /** The rows of `archetypeId` whose changeVersion stamp is > since (the delta serializer scan). */
  changedRows(archetypeId: number, since: number): Iterable<number>

  /** Advance the frame tick (reactivity.frameReset calls this; world owns the counter). */
  advanceTick(): void
  /** (no-op single-threaded). */
  mergeCorrals(): void
  /**, re-testing affected entities against referencing queries. */
  maintainStructural(): void
  /** */
  observerDrain(): void
  /** /merge spill, schedule next-frame ring resize. */
  flushLogs(): void

  /**
   * Compile (or fetch the cached) LiveQuery for `terms` and return it. Identical
   * term sets share one LiveQuery by canonical hash (order-independent, pair-target-encoded). The
   * arity-cap overload family (1..8 inferred, 9+ → LooseQueryElement) is the WorldQuery type.
   */
  query: WorldQuery

  /**
   * Reset every live query's per-frame transient flavor (added/removed) lists. The kernel-only frame
   * loop calls this at frame start; the scheduler drives it at.
   */
  frameReset(): void
}

interface WorldState {
  phase: WorldPhase
  tick: number
}

/**
 * The only world constructor. Resolves and validates options fail-fast, then
 * (at later milestones) probes capabilities, allocates bounded buffers, and wires the owning
 * modules. Returns a frozen World facade.
 */
export function createWorld(options: WorldOptions = {}): World {
  const resolved = resolveOptions(options)

  // --- Module wiring seam ---
  // registry → buffers → storage → reactivity → queries → scheduler → serialization.
  // The entity layer lands first; later layers fill in around it.
  const state: WorldState = { phase: 'serial', tick: 0 }

  const handleLayout = makeHandleLayout(resolved.generationBits)
  const entities = new EntityStore({
    layout: handleLayout,
    maxEntities: resolved.maxEntities,
    shared: resolved.threaded,
  })

  // --- buffers: one capability probe, one SAB-vs-AB decision ---
  const workerMode: WorkerMode = resolved.threaded
    ? resolved.scheduler.workers === 'no-sab'
      ? 'no-sab'
      : 'auto'
    : 'single'
  const capabilities = probeCapabilities(workerMode, (message) => {
    if (typeof console !== 'undefined') console.warn(`[ecsia] ${message}`)
  })
  const buffers = new Buffers({ capabilities, maxEntities: resolved.maxEntities })

  // The accessor seam: a setter calls world.trackWrite. handleIndex strips the generation so the LOW
  // handle bits index the write log. Routes to the reactivity module once built
  // (late-bound so the acyclic construction order registry → buffers → storage → reactivity holds).
  let reactivity: Reactivity | null = null
  const trackWrite = (index: number, componentId: ComponentId, fieldIndex?: number): void => {
    reactivity?.trackWrite(index, componentId, fieldIndex)
  }
  // The shared "any write consumer exists" cell the accessor setters read to fast-out the trackWrite
  // chain. Reactivity owns recomputing `.active` on every flavor/observer/changeVersion
  // (de)registration; until reactivity is wired it stays false (no consumers can exist yet).
  const tracking = { active: false }
  // The rich-field sidecar. Created BEFORE accessorWorld so the accessor's rich
  // getters/setters can delegate through the seam. Main-thread-only; never shared with workers.
  const sidecar = new SidecarStore()
  // During an observer drain the rich getter must read the DYING entity's value (RF-REMOVE-READ); the
  // sidecar disambiguates via its generation-stamped pending-clear table, so route reads through
  // readForObserver while a pending window is open and through the generation-guarded read otherwise.
  // Reads/writes are keyed by the BOUND handle's generation (not the index's live generation) so a
  // remove-event ref bound to the dying handle reaches its own tenant's stash while a same-window
  // re-mint at the index reads/writes its own slot.
  const accessorWorld: AccessorWorld = {
    trackWrite,
    tracking,
    handleIndex: (handle) => handleIndex(handle, handleLayout) as number,
    sidecarRead: (key, index, gen) =>
      sidecar.hasPending() ? sidecar.readForObserver(key, index, gen) : sidecar.read(key, index, gen),
    sidecarWrite: (key, index, gen, value) => sidecar.write(key, index, gen, value),
    handleGeneration: (handle) => handleGeneration(handle, handleLayout) as number,
  }

  // --- registry: mint dense user ids, wire accessor factories ---
  // prefabs: true auto-appends the per-world `Prefab` tag AFTER user components (an ordinary
  // registered tag, no reserved-id churn). Its stable name "ecsia:Prefab" rides the serialization
  // registry + schemaHash like any user component, so both sides of a snapshot must agree on the
  // flag. Per-world because registerComponentId binds a def to one world.
  const prefabDef = resolved.prefabs ? (defineTag('ecsia:Prefab') as ComponentDef<Schema>) : null
  if (IS_DEV) {
    // "ecsia:" is the built-ins' stable serialization namespace ("ecsia:Prefab", "ecsia:IsA");
    // a user component squatting on it would collide in the name-keyed snapshot registry.
    for (const def of resolved.components as readonly ComponentDef<Schema>[]) {
      if (def.name.startsWith('ecsia:')) {
        throw new ConfigError(`component name '${def.name}' uses the reserved "ecsia:" prefix (ecsia built-in serialization names)`)
      }
    }
  }
  const userComponents: readonly ComponentDef<Schema>[] =
    prefabDef !== null
      ? [...(resolved.components as readonly ComponentDef<Schema>[]), prefabDef]
      : (resolved.components as readonly ComponentDef<Schema>[])
  const registry = new ComponentRegistry()
  registry.register(userComponents)

  // Declare a sidecar column per rich field of every registered component. This
  // is the single place the sidecar learns about a rich column; ensureColumn is idempotent.
  for (const def of userComponents) {
    const id = registry.idOf(def)
    if (id === undefined) continue
    let fieldIndex = 0
    for (const f of def.fields as readonly FieldDescriptor[]) {
      if (f.rich !== undefined) sidecar.ensureColumn(sidecarKey(id as number, fieldIndex), f.rich, f.default)
      fieldIndex += 1
    }
  }

  // --- topics: typed event queues. Zero cost until a topic is registered (no rings, no merge
  // work); topic ids are synthetic ComponentIds minted past the fixed stride, like relation pairs.
  const topics = new Topics({
    buffers,
    allocId: () => registry.allocSyntheticId() as number,
    phase: () => state.phase,
    dev: IS_DEV,
    warn: (message) => {
      if (typeof console !== 'undefined') console.warn(`[ecsia] ${message}`)
    },
  })

  // --- bitmask + storage: the per-entity membership index and the
  // archetype tables. The bitmask stride = ceil(nextComponentId/32); both derive from the SAME
  // registered-component count so sigWords and bitmask layouts align. Structural mutation is
  // serial; the bitmask asserts world.phase === 'serial'.
  const bitmask = new Bitmask(buffers, registry.nextComponentId, resolved.maxEntities, () => state.phase)
  const stride = bitmask.stride
  const records = entities.records
  const handleIndexOf = (handle: number): number => handleIndex(handle as EntityHandle, handleLayout) as number

  // Relations attach late: the pair-resolver feeds the query compiler, the preDespawn hook runs
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
    // A held deferred-dead row was evicted to keep [0,count) dense: re-point its observer-window
    // location stash at the new row so a dead-tenant ref still resolves the surviving values.
    relocateHeld: (handle, archId, newRow) =>
      sidecar.updatePendingLocation(
        handleIndexOf(handle),
        handleGeneration(handle as EntityHandle, handleLayout) as number,
        newRow,
      ),
  })

  // Dev-only re-entrancy guard: > 0 while a query iteration (each/eachChunk/iterator) is running.
  // The immediate structural mutators throw if it's armed — mutating the set you're iterating
  // swap-pops rows and silently skips/double-visits entities. Zero cost in production (IS_DEV gate).
  let iterating = 0
  const iterationMutationError = (op: string): Error =>
    new Error(
      `world.${op}() ran during query iteration — restructuring entities mid-iteration swap-pops rows and ` +
        `silently skips or double-visits them. Collect the handles in the loop, then ${op} them after it.`,
    )

  // --- queries: the canonical-hash dedup cache + per-archetype matching, kept
  // current by the archetypeCreated hook. fixedBitCount = stride*32 (ids below it pack into the
  // signature words; larger pair ids are residual — ).
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
      ...(prefabDef !== null ? { prefabId: registry.idOf(prefabDef) as ComponentId } : {}),
    },
    resolveLocation: (index) => entities.locationOfIndex(index),
    handleOf: (index) => entities.handleOfIndex(index),
    indexOfHandle: handleIndexOf,
    beginIteration: () => {
      iterating += 1
    },
    endIteration: () => {
      iterating -= 1
    },
    coldResidentsOf: (archetypeId) => storage.coldResidentsOf(archetypeId),
    coldColumnSet: (componentId) => storage.coldColumnSet(componentId),
    coldRowOf: (index, componentId) => storage.coldRowOf(index, componentId),
    signatureOf: (index) => {
      const archId = records.archetypeIdOf(index)
      return (storage.archetypes.byId[archId] as Archetype).signature as Signature
    },
  })

  // Rich-field despawn clear. Walk the dying entity's signature for rich
  // fields and decide whether to DEFER the clear: when any held component has a remove-observer, the
  // deferred row reclaim keeps numeric values readable in onRemove, so the sidecar must stash the
  // dying rich values for the same observer window (RF-REMOVE-READ). The decision mirrors storage's
  // `defer` gate exactly so rich and numeric parity holds.
  const sidecarOnDespawn = (handle: EntityHandle): boolean => {
    const index = handleIndexOf(handle as number)
    const archId = records.archetypeIdOf(index)
    const arch = storage.archetypes.byId[archId] as Archetype | undefined
    if (arch === undefined) return false
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
    // Unconditional (even with no rich keys): the sidecar's per-index despawn ordinal must count
    // EVERY despawn so drain-side Destroy entries pair with the right stashed tenant. windowArmed
    // (any remove-observer exists) lets the window run in a rich-free world for the numeric location
    // stash. Returns `defer` so the caller captures the final location after storage.onDespawn.
    sidecar.onDespawn(
      index,
      handleGeneration(handle, handleLayout) as number,
      richKeys,
      defer,
      reactivity?.hasAnyRemoveObserver ?? false,
    )
    return defer
  }

  // The generation-aware resolver shim: a dead-tenant observer ref (lenient bind, dying generation)
  // resolves a HELD NUMERIC component through the dying tenant's stashed archetype location, not the
  // live records a same-window re-mint at the index has overwritten. The divert is per-read +
  // per-component and guarded three ways, so it never perturbs a normal read:
  //   - only while a deferred-despawn window is open (hasPending), only for the lenient observer path;
  //   - only for a generation that has a location stash (a dying tenant — a live handle never matches);
  //   - only when the stashed archetype HOLDS the component AND its row STILL holds this handle
  //     (a same-archetype re-mint that reused the dense row fails the survival check → prior behavior;
  //     a never-held component fails the holds check → prior rich-default / not-held behavior).
  // The rich half stays covered by the generation-guarded sidecar read; this closes the numeric half
  // for every case the dying row survives (PR2's deferred-dead-row hold closes the reused-row case).
  const genAwareResolver: AccessorResolver = {
    resolveRead: (handle, archetypeId, row, def, lenient) =>
      divertLocation(handle, def, lenient) ?? storage.resolveRead(handle, archetypeId, row, def, lenient),
    resolveWrite: (handle, archetypeId, row, def, lenient) =>
      divertWrite(handle, def, lenient) ?? storage.resolveWrite(handle, archetypeId, row, def, lenient),
  }
  function divertTarget(handle: EntityHandle, def: unknown, lenient: boolean | undefined): { archId: number; row: number } | null {
    if (lenient !== true || !sidecar.hasPending()) return null
    const index = handleIndexOf(handle as number)
    const gen = handleGeneration(handle, handleLayout) as number
    const loc = sidecar.locationForObserver(index, gen)
    if (loc === undefined) return null
    const arch = storage.archetypes.byId[loc.archId] as { cold?: boolean; signature: ArrayLike<number>; rows: ArrayLike<number> } | undefined
    if (arch === undefined || arch.cold === true) return null
    const id = (def as { id: number }).id
    let holds = false
    for (let i = 0; i < arch.signature.length; i++) if ((arch.signature[i] as number) === id) { holds = true; break }
    if (!holds) return null
    if ((arch.rows[loc.row] as number) !== (handle as number)) return null // dense row reused → decline
    return loc
  }
  function divertLocation(handle: EntityHandle, def: unknown, lenient: boolean | undefined): unknown {
    const loc = divertTarget(handle, def, lenient)
    return loc === null ? undefined : storage.resolveRead(handle, loc.archId, loc.row, def, lenient)
  }
  function divertWrite(handle: EntityHandle, def: unknown, lenient: boolean | undefined): unknown {
    const loc = divertTarget(handle, def, lenient)
    return loc === null ? undefined : storage.resolveWrite(handle, loc.archId, loc.row, def, lenient)
  }

  entities.setAccessorResolver(genAwareResolver)
  entities.setLifecycle({
    onSpawn: (handle) => storage.onSpawn(handle),
    onDespawn: (handle) => {
      // PreDespawn (cascade + pair teardown) runs WHILE `dying` is still
      // alive/resolvable, BEFORE storage.onDespawn shuffle-pops the row and the entity layer frees it.
      preDespawnHook?.(handle)
      // The rich clear runs BEFORE storage.onDespawn so the dying entity's signature is still resolvable
      // (storage.onDespawn shuffle-pops the row; the entity index record is unchanged either way).
      const deferred = sidecarOnDespawn(handle)
      storage.onDespawn(handle)
      // AFTER storage.onDespawn the deferred swap-pop has settled the dying entity at its resting row;
      // capture (archId, row) NOW (the index record is still the dying tenant's — freeEntity and any
      // re-mint run later) so the resolver shim can serve the dying numeric values.
      if (deferred) {
        const index = handleIndexOf(handle as number)
        sidecar.setPendingLocation(index, records.archetypeIdOf(index), records.rowOf(index))
      }
    },
  })

  // --- reactivity: the write/shape rings, changeVersion stamps, deferred
  // observers, and the query-flavor hooks. Wired AFTER storage + queries so trackWrite/trackShape and
  // observer dispatch can resolve locations and re-test entities.
  reactivity = new Reactivity({
    buffers,
    maxEntities: resolved.maxEntities,
    indexBits: handleLayout.indexBits,
    logEntryWords: resolved.reactivity.logEntryWords,
    maxWritesPerFrame: resolved.reactivity.maxWritesPerFrame,
    maxShapeChangesPerFrame: resolved.reactivity.maxShapeChangesPerFrame,
    shrinkRings: resolved.reactivity.shrinkRings,
    dev: IS_DEV,
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
    // Observer events bind to the handle of the tenant the drain cursor is inside: the stashed
    // DYING handle while the sidecar's pending-clear window covers the index — the rich getter then
    // passes that tenant's generation and reaches its stash even when the index was re-minted in the
    // same window. Without a stash (no deferred despawn this window, or a component remove on a live
    // entity) the current handle preserves the existing behavior. The hasPending() gate is safe
    // because mutations stage during a drain: with zero stashes at drain entry none can appear
    // mid-drain, so pendingGenerationOf would return undefined for every index anyway.
    eventRefOf: (index) => {
      const gen = sidecar.hasPending() ? sidecar.pendingGenerationOf(index) : undefined
      const handle = gen === undefined ? entities.handleOfIndex(index) : makeHandle(index, gen, handleLayout)
      return entities.entity(handle, { lenient: true })
    },
    onDestroyDrained: (index) => sidecar.noteDestroyDrained(index),
    onCreateDrained: (index) => sidecar.supersedePending(index),
    resolveHandle: (index) => entities.handleOfIndex(index) as number,
    tracking,
  })
  // The shape-log drain re-runs the same idempotent single-entity maintenance the synchronous
  // hook performs; the conservative overflow path needs a "current matches" source for change
  // observers.
  reactivity.setMaintainHook((index, c) => engine?.maintainEntity(index, c as ComponentId))
  reactivity.setCurrentMembersSource(() => collectCurrentMembers(engine as QueryEngine))
  ;(engine as QueryEngine).setReactivity({
    attachChangedFlavor: (q, ids) => (reactivity as Reactivity).attachChangedFlavor(q, ids),
    drainChanged: (q) => (reactivity as Reactivity).drainChanged(q),
  })

  // --- deferred-observer command buffer ---
  // While observerDrain runs, the world's structural verbs (spawn/spawnWith/add/remove/despawn and
  // the relations apply-pair seam) STAGE here instead of direct-applying, so an observer handler that
  // mutates structure cannot corrupt the wave the drain is replaying. The staged ops apply at
  // the start of the NEXT drain — i.e. the next serial flush. applyAddPair/applyRemovePair are the
  // SAME relation seams the scheduler's command-apply path drives (filled by __installRelations).
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

  // --- serialization surface -------------------------
  // Reads archetype columns/signatures + the registry + the relation provider; drives deserialize-side
  // spawn/migrate. The user-component metadata is the registered defs in dense-id order (the
  // auto-registered Prefab tag included). Synthetic ids (pair/presence/overflow) are intentionally
  // excluded from `components()` — they are reconstructed by re-minting on the receiver, never
  // shipped as schema.
  const componentIdByName = new Map<string, ComponentId>()
  for (const def of userComponents) {
    const id = registry.idOf(def)
    if (id !== undefined) componentIdByName.set(def.name, id)
  }

  // Rich-field enumeration for the serialization sidecar section. Built once
  // from the registered defs in (componentId, fieldIndex) order; the snapshot/delta writers join this
  // with each entity's signature — they MUST NOT read `archetypeView().components`, which strips rich
  // fields (and drops rich-only components entirely).
  const richFieldList: SerializeRichField[] = []
  for (const def of userComponents) {
    const id = registry.idOf(def)
    if (id === undefined) continue
    let fieldIndex = 0
    for (const f of def.fields as readonly FieldDescriptor[]) {
      if (f.rich !== undefined) richFieldList.push({ componentId: id, fieldIndex, name: f.name, kind: f.rich, persist: f.persist })
      fieldIndex += 1
    }
  }

  const computeSchemaHash = (): number => {
    // FNV-1a over the canonical (componentName, fieldName, token)* + relation names. The receiver
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
        // The persisted-field subset is part of the wire contract: the SoA sections are positional
        // over PERSISTED columns only, so producers/consumers whose persist flags differ must be
        // rejected. Hashed only when false so all-persisted schemas keep their existing hash.
        // (Relation payloads are exempt: the pair-payload wire is name-keyed/self-describing.)
        if (!f.persist) fnv('!persist')
      }
    }
    // The prefabs flag is part of the wire contract (built-ins + default query exclusion must
    // agree on both sides), beyond the "ecsia:Prefab" name the component loop already folds.
    if (resolved.prefabs) fnv('!prefabs')
    const prov = serializationProvider
    if (prov !== null) for (const r of prov.relations()) fnv(r.name)
    return h >>> 0
  }

  const archetypeView = (arch: Archetype): SerializeArchetype => {
    const components: SerializeComponentColumns[] = []
    // Iterate the signature in canonical (sorted) order so column order is deterministic.
    for (let i = 0; i < arch.signature.length; i++) {
      const c = arch.signature[i] as number as ComponentId
      const set = arch.columnSets.get(c)
      if (set === undefined) continue // tag / pair / no column
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

  // Cold residents in ascending entity-index order. This ordering is a CONTRACT shared by
  // coldArchetypeView and changedRows below: the delta serializer pairs changedRows' row numbers
  // with the materialized view's rows, so both must enumerate residents identically.
  const coldResidentsSorted = (archetypeId: number): number[] => {
    const out = [...storage.coldResidentsOf(archetypeId)]
    out.sort((a, b) => a - b)
    return out
  }

  // Cold archetypes keep their entities in per-TYPE shared blocks (non-contiguous rows), but the
  // wire format reads contiguous per-archetype columns — so the serialize view MATERIALIZES scratch
  // copies. Read-only consumers (snapshot/delta/structural) never write back through these. The
  // copy cost is per-archetypes() call and proportional to cold residency, which is the rare case
  // by construction; the alternative was silently dropping cold entities from snapshots.
  const coldArchetypeView = (arch: Archetype): SerializeArchetype | null => {
    const residents = coldResidentsSorted(arch.id as number)
    if (residents.length === 0) return null
    const rows = new Uint32Array(residents.length)
    for (let i = 0; i < residents.length; i++) rows[i] = (entities.handleOfIndex(residents[i] as number) as number) >>> 0
    const components: SerializeComponentColumns[] = []
    for (let i = 0; i < arch.signature.length; i++) {
      const c = arch.signature[i] as number as ComponentId
      const block = storage.coldColumnSet(c)
      if (block === undefined) continue // tag / pair / no column — same skip as the hot view
      const def = registry.defOf(c)
      if (def === undefined) continue
      const fields: FieldDescriptor[] = []
      for (const f of def.fields as readonly FieldDescriptor[]) if (f.ctor !== null) fields.push(f)
      const columns = block.columns.map((src) => {
        const stride = src.layout.stride
        const Ctor = src.view.constructor as new (n: number) => typeof src.view
        const view = new Ctor(residents.length * stride)
        for (let r = 0; r < residents.length; r++) {
          const srcRow = storage.coldRowOf(residents[r] as number, c)
          if (srcRow < 0) continue
          for (let a = 0; a < stride; a++) view[r * stride + a] = src.view[srcRow * stride + a] as number
        }
        return { ...src, view }
      })
      components.push({ componentId: c, columns, fields })
    }
    return {
      id: arch.id as number,
      signature: arch.signature as unknown as readonly number[],
      count: residents.length,
      rows,
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
        if (arch.cold) {
          // Cold archetypes serialize through a materialized view — omitting them was silent
          // data loss ("whole world at one tick" is the snapshot contract).
          const view = coldArchetypeView(arch)
          if (view !== null) out.push(view)
          continue
        }
        if (arch.count === 0) continue
        out.push(archetypeView(arch))
      }
      // id-ascending (byId is already in id order, but tag/empty gaps are filtered above).
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
      // changeVersion stamp; fieldIndex forwarded but discarded downstream as for numeric fields.
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
      if (arch === undefined) return null
      if (arch.cold) {
        // Cold receivers write straight into the shared per-type blocks at the entity's cold row —
        // returning null here silently dropped every snapshot/delta value bound for a cold entity.
        const set = storage.coldColumnSet(componentId as ComponentId)
        if (set === undefined) return null
        const row = storage.coldRowOf(index, componentId as ComponentId)
        if (row < 0) return null
        const def = registry.defOf(componentId as ComponentId)
        if (def === undefined) return null
        const fields: FieldDescriptor[] = []
        for (const f of def.fields as readonly FieldDescriptor[]) if (f.ctor !== null) fields.push(f)
        return { columns: set.columns as readonly Column[], fields, row }
      }
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
      // Cold residents too — leaving them alive made a 'replace' load mix stale entities into the
      // loaded state. Snapshot the map first: despawn mutates cold.archOf mid-iteration.
      for (const index of [...storage.archetypes.cold.archOf.keys()]) handles.push(entities.handleOfIndex(index))
      for (const h of handles) if (entities.isAlive(h)) entities.despawn(h)
    },
    aliveCount() {
      return entities.handleStats().aliveCount
    },
    indexBits: handleLayout.indexBits,
    handleIndex: (handle) => handleIndexOf(handle as number),
    capabilities: () => capabilities,
  }

  // --- introspection surface (@ecsia/devtools) -------------------------
  // The FULL archetype census (cold + empty, which __serialize.archetypes() filters out) and the live
  // query enumeration (the QueryEngine's `liveQueries` getter is core-private). Pure reads.
  const inspect: InspectSurface = {
    archetypes(): readonly InspectArchetype[] {
      const out: InspectArchetype[] = []
      for (const arch of storage.archetypes.byId as Archetype[]) {
        out.push({
          // Copy: arch.signature is the LIVE typed-array backing the archetype; the seam is read-only
          // and must never hand out a buffer a consumer could mutate to corrupt storage.
          id: arch.id as number,
          signature: Array.from(arch.signature as Iterable<number>) as unknown as readonly ComponentId[],
          count: arch.count,
          cold: arch.cold,
        })
      }
      out.sort((a, b) => a.id - b.id)
      return out
    },
    queries(): readonly InspectQuery[] {
      const out: InspectQuery[] = []
      for (const lq of (engine as QueryEngine).liveQueries) {
        out.push({ terms: lq.terms, matchedArchetypes: lq.matchingArchetypes.length, size: lq.count })
      }
      return out
    },
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
        fieldLocationFor: (handle, def) => {
          if (!entities.isAlive(handle)) return null
          const index = handleIndexOf(handle as number)
          const archId = records.archetypeIdOf(index)
          const arch = storage.archetypes.byId[archId] as Archetype | undefined
          if (arch === undefined) return null
          const id = registry.idOf(def)
          if (id === undefined) return null
          if (arch.cold) {
            const set = storage.coldColumnSet(id)
            if (set === undefined) return null
            const row = storage.coldRowOf(index, id)
            if (row < 0) return null
            return { set, row }
          }
          const set = arch.columnSets.get(id)
          if (set === undefined) return null
          return { set, row: records.rowOf(index) }
        },
        isAlive: (handle) => entities.isAlive(handle),
        handleIndex: (handle) => handleIndexOf(handle as number),
        handleOfIndex: (index) => entities.handleOfIndex(index),
        despawn: (handle) => entities.despawn(handle),
        prefabDef,
        componentIdsOf: (handle) => {
          if (!entities.isAlive(handle)) return []
          const index = handleIndexOf(handle as number)
          const archId = records.archetypeIdOf(index)
          const arch = storage.archetypes.byId[archId] as Archetype | undefined
          if (arch === undefined) return []
          return Array.from(arch.signature as Iterable<number>)
        },
        spawnEmpty: () => entities.spawn(),
        copyRichFields: (src, dst, componentId) => {
          const def = registry.defOf(componentId) as ComponentRuntime<Schema> | undefined
          if (def === undefined || !def.hasRichFields) return
          const srcIndex = handleIndexOf(src as number)
          const dstIndex = handleIndexOf(dst as number)
          const srcGen = entities.decodeHandle(entities.handleOfIndex(srcIndex)).generation as number
          const dstGen = entities.decodeHandle(entities.handleOfIndex(dstIndex)).generation as number
          let fieldIndex = 0
          for (const f of def.fields as readonly FieldDescriptor[]) {
            if (f.rich !== undefined) {
              const key = sidecarKey(componentId as number, fieldIndex)
              // Only PRESENT (written) slots copy, so a never-touched field stays absent on dst —
              // snapshot presence semantics survive the copy.
              if (sidecar.hasColumn(key) && sidecar.isPresent(key, srcIndex, srcGen)) {
                sidecar.write(key, dstIndex, dstGen, sidecar.read(key, srcIndex, srcGen))
              }
            }
            fieldIndex += 1
          }
        },
        deferTemplateSpawn: (build) => {
          if (!observerCommands.deferring) return null
          const handle = reserveEntityBlock(entities.index, -1, 1).handles[0] as EntityHandle
          observerCommands.stageBuildReserved(handle, build)
          return handle
        },
        hasPendingDeferred: () => observerCommands.deferring || observerCommands.pendingCount > 0,
        deferRelationOp: (op, subject, relation, target, payload) => {
          if (!observerCommands.deferring) return false
          const relationId = relation.id as RelationId
          if (op === 'add') observerCommands.stageAddPair(subject, relation, relationId, target, payload)
          else observerCommands.stageRemovePair(subject, relation, relationId, target)
          return true
        },
        trackWrite: (index, componentId) => trackWrite(index, componentId),
        trackShapePair: (index, pairId, targetIndex, add, journal = true) => {
          ;(reactivity as Reactivity).trackShapePair(
            index,
            pairId,
            targetIndex,
            add ? ShapeKind.AddPair : ShapeKind.RemovePair,
            journal,
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
        setPairObserverResolver: (resolve) => {
          ;(reactivity as Reactivity).setPairObserverResolver(resolve)
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
      if (isSharedBacking(rec.archetypeId)) {
        extra.push({ key: 'entity.archetypeId' as RegionKey, backing: rec.archetypeId, element: 'u32' })
      }
      if (isSharedBacking(rec.archetypeRow)) {
        extra.push({ key: 'entity.archetypeRow' as RegionKey, backing: rec.archetypeRow, element: 'u32' })
      }
      return { columns: base.columns, regions: [...base.regions, ...extra] }
    },
    __columnGrowth() {
      return buffers.columnGrowth()
    },
    __serialize: serialize,
    __inspect: inspect,
    __mergeWorkerWrites(pairs, count) {
      ;(reactivity as Reactivity).mergeWorkerWrites(pairs, count)
    },
    __topics: topics,
    get tick() {
      return state.tick
    },
    currentTick() {
      return state.tick
    },
    spawn() {
      if (observerCommands.deferring) {
        // A spawn inside an observer reserves a live handle NOW (so the handler can configure it)
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
      if (IS_DEV && iterating > 0) throw iterationMutationError('add')
      storage.add(handle, def)
    },
    remove(handle, def) {
      if (observerCommands.deferring) {
        observerCommands.stageRemove(handle, def)
        return
      }
      if (IS_DEV && iterating > 0) throw iterationMutationError('remove')
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
      if (IS_DEV && iterating > 0) throw iterationMutationError('despawn')
      entities.despawn(handle)
    },
    isAlive(handle) {
      return entities.isAlive(handle)
    },
    has(handle, def) {
      // Liveness first, WITHOUT the bitmask; a dead handle is never a member.
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
    publish(topic, init) {
      if (state.phase !== 'serial') {
        throw new Error(`world.publish('${topic.name}') requires world.phase === 'serial' (got '${state.phase}')`)
      }
      topics.publishOutside(topic as TopicDef<Schema>, init as Record<string, unknown> | undefined)
    },
    changedSince(handle, since) {
      ;(reactivity as Reactivity).enableChangeVersion()
      return (reactivity as Reactivity).changedSince(handle, since)
    },
    changedRows(archetypeId, since) {
      const arch = storage.archetypes.byId[archetypeId] as Archetype | undefined
      if (arch !== undefined && arch.cold) {
        // Cold rows have no per-archetype rows array; enumerate residents in the SAME ascending
        // index order as coldArchetypeView so the delta serializer's row numbers line up with the
        // materialized view it reads values from. Stamps are per-entity, so changedSince is exact.
        const residents = coldResidentsSorted(archetypeId)
        return (reactivity as Reactivity).changedRows(archetypeId, since, residents.length, (row) => residents[row] as number)
      }
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
      // re-entrancy guard: a drain must never re-enter itself (the flush below can trigger query
      // maintenance / structural ops that must not recursively re-drain). If already draining, return.
      if (!observerCommands.enterDrain()) return
      let drained = false
      try {
        // "applied at the NEXT serial flush": apply the ops staged by the PREVIOUS drain's
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
        drained = true
      } finally {
        observerCommands.exitDrain()
        // A handler exception leaves the observer cursors at the window's start while flushPending
        // below clears the stashes and despawn ordinals they pair with — replaying the remainder
        // next drain would misattribute its Destroy entries to the NEXT window's tenants. The window
        // is already lost (its handlers partially ran), so drop its remainder.
        if (!drained) (reactivity as Reactivity).abandonObserverWindow()
        // Flush the deferred rich-field clears now that onRemove handlers have run
        // — the same post-observer point storage's deferred row reclaim ceases to be readable. After this
        // the dying entity's rich values are gone (RF-REMOVE-READ window closes); a recycled index reads
        // the default via the generation guard regardless.
        sidecar.flushPending()
        // Release the held deferred-dead rows the window protected: the same post-observer point as
        // the rich flush, so a numeric dead-tenant read survives exactly as long as a rich one.
        storage.releaseHeldRows()
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
      // Reactivity.frameReset advances the world tick + recycles the rings; then the query
      // engine clears its per-frame added/removed delta lists; then topics drop two-frame-old
      // events and fold any spill back into their rings (no-op when no topics are registered).
      ;(reactivity as Reactivity).frameReset()
      ;(engine as QueryEngine).frameReset()
      topics.frameReset()
    },
  }

  return Object.freeze(world)
}

/** Collect the union of every live query's current matching indices. */
function collectCurrentMembers(engine: QueryEngine): Iterable<number> {
  const seen = new Set<number>()
  for (const lq of engine.liveQueries) {
    for (const index of lq.current) seen.add(index)
  }
  return seen
}
