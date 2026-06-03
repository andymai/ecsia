// The world↔scheduler wiring seam (scheduler.md §12; the locked dependency direction schema ← core ←
// scheduler). The scheduler DRIVES the world externally: `createScheduler(world, systems).update(dt)`.
// @ecsia/core NEVER imports @ecsia/scheduler — so rather than a core→scheduler import, the scheduler
// holds the World and calls its public lifecycle verbs (frameReset / mergeCorrals /
// maintainStructural / observerDrain / flushLogs / query / phase). A `world.setUpdate(fn)` seam was
// rejected in favour of this external driver because it keeps the acyclic graph trivially obvious and
// needs no new core surface.

import type { World } from '@ecsia/core'
import { lowerSystems, aggregateAccess } from '../planner/index.js'
import type { SystemBox, SystemDef } from '../planner/index.js'
import { resolveOrdering, buildEdges, buildDAG, buildPlan } from '../graph/index.js'
import type { SchedulePlan } from '../graph/index.js'
import { directApplySink } from '../commands/index.js'
import { buildScopedQueries } from './run-wave.js'
import { runUpdate } from './update.js'
import { runUpdateThreaded } from './update-threaded.js'
import type { RoundDispatcher } from './update-threaded.js'

export interface SchedulerHandle {
  /** The immutable plan (frozen; rebuilt wholesale on re-plan, never patched — §4.4). */
  readonly plan: SchedulePlan
  /** Run one wave-scheduled tick on the main thread (scheduler.md §6.2). */
  update(dt?: number): void
  /**
   * Run one wave-scheduled tick THREADED (scheduler.md §6.2 + §7, PHASE-2): each round's worker batches
   * are dispatched to `pool` (the WorkerPool), the rest run on the main thread. Reproduces the
   * single-thread observable result through the SAME frame loop (§2.2/§6.5). The `pool`'s PoolSystem
   * registration order MUST match the plan's SystemId order (the test rig wires this).
   */
  updateThreaded(pool: RoundDispatcher, dt?: number): Promise<void>
}

export interface CreateSchedulerOptions {
  /**
   * registry.nextComponentId after createWorld registration (user components + reserved ids + one
   * presence id per relation); accessStrideWords = ceil(registeredComponentCount / 32). When omitted,
   * the stride is derived from the max declared component id (correct for the type-level disjointness
   * test; widen-only). Pass it to align the access words with the bitmask stride for M7 worker work.
   */
  readonly registeredComponentCount?: number
  /** Worker pool size for plan shape. Default: 0 (single-thread; worker bodies land at M7). */
  readonly workerCount?: number
  /** Dev guards on/off. Default: NODE_ENV !== 'production'. */
  readonly dev?: boolean
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
 * waves + pack batches (WAVE-CONFLICT). Fails fast on a cyclic dependency (CycleError, §4.5).
 */
export function buildSchedulePlan(
  systems: readonly SystemBox[],
  opts: { accessStrideWords: number; workerCount: number },
): SchedulePlan {
  if (systems.length === 0) {
    return Object.freeze({
      waves: [],
      systems,
      accessStrideWords: opts.accessStrideWords,
      workerCount: opts.workerCount,
    })
  }
  const defs = systems.map((sb) => sb.def)
  const access = aggregateAccess(systems)
  const edges = buildEdges(systems, defs, access)
  const dag = buildDAG(systems, edges)
  return buildPlan(systems, dag, opts.accessStrideWords, opts.workerCount)
}

export function createScheduler(
  world: World,
  defs: readonly SystemDef[],
  opts?: CreateSchedulerOptions,
): SchedulerHandle {
  const workerCount = opts?.workerCount ?? 0
  const dev = opts?.dev ?? (typeof process !== 'undefined' && process.env['NODE_ENV'] !== 'production')

  const accessStrideWords = strideFor(lowerSystems(defs, 1), opts?.registeredComponentCount)
  const systems = resolveOrdering(lowerSystems(defs, accessStrideWords), defs)
  const plan = buildSchedulePlan(systems, { accessStrideWords, workerCount })

  const env = {
    world,
    dev,
    commands: directApplySink,
    observerCadence: world.options.reactivity.observerCadence,
    systems: plan.systems,
    scopedQueries: buildScopedQueries(world, plan.systems, dev),
  }

  return {
    plan,
    update(dt: number = 0): void {
      runUpdate(env, plan, dt)
    },
    updateThreaded(pool: RoundDispatcher, dt: number = 0): Promise<void> {
      return runUpdateThreaded(env, plan, pool, dt)
    },
  }
}
