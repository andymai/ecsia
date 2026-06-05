// Example: worker-parallel particle simulation. Two DISJOINT-WRITE update systems (each integrates a
// distinct particle group's Position from its Velocity) land in the SAME schedule wave because their
// write-sets are disjoint — so the wave scheduler packs them into separate worker batches. The
// threaded frame loop (scheduler.updateThreaded) walks that wave and dispatches the worker batches via
// a RoundDispatcher.
//
// Design latitude (the "demonstrates the parallel path" gate): a real @ecsia/scheduler WorkerPool
// needs a built worker-entry module + SAB-shared columns + a cross-origin-isolated host, which is
// brittle to spin up inside a smoke test. The parallel-readiness contract
// is that the SAME user code runs under an in-process dispatcher and an OS-thread pool — the mode is a
// dispatcher choice, not a code-shape change. This example therefore drives updateThreaded with an
// IN-PROCESS RoundDispatcher that runs each disjoint worker batch's kernel directly. It exercises the
// real threaded frame loop (phase flips, wave walk, per-round dispatch, serial flush) and is the same
// disjoint-write structure a WorkerPool would parallelize, while staying deterministic + non-flaky.
//
// Pass `parallel: false` to run the identical systems through the single-thread executor; the result
// is byte-identical (the parallel-equivalence the wave scheduler guarantees).

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  write,
} from 'ecsia'
import type { EntityHandle, RoundDispatcher, World, SystemDef, SystemContext, Tick } from 'ecsia'

export interface WorkerSimOptions {
  /** Particles per group (two groups total). Default 512. */
  readonly perGroup?: number
  /** Ticks to run. Default 60. */
  readonly ticks?: number
  /** Fixed timestep. Default 1/60. */
  readonly dt?: number
  /** Run threaded (in-process dispatcher) vs single-thread. Default true. */
  readonly parallel?: boolean
  /** Central gravity strength pulling particles toward the origin. Default 4. */
  readonly gravity?: number
  readonly seed?: number
}

