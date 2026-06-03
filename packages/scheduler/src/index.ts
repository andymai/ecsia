// @ecsia/scheduler — the system access graph (read/write declarations → conflict DAG), wave-level
// topological layering with type-level conflict detection (v1), the CORRECT single-threaded executor
// (wave order + serial slots for command-buffer flush and deferred observers), the world.update()
// frame loop, and the parallel-READY seams (worker dispatch + Atomics wave-sync — INTERFACES, bodies
// at M7). DEPENDS ON @ecsia/core; @ecsia/core NEVER imports this package (acyclic: schema ← core ←
// scheduler).
//
// The kernel runs single-threaded WITHOUT this module; the scheduler is an opt-in layer
// (public-api.md §10). Importing it + `createScheduler(world, systems).update(dt)` pulls in the DAG +
// waves; nothing else changes for the user.

export const SCHEDULER_PACKAGE = 'scheduler' as const

// --- planner: system definition + access-set aggregation (§3) ---
export { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from './planner/index.js'
export { lowerSystems, aggregateAccess, DEFAULT_MAX_SPAWNS_PER_WAVE } from './planner/index.js'
export type { SystemDef, SystemContext, SystemBox, OrderingHint, AccessMaps } from './planner/index.js'

// --- graph: priority-weighted DAG + waves + WAVE-CONFLICT (§4, §5) ---
export { EdgeWeight, resolveOrdering, buildEdges, buildDAG, CycleError, buildPlan, concurrencyCompatible } from './graph/index.js'
export type { Edge, DAG, SchedulePlan, ScheduleWave, SystemBatch } from './graph/index.js'

// --- executor: the single-threaded wave runner + frame loop + world-driving seam (§6, §12) ---
export { createScheduler, buildSchedulePlan, runUpdate, runUpdateThreaded, runWave, buildScopedQueries, makeScopedQuery } from './executor/index.js'
export type { SchedulerHandle, CreateSchedulerOptions, ExecutorEnv, RoundDispatcher } from './executor/index.js'

// --- parallel-ready seams (§7) — interfaces only; worker bodies at M7 ---
export { selectWaitTier } from './executor/seams.js'
export type {
  WorkerMode,
  WaveSync,
  WaveCounter,
  WaveSyncTier,
  WaveSyncTierProbe,
  WorkerHandle,
  WorkerDispatch,
} from './executor/seams.js'

// --- commands: the command-buffer ENCODING FORMAT contract (op ordinals CANON 0..6) + apply path ---
export { Op, recordLen, directApplySink, flushAll, makeCommandBuffer, resetBuffer, ensureWords, makeEncoder, buildFieldCodec } from './commands/index.js'
export type {
  CommandSink,
  StructuralIntent,
  WorldApply,
  CommandBuffer,
  BufferReservation,
  CommandEncoder,
  ComponentEncodeInfo,
  EncoderEnv,
  ComponentFieldCodec,
} from './commands/index.js'

// --- workers (M7): SAB worker pool, wave dispatch, Atomics wave-sync, deterministic merge ---
export {
  WorkerPool,
  makeWaveCounter,
  makeWaveSync,
  completeWave,
  setWaveError,
  waveErrored,
  workerHead,
  makeReservationSab,
  fillReservation,
  takeReserved,
  consumedCount,
  buildWorkerWorldView,
  matchComponentsOf,
  hasWaitAsync,
  waitAsync,
} from './workers/index.js'
export type {
  PoolConfig,
  PoolSystem,
  WorkerReservationSab,
  WorkerWorldView,
  WorkerSystemDef,
  WorkerSystemKernel,
  WorkerSystemBox,
  WorkerBootstrap,
  ComponentManifestEntry,
  DispatchMessage,
  WaitAsyncResult,
} from './workers/index.js'
