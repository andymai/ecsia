// The Web Worker host for the worker body (worker-body.ts owns the dispatch loop). Browser Workers
// have no `workerData`, so the bootstrap arrives as the pool's FIRST postMessage ('ecsia:bootstrap' —
// SharedArrayBuffer references are sharable through postMessage, which is also how column re-backing
// broadcasts already travel). Kernels are NOT dynamically imported here: functions can't cross the
// worker boundary and a runtime `import(url)` defeats bundlers, so the app's own worker file bundles
// its kernels statically and hands the builder in:
//
//   // sim.worker.ts — the file the app passes to `new Worker(new URL(...), { type: 'module' })`
//   import { ecsiaWorker } from '@ecsia/scheduler/worker'
//   import { buildWorkerKernels } from './kernels.js'
//   ecsiaWorker(buildWorkerKernels)
//
// This module touches no node:* builtin and no DOM API beyond the worker-global message surface, so
// it bundles clean for the web.

import { runWorkerBody } from './worker-body.js'
import type { WorkerHostPort, WorkerKernelsBundle } from './worker-body.js'
import type { WorkerBootstrap } from './manifest.js'

/** The bootstrap message the browser transport posts once per worker at pool startup. */
export interface BrowserBootstrapMessage {
  readonly kind: 'ecsia:bootstrap'
  readonly boot: WorkerBootstrap
}

interface WorkerGlobal {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(msg: unknown): void
}

/**
 * Install the ecsia worker runtime on this Web Worker. Call once at the top of the app's worker
 * file. Waits for the pool's bootstrap message, then runs the shared dispatch loop with the
 * statically bundled kernels from `build`.
 */
export function ecsiaWorker(build: () => WorkerKernelsBundle): void {
  const g = globalThis as unknown as WorkerGlobal
  if (typeof g.postMessage !== 'function') {
    throw new Error('ecsiaWorker must run inside a Web Worker (no worker-global postMessage found)')
  }
  let booted = false
  g.onmessage = (e) => {
    const msg = e.data as Partial<BrowserBootstrapMessage> | undefined
    if (booted || msg?.kind !== 'ecsia:bootstrap' || msg.boot === undefined) return
    booted = true
    const port: WorkerHostPort = {
      postMessage: (m) => g.postMessage(m),
      // The body installs THE inbound handler; from here on it owns the message stream
      // (columns-added re-backing broadcasts).
      onMessage: (cb) => {
        g.onmessage = (ev) => cb(ev.data)
      },
    }
    runWorkerBody(msg.boot, build(), port).catch((err) => {
      g.postMessage({ kind: 'error', message: String(err) })
    })
  }
}
