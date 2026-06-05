// The world↔scheduler wiring seam (the locked dependency direction schema ← core ←
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
import { buildScopedQueries, buildTopicCtx } from './run-wave.js'
import { runUpdate } from './update.js'
import { runUpdateThreaded } from './update-threaded.js'
import type { RoundDispatcher } from './update-threaded.js'
import { IS_DEV } from '@ecsia/core'

export interface SchedulerHandle {
  /** The immutable plan (frozen; rebuilt wholesale on re-plan, never patched — ). */
  readonly plan: SchedulePlan
  /** Run one wave-scheduled tick on the main thread. */
  update(dt?: number): void
  /**
   * Run one wave-scheduled tick THREADED (PHASE-2): each round's worker batches
   * are dispatched to `pool` (the WorkerPool), the rest run on the main thread. Reproduces the
   * single-thread observable result through the SAME frame loop. The `pool`'s PoolSystem
   * registration order MUST match the plan's SystemId order (the test rig wires this).
   */
  updateThreaded(pool: RoundDispatcher, dt?: number): Promise<void>
}

export interface CreateSchedulerOptions {
  /**
   * registry.nextComponentId after createWorld registration (user components + reserved ids + one
   * presence id per relation); accessStrideWords = ceil(registeredComponentCount / 32). When omitted,
   * the stride is derived from the max declared component id (correct for the type-level disjointness
   * test; widen-only). Pass it to align the access words with the bitmask stride for worker work.
   */
  readonly registeredComponentCount?: number
  /** Worker pool size for plan shape (matches WorldOptions.scheduler.workers). Default: 0 (single-thread; worker bodies land at ). */
  readonly workers?: number
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
  const workers = opts?.workers ?? 0
  const dev = opts?.dev ?? IS_DEV

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
