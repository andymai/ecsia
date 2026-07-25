// The node:worker_threads host for the worker body (worker-body.ts owns the dispatch loop).
// This entry does exactly three Node-specific things: read the bootstrap from `workerData`, resolve
// the kernels by dynamically importing the bootstrap's `kernelModule` (the Node dispatch mechanism —
// kernels are functions, resolved by importing the same source on the worker side), and adapt
// `parentPort` to the WorkerHostPort surface. The browser host (browser-entry.ts) differs only here.

import { parentPort, workerData } from 'node:worker_threads'
import { runWorkerBody } from './worker-body.js'
import type { KernelModule, WorkerHostPort } from './worker-body.js'
import type { WorkerBootstrap } from './manifest.js'

async function main(): Promise<void> {
  const boot = workerData as WorkerBootstrap
  if (boot.kernelModule === undefined) {
    throw new Error('worker-entry: bootstrap carries no kernelModule — the Node pool requires one (browser pools bundle kernels into the worker file instead)')
  }
  const mod = (await import(boot.kernelModule)) as unknown as KernelModule
  const port: WorkerHostPort = {
    postMessage: (msg) => parentPort?.postMessage(msg),
    onMessage: (cb) => parentPort?.on('message', cb),
  }
  await runWorkerBody(boot, mod.buildWorkerKernels(), port)
}

void main()
