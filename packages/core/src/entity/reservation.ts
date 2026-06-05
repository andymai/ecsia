// The worker-ID reservation handshake. v1 ships the LAYOUT plus the
// single-thread path: the main thread reserves a block by calling the ordinary serial
// `allocEntity`, so the entities are fully alive the instant they are reserved. The
// Atomics.sub-on-reservedHead worker take is the v2 path exercised at.

import type { EntityHandle } from './codec.js'
import type { EntityIndex } from './index-allocator.js'

export interface EntityReservation {
  /** Pre-fully-formed handles, ready to use. */
  readonly handles: readonly EntityHandle[]
  readonly workerIndex: number
}

/** Reserve `count` entity handles for `workerIndex` to consume mid-wave. Serial-phase only. */
export function reserveEntityBlock(index: EntityIndex, workerIndex: number, count: number): EntityReservation {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`reserveEntityBlock count must be a non-negative integer; got ${count}`)
  }
  const handles: EntityHandle[] = []
  for (let i = 0; i < count; i++) {
    handles.push(index.allocEntity())
  }
  return { handles, workerIndex }
}

/** After the wave, reclaim any handles the worker did not consume (returns them to the pool). */
export function returnReservedIds(index: EntityIndex, reservation: EntityReservation, consumedCount: number): void {
  if (!Number.isInteger(consumedCount) || consumedCount < 0 || consumedCount > reservation.handles.length) {
    throw new RangeError(
      `returnReservedIds consumedCount must be an integer in [0, ${reservation.handles.length}]; got ${consumedCount}`,
    )
  }
  // Free the unconsumed tail in reverse so the free-list reissues them LIFO.
  for (let i = reservation.handles.length - 1; i >= consumedCount; i--) {
    const h = reservation.handles[i]
    if (h !== undefined && index.isAlive(h)) index.freeEntity(h)
  }
}
