// @ecsia/scheduler/workers — the M7 parallel execution layer: SAB allocation + one-time column/region
// transfer to a fixed worker pool, the wave dispatch loop, the three-tier Atomics wave-sync, the
// reservation Atomics.sub take path, and the deterministic command-buffer merge (serial-equivalence).

export { WorkerPool } from './pool.js'
export type { PoolConfig, PoolSystem } from './pool.js'
export { makeWaveCounter, makeWaveSync, completeWave, setWaveError, waveErrored, workerHead } from './wave-sync.js'
export { makeReservationSab, fillReservation, takeReserved, consumedCount } from './reservation.js'
export type { WorkerReservationSab } from './reservation.js'
export { buildWorkerWorldView } from './world-view.js'
export type { WorkerWorldView } from './world-view.js'
export { matchComponentsOf } from './worker-system.js'
export type { WorkerSystemDef, WorkerSystemKernel, WorkerSystemBox } from './worker-system.js'
export type { WorkerBootstrap, ComponentManifestEntry, DispatchMessage } from './manifest.js'
export { hasWaitAsync, waitAsync } from './atomics-shim.js'
export type { WaitAsyncResult } from './atomics-shim.js'
