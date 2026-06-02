// @ecsia/core — the single-threaded kernel. M0: world keystone scaffold + reserved-id constants.
export { NO_COMPONENT, FIRST_USER_COMPONENT_ID } from './ids.js'
export type { ComponentId } from './ids.js'
export { ConfigError, resolveOptions } from './config.js'
export type {
  WorldOptions,
  ResolvedWorldOptions,
  ResolvedReactivityOptions,
  ReactivityOptions,
  SchedulerOptions,
  ObserverCadence,
  ChangeTracking,
  WorkerOption,
} from './config.js'
export { createWorld } from './world.js'
export type { World, WorldPhase } from './world.js'

export {
  makeHandle,
  handleIndex,
  handleGeneration,
  makeHandleLayout,
  NO_ENTITY,
  ARCHETYPE_NONE,
  CapacityExceeded,
  EntityRef,
  reserveEntityBlock,
  returnReservedIds,
} from './entity/index.js'
export type {
  EntityHandle,
  EntityIndex,
  EntityGeneration,
  HandleLayout,
  HandleStats,
  EntityLocation,
  EntityReservation,
  EntityAccessors,
} from './entity/index.js'

export { allocU32 } from './memory/index.js'
export type { AllocU32Options, U32Region } from './memory/index.js'
