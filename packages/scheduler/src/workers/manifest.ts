// The workerData payload posted ONCE per worker at pool startup (). Carries the shared buffer set (by reference — SABs are sharable, NOT transferred)
// plus the per-worker control SABs the dispatch loop uses. No component VALUES are ever serialized
// (zero-copy): the worker reads live SAB columns.

import type { SharedHandleManifest } from '@ecsia/core'

/** Dense component-id assignment so the worker aligns ids identically. */
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
  /**
   * Registered topic ids the worker aligns its own defineTopic defs to (by name), so OP_PUBLISH
   * records carry the main thread's topicId. Empty in a topic-free world.
   */
  readonly topics: readonly { readonly name: string; readonly id: number }[]
  /**
   * Per-system consume windows, indexed by SystemId: for each topic the system declares in
   * `consume:`, the topic id plus this (system, topic) reader's cursor-table slot. A worker-run
   * consumer reads its own slot from the topic's SAB cursor region (frozen mid-wave) and reports
   * its advance back via OP_CONSUMED. Empty arrays for non-consuming systems.
   */
  readonly consumes: ReadonlyArray<ReadonlyArray<{ readonly topicId: number; readonly readerSlot: number }>>
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
   * Re-backing signal SAB. Word [0] = the column
   * re-backing generation the main thread last published. When the worker is woken and finds [0] !=
   * its last-applied generation, the wake is a NOTICE round: it `await`s the queued `columns-added`
   * postMessage (the only transport that can carry a new SharedArrayBuffer reference), re-wraps the
   * named columns, then completes the wave fence as its ACK — all BEFORE the next dispatch. Steady
   * state ([0] unchanged) costs one extra Atomics.load per wave.
   */
  readonly noticeSab: SharedArrayBuffer
  /**
   * Per-worker write-corral SAB: the worker stages value writes here as
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

/**
 * The re-backing broadcast. Posted to each worker at the wave fence carrying
 * the NEW SharedArrayBuffer backings (by reference — SABs cannot ride a SAB) so the worker re-wraps
 * its stale column views. `generation` matches `noticeSab[0]`; the worker ACKs via the wave fence.
 */
export interface ColumnsAddedMessage {
  readonly kind: 'columns-added'
  readonly generation: number
  readonly columns: ReadonlyArray<{ key: string; backing: SharedArrayBuffer; layout: import('@ecsia/core').ColumnLayout }>
  /**
   * Region re-backs riding the same broadcast (TopicRingGrown: a topic ring or cursor table moved
   * to a new SAB past its reservation). The worker re-wraps these in its regions map before ACKing.
   */
  readonly regions?: ReadonlyArray<{ key: string; backing: SharedArrayBuffer; element: import('@ecsia/core').ElementKind }>
}
