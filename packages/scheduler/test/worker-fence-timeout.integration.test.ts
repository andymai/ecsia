// REGRESSION — the BLOCKING wait tier must not hang forever on a dead worker. A Node main thread
// waits out the fence in Atomics.wait, where a crashed worker's 'error'/'exit' events can never be
// delivered (the event loop is blocked) — so the promise-race that guards the async tiers cannot
// help. The fence deadline (fenceTimeoutMs) is the only escape: sliced waits that throw once the
// deadline passes with the counter still nonzero, latching the pool broken.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { WorkerPool } from '@ecsia/scheduler/workers'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

describe('blocking-tier fence deadline', () => {
  test('a worker that dies mid-wave times the fence out loudly instead of blocking forever', async () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 1 << 10, threaded: true, scheduler: { workers: 1 } })
    for (let i = 0; i < 4; i++) world.spawnWith(Health)
    const KrashT = defineSystem({ name: 'Krash', read: [], write: [Health], run() {} })
    const sched = createScheduler(world, [KrashT], { workers: 1 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Krash', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      fenceTimeoutMs: 400,
      diagnostic: () => {},
    })
    await pool.ready()

    // The Krash kernel process.exit(3)s before ACKing. Default node transport → blocking tier: the
    // main thread is inside Atomics.wait when the worker dies, so only the deadline can free it.
    await expect(sched.updateThreaded(pool, 1)).rejects.toThrow(/timed out/)
    expect(world.phase).toBe('serial')
    // Latched broken: further rounds refuse instead of re-blocking on a dead pool.
    await expect(pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)).rejects.toThrow(/failed|crashed/)
  })
})
