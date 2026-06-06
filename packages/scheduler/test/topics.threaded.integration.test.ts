// INTEGRATION — topics through REAL worker threads: a publishing kernel emits OP_PUBLISH records
// from a worker (the reservationless, non-entity-targeted record), the pool replays them at the
// serial flush, and the threaded frame loop's per-wave merge canonicalizes the stream. The
// canonical stream and the main-thread consumer's delivered sequence must equal the single-thread
// executor's run of the same plan — the full-stack leg of the serial-equivalence headline.

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTopic, handleIndex } from '@ecsia/core'
import type { EntityHandle, TopicDef, World } from '@ecsia/core'
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

interface Rig {
  world: World
  Health: ReturnType<typeof defineComponent>
  Hits: TopicDef<Schema>
  delivered: number[][]
  sched: ReturnType<typeof createScheduler>
}

function makeRig(threaded: boolean, workers: number, n: number): Rig {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Hits = defineTopic('hits', { n: 'i32' }) as unknown as TopicDef<Schema>
  const world = createWorld(
    threaded
      ? { components: [Health], maxEntities: 1 << 12, threaded: true, scheduler: { workers } }
      : { components: [Health], maxEntities: 1 << 12 },
  )
  for (let i = 0; i < n; i++) world.spawnWith(Health)
  const delivered: number[][] = []
  const layout = world.handleLayout
  const Hitter = defineSystem({
    name: 'Hitter',
    read: [Health],
    publish: [Hits],
    run({ query, publish }) {
      // The single-thread twin of the worker kernel: one event per matched entity, payload = index.
      if (threaded) return // threaded run: the WORKER kernel publishes instead
      for (const e of query(Health) as Iterable<{ handle: EntityHandle }>) {
        publish(Hits, { n: handleIndex(e.handle, layout) as number })
      }
    },
  })
  const Logger = defineSystem({
    name: 'Logger',
    consume: [Hits],
    run({ consume }) {
      const got: number[] = []
      for (const ev of consume(Hits)) got.push((ev as { n: number }).n)
      delivered.push(got)
    },
  })
  const sched = createScheduler(world, [Hitter, Logger], threaded ? { workers } : undefined)
  return { world, Health, Hits, delivered, sched }
}

describe('topics across real worker threads (OP_PUBLISH end-to-end)', { timeout: 30_000 }, () => {
  test('worker-published stream + main-thread consumer match the single-thread run byte-for-byte', async () => {
    const N = 24
    const FRAMES = 3

    const ref = makeRig(false, 0, N)
    for (let f = 0; f < FRAMES; f++) ref.sched.update(1)

    const thr = makeRig(true, 2, N)
    // The pool snapshots registered topic ids at construction — the scheduler above registered them.
    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'Hitter',
        matchComponents: [thr.Health],
        kernel: () => {},
        maxSpawnsPerWave: 0,
      },
    ]
    pool = new WorkerPool({
      world: thr.world,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()
    for (let f = 0; f < FRAMES; f++) await thr.sched.updateThreaded(pool, 1)

    expect(thr.world.phase).toBe('serial')
    // The consumer (main-thread batch — consumers are pinned) delivered identical sequences…
    expect(thr.delivered).toEqual(ref.delivered)
    expect(ref.delivered[0]!.length).toBe(N) // …and they are non-trivial (one event per entity).
    // …and the canonical stream words are byte-identical across the two execution modes.
    expect([...thr.world.__topics.streamWords(thr.Hits)]).toEqual([...ref.world.__topics.streamWords(ref.Hits)])
  })
})
