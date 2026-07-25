// The pool↔host worker-spawn seam. The pool's coordination is pure SAB + Atomics (portable); the
// only host-specific parts are how a worker is spawned, how its bootstrap is delivered, and whether
// the SPAWNING thread may block in Atomics.wait — node:worker_threads main may, a browser main
// thread may not (it takes the Atomics.waitAsync tier instead). Those three concerns live behind
// this interface; pool.ts stays host-agnostic.

import type { WorkerBootstrap } from './manifest.js'

/** The pool's view of one spawned worker: outbound messages, inbound stream, error tap, teardown. */
export interface WorkerPort {
  postMessage(msg: unknown): void
  /**
   * Install the inbound message handler. Single consumer, installed AT MOST ONCE per port —
   * transports may append rather than replace, so a second install would double-deliver.
   */
  onMessage(cb: (msg: unknown) => void): void
  onError(cb: (err: unknown) => void): void
  terminate(): Promise<void> | void
}

export interface WorkerTransport {
  /**
   * True when the thread constructing the pool may block in Atomics.wait (Node main / any worker
   * thread); false on a browser main thread, which must take the non-blocking waitAsync tier.
   */
  readonly mainThreadMayBlock: boolean
  /** Spawn one worker and deliver its bootstrap (workerData on Node, first postMessage on the web). */
  spawn(boot: WorkerBootstrap, opts: { readonly workerEntryUrl?: string | undefined }): Promise<WorkerPort> | WorkerPort
}
