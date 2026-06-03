// The workerData payload posted ONCE per worker at pool startup (serialization.md §3.1 WorldBootstrap,
// scheduler.md §7.6). Carries the shared buffer set (by reference — SABs are sharable, NOT transferred)
// plus the per-worker control SABs the dispatch loop uses. No component VALUES are ever serialized
// (zero-copy, §3.3): the worker reads live SAB columns.

import type { SharedHandleManifest } from '@ecsia/core'

/** Dense component-id assignment so the worker aligns ids identically (serialization.md §3.2). */
export interface ComponentManifestEntry {
  readonly name: string
  readonly id: number
  /** Per-field word counts (declaration order) so the worker rebuilds the payload codec. */
  readonly fieldWords: readonly number[]
}

export interface WorkerBootstrap {
  readonly workerIndex: number
  /** Module URL the worker imports to obtain its system kernels by name (the dispatch mechanism). */
  readonly kernelModule: string
  /** System names indexed by SystemId (the POOL's registration order) — the kernel lookup key. */
  readonly systemNames: readonly string[]
  /** The shared buffer set (SAB columns + regions), by reference. */
  readonly buffers: SharedHandleManifest
  readonly indexBitsMask: number
  /** Dense component-id registry the worker aligns to. */
  readonly components: readonly ComponentManifestEntry[]
  /** Per-worker control SABs. */
  readonly commandSab: SharedArrayBuffer
  readonly reservationSab: SharedArrayBuffer
  readonly reservationCapacity: number
  readonly waveSab: SharedArrayBuffer
  /** Work descriptor SAB: [0]=systemId [1]=count [2]=dtBits(f32) [3..]=entity indices. */
  readonly workSab: SharedArrayBuffer
  /** Wake SAB: the worker Atomics.waits on [0]; the main thread bumps it + notifies to dispatch. */
  readonly wakeSab: SharedArrayBuffer
  /**
   * Per-worker write-corral SAB (reactivity.md §9.1, R-4): the worker stages value writes here as
   * `[count, index0, componentId0, index1, componentId1, …]`. Word [0] is the entry count; the main
   * thread reads it after the fence and merges into the shared write log in worker-index order. No
   * atomics on the worker push path — it is single-writer, drained only after the wave fence.
   */
  readonly writeCorralSab: SharedArrayBuffer
}

/** A message the main thread posts to ask a worker to run one batch (used in the postMessage tier). */
export interface DispatchMessage {
  readonly kind: 'dispatch'
  readonly systemId: number
  readonly dt: number
  readonly indices: Int32Array
}
