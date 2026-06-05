// System-definition public types and the internal
// lowered `SystemBox`. `defineSystem` lives in @ecsia/scheduler because the
// kernel runs single-threaded WITHOUT this package (`defineSystem` + `world.update`
// pull in the scheduler layer); a relation-free kernel never imports it.

import type { ComponentDef, ComponentId, Schema, SystemId, Tick } from '@ecsia/schema'
import type { World } from '@ecsia/core'

/** The context a system body receives each tick. */
export interface SystemContext {
  readonly world: World
  readonly dt: number
  readonly tick: Tick
  /** The same `query()` the world exposes, scoped (dev-mode access-guarded) for the wave. */
  readonly query: World['query']
}

/**
 * An ordering hint produced by `inAnyOrderWith` / `beforeWritersOf` / `afterReadersOf`. These
 * are passed in `SystemDef.order` (ecsia's surface for the becsy weight scheme) and resolved against
 * the registered systems at plan time.
 */
export type OrderingHint =
  | { readonly kind: 'deny'; readonly a: SystemDef; readonly b: SystemDef }
  | { readonly kind: 'beforeWritersOf'; readonly component: ComponentDef<Schema> }
  | { readonly kind: 'afterReadersOf'; readonly component: ComponentDef<Schema> }

export interface SystemDef {
  readonly name: string
  /** Declared read access — scheduler conflict input. */
  readonly read?: readonly ComponentDef<Schema>[]
  /** Declared write access — the SOLE source of write-intent. */
  readonly write?: readonly ComponentDef<Schema>[]
  /** Explicit ordering: this runs BEFORE these (EdgeWeight.EXPLICIT = 5). */
  readonly before?: readonly SystemDef[]
  /** Explicit ordering: this runs AFTER these. */
  readonly after?: readonly SystemDef[]
  /** Coarse hints + denial edges. */
  readonly order?: readonly OrderingHint[]
  /** Reservation sizing for OP_CREATE mid-wave (default 64). */
  readonly maxSpawnsPerWave?: number
  readonly run: (ctx: SystemContext) => void
  /** Branding marker so a plain object can't be mistaken for a validated SystemDef. */
  readonly __ecsiaSystem?: true
}

/**
 * The internal lowered form. Immutable, declaration-derived ONLY: all
 * plan-derived state lives in the separate `SchedulePlan` so it never goes stale across re-plans
 * (report "Planner metadata on SystemBox mutable fields — stale across re-plans (HMR)").
 */
export interface SystemBox {
  readonly id: SystemId
  readonly name: string
  readonly def: SystemDef
  readonly run: (ctx: SystemContext) => void

  /** Declared access, resolved to dense ComponentIds (pair ids included — ). Sorted, de-duped. */
  readonly readIds: readonly ComponentId[]
  readonly writeIds: readonly ComponentId[]

  /** Packed access signatures for the O(words) disjointness test. length = accessStrideWords. */
  readonly readWords: Uint32Array
  readonly writeWords: Uint32Array

  /** Explicit ordering edges, resolved to SystemIds. */
  readonly before: readonly SystemId[]
  readonly after: readonly SystemId[]

  /** Reservation sizing for OP_CREATE mid-wave. */
  readonly maxSpawnsPerWave: number

  /**
   * Worker-eligibility: false if the system reads/writes any object<T> (restrictedToMainThread)
   * component. Such a system is pinned to a main-thread batch; the
   * object-field boundary is structural at schedule time, not a runtime throw.
   */
  readonly workerEligible: boolean
}

export const DEFAULT_MAX_SPAWNS_PER_WAVE = 64
