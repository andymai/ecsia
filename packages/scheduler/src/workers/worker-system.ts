// A WORKER-ELIGIBLE system: its body is expressed against the
// `WorkerWorldView` (shared-SAB column field access + the command encoder) and an explicit list of
// matched entity indices, so the SAME kernel runs identically on a worker thread (over the shared
// buffer set) and on the main thread (single-thread mode) — the structural guarantee behind
// serial-equivalence: there is ONE body, not two.
//
// The main thread does the bitmask-free archetype MATCHING (it owns the query engine) and hands the
// worker the matched entity indices; the worker runs the per-entity kernel reading ARCHETYPE TABLES
// ONLY (never the bitmask). Field writes go to disjoint shared columns; structural ops
// are deferred to the worker's command buffer.

import type { ComponentDef, Schema } from '@ecsia/schema'
import type { WorkerWorldView } from './world-view.js'
import type { OrderingHint, SystemDef } from '../planner/index.js'

export interface WorkerSystemKernel {
  (view: WorkerWorldView, indices: Int32Array, dt: number): void
}

export interface WorkerSystemDef {
  readonly name: string
  readonly read?: readonly ComponentDef<Schema>[]
  readonly write?: readonly ComponentDef<Schema>[]
  readonly before?: readonly WorkerSystemDef[]
  readonly after?: readonly WorkerSystemDef[]
  readonly order?: readonly OrderingHint[]
  readonly maxSpawnsPerWave?: number
  /** The worker-runnable per-batch body. Receives the matched entity indices for this dispatch. */
  readonly kernel: WorkerSystemKernel
}

/** Components a worker system reads + writes — the matching set the main thread uses for dispatch. */
export function matchComponentsOf(def: WorkerSystemDef): readonly ComponentDef<Schema>[] {
  const set = new Map<ComponentDef<Schema>, true>()
  for (const c of def.read ?? []) set.set(c, true)
  for (const c of def.write ?? []) set.set(c, true)
  return [...set.keys()]
}

/**
 * A worker system carries its `kernel` on the SystemDef so the executor can dispatch it to a worker
 * AND run it on the main thread. The `run` body (used by the single-thread executor's runSystem path)
 * is a thin adapter the scheduler installs when it has the main-thread WorkerWorldView; until then it
 * throws if invoked outside the worker-aware executor.
 */
export interface WorkerSystemBox {
  readonly def: SystemDef
  readonly kernel: WorkerSystemKernel
  readonly matchComponents: readonly ComponentDef<Schema>[]
}
