// The world↔scheduler wiring seam (the locked dependency direction schema ← core ←
// scheduler). The scheduler DRIVES the world externally: `createScheduler(world, systems).update(dt)`.
// @ecsia/core NEVER imports @ecsia/scheduler — so rather than a core→scheduler import, the scheduler
// holds the World and calls its public lifecycle verbs (frameReset / mergeCorrals /
// maintainStructural / observerDrain / flushLogs / query / phase). A `world.setUpdate(fn)` seam was
// rejected in favour of this external driver because it keeps the acyclic graph trivially obvious and
// needs no new core surface.

import type { World, ComponentDef, Schema } from '@ecsia/core'
import { lowerSystems, aggregateAccess } from '../planner/index.js'
import type { SystemBox, SystemDef } from '../planner/index.js'
import { resolveOrdering, buildEdges, buildDAG, buildPlan } from '../graph/index.js'
import type { SchedulePlan } from '../graph/index.js'
import { directApplySink } from '../commands/index.js'
import { buildScopedQueries, buildTopicCtx } from './run-wave.js'
import { runUpdate } from './update.js'
import { runUpdateThreaded } from './update-threaded.js'
import type { RoundDispatcher } from './update-threaded.js'
import { IS_DEV } from '@ecsia/core'
// Type-only: the concrete pool stays a dynamic import (the workers layer is the deeper sibling —
// no static executor→workers edge, and a browser bundle of the serial path never touches
// node:worker_threads through this module).
import type { PoolConfig, PoolSystem, WorkerPool } from '../workers/pool.js'

/**
 * Auto-dispatch configuration: with `threading` set (and a worker count), `scheduler.update()`
 * transparently drives the threaded frame loop through a scheduler-OWNED WorkerPool — created
 * lazily on the first update, derived from the plan (PoolSystem order = SystemId order), and
 * terminated by `dispose()`. When worker execution is unavailable (the world was not created
 * `threaded: true`, SharedArrayBuffer is missing, or pool startup fails) the scheduler warns ONCE
 * and runs single-threaded from then on — output is identical either way (parallel equals serial).
 */
export interface SchedulerThreadingOptions extends Partial<Omit<PoolConfig, 'world' | 'workers' | 'systems'>> {
  /**
   * Module URL the workers import for their kernels (`buildWorkerKernels` export). REQUIRED unless
   * `pool` is injected — system `run` closures cannot cross a worker boundary, so worker-eligible
   * systems express their bodies as kernels in a module workers can load.
   */
  readonly kernelModule?: string
  /** Bring-your-own pool. The caller owns its lifecycle; `dispose()` will NOT terminate it. */
  readonly pool?: RoundDispatcher
}

export interface SchedulerHandle {
  /** The immutable plan (frozen; rebuilt wholesale on re-plan, never patched — ). */
  readonly plan: SchedulePlan
  /**
   * Run one wave-scheduled tick. Synchronous (void) on the single-threaded path; returns a Promise
   * when auto-threading is active (`threading` option + workers > 0) — AWAIT it before the next
   * update (an overlapping call throws). Falls back to the synchronous path (with a one-time
   * warning) when worker execution is unavailable.
   */
  update(dt?: number): void | Promise<void>
  /**
   * Run one wave-scheduled tick THREADED (PHASE-2): each round's worker batches
   * are dispatched to `pool` (the WorkerPool), the rest run on the main thread. Reproduces the
   * single-thread observable result through the SAME frame loop. The `pool`'s PoolSystem
   * registration order MUST match the plan's SystemId order (the test rig wires this).
   */
  updateThreaded(pool: RoundDispatcher, dt?: number): Promise<void>
  /** Terminate the scheduler-owned worker pool, if one was auto-created. Idempotent. */
  dispose(): Promise<void>
}

export interface CreateSchedulerOptions {
  /**
   * registry.nextComponentId after createWorld registration (user components + reserved ids + one
   * presence id per relation); accessStrideWords = ceil(registeredComponentCount / 32). When omitted,
   * the stride is derived from the max declared component id (correct for the type-level disjointness
   * test; widen-only). Pass it to align the access words with the bitmask stride for worker work.
   */
  readonly registeredComponentCount?: number
  /** Worker pool size for plan shape. Default: `world.options.scheduler.workers` (0 = single-thread). */
  readonly workers?: number
  /** Dev guards on/off. Default: NODE_ENV !== 'production'. */
  readonly dev?: boolean
  /** Enable auto-dispatch: `update()` drives the threaded loop through a scheduler-owned pool. */
  readonly threading?: SchedulerThreadingOptions
}

function strideFor(systems: readonly SystemBox[], registeredComponentCount: number | undefined): number {
  if (registeredComponentCount !== undefined) return Math.max(1, Math.ceil(registeredComponentCount / 32))
  let maxId = 0
  for (const sb of systems) {
    for (const c of [...sb.readIds, ...sb.writeIds] as unknown as number[]) {
      if (c > maxId) maxId = c
    }
  }
  return Math.max(1, Math.ceil((maxId + 1) / 32))
}

/**
 * Build the immutable plan from lowered, ordering-resolved SystemBoxes. The full pipeline:
 * aggregate access → derive weighted conflict edges → cycle-detect + transitively reduce → extract
 * waves + pack batches (WAVE-CONFLICT). Fails fast on a cyclic dependency (CycleError).
 */
