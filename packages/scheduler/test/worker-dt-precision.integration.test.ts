// REGRESSION — dt crosses the worker boundary at FULL f64 precision. The work descriptor used to
// carry dt in an f32 slot: kernels computed with Math.fround(dt) while the single-thread executor's
// bodies computed with the exact f64 — for dt = 1/60 (not f32-exact) every float integration
// diverged in the last bits, silently breaking the byte-identical guarantee. The Drift kernel
// (x += dt * 3 into an f32 column) is exactly the shape that exposes it.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import type { SchedulerHandle } from '@ecsia/scheduler'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

let sched: SchedulerHandle | undefined
afterEach(async () => {
  await sched?.dispose()
  sched = undefined
})

describe('dt reaches worker kernels at full f64 precision', () => {
  test('f32 drift column integrates byte-identically serial vs threaded at dt = 1/60', async () => {
    const DT = 1 / 60 // not representable in f32 — fround(DT) !== DT
    const N = 32
    const FRAMES = 8

    const mk = (threaded: boolean) => {
      const Drift = defineComponent({ x: 'f32' }, { name: 'drift' })
      const world = createWorld(
        threaded
          ? { components: [Drift], maxEntities: 1 << 10, threaded: true, scheduler: { workers: 1 } }
          : { components: [Drift], maxEntities: 1 << 10 },
      )
      const handles: EntityHandle[] = []
      for (let i = 0; i < N; i++) {
        const h = world.spawnWith(Drift)
        ;(world.entity(h).write(Drift) as { x: number }).x = i * 0.125
        handles.push(h)
      }
      const DriftSys = defineSystem({
        name: 'Drift',
        read: [],
        write: [Drift],
        run({ query, dt }) {
          for (const e of query(write(Drift)) as Iterable<{ drift: { x: number } }>) e.drift.x += dt * 3
        },
      })
      return { world, Drift, handles, DriftSys }
    }

    const ref = mk(false)
    const refSched = createScheduler(ref.world, [ref.DriftSys])
    const thr = mk(true)
    sched = createScheduler(thr.world, [thr.DriftSys], {
      workers: 1,
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })

    for (let f = 0; f < FRAMES; f++) {
      refSched.update(DT)
      await sched.update(DT)
    }

    for (let i = 0; i < N; i++) {
      const a = (ref.world.entity(ref.handles[i]!).read(ref.Drift) as { x: number }).x
      const b = (thr.world.entity(thr.handles[i]!).read(thr.Drift) as { x: number }).x
      // toBe, not toBeCloseTo: the guarantee is BYTE-identical, and last-bit drift is the bug.
      expect(b).toBe(a)
    }
  })
})
