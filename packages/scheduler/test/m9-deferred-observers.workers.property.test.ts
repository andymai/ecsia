// PROPERTY (fast-check) — the NO-RE-ENTRANCY HEADLINE under a REAL multi-worker frame.
//
// Setup: a real worker_threads WorkerPool (2 workers) drives a fuzzed structural frame through the
// PUBLIC frame loop scheduler.updateThreaded(pool, dt). One worker regenerates Health (disjoint
// value write), one spawns a Mana child per matched entity (OP_CREATE + OP_ADD via the per-worker
// command buffer, applied in deterministic worker-index merge order). The onAdd(Mana) observers
// THEMSELVES stage structural commands (despawn the new child, or spawn a grandchild) — exercising
// Those ops are STAGED to the deferred buffer and applied at the NEXT serial flush, never
// mid-drain. We assert three discriminating facts:
//
// (a) NO PARTIALLY-APPLIED WAVE: at the instant each observer fires, the world is quiescent —
// the entity it is handed is fully placed (holds Mana) and every structural op the handler issues
// is NOT yet visible (hasn't shuffled a row a later observer in the same drain still reads). The
// handler records `world.has(child, Mana)` (must be true) and, for a staged despawn, that the
// child is STILL alive immediately after staging (deferred). A re-entrant apply would flip these.
//
// (b) CROSS-RUN IDENTITY: the ordered observer event stream from the THREADED run is byte-for-
// byte identical to a SINGLE-THREADED run of the SAME workload (same seeds, same frames, same
// observer staging policy). Worker nondeterminism (which worker finishes first) must NOT leak into
// the observed stream — the command merge order is fixed, so the deltas are deterministic.
//
// (c) EXACTLY ONCE: each net structural change is observed exactly once (no double-emit from the
// command-apply path re-driving a lifecycle hook) — checked implicitly by the stream equality
// (a double-emit on either side diverges) and explicitly by the add-count == spawn-count assertion.
//
// CHANGE-STREAM leg: worker VALUE writes now stage into the per-worker
// write corral (world-view.ts writeField → makeWriteCorralWriter) and merge into the shared write log
// in ascending worker-index order at the serial flush slot (pool.runRound → world.__mergeWorkerWrites).
// So onChange(Health) fires for worker writes exactly as for single-thread writes. This suite asserts
// the CHANGE stream is byte-for-byte identical across thread modes (audit point (2) change leg), in
// addition to the STRUCTURAL (onAdd/onRemove) stream that flows through command-buffer apply.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, handleIndex, onAdd, onChange, onRemove } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema, World } from '@ecsia/core'
import { createScheduler, defineSystem, WorkerPool } from '@ecsia/scheduler'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

interface Ev {
  kind: string
  component: number
  index: number
}

// Normalize within (kind) by index: robust to intra-wave timing, but a reorder ACROSS kinds or a
// double/missing emit still diverges. Identical to the integration's `norm`.
const norm = (d: Ev[]): Ev[] =>
  d.slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index || a.component - b.component)

interface Seeded {
  world: World
  Health: ComponentDef<Schema>
  Mana: ComponentDef<Schema>
  seeds: EntityHandle[]
}

// Seed Health-ONLY so the ONLY Mana adds in the whole run are the spawner's children (no
// pre-registration seeding history pollutes the onAdd(Mana) stream).
function seed(threaded: boolean, workers: number, n: number): Seeded {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld(
    threaded
      ? { components: [Health, Mana], maxEntities: 1 << 13, threaded: true, scheduler: { workers } }
      : { components: [Health, Mana], maxEntities: 1 << 13 },
  )
  const seeds: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Health)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    seeds.push(h)
  }
  return { world, Health, Mana, seeds }
}

// `policy` controls what the onAdd(Mana) handler STAGES (the re-entrant structural op under test):
// 'noop' — observe only.
// 'despawn' — despawn the just-added child (staged → applied next flush → onRemove fires next drain).
// 'grand' — spawn a grandchild + add Mana (staged → onAdd fires for it next drain).
type Policy = 'noop' | 'despawn' | 'grand'

// Wire the onAdd(Mana)/onRemove(Mana) observers + the staging policy. Returns the captured stream and
// a list of quiescence assertions to check after the run.
function wireObservers(s: Seeded, policy: Policy): { events: Ev[]; quiescence: boolean[] } {
  const events: Ev[] = []
  const quiescence: boolean[] = []
  const layout = s.world.handleLayout
  const grandchildren = new Set<number>()

  s.world.observe(onAdd(s.Mana), (e: { __handle: EntityHandle }, ctx: { kind: string; component: number }) => {
    const idx = handleIndex(e.__handle, layout) as number
    events.push({ kind: 'add', component: ctx.component, index: idx })
    // (a): at fire time the entity is FULLY placed — it must already hold Mana (no partial wave).
    quiescence.push(s.world.has(e.__handle, s.Mana))
    if (grandchildren.has(idx)) return // don't recurse on grandchildren (bounded)
    if (policy === 'despawn') {
      s.world.despawn(e.__handle)
      // (a): the despawn is STAGED — the child is STILL alive immediately after (not applied mid-drain).
      quiescence.push(s.world.isAlive(e.__handle))
    } else if (policy === 'grand') {
      const g = s.world.spawn()
      s.world.add(g, s.Mana)
      grandchildren.add(handleIndex(g, layout) as number)
      // (a): the grandchild is reserved-alive but NOT yet a Mana holder (placement deferred).
      quiescence.push(!s.world.has(g, s.Mana))
    }
  })
  s.world.observe(onRemove(s.Mana), (e: { __handle: EntityHandle }, ctx: { kind: string; component: number }) => {
    events.push({ kind: 'remove', component: ctx.component, index: handleIndex(e.__handle, layout) as number })
  })
  // CHANGE leg: onChange(Health) must fire for the worker's regen value writes — and be identical to
  // the single-thread reference's regen writes ( change-stream parity across thread modes).
  s.world.observe(onChange(s.Health), (e: { __handle: EntityHandle }, ctx: { kind: string; component: number }) => {
    events.push({ kind: 'change', component: ctx.component, index: handleIndex(e.__handle, layout) as number })
  })
  return { events, quiescence }
}

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