export function buildSchedulePlan(
  systems: readonly SystemBox[],
  opts: { accessStrideWords: number; workers: number },
): SchedulePlan {
  if (systems.length === 0) {
    return Object.freeze({
      waves: [],
      systems,
      accessStrideWords: opts.accessStrideWords,
      workers: opts.workers,
    })
  }
  const defs = systems.map((sb) => sb.def)
  const access = aggregateAccess(systems)
  const edges = buildEdges(systems, defs, access)
  const dag = buildDAG(systems, edges)
  return buildPlan(systems, dag, opts.accessStrideWords, opts.workers)
}

export function createScheduler(
  world: World,
  defs: readonly SystemDef[],
  opts?: CreateSchedulerOptions,
): SchedulerHandle {
  const worldWorkers = world.options.scheduler.workers
  const workers = opts?.workers ?? (typeof worldWorkers === 'number' ? worldWorkers : 0)
  const dev = opts?.dev ?? IS_DEV
  const threading = opts?.threading
  if (threading !== undefined && threading.pool === undefined && threading.kernelModule === undefined) {
    throw new Error("createScheduler: threading requires either 'kernelModule' (workers import their kernels from it) or an injected 'pool'")
  }

  const accessStrideWords = strideFor(lowerSystems(defs, 1), opts?.registeredComponentCount)
  const systems = resolveOrdering(lowerSystems(defs, accessStrideWords), defs)

  // Register every declared topic with the world (idempotent — re-plans and world.publish-first
  // topics share the same store), then position each consumer's cursor: a FIRST-plan consumer
  // starts at the oldest retained event (world.publish before createScheduler is still delivered),
  // while a system added by a re-plan after frames have run starts at the current visible head —
  // it sees only events published after it joined, never a stale replay.
  const topics = world.__topics
  for (const sb of systems) {
    for (const t of sb.publishTopics) topics.register(t)
    for (const t of sb.consumeTopics) topics.register(t)
  }
  for (const sb of systems) {
    for (const t of sb.consumeTopics) topics.initCursor(t, sb.name)
  }

  const plan = buildSchedulePlan(systems, { accessStrideWords, workers })

  const env = {
    world,
    dev,
    commands: directApplySink,
    observerCadence: world.options.reactivity.observerCadence,
    systems: plan.systems,
    scopedQueries: buildScopedQueries(world, plan.systems, dev),
    topicCtx: buildTopicCtx(world, plan.systems, dev),
  }

  // ---- auto-dispatch state (inert unless `threading` is set and workers > 0) ----
  const threadingActive = threading !== undefined && workers > 0
  let pool: RoundDispatcher | null = threading?.pool ?? null
  let ownedPool: WorkerPool | null = null
  let fellBack = false
  let inFlight = false

  const fallBack = (reason: string): void => {
    fellBack = true
    if (typeof console !== 'undefined') {
      console.warn(`[ecsia] threaded update unavailable — running single-threaded (output is identical). ${reason}`)
    }
  }

  // Derive the pool's system list from the plan: PoolSystem order IS SystemId order (the contract
  // updateThreaded's batches dispatch by). The main-side `kernel` field is never invoked — workers
  // resolve kernels by system NAME from `kernelModule` — so a noop satisfies the shape.
  const poolSystems = (): PoolSystem[] =>
    plan.systems.map((sb) => {
      const match = new Set<ComponentDef<Schema>>()
      for (const c of sb.def.read ?? []) match.add(c)
      for (const c of sb.def.write ?? []) match.add(c)
      return {
        id: sb.id,
        name: sb.name,
        matchComponents: [...match],
        kernel: () => {},
        maxSpawnsPerWave: sb.maxSpawnsPerWave,
      }
    })

  async function ensurePool(): Promise<RoundDispatcher | null> {
    if (pool !== null) return pool
    if (fellBack) return null
    if (world.options.threaded !== true) {
      fallBack("Create the world with `threaded: true` so its columns get shared backings.")
      return null
    }
    if (typeof SharedArrayBuffer !== 'function') {
      fallBack('SharedArrayBuffer is unavailable in this environment (cross-origin isolation absent?).')
      return null
    }
    try {
      // Dynamic: no static executor→workers edge, and the serial path never loads node:worker_threads.
      const workersModule = await import('../workers/pool.js')
      const own = new workersModule.WorkerPool({
        ...threading,
        world,
        workers,
        kernelModule: threading!.kernelModule as string,
        systems: poolSystems(),
      })
      await own.ready()
      ownedPool = own
      pool = own
      return own
    } catch (err) {
      fallBack(`Worker pool startup failed: ${String(err)}`)
      return null
    }
  }

  async function updateAuto(dt: number): Promise<void> {
    if (inFlight) {
      throw new Error('scheduler.update: the previous threaded update is still in flight — await update() before calling it again')
    }
    inFlight = true
    try {
      const p = await ensurePool()
      if (p === null) {
        runUpdate(env, plan, dt)
        return
      }
      await runUpdateThreaded(env, plan, p, dt)
    } finally {
      inFlight = false
    }
  }

  return {
    plan,
    update(dt: number = 0): void | Promise<void> {
      if (threadingActive && !fellBack) return updateAuto(dt)
      runUpdate(env, plan, dt)
    },
    updateThreaded(pool: RoundDispatcher, dt: number = 0): Promise<void> {
      return runUpdateThreaded(env, plan, pool, dt)
    },
    async dispose(): Promise<void> {
      const own = ownedPool
      ownedPool = null
      pool = threading?.pool ?? null
      await own?.dispose()
    },
  }
}
