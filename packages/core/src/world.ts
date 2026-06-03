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

  // The accessor seam: a setter calls world.trackWrite (stubbed until M5); handleIndex strips the
  // generation so the LOW handle bits index the write log (world.md §9.1, W-8).
  const trackWrite = (_index: number, _componentId: ComponentId, _fieldIndex?: number): void => {
    // M5 stub: no-op. Signature and call sites are canonical now (world.md §9.1 / I-ACC-4).
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
  const storage = new Storage({
    buffers,
    accessorWorld,
    bitmask,
    record: records,
    registry,
    maxHotArchetypes: resolved.maxHotArchetypes,
    stride,
    maxEntities: resolved.maxEntities,
    enqueueRemoveLog: () => {
      // M5 stub: removal reactivity (writeLog / shapeLog). The call SITE + ordering are canonical
      // now (archetype-storage.md §5.5 step 3 / §6.3 step 2); M5 fills the body.
    },
    tick: () => state.tick,
    handleIndex: (handle) => handleIndex(handle, handleLayout) as number,
  })
  entities.setAccessorResolver(storage)
  entities.setLifecycle({
    onSpawn: (handle) => storage.onSpawn(handle),
    onDespawn: (handle) => storage.onDespawn(handle),
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
  }

  return Object.freeze(world)
}
