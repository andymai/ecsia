import { Worker } from 'node:worker_threads'
import { expect, test } from 'vitest'

// becsy never tested its SAB paths (becsy/src/dispatcher.ts:130-132); ecsia validates the
// resizable-SAB + worker round-trip from M0 (build-plan.md M0 exit criteria).
test('resizable SharedArrayBuffer grows and round-trips across a worker boundary', async () => {
  const sab = new SharedArrayBuffer(8, { maxByteLength: 16 })
  const main = new Int32Array(sab)
  Atomics.store(main, 0, 41)

  sab.grow(16)
  const grown = new Int32Array(sab) // re-wrap after growth (memory-buffers.md view-invalidation)
  expect(sab.byteLength).toBe(16)

  const workerSrc = `
    const { parentPort, workerData } = require('node:worker_threads')
    const v = new Int32Array(workerData.sab)
    Atomics.add(v, 0, 1)        // 41 -> 42, observed by the main thread (shared memory)
    Atomics.store(v, 3, 99)     // write into the grown region
    parentPort.postMessage('done')
  `
  const worker = new Worker(workerSrc, { eval: true, workerData: { sab } })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  await worker.terminate()

  expect(Atomics.load(grown, 0)).toBe(42)
  expect(Atomics.load(grown, 3)).toBe(99)
})