export interface WorkerSimResult {
  readonly perGroup: number
  readonly ticks: number
  readonly parallel: boolean
  /** Sum of kinetic energy across all particles (a single observable scalar for the smoke test). */
  readonly totalEnergy: number
  /** End-state mean radius of group A and B (they should track each other — identical dynamics). */
  readonly meanRadiusA: number
  readonly meanRadiusB: number
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export async function main(opts: WorkerSimOptions = {}): Promise<WorkerSimResult> {
  const perGroup = opts.perGroup ?? 512
  const ticks = opts.ticks ?? 60
  const dt = opts.dt ?? 1 / 60
  const parallel = opts.parallel ?? true
  const gravity = opts.gravity ?? 4
  const rand = lcg(opts.seed ?? 7)

  // Per-call defs (component ids are world-scoped). Two groups with DISJOINT component sets so their
  // update systems have disjoint write-sets ⇒ they share one schedule wave and split into two worker
  // batches. VelocityX is BOTH read+write because the gravity term writes velocity (honest to the
  // scheduler).
  const PositionA = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionA' })
  const VelocityA = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityA' })
  const PositionB = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionB' })
  const VelocityB = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocityB' })

  const world = createWorld({
    components: [PositionA, VelocityA, PositionB, VelocityB],
    maxEntities: 1 << 16,
    ...(parallel ? { threaded: true as const, scheduler: { workers: 2 } } : {}),
  })

  const groupA: EntityHandle[] = []
  const groupB: EntityHandle[] = []
  for (let i = 0; i < perGroup; i++) {
    const a = world.spawnWith(PositionA, VelocityA)
    const pa = world.entity(a).write(PositionA)
    pa.x = (rand() - 0.5) * 100
    pa.y = (rand() - 0.5) * 100
    const va = world.entity(a).write(VelocityA)
    va.dx = (rand() - 0.5) * 10
    va.dy = (rand() - 0.5) * 10
    groupA.push(a)

    const b = world.spawnWith(PositionB, VelocityB)
    const pb = world.entity(b).write(PositionB)
    pb.x = (rand() - 0.5) * 100
    pb.y = (rand() - 0.5) * 100
    const vb = world.entity(b).write(VelocityB)
    vb.dx = (rand() - 0.5) * 10
    vb.dy = (rand() - 0.5) * 10
    groupB.push(b)
  }

  const UpdateA = defineSystem({
    name: 'UpdateA',
    read: [PositionA, VelocityA],
    write: [PositionA, VelocityA],
    run({ query, dt: d }) {
      for (const e of query(write(VelocityA), write(PositionA))) {
        e.velocityA.dx += -e.positionA.x * gravity * d
        e.velocityA.dy += -e.positionA.y * gravity * d
        e.positionA.x += e.velocityA.dx * d
        e.positionA.y += e.velocityA.dy * d
      }
    },
  })
  const UpdateB = defineSystem({
    name: 'UpdateB',
    read: [PositionB, VelocityB],
    write: [PositionB, VelocityB],
    run({ query, dt: d }) {
      for (const e of query(write(VelocityB), write(PositionB))) {
        e.velocityB.dx += -e.positionB.x * gravity * d
        e.velocityB.dy += -e.positionB.y * gravity * d
        e.positionB.x += e.velocityB.dx * d
        e.positionB.y += e.velocityB.dy * d
      }
    },
  })

  const defs: readonly SystemDef[] = [UpdateA, UpdateB]
  const scheduler = createScheduler(world, defs, parallel ? { workers: 2 } : undefined)

  if (parallel) {
    // In-process RoundDispatcher: run each disjoint worker batch's kernel by systemId. Because the
    // batches in a round are conflict-free by construction (disjoint write-sets), running them in
    // index order is observably identical to true parallel execution (the wave-scheduler guarantee).
    const dispatcher = makeInProcessDispatcher(world, scheduler.plan.systems, defs)
    for (let t = 0; t < ticks; t++) await scheduler.updateThreaded(dispatcher, dt)
  } else {
    for (let t = 0; t < ticks; t++) scheduler.update(dt)
  }

  let energy = 0
  let radA = 0
  for (const h of groupA) {
    // Read each component's fields out before resolving the next — the pooled ref rebinds per call.
    const p = world.entity(h).read(PositionA)
    const radius = Math.hypot(p.x, p.y)
    const v = world.entity(h).read(VelocityA)
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
    radA += radius
  }
  let radB = 0
  for (const h of groupB) {
    const p = world.entity(h).read(PositionB)
    const radius = Math.hypot(p.x, p.y)
    const v = world.entity(h).read(VelocityB)
    energy += 0.5 * (v.dx * v.dx + v.dy * v.dy)
    radB += radius
  }

  return {
    perGroup,
    ticks,
    parallel,
    totalEnergy: energy,
    meanRadiusA: radA / perGroup,
    meanRadiusB: radB / perGroup,
  }
}

interface PlanSystemLike {
  readonly name: string
}

/** Build a RoundDispatcher that runs each worker batch's kernel in-process via the world's query. */
function makeInProcessDispatcher(
  world: World,
  planSystems: readonly PlanSystemLike[],
  defs: readonly SystemDef[],
): RoundDispatcher {
  const runByName = new Map<string, SystemDef['run']>()
  for (const d of defs) runByName.set(d.name, d.run)
  return {
    async runRound(batches, dt): Promise<void> {
      for (const b of batches) {
        const sys = planSystems[b.systemId as unknown as number]
        if (sys === undefined) continue
        const run = runByName.get(sys.name)
        if (run === undefined) continue
        run({
          world: world as unknown as SystemContext['world'],
          dt,
          tick: world.currentTick() as unknown as Tick,
          query: world.query,
        })
      }
    },
  }
}
