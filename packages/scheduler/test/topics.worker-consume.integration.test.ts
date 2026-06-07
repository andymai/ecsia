// INTEGRATION — the worker-side consume legs beyond the happy path, through REAL workers:
//
// 1. A PURE consumer (matches no components) is still dispatched every wave — events are its
//    input, not the entity set; the old `count > 0` gate would starve it silently.
// 2. Exactly-once across frames: the cursor advance rides OP_CONSUMED back to the main-thread
//    store, so no event is delivered twice and none is skipped, frame after frame.
// 3. TopicRingGrown: a pre-frame burst overflows the ring's in-place reservation, forcing an
//    allocate-copy re-back; the pool's notice fence re-wraps the worker's region views before the
//    next dispatch, and the worker consumer reads every event from the NEW backing.

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTopic } from '@ecsia/core'
import type { TopicDef, World } from '@ecsia/core'
import { createScheduler, defineSystem, WorkerPool } from '@ecsia/scheduler'
import type { PoolSystem } from '@ecsia/scheduler'
import type { Schema, SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

describe('worker-side consume — pure consumers, exactly-once, TopicRingGrown', { timeout: 30_000 }, () => {
  test('a pure consumer (zero matched entities) drains worker-side, exactly once across frames', async () => {
    const Tally = defineComponent({ sum: 'u32', frames: 'u32' }, { name: 'tally' })
    const Hits = defineTopic('hits', { n: 'i32' }) as unknown as TopicDef<Schema>
    const Echo = defineTopic('echo', { count: 'i32' }) as unknown as TopicDef<Schema>
    const world: World = createWorld({
      components: [Tally],
      maxEntities: 1 << 10,
      threaded: true,
      scheduler: { workers: 2 },
    })
    const LoggerPure = defineSystem({
      name: 'LoggerPure',
      consume: [Hits],
      publish: [Echo],
      run() {
        /* threaded run: the WORKER kernel consumes */
      },
    })
    const sched = createScheduler(world, [LoggerPure], { workers: 2 })

    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'LoggerPure',
        matchComponents: [], // pure consumer: matches NOTHING — dispatch must not gate on count
        kernel: () => {},
        maxSpawnsPerWave: 0,
        consumeTopics: [Hits],
      },
    ]
    pool = new WorkerPool({
      world,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()

    // Frame 1: three pre-frame input events. Frame 2: two more. Frame 3: none (idle frame). The
    // kernel publishes its RUNNING total each frame; read the newest Echo row after each update
    // (reading once at the end would lose frame 1's row to two-frame retention).
    const totals: number[] = []
    for (const burst of [3, 2, 0]) {
      for (let i = 0; i < burst; i++) world.publish(Hits as TopicDef<Schema>, { n: i })
      await sched.updateThreaded(pool, 1)
      const rows = world.__topics.streamWords(Echo as TopicDef<Schema>)
      totals.push(rows[rows.length - 1]! | 0) // last row's count word ([hdr0, hdr1, count] per row)
    }

    // 3 delivered, then 2 more, then none re-delivered — exactly-once across frames, with the
    // cursor advance riding OP_CONSUMED back to the main-thread store between waves.
    expect(totals).toEqual([3, 5, 5])
  })

  test('TopicRingGrown: a ring re-back past its reservation re-wraps worker views before the next dispatch', async () => {
    const Tally = defineComponent({ sum: 'u32', frames: 'u32' }, { name: 'tally' })
    const Hits = defineTopic('hits', { n: 'i32' }) as unknown as TopicDef<Schema>
    const world: World = createWorld({
      components: [Tally],
      maxEntities: 1 << 10,
      threaded: true,
      scheduler: { workers: 2 },
    })
    const Logger = defineSystem({
      name: 'Logger',
      write: [Tally],
      consume: [Hits],
      run() {
        /* threaded run: the WORKER kernel consumes */
      },
    })
    const sched = createScheduler(world, [Logger], { workers: 2 })
    const tally = world.spawnWith(Tally)

    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'Logger',
        matchComponents: [Tally],
        kernel: () => {},
        maxSpawnsPerWave: 0,
        consumeTopics: [Hits],
      },
    ]
    pool = new WorkerPool({
      world,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()

    // The hits ring starts at 256 rows with a 16x in-place reservation (4096 rows). A 5000-event
    // pre-frame burst exceeds it: publishOutside folds the spill by re-backing onto a NEW SAB and
    // journals the re-back; the pool's notice fence must re-wrap the worker's ring/hdr views
    // BEFORE the consuming dispatch, or the kernel reads the abandoned buffer (zeros / short ring).
    const N = 5000
    let expected = 0
    for (let i = 0; i < N; i++) {
      world.publish(Hits as TopicDef<Schema>, { n: i })
      expected = (expected * 31 + i) % 0x7fffffff
    }
    await sched.updateThreaded(pool, 1)

    const t = world.entity(tally).read(Tally) as { sum: number; frames: number }
    expect(t.frames >>> 0).toBe(1)
    expect(t.sum >>> 0).toBe(expected) // every one of the 5000 events read from the re-backed ring
  })
})
