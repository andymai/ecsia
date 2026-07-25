// A Web-Worker-global emulation over node:worker_threads, so the BUILT browser worker host
// (dist/workers/browser-entry.js — the '@ecsia/scheduler/worker' subpath) runs end-to-end in Node:
// bootstrap-as-first-postMessage, statically supplied kernels, the whole shared dispatch loop. The
// only fakery is the message surface (self.postMessage / self.onmessage over parentPort); everything
// the body does — SAB views, Atomics waits, command buffers — is the real thing.

import { parentPort } from 'node:worker_threads'
import { ecsiaWorker } from '../../dist/workers/browser-entry.js'
import { buildWorkerKernels } from './m7-kernels.mjs'

globalThis.postMessage = (msg) => parentPort.postMessage(msg)
Object.defineProperty(globalThis, 'onmessage', {
  configurable: true,
  set(cb) {
    parentPort.removeAllListeners('message')
    if (cb) parentPort.on('message', (data) => cb({ data }))
  },
})

ecsiaWorker(buildWorkerKernels)
