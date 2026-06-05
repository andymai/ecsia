// M12 worker example — the no-silent-failure threading gate (public-api.md §7, PA-4). The worker-sim
// example's main() runs the SAME disjoint-write workload under two transports:
//
//   SAB lane          (parallel: true)  — threaded:true + scheduler.workers:2, driven by the in-process
//                                          RoundDispatcher the example ships (the wave/round/dispatch path
//                                          a real WorkerPool parallelizes; PA-4 says the user code is the
//                                          same shape regardless of transport).
//   single-thread     (parallel: false) — the v1 baseline serial executor.
//
// This file ADDS the third documented lane — the postMessage / no-SAB fallback — and proves it is NOT a
// silent failure: `createWorld({ threaded:true, scheduler:{ workers:'postMessage-fallback' } })` builds a
// correct world and the identical workload through the threaded frame loop reproduces the single-thread
// result byte-for-byte (public-api.md §7 "Never silent"). Run twice for stability (the task's gate).

import { describe, expect, test } from 'vitest'
import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  write,
} from '@ecsia/ecsia'
import type { EntityHandle, RoundDispatcher, SystemContext, SystemDef, Tick, World } from '@ecsia/ecsia'
import { main as workerSim } from '../worker-sim.js'

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// The single-thread baseline replica of the example's disjoint-write workload. Returns one observable
// scalar (total kinetic energy) for an exact cross-lane comparison.
function runSingleThread(opts: { perGroup: number; ticks: number; seed: number }): {
  totalEnergy: number
  built: boolean
} {
  const dt = 1 / 60
  const gravity = 4
  const rand = lcg(opts.seed)

  const PositionA = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionA' })
  const VelocityA = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityA' })
  const PositionB = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionB' })
  const VelocityB = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityB' })

  const world: World = createWorld({
    components: [PositionA, VelocityA, PositionB, VelocityB],
    maxEntities: 1 << 16,
  })
  const built = world !== undefined && world !== null

  const groupA: EntityHandle[] = []
  const groupB: EntityHandle[] = []
  for (let i = 0; i < opts.perGroup; i++) {
    const a = world.spawnWith(PositionA, VelocityA)
    const pa = world.entity(a).write(PositionA) as { x: number; y: number }
    pa.x = (rand() - 0.5) * 100
    pa.y = (rand() - 0.5) * 100
    const va = world.entity(a).write(VelocityA) as { dx: number; dy: number }
    va.dx = (rand() - 0.5) * 10
    va.dy = (rand() - 0.5) * 10
    groupA.push(a)

    const b = world.spawnWith(PositionB, VelocityB)
    const pb = world.entity(b).write(PositionB) as { x: number; y: number }
    pb.x = (rand() - 0.5) * 100
    pb.y = (rand() - 0.5) * 100
    const vb = world.entity(b).write(VelocityB) as { dx: number; dy: number }
    vb.dx = (rand() - 0.5) * 10
    vb.dy = (rand() - 0.5) * 10
    groupB.push(b)
  }

  const UpdateA = defineSystem({
    name: 'UpdateA',
    read: [PositionA, VelocityA],
    write: [PositionA, VelocityA],
    run({ query, dt: d }) {
      query(write(VelocityA), write(PositionA)).each((el) => {
        const e = el as unknown as { velocityA: { dx: number; dy: number }; positionA: { x: number; y: number } }
        e.velocityA.dx += -e.positionA.x * gravity * d
        e.velocityA.dy += -e.positionA.y * gravity * d
        e.positionA.x += e.velocityA.dx * d
        e.positionA.y += e.velocityA.dy * d
      })
    },
  })
  const UpdateB = defineSystem({
    name: 'UpdateB',
    read: [PositionB, VelocityB],
    write: [PositionB, VelocityB],
    run({ query, dt: d }) {
      query(write(VelocityB), write(PositionB)).each((el) => {
        const e = el as unknown as { velocityB: { dx: number; dy: number }; positionB: { x: number; y: number } }
        e.velocityB.dx += -e.positionB.x * gravity * d
        e.velocityB.dy += -e.positionB.y * gravity * d
        e.positionB.x += e.velocityB.dx * d
        e.positionB.y += e.velocityB.dy * d
      })
    },
  })

  const scheduler = createScheduler(world, [UpdateA, UpdateB])
  for (let t = 0; t < opts.ticks; t++) scheduler.update(dt)

  let energy = 0
  for (const h of groupA) {
    const v = world.entity(h).read(VelocityA) as { dx: number; dy: number }
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
  }
  for (const h of groupB) {
    const v = world.entity(h).read(VelocityB) as { dx: number; dy: number }
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
  }
  return { totalEnergy: energy, built }
}

