// AUTO-DISPATCH — `scheduler.update()` with the `threading` option drives the threaded frame loop
// through a scheduler-OWNED WorkerPool (created lazily on the first update, derived from the plan,
// terminated by dispose()) and REPRODUCES the single-thread result. Companion to
// m7-threaded-update.integration.test.ts, which exercises the same loop through a hand-wired pool.
// Also: the serial fallback (world not threaded → one warning, single-threaded output) and the
// overlapping-update guard.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach, vi } from 'vitest'
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
  vi.restoreAllMocks()
})

function seedWorld(threaded: boolean, workers: number, n: number) {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld(
    threaded
      ? { components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers } }
      : { components: [Health, Mana], maxEntities: 1 << 12 },
  )
  const handles: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Health, Mana)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    ;(world.entity(h).write(Mana) as { mp: number }).mp = 100 + i
    handles.push(h)
  }
  return { world, Health, Mana, handles }
}

describe('auto-dispatch: update() drives the threaded loop through a scheduler-owned pool', () => {
  test('column state matches the single-thread run; dispose() terminates the owned pool', async () => {
    const N = 48
    const FRAMES = 3

    // Single-thread reference (run bodies are the arithmetic twins of the worker kernels).
    const ref = seedWorld(false, 0, N)
    const Regen = defineSystem({
      name: 'Regen',
      read: [],
      write: [ref.Health],
      run({ query }) {
        for (const e of query(write(ref.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
      },
    })
    const Channel = defineSystem({
      name: 'Channel',
      read: [],
      write: [ref.Mana],
      run({ query }) {
        for (const e of query(write(ref.Mana)) as Iterable<{ mana: { mp: number } }>) e.mana.mp -= 1
      },
    })
    const refSched = createScheduler(ref.world, [Regen, Channel])
    for (let f = 0; f < FRAMES; f++) refSched.update(1)

    // Auto-dispatched run: same plan shape, NO hand-built PoolSystem list, NO pool.ready() ritual.
    const thr = seedWorld(true, 2, N)
    const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
    const ChannelT = defineSystem({ name: 'Channel', read: [], write: [thr.Mana], run() {} })
    sched = createScheduler(thr.world, [RegenT, ChannelT], {
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })
    for (let f = 0; f < FRAMES; f++) await sched.update(1)

    expect(thr.world.phase).toBe('serial')
    for (let i = 0; i < N; i++) {
      const r = ref.handles[i] as EntityHandle
      const t = thr.handles[i] as EntityHandle
      expect((thr.world.entity(t).read(thr.Health) as { hp: number }).hp).toBe(
        (ref.world.entity(r).read(ref.Health) as { hp: number }).hp,
      )
      expect((thr.world.entity(t).read(thr.Mana) as { mp: number }).mp).toBe(
        (ref.world.entity(r).read(ref.Mana) as { mp: number }).mp,
      )
    }

    await sched.dispose() // explicit (afterEach also covers it) — must be idempotent
    await sched.dispose()
  })

  test('workers default from world.options.scheduler.workers when the option is omitted', async () => {
    const thr = seedWorld(true, 2, 8)
    const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
    sched = createScheduler(thr.world, [RegenT], {
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })
    expect(sched.plan.workers).toBe(2)
    await sched.update(1)
    expect((thr.world.entity(thr.handles[0] as EntityHandle).read(thr.Health) as { hp: number }).hp).toBe(1)
  })

  test('overlapping update() calls throw instead of interleaving frames', async () => {
    const thr = seedWorld(true, 2, 8)
    const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
    sched = createScheduler(thr.world, [RegenT], {
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })
    const first = sched.update(1) as Promise<void>
    await expect(async () => {
      await (sched!.update(1) as Promise<void>)
    }).rejects.toThrow(/still in flight/)
    await first
  })
})

describe('auto-dispatch: serial fallback', () => {
  test('a non-threaded world warns ONCE and runs single-threaded with identical results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = seedWorld(false, 0, 8) // threaded: false — no shared backings
    const Regen = defineSystem({
      name: 'Regen',
      read: [],
      write: [w.Health],
      run({ query }) {
        for (const e of query(write(w.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
      },
    })
    sched = createScheduler(w.world, [Regen], {
      workers: 2,
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })
    await sched.update(1)
    await sched.update(1) // second frame: already fallen back, returns void — await is harmless
    const fallbackWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('threaded update unavailable'))
    expect(fallbackWarnings.length).toBe(1)
    expect((w.world.entity(w.handles[0] as EntityHandle).read(w.Health) as { hp: number }).hp).toBe(2)
  })

  test('threading without kernelModule or pool fails fast at createScheduler', () => {
    const w = seedWorld(true, 2, 1)
    const Regen = defineSystem({ name: 'Regen', read: [], write: [w.Health], run() {} })
    expect(() => createScheduler(w.world, [Regen], { threading: {} })).toThrow(/kernelModule|pool/)
  })
})