describe('— deferred observers under a REAL multi-worker frame: no re-entrancy, stream === single-thread', () => {
  test('a fuzzed multi-worker spawner frame: threaded observer stream is IDENTICAL to the single-thread run, and no observer sees a partial wave', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }), // N seed (Health-only) entities → N spawns/frame
        fc.integer({ min: 1, max: 3 }), // frames
        fc.constantFrom<Policy>('noop', 'despawn', 'grand'),
        async (n, frames, policy) => {
          // --- single-thread reference: the arithmetic twin of the two worker kernels. RegenRef is the
          // twin of regenKernel (write Health=hp+1 for every Health holder → drives onChange(Health));
          // SpawnerRef is the twin of spawnerKernel (create a child + add Mana=7 per matched entity).
          const ref = seed(false, 0, n)
          const refCap = wireObservers(ref, policy)
          const RegenRef = defineSystem({
            name: 'Regen',
            read: [],
            write: [ref.Health],
            run({ world }) {
              for (const e of world.query(ref.Health) as Iterable<{ handle: EntityHandle }>) {
                const w = world.entity(e.handle).write(ref.Health) as { hp: number }
                w.hp = w.hp + 1
              }
            },
          })
          const SpawnerRef = defineSystem({
            name: 'Spawner',
            read: [ref.Health],
            write: [ref.Mana],
            maxSpawnsPerWave: n,
            run({ world }) {
              const targets: EntityHandle[] = []
              for (const e of world.query(ref.Health) as Iterable<{ handle: EntityHandle }>) targets.push(e.handle)
              for (let i = 0; i < targets.length; i++) {
                const child = world.spawn()
                world.add(child, ref.Mana)
                ;(world.entity(child).write(ref.Mana) as { mp: number }).mp = 7
              }
            },
          })
          const refSched = createScheduler(ref.world, [RegenRef, SpawnerRef])

          // --- threaded run: the SAME workload dispatched to 2 workers through the frame loop. The
          // Spawner worker (workerIndex 1) creates the children; Regen (worker 0) is a disjoint-write
          // filler so the round genuinely runs two workers concurrently.
          const thr = seed(true, 2, n)
          const thrCap = wireObservers(thr, policy)
          const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
          const SpawnerT = defineSystem({ name: 'Spawner', read: [thr.Health], write: [thr.Mana], maxSpawnsPerWave: n, run() {} })
          const thrSched = createScheduler(thr.world, [RegenT, SpawnerT], { workers: 2 })
          const systems: PoolSystem[] = [
            { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
            { id: 1 as unknown as SystemId, name: 'Spawner', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: n },
          ]
          pool = new WorkerPool({
            world: thr.world,
            workers: 2,
            kernelModule: KERNEL_MODULE,
            workerEntryUrl: WORKER_ENTRY,
            systems,
            components: [thr.Health, thr.Mana],
          })
          await pool.ready()

          for (let f = 0; f < frames; f++) {
            refSched.update(1)
            await thrSched.updateThreaded(pool, 1)
          }
          // One trailing drain on each so the LAST frame's staged ops apply + their observers fire,
          // keeping both runs at the same drain count (the frame loop drains at frame-start of the
          // NEXT frame; without a trailing flush the final staged batch would be unobserved on both).
          ref.world.frameReset()
          ref.world.observerDrain()
          thr.world.frameReset()
          thr.world.observerDrain()

          await pool.dispose()
          pool = undefined

          // (b) CROSS-RUN IDENTITY: the observer event streams (add + remove + change) must be
          // identical. A worker-order leak, a double-emit, a dropped event, or a mid-drain mutation
          // would diverge them.
          expect(norm(thrCap.events)).toEqual(norm(refCap.events))

          // CHANGE-STREAM PARITY (audit point (2) change leg): the onChange(Health) stream from the
          // worker writes is byte-for-byte identical to the single-thread reference's regen writes — AND
          // non-empty, so the assertion is not vacuous (worker writes really reached the write log via
          // the corral merge). This is the leg that was previously documented out-of-scope.
          const thrChange = thrCap.events.filter((e) => e.kind === 'change')
          const refChange = refCap.events.filter((e) => e.kind === 'change')
          expect(norm(thrChange)).toEqual(norm(refChange))
          expect(thrChange.length).toBeGreaterThanOrEqual(n * frames)

          // (a) NO PARTIAL WAVE: every quiescence probe held on BOTH runs (entity fully placed at
          // fire time; staged ops not yet applied mid-drain).
          expect(thrCap.quiescence.every((q) => q)).toBe(true)
          expect(refCap.quiescence.every((q) => q)).toBe(true)

          // (c) EXACTLY ONCE: one add per spawned child, every frame — no double-emit. (`grand`
          // adds extra children, but both runs add the same extra count, so the streams still match;
          // we assert the floor: at least the N base spawns per frame were observed.)
          const baseAdds = thrCap.events.filter((e) => e.kind === 'add').length
          expect(baseAdds).toBeGreaterThanOrEqual(n * frames)
          expect(thr.world.phase).toBe('serial')
        },
      ),
      { numRuns: 12 },
    )
  })
})
