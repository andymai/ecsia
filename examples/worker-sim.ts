// A particle simulation built to run across worker threads. Two systems each pull a different
// particle group toward the origin; because the two systems write different components, the
// scheduler puts them in the same wave (a batch of systems that can safely run at the same time)
// and splits them into separate worker batches. The thing to notice: pass `parallel: false` and
// the identical systems run on one thread with a byte-identical result — the guarantee that
// threaded results are byte-for-byte identical to single-threaded.

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
  /** Run the threaded frame loop (with an in-process dispatcher) vs single-thread. Default true. */
  readonly parallel?: boolean
  /** Central gravity strength pulling particles toward the origin. Default 4. */
  readonly gravity?: number
  readonly seed?: number
}

export interface WorkerSimResult {
  readonly perGroup: number
  readonly ticks: number
  readonly parallel: boolean
  /** Sum of kinetic energy across all particles (one observable number for the smoke test). */
  readonly totalEnergy: number
  /** Mean end radius of group A and B (they should track each other — identical dynamics). */
  readonly meanRadiusA: number
  readonly meanRadiusB: number
}

function seededRandom(seed: number): () => number {
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
  const rand = seededRandom(opts.seed ?? 7)

  // Component definitions get their id at world registration, so they're created per call. The
  // two groups use separate component sets so UpdateA and UpdateB write different components —
  // that's what lets them share one wave and split onto separate workers. Velocity appears in
  // both read and write because the gravity term writes it: the declarations must stay honest,
  // since the scheduler trusts them.
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
    // A RoundDispatcher is the object the scheduler hands each round's batches to for execution —
    // normally a pool of OS threads. Real threads need a built worker-entry module, storage backed
    // by SharedArrayBuffer (memory several threads can read and write at once), and host opt-ins
    // that are brittle inside a smoke test, so this example runs each batch's kernel (the function
    // the worker thread runs) in-process instead. The user code is identical either way — the
    // dispatcher is the only thing that changes. And because batches in a round never conflict
    // (the two systems write different components), running them one after another produces the
    // exact result true parallel execution would.
    const dispatcher = makeInProcessDispatcher(world, scheduler.plan.systems, defs)
    for (let t = 0; t < ticks; t++) await scheduler.updateThreaded(dispatcher, dt)
  } else {
    for (let t = 0; t < ticks; t++) scheduler.update(dt)
  }

  let energy = 0
  let radA = 0
  for (const h of groupA) {
    // Copy a component's fields out before asking for the next — world.entity() reuses one
    // pooled reference.
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

/** A RoundDispatcher that runs each batch's system directly on this thread via the world's query. */
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
