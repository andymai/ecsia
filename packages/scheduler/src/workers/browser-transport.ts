// The Web Worker transport. The APP constructs the Worker (it owns the worker file URL — the
// `new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' })` shape every bundler
// understands statically); the transport delivers the bootstrap as the first postMessage
// (SharedArrayBuffer references are sharable through postMessage) and adapts the event surface.
// The worker file itself calls `ecsiaWorker(buildWorkerKernels)` from '@ecsia/scheduler/worker'.
//
// This module touches no node:* builtin and no DOM type — the Worker is typed structurally so the
// package needs no DOM lib.

import type { WorkerBootstrap } from './manifest.js'
import type { WorkerPort, WorkerTransport } from './transport.js'

/** A structural slice of the DOM `Worker` — what the transport actually uses. */
export interface BrowserWorkerLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
  terminate(): void
}

/**
 * Build the pool transport for browser Web Workers. `createWorker` is called once per pool worker;
 * every Worker it returns must run a worker file that installs `ecsiaWorker(...)`.
 */
export function browserWorkerTransport(createWorker: (index: number) => BrowserWorkerLike): WorkerTransport {
  return {
    mainThreadMayBlock: false, // browser main takes the Atomics.waitAsync tier — blocking waits throw there
    spawn(boot: WorkerBootstrap): WorkerPort {
      const worker = createWorker(boot.workerIndex)
      worker.postMessage({ kind: 'ecsia:bootstrap', boot })
      return {
        postMessage: (msg) => worker.postMessage(msg),
        onMessage: (cb) => worker.addEventListener('message', (ev) => cb(ev.data)),
        onError: (cb) => worker.addEventListener('error', (ev) => cb(ev)),
        terminate: () => worker.terminate(),
      }
    },
  }
}