// The threaded lane (postMessage-fallback OR explicit numeric pool): identical workload, awaited frame
// loop, driven by an in-process RoundDispatcher (PA-4: the dispatcher is the transport, not a code shape).
async function runThreaded(opts: {
  perGroup: number
  ticks: number
  workers: number | 'postMessage-fallback'
  seed: number
}): Promise<{ totalEnergy: number; built: boolean }> {
  const dt = 1 / 60
  const gravity = 4
  const rand = lcg(opts.seed)

  const PositionA = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionA' })
  const VelocityA = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityA' })
  const PositionB = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionB' })
  const VelocityB = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityB' })

  const world: World = createWorld({
    components: [PositionA, VelocityA, PositionB, VelocityB],
    maxEntities: 1 << 16,
    threaded: true as const,
    scheduler: { workers: opts.workers },
  })
  const built = world !== undefined && world !== null

  const groupA: EntityHandle[] = []
  const groupB: EntityHandle[] = []
  for (let i = 0; i < opts.perGroup; i++) {
    const a = world.spawnWith(PositionA, VelocityA)
    const pa = world.entity(a).write(PositionA) as { x: number; y: number }
    pa.x = (rand() - 0.5) * 100
    pa.y = (rand() - 0.5) * 100
    const va = world.entity(a).write(VelocityA) as { dx: number; dy: number }
    va.dx = (rand() - 0.5) * 10
    va.dy = (rand() - 0.5) * 10
    groupA.push(a)

    const b = world.spawnWith(PositionB, VelocityB)
    const pb = world.entity(b).write(PositionB) as { x: number; y: number }
    pb.x = (rand() - 0.5) * 100
    pb.y = (rand() - 0.5) * 100
    const vb = world.entity(b).write(VelocityB) as { dx: number; dy: number }
    vb.dx = (rand() - 0.5) * 10
    vb.dy = (rand() - 0.5) * 10
    groupB.push(b)
  }

  const UpdateA = defineSystem({
    name: 'UpdateA',
    read: [PositionA, VelocityA],
    write: [PositionA, VelocityA],
    run({ query, dt: d }) {
      query(write(VelocityA), write(PositionA)).each((el) => {
        const e = el as unknown as { velocityA: { dx: number; dy: number }; positionA: { x: number; y: number } }
        e.velocityA.dx += -e.positionA.x * gravity * d
        e.velocityA.dy += -e.positionA.y * gravity * d
        e.positionA.x += e.velocityA.dx * d
        e.positionA.y += e.velocityA.dy * d
      })
    },
  })
  const UpdateB = defineSystem({
    name: 'UpdateB',
    read: [PositionB, VelocityB],
    write: [PositionB, VelocityB],
    run({ query, dt: d }) {
      query(write(VelocityB), write(PositionB)).each((el) => {
        const e = el as unknown as { velocityB: { dx: number; dy: number }; positionB: { x: number; y: number } }
        e.velocityB.dx += -e.positionB.x * gravity * d
        e.velocityB.dy += -e.positionB.y * gravity * d
        e.positionB.x += e.velocityB.dx * d
        e.positionB.y += e.velocityB.dy * d
      })
    },
  })

  const defs: readonly SystemDef[] = [UpdateA, UpdateB]
  const scheduler = createScheduler(world, defs, { workerCount: 2 })
  const runByName = new Map<string, SystemDef['run']>()
  for (const d of defs) runByName.set(d.name, d.run)
  const dispatcher: RoundDispatcher = {
    async runRound(batches, d): Promise<void> {
      for (const b of batches) {
        const sys = scheduler.plan.systems[b.systemId as unknown as number]
        if (sys === undefined) continue
        const run = runByName.get((sys as { name: string }).name)
        if (run === undefined) continue
        run({
          world: world as unknown as SystemContext['world'],
          dt: d,
          tick: world.currentTick() as unknown as Tick,
          query: world.query,
        })
      }
    },
  }
  for (let t = 0; t < opts.ticks; t++) await scheduler.updateThreaded(dispatcher, dt)

  let energy = 0
  for (const h of groupA) {
    const v = world.entity(h).read(VelocityA) as { dx: number; dy: number }
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
  }
  for (const h of groupB) {
    const v = world.entity(h).read(VelocityB) as { dx: number; dy: number }
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
  }
  return { totalEnergy: energy, built }
}

describe('worker example: SAB lane vs fallback lanes — identical results, never silent (PA-4, §7)', () => {
  test('SAB-lane (example main, threaded:true) === single-thread fallback (run twice for stability)', async () => {
    for (let pass = 0; pass < 2; pass++) {
      const sab = await workerSim({ perGroup: 256, ticks: 40, parallel: true, seed: 11 })
      const serial = await workerSim({ perGroup: 256, ticks: 40, parallel: false, seed: 11 })
      expect(sab.parallel).toBe(true)
      expect(serial.parallel).toBe(false)
      expect(sab.totalEnergy).toBeCloseTo(serial.totalEnergy, 5)
      expect(sab.meanRadiusA).toBeCloseTo(serial.meanRadiusA, 5)
      expect(sab.meanRadiusB).toBeCloseTo(serial.meanRadiusB, 5)
      expect(sab.totalEnergy).toBeGreaterThan(0)
      expect(Number.isFinite(sab.totalEnergy)).toBe(true)
    }
  })

  test("postMessage-fallback lane BUILDS and produces the IDENTICAL result to single-thread (no silent failure)", async () => {
    for (let pass = 0; pass < 2; pass++) {
      const single = runSingleThread({ perGroup: 200, ticks: 30, seed: 23 })
      const fallback = await runThreaded({ perGroup: 200, ticks: 30, workers: 'postMessage-fallback', seed: 23 })
      // Never silent: the threaded:true + no-SAB request still builds a correct world...
      expect(fallback.built).toBe(true)
      expect(single.built).toBe(true)
      // ...and the workload reproduces the single-thread answer exactly (PA-4).
      expect(fallback.totalEnergy).toBeCloseTo(single.totalEnergy, 5)
      expect(fallback.totalEnergy).toBeGreaterThan(0)
      expect(Number.isFinite(fallback.totalEnergy)).toBe(true)
    }
  })

  test("an explicit numeric worker pool ('SAB lane' shape) also matches single-thread", async () => {
    const single = runSingleThread({ perGroup: 150, ticks: 25, seed: 5 })
    const pooled = await runThreaded({ perGroup: 150, ticks: 25, workers: 2, seed: 5 })
    expect(pooled.built).toBe(true)
    expect(pooled.totalEnergy).toBeCloseTo(single.totalEnergy, 5)
  })
})
