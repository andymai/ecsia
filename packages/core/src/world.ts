// The World keystone (world.md). M0 lands the scaffold: option resolution, the phase/tick
// contracts, and the module-wiring seam. Later milestones fill the seven owning modules in the
// fixed order registry → buffers → storage → reactivity → queries → scheduler → serialization (§7).

import { resolveOptions } from './config.js'
import type { ResolvedWorldOptions, WorldOptions } from './config.js'
import { EntityStore, makeHandleLayout, reserveEntityBlock, returnReservedIds } from './entity/index.js'
import type {
  EntityGeneration,
  EntityHandle,
  EntityIndex,
  EntityRef,
  EntityReservation,
  HandleLayout,
  HandleStats,
} from './entity/index.js'

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
  /** Destroy an entity. Main-thread/serial. Idempotent on dead handles (entity-model.md §6.3). */
  despawn(handle: EntityHandle): void
  /** O(1) liveness/staleness check. Never consults the bitmask (Must-Fix #1). */
  isAlive(handle: EntityHandle): boolean
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
    despawn(handle) {
      entities.despawn(handle)
    },
    isAlive(handle) {
      return entities.isAlive(handle)
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
  }

  return Object.freeze(world)
}
