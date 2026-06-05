// Parallel-ready seams — INTERFACES ONLY. The single-thread executor is the
// normative semantics; these contracts let the worker layer slot in with no public-API change.
// This file ships only the type declarations + `selectWaitTier` so the plan already knows the
// tier; the workers/ layer fills the bodies (WaveSync.complete, WorkerDispatch.dispatch, the
// coordinator worker). NO Atomics, NO worker bodies here.

import type { Tick } from '@ecsia/schema'
import type { SystemBatch } from '../graph/index.js'

export type WorkerMode = 'single' | 'sab' | 'no-sab'

/** SAB control block for one round's completion fence. */
export interface WaveCounter {
  readonly sab: SharedArrayBuffer
  readonly view: Int32Array
  // word 0: remaining — initialized to batchCount; each worker Atomics.sub(.,0,1) on completion
  // word 1: epoch — bumped per round so a stale wake is ignored (Atomics.wait value guard)
  // word 2: errorFlag — a worker sets this (Atomics.store) if its system threw
  // word 3: padding
}

export interface WaveSync {
  /** Reset the counter to `batchCount` and bump the epoch. Main thread, before dispatch. */
  begin(c: WaveCounter, batchCount: number): void
  /** Worker side (body ): Atomics.sub(remaining,1); if 0, Atomics.notify(epoch). */
  complete(c: WaveCounter): void
  /** Main thread: wait until remaining === 0. Tier chosen by capability probe. */
  await(c: WaveCounter): Promise<void> | void
}

export interface WaveSyncTierProbe {
  readonly waitAsync: boolean
  readonly waitBlocking: boolean
  readonly sabAvailable: boolean
}

export type WaveSyncTier = 'waitAsync' | 'coordinator-block' | 'promise-poll' | 'postMessage'

/**: choose the three-tier wait implementation once at world creation from the capability probe. */
export function selectWaitTier(caps: WaveSyncTierProbe): WaveSyncTier {
  if (caps.waitAsync) return 'waitAsync' // tier 1: browser main thread, non-blocking
  if (caps.waitBlocking) return 'coordinator-block' // tier 2: blocking Atomics.wait off main thread
  if (caps.sabAvailable) return 'promise-poll' // tier 3: Atomics.load poll on microtask/setTimeout(0)
  return 'postMessage' // no SAB:
}

export interface WorkerHandle {
  readonly index: number
  /** (plain AB, worker-local). Typed loosely until fills the CommandBuffer. */
  readonly commandBuffer: unknown
  /** (plain AB, worker-local). */
  readonly writeCorral: Uint32Array
}

export interface WorkerDispatch {
  /** Post a batch's systemId + ctx slice to a worker. Worker runs runSystem then WaveSync.complete (body ). */
  dispatch(w: WorkerHandle, batch: SystemBatch, dt: number, tick: Tick): void
  readonly workers: readonly WorkerHandle[]
  readonly mode: WorkerMode
}
