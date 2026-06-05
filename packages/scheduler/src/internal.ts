// @ecsia/scheduler — INTERNAL surface. NOT part of the published package (`package.json#exports` only
// maps `.` → index.ts). These are builders/primitives consumed by this package's own tests via a
// RELATIVE import (`../src/internal.js`); they are deliberately kept OFF the public `index.ts` so the
// published surface stays curated (P0.5 surface diet). No sibling package imports `@ecsia/scheduler`,
// so nothing here is cross-package — it is test-reachable internals only.

export { lowerSystems, aggregateAccess, DEFAULT_MAX_SPAWNS_PER_WAVE } from './planner/index.js'
export type { SystemBox, AccessMaps } from './planner/index.js'

export {
  EdgeWeight,
  resolveOrdering,
  buildEdges,
  buildDAG,
  CycleError,
  buildPlan,
  concurrencyCompatible,
} from './graph/index.js'
export type { Edge, DAG, SchedulePlan, ScheduleWave, SystemBatch } from './graph/index.js'

export {
  buildSchedulePlan,
  runUpdate,
  runUpdateThreaded,
  runWave,
  buildScopedQueries,
  makeScopedQuery,
} from './executor/index.js'
export type { ExecutorEnv } from './executor/index.js'

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

export {
  Op,
  recordLen,
  directApplySink,
  flushAll,
  makeCommandBuffer,
  resetBuffer,
  ensureWords,
  makeEncoder,
  buildFieldCodec,
} from './commands/index.js'
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

export {
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
