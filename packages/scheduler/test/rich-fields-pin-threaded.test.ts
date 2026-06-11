// RF-PIN serial-equivalence under a REAL multi-worker frame (the
// threaded leg). A rich-field-bearing component is restrictedToMainThread, so a system writing it is
// worker-INELIGIBLE and runs its run() body SERIALLY on the main thread BEFORE each round's worker
// dispatch (update-threaded.ts:10-11,44 — "object-field systems"). We assert that a threaded world
// mixing a worker-eligible NUMERIC system (kernel-dispatched) with a main-pinned RICH system produces
// the IDENTICAL state as a single-threaded run of the same plan. If the rich system were (wrongly)
// dispatched to a worker, its sidecar write would be lost (the field codec drops non-shareable
// fields) and the rich state would diverge — so this is a discriminating equivalence, not a tautology.
//
// RESOURCE SAFETY: exactly ONE WorkerPool, disposed in afterEach; a single targeted file run.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { WorkerPool } from '@ecsia/scheduler/workers'
import { lowerSystems } from '../src/internal.js'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

// Seed a world: every entity carries Health (numeric, worker-eligible regen) + Label (rich 'string',
// main-pinned titler). The single-thread reference and the threaded run seed identically.
function seed(threaded: boolean, n: number) {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Label = defineComponent({ text: 'string' }, { name: 'label' })
  const world: World = createWorld(
    threaded
      ? { components: [Health, Label], maxEntities: 1 << 12, threaded: true, scheduler: { workers: 2 } }
      : { components: [Health, Label], maxEntities: 1 << 12 },
  )
  const handles: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Health, Label)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    handles.push(h)
  }
  return { world, Health, Label, handles }
}

describe('RF-PIN — a rich-writing system is main-pinned; the threaded run is serial-equivalent', () => {
  test('the planner pins the rich system and keeps the numeric one worker-eligible', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'healthE' })
    const Label = defineComponent({ text: 'string' }, { name: 'labelE' })
    createWorld({ components: [Health, Label] })
    const Regen = defineSystem({ name: 'Regen', write: [Health], run() {} })
    const Titler = defineSystem({ name: 'Titler', read: [Health], write: [Label], run() {} })
    const [regen, titler] = lowerSystems([Regen, Titler], 4)
    expect(regen!.workerEligible).toBe(true) // numeric → worker-eligible
    expect(titler!.workerEligible).toBe(false) // writes a rich component → main-pinned
  })

  test('threaded Regen(worker)+Titler(main-pinned) reproduces the single-thread numeric AND rich state', async () => {
    const N = 32
    const FRAMES = 3

    // --- single-thread reference. Regen: hp += 1 (twin of the worker regenKernel). Titler: write the
    // rich Label.text from the current hp — runs on the main thread in BOTH modes (it is pinned).
    const ref = seed(false, N)
    const RegenRef = defineSystem({
      name: 'Regen',
      write: [ref.Health],
      run({ query }) {
        for (const e of query(write(ref.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
      },
    })
    const TitlerRef = defineSystem({
      name: 'Titler',
      read: [ref.Health],
      write: [ref.Label],
      run({ world }) {
        for (const e of world.query(ref.Health) as Iterable<{ handle: EntityHandle }>) {
          const hp = (world.entity(e.handle).read(ref.Health) as { hp: number }).hp
          ;(world.entity(e.handle).write(ref.Label) as { text: string }).text = `hp=${hp}`
        }
      },
    })
    const refSched = createScheduler(ref.world, [RegenRef, TitlerRef])

    // --- threaded run. RegenT is kernel-dispatched (worker); TitlerT keeps a REAL run() body because it
    // is main-pinned and never reaches a worker. The pool `systems` array carries ONLY the worker system.
    const thr = seed(true, N)
    const RegenT = defineSystem({ name: 'Regen', write: [thr.Health], run() {} })
    const TitlerT = defineSystem({
      name: 'Titler',
      read: [thr.Health],
      write: [thr.Label],
      run({ world }) {
        for (const e of world.query(thr.Health) as Iterable<{ handle: EntityHandle }>) {
          const hp = (world.entity(e.handle).read(thr.Health) as { hp: number }).hp
          ;(world.entity(e.handle).write(thr.Label) as { text: string }).text = `hp=${hp}`
        }
      },
    })
    const thrSched = createScheduler(thr.world, [RegenT, TitlerT], { workers: 2 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({
      world: thr.world,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      components: [thr.Health, thr.Label],
    })
    await pool.ready()

    for (let f = 0; f < FRAMES; f++) {
      refSched.update(1)
      await thrSched.updateThreaded(pool, 1)
    }

    expect(thr.world.phase).toBe('serial')

    // Numeric column parity (the worker leg) AND rich sidecar parity (the main-pinned leg). The rich
    // value depends on the post-regen hp, so it ALSO proves the main-pinned Titler observed the worker's
    // writes in the correct serial order each frame.
    for (let i = 0; i < N; i++) {
      const refHp = (ref.world.entity(ref.handles[i]!).read(ref.Health) as { hp: number }).hp
      const thrHp = (thr.world.entity(thr.handles[i]!).read(thr.Health) as { hp: number }).hp
      expect(thrHp).toBe(refHp)
      const refText = (ref.world.entity(ref.handles[i]!).read(ref.Label) as { text: string }).text
      const thrText = (thr.world.entity(thr.handles[i]!).read(thr.Label) as { text: string }).text
      expect(thrText).toBe(refText)
      expect(thrText).toBe(`hp=${i + FRAMES}`) // non-vacuous: the value really advanced
    }
  })
})
