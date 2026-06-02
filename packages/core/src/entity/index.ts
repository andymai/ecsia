export { makeHandle, handleIndex, handleGeneration, makeHandleLayout, NO_ENTITY } from './codec.js'
export type { EntityHandle, EntityIndex, EntityGeneration, HandleLayout } from './codec.js'

export { EntityIndex as EntityIndexAllocator, CapacityExceeded } from './index-allocator.js'
export type { EntityIndexArrays } from './index-allocator.js'

export { EntityRecord, ARCHETYPE_NONE } from './record.js'
export type { EntityRecordArrays, EntityLocation } from './record.js'

export { EntityRef } from './ref.js'
export type { EntityAccessors } from './ref.js'

export { reserveEntityBlock, returnReservedIds } from './reservation.js'
export type { EntityReservation } from './reservation.js'

export { EntityStore } from './store.js'
export type { EntityStoreConfig, HandleStats } from './store.js'
