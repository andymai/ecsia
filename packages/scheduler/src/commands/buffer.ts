// Per-worker command buffer (command-buffer.md §3): a plain (or SAB-backed) Uint32Array a worker
// appends structural-intent records into mid-wave and the main thread replays at the serial flush.
//
// Backing choice (command-buffer.md §3.1): the buffer is written ONLY by its owning worker and read
// ONLY by the main thread AFTER the wave fence — no concurrent access ever — so no atomics are needed
// on it. In the SAB/Atomics runtime we back it with a *fixed-size* SharedArrayBuffer so the main
// thread reads the worker's records in place (no per-flush transfer); growth past that cap spills to
// a plain-AB overflow (§3.3 doubling) which the worker reports back via its `head`. In the
// postMessage fallback the backing is a plain ArrayBuffer transferred at flush. Either way the apply
// path (apply.ts) reads `{ words, head }` byte-for-byte identically (CB-1).

import type { EntityHandle, EntityReservation } from '@ecsia/core'

/** A per-worker reservation block consumed by OP_CREATE (entity-model.md §5.1). */
export interface BufferReservation {
  readonly handles: readonly EntityHandle[]
}

export interface CommandBuffer {
  /** Worker index this buffer belongs to (0..workers-1). Fixes merge order (§7.2). */
  readonly workerIndex: number
  /** u32 words. SAB-backed in the threaded path, plain AB in the fallback (§3.1). */
  words: Uint32Array
  /** Write head: index of the next free u32 slot. Reset to 0 each wave (§3.4). */
  head: number
  /** Count of records appended this wave (diagnostics / merge bound). */
  recordCount: number
  /** The worker's reservation block for this wave. Consumed by OP_CREATE in append order. */
  reservation: BufferReservation
  /** Cursor into `reservation.handles`: next unused reserved handle. */
  reservationCursor: number
  /** Count of OP_CREATE records actually applied (set by the apply path for returnUnused, §6.3). */
  appliedCreateCount: number
  /** The EntityReservation block reserved for this buffer's wave (main-thread bookkeeping for §6.3). */
  lastReservation?: EntityReservation
  /**
   * When true the backing is a FIXED-SIZE SharedArrayBuffer that MUST NOT be reassigned mid-wave: the
   * main thread reads records in place over the same SAB, so growing the worker-side view off the SAB
   * would point `head` past the shared backing and either lose records or corrupt the apply decode
   * (review issue #3). On a fixed buffer `ensureWords` caps instead of growing and sets `overflowed`.
   */
  fixed: boolean
  /** Set by `ensureWords` when a fixed (SAB) buffer could not fit a record: encoding was capped. */
  overflowed: boolean
  /** Latch so the encoder emits the overflow diagnostic ONCE per wave; cleared by `resetBuffer`. */
  overflowWarned?: boolean
}

const EMPTY_RESERVATION: BufferReservation = { handles: [] }

export function makeCommandBuffer(workerIndex: number, initialWords: number, shared: boolean): CommandBuffer {
  const bytes = Math.max(initialWords, 16) * 4
  const backing = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)
  return {
    workerIndex,
    words: new Uint32Array(backing),
    head: 0,
    recordCount: 0,
    reservation: EMPTY_RESERVATION,
    reservationCursor: 0,
    appliedCreateCount: 0,
    fixed: shared,
    overflowed: false,
    overflowWarned: false,
  }
}

/** command-buffer.md §3.4: head→0, retain backing. Steady-state encoding is allocation-free. */
export function resetBuffer(cb: CommandBuffer): void {
  cb.head = 0
  cb.recordCount = 0
  cb.reservationCursor = 0
  cb.appliedCreateCount = 0
  cb.overflowed = false
  cb.overflowWarned = false
}

/**
 * command-buffer.md §3.3: ensure room for `need` more words. Returns true iff the caller may now write
 * `need` words at `cb.head`.
 *
 * Plain-AB (growable) buffers double on overflow and always return true — the no-sab
 * transport reads `{ words, head }` after the fence so a reallocated private buffer is fine.
 *
 * FIXED (SAB-backed) buffers MUST NOT reassign `cb.words` off the shared backing (review issue #3): the
 * main thread reads the same SAB in place up to `head`, so a worker-private grow would (a) hide the
 * overflow records from the main thread and (b) push `head` past the SAB length → NaN-opcode crash in
 * `recordLen`. Instead we CAP: set `overflowed`, leave `head` untouched, and return false so the encoder
 * appends NOTHING. The buffer therefore always satisfies `head <= words.length`, and the overflow is a
 * loud diagnostic rather than silent loss + crash.
 */
export function ensureWords(cb: CommandBuffer, need: number): boolean {
  if (cb.head + need <= cb.words.length) return true
  if (cb.fixed) {
    cb.overflowed = true
    return false
  }
  let newLen = cb.words.length
  while (cb.head + need > newLen) newLen = newLen === 0 ? need : newLen * 2
  const next = new Uint32Array(newLen)
  next.set(cb.words.subarray(0, cb.head))
  cb.words = next
  return true
}
