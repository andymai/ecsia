// @ecsia/scheduler — the system access graph (read/write declarations → conflict DAG), wave-level
// topological layering with type-level conflict detection (v1), the CORRECT single-threaded executor
// (wave order + serial slots for command-buffer flush and deferred observers), the world.update()
// frame loop, and the parallel-READY seams (worker dispatch + Atomics wave-sync). DEPENDS ON
// @ecsia/core; @ecsia/core NEVER imports this package (acyclic: schema ← core ← scheduler).
//
// The kernel runs single-threaded WITHOUT this module; the scheduler is an opt-in layer
// (public-api.md §10). Importing it + `createScheduler(world, systems).update(dt)` pulls in the DAG +
// waves; nothing else changes for the user.
//
// PUBLIC SURFACE ONLY (P0.5 surface diet). The DAG/wave builders, command-buffer encoder, executor
// run loop, and worker SAB primitives are implementation internals — they live in `./internal.ts`,
// are NOT re-exported here, and are reached by this package's own tests through a relative import.
// The umbrella (@ecsia/ecsia) re-exports exactly the symbols below.

// --- planner: the system descriptor + ordering hints (§3) ---
export { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from './planner/index.js'
export type { SystemDef, SystemContext, OrderingHint } from './planner/index.js'

// --- executor: the opt-in frame scheduler (§6) ---
export { createScheduler } from './executor/index.js'
export type { SchedulerHandle, CreateSchedulerOptions, RoundDispatcher } from './executor/index.js'

// --- plan introspection (§5): the immutable, frozen plan shape `SchedulerHandle.plan` carries.
// Surfaced for @ecsia/devtools (P5) — the wave visualizer reads the plan to explain WHY the schedule
// looks the way it does (waves, rounds, per-system access, worker-eligibility pinning). `SystemBox` is
// the lowered, declaration-derived system record `plan.systems[systemId]` indexes (read-only metadata:
// name, dense read/write ids, workerEligible). These are read-only views; nothing here lets a consumer
// build or mutate a plan. ---
export type { SchedulePlan, ScheduleWave, SystemBatch } from './graph/index.js'
export type { SystemBox } from './planner/index.js'

// --- workers (M7): the worker pool the threaded frame loop drives (§7) ---
export { WorkerPool } from './workers/index.js'
export type { PoolConfig, PoolSystem } from './workers/index.js'
