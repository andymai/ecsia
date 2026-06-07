// INTEGRATION — topics through REAL worker threads, BOTH directions: a publishing kernel emits
// OP_PUBLISH records from a worker, and a CONSUMING kernel drains the canonical stream worker-side
// (reading the frozen SAB ring mid-wave, reporting its cursor advance via OP_CONSUMED). The
// canonical stream AND the consumer's delivered sequence (folded into an order-sensitive checksum
// on a Tally component) must equal the single-thread executor's run of the same plan — the
// full-stack leg of the serial-equivalence headline, now including worker-side consume.

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
  Tally: ReturnType<typeof defineComponent>
  Hits: TopicDef<Schema>
  tally: EntityHandle
  sched: ReturnType<typeof createScheduler>
}

function makeRig(threaded: boolean, workers: number, n: number): Rig {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Tally = defineComponent({ sum: 'u32', frames: 'u32' }, { name: 'tally' })
  const Hits = defineTopic('hits', { n: 'i32' }) as unknown as TopicDef<Schema>
  const world = createWorld(
    threaded
      ? { components: [Health, Tally], maxEntities: 1 << 12, threaded: true, scheduler: { workers } }
      : { components: [Health, Tally], maxEntities: 1 << 12 },
  )
  for (let i = 0; i < n; i++) world.spawnWith(Health)
  const tally = world.spawnWith(Tally)
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
    write: [Tally],
    consume: [Hits],
    run({ query, consume }) {
      // The single-thread twin of loggerKernel: fold each delivered payload into the checksum.
      if (threaded) return // threaded run: the WORKER kernel consumes instead
      for (const t of query(Tally) as Iterable<{ tally: { sum: number; frames: number } }>) {
        let h = t.tally.sum >>> 0
        for (const ev of consume(Hits)) h = (h * 31 + ((ev as { n: number }).n >>> 0)) % 0x7fffffff
        t.tally.sum = h
        t.tally.frames = (t.tally.frames >>> 0) + 1
      }
    },
  })
  const sched = createScheduler(world, [Hitter, Logger], threaded ? { workers } : undefined)
  return { world, Health, Tally, Hits, tally, sched }
}

describe('topics across real worker threads (OP_PUBLISH + worker-side consume end-to-end)', { timeout: 30_000 }, () => {
  test('worker-published stream + WORKER-consumed checksum match the single-thread run byte-for-byte', async () => {
    const N = 24
    const FRAMES = 3

    const ref = makeRig(false, 0, N)
    for (let f = 0; f < FRAMES; f++) ref.sched.update(1)
    const refTally = ref.world.entity(ref.tally).read(ref.Tally) as { sum: number; frames: number }
    expect(refTally.frames >>> 0).toBe(FRAMES)
    expect(refTally.sum >>> 0).not.toBe(0) // non-trivial: events were actually folded

    const thr = makeRig(true, 2, N)
    // PoolSystem order IS SystemId order: Hitter=0, Logger=1. Logger declares its consume so the
    // pool assigns the (system, topic) cursor slot and ships the window to workers.
    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'Hitter',
        matchComponents: [thr.Health],
        kernel: () => {},
        maxSpawnsPerWave: 0,
      },
      {
        id: 1 as unknown as SystemId,
        name: 'Logger',
        matchComponents: [thr.Tally],
        kernel: () => {},
        maxSpawnsPerWave: 0,
        consumeTopics: [thr.Hits],
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
    // The worker-consumed checksum equals the single-thread one: same events, same order, same
    // exactly-once cursor — delivered-sequence equality without marshalling events off the worker.
    const thrTally = thr.world.entity(thr.tally).read(thr.Tally) as { sum: number; frames: number }
    expect(thrTally.frames >>> 0).toBe(FRAMES) // the consumer ran every frame on the worker
    expect(thrTally.sum >>> 0).toBe(refTally.sum >>> 0)
    // …and the canonical stream words are byte-identical across the two execution modes.
    expect([...thr.world.__topics.streamWords(thr.Hits)]).toEqual([...ref.world.__topics.streamWords(ref.Hits)])
    // The cursor advance reached the main-thread store (OP_CONSUMED replayed at the flush): both
    // modes retain the same window, and the reader is caught up to the head in both.
    expect(thr.world.__topics.bounds(thr.Hits)).toEqual(ref.world.__topics.bounds(ref.Hits))
  })
})
