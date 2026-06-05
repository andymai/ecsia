// SAB-backed per-worker entity-ID reservation. The main
// thread pre-reserves a block of fully-formed (alive) handles per worker before each wave via the
// serial `world.reserveEntityBlock` ( layout), writes the handles into a SAB, and the worker TAKES
// them mid-wave with `Atomics.sub` on a cursor word — exercising the Atomics.sub take path (the
// v2 ) without ever touching the shared free-list.
//
// SAB layout per worker: word 0 = cursor (next free slot, counts DOWN via Atomics.sub),
// words [1 .. 1+capacity) = the reserved full handles. A take of cursor c yields handles[c-1].

import type { EntityHandle, EntityReservation } from '@ecsia/core'

const CURSOR = 0
const HANDLES_BASE = 1

export interface WorkerReservationSab {
  readonly sab: SharedArrayBuffer
  readonly view: Int32Array
  readonly capacity: number
}

export function makeReservationSab(capacity: number): WorkerReservationSab {
  const cap = Math.max(capacity, 0)
  const sab = new SharedArrayBuffer((1 + cap) * 4)
  return { sab, view: new Int32Array(sab), capacity: cap }
}

/** Main thread, serial: fill the SAB with a freshly-reserved block and reset the take cursor. */
export function fillReservation(r: WorkerReservationSab, reservation: EntityReservation): void {
  const n = Math.min(reservation.handles.length, r.capacity)
  for (let i = 0; i < n; i++) r.view[HANDLES_BASE + i] = reservation.handles[i] as number
  Atomics.store(r.view, CURSOR, n) // cursor counts down; n handles available
}

/** Worker, mid-wave: take the next reserved handle via Atomics.sub, or NO_ENTITY (-1) if exhausted. */
export function takeReserved(r: WorkerReservationSab): EntityHandle {
  const prev = Atomics.sub(r.view, CURSOR, 1)
  if (prev <= 0) {
    Atomics.add(r.view, CURSOR, 1) // undo: do not let the cursor run negative
    return 0xffffffff as EntityHandle
  }
  return (r.view[HANDLES_BASE + (prev - 1)]! >>> 0) as EntityHandle
}

/**
 * Count of reserved handles the worker actually took = filled - remaining. `filled` is the block size
 * the main thread wrote (NOT the SAB capacity, which may exceed the block), so a 0-handle block reports
 * 0 consumed even though the SAB reserves a larger cursor capacity.
 */
export function consumedCount(r: WorkerReservationSab, filled: number): number {
  const remaining = Math.max(Atomics.load(r.view, CURSOR), 0)
  return Math.max(filled - remaining, 0)
}
