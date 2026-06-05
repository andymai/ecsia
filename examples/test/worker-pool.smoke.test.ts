// M12 EXECUTION-BACKED threaded smoke (review medium #6 / public-api.md §7, PA-4). The other worker
// smoke tests drive scheduler.updateThreaded with an IN-PROCESS RoundDispatcher — they exercise the
// wave/round/dispatch frame loop but NOT a real OS-thread pool. This test closes that gap: it stands up
// the genuine @ecsia/scheduler WorkerPool (node:worker_threads + Atomics wave-sync) and drives a real
// world through scheduler.updateThreaded(pool, dt), then asserts the worker-thread run reproduces the
// single-thread executor's column state byte-for-byte. So the umbrella's "genuinely runs threaded"
// claim is backed by EXECUTION on real threads, not by construction.
//
// Reuses the built worker-entry (dist) + the M7 kernel fixture (a .mjs a raw worker_threads Worker can
// load without a TS transform), exactly as packages/scheduler/test/m7-threaded-update.integration.test.ts
// does — the same real-pool path, now reached at the M12 integration level.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent, defineSystem, createScheduler, write, WorkerPool } from '@ecsia/ecsia'
import type { EntityHandle, PoolSystem, World } from '@ecsia/ecsia'

const WORKER_ENTRY = fileURLToPath(
  new URL('../../packages/scheduler/dist/workers/worker-entry.js', import.meta.url),
)
const KERNEL_MODULE = fileURLToPath(
  new URL('../../packages/scheduler/test/fixtures/m7-kernels.mjs', import.meta.url),
)

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

function seed(threaded: boolean, workers: number, n: number) {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world: World = createWorld(
    threaded
      ? { components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers } }
      : { components: [Health, Mana], maxEntities: 1 << 12 },
  )
  const handles: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Health, Mana)
    world.entity(h).write(Health).hp = i
    world.entity(h).write(Mana).mp = 100 + i
    handles.push(h)
  }
  return { world, Health, Mana, handles }
}

describe('M12 worker example genuinely runs threaded on a REAL WorkerPool (execution-backed PA-4)', () => {
  test('disjoint-write wave on real OS threads reproduces the single-thread column state', async () => {
    const N = 32
    const FRAMES = 3

    // Single-thread reference: defineSystem bodies are the arithmetic twins of the worker kernels.
    const ref = seed(false, 0, N)
    const Regen = defineSystem({
      name: 'Regen',
      read: [],
      write: [ref.Health],
      run({ query }) {
        for (const e of query(write(ref.Health))) e.health.hp += 1
      },
    })
    const Channel = defineSystem({
      name: 'Channel',
      read: [],
      write: [ref.Mana],
      run({ query }) {
        for (const e of query(write(ref.Mana))) e.mana.mp -= 1
      },
    })
    const refSched = createScheduler(ref.world, [Regen, Channel])

    // Threaded run: the SAME plan, dispatched to 2 real worker threads through the public frame loop.
    const thr = seed(true, 2, N)
    const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
    const ChannelT = defineSystem({ name: 'Channel', read: [], write: [thr.Mana], run() {} })
    const thrSched = createScheduler(thr.world, [RegenT, ChannelT], { workers: 2 })
    const systems: PoolSystem[] = [
      { id: 0 as never, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
      { id: 1 as never, name: 'Channel', matchComponents: [thr.Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({
      world: thr.world as never,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()

    for (let f = 0; f < FRAMES; f++) {
      refSched.update(1)
      await thrSched.updateThreaded(pool, 1)
    }

    // The pool returned to the serial phase, and every entity's columns equal the single-thread run.
    expect(thr.world.phase).toBe('serial')
    for (let i = 0; i < N; i++) {
      expect(thr.world.entity(thr.handles[i]!).read(thr.Health).hp).toBe(
        ref.world.entity(ref.handles[i]!).read(ref.Health).hp,
      )
      expect(thr.world.entity(thr.handles[i]!).read(thr.Mana).mp).toBe(
        ref.world.entity(ref.handles[i]!).read(ref.Mana).mp,
      )
    }
  })
})
