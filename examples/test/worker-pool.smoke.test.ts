// The one worker test that uses REAL OS threads. The other worker smoke tests drive
// scheduler.updateThreaded with an in-process dispatcher — they exercise the threaded frame loop
// but never leave the main thread. This test closes that gap: it stands up the genuine
// @ecsia/scheduler WorkerPool (node:worker_threads, synchronized via Atomics), drives a real
// world through scheduler.updateThreaded(pool, dt), and asserts the worker-thread run reproduces
// the single-thread run's component data exactly. So the umbrella's "genuinely runs threaded"
// claim is backed by execution on real threads, not by construction.
//
// Reuses the built worker entry (dist) plus the scheduler suite's kernel fixture — a kernel is
// the function the worker thread runs, and the fixture is a plain .mjs file a raw worker_threads
// Worker can load without a TypeScript transform. This is the same path
// packages/scheduler/test/m7-threaded-update.integration.test.ts takes, reached here through the
// umbrella's public surface.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent, defineSystem, createScheduler, write, WorkerPool } from 'ecsia'
import type { EntityHandle, PoolSystem, World } from 'ecsia'

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

describe('worker example genuinely runs threaded on a REAL WorkerPool', () => {
  test('two systems writing different components run on real OS threads and reproduce the single-thread state', async () => {
    const N = 32
    const FRAMES = 3

    // Single-thread reference: these system bodies do the same arithmetic as the worker kernels
    // in the fixture module.
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

    // Threaded run: the SAME plan, dispatched to 2 real worker threads through the public frame
    // loop. The local run()/kernel bodies are empty placeholders — the real arithmetic lives in
    // the kernel module the workers load.
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

    // The pool returned to the serial phase, and every entity's component values equal the
    // single-thread run's.
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
