// @ecsia/ecsia — the batteries-included umbrella (public-api.md §10). Frozen at M12.
//
// This module owns no runtime mechanism: it is the curated assembly + re-export layer over
// @ecsia/{schema,core,relations,scheduler,serialization}. A consumer imports the whole cohesive
// surface from here — world/entity/component/query/relations/scheduler/serialization.
//
// TREE-SHAKING (public-api.md §10, Q-PA6): every line below is a static `export ... from`. There is
// NO eager side-effecting glue at module scope, so a single-threaded bundle that only touches
// createWorld/query/accessors never pulls in @ecsia/scheduler's worker code or @ecsia/serialization —
// the bundler drops the untouched re-exports. The thin convenience helpers (§"Convenience wiring")
// are likewise plain re-exported functions, so they only cost what the caller actually references.

// ---------------------------------------------------------------------------
// World — the single constructor + its frozen PUBLIC facade (world.md / public-api.md §2, §0/PA-1..8)
// ---------------------------------------------------------------------------
// The core `World`/`EntityRef` types carry `__`-prefixed wiring seams (scheduler/serialization/relations
// attach points) plus scheduler-only frame-loop verbs. PA-1..PA-8 require those seams stay NON-public.
// The umbrella therefore re-exports a PUBLIC VIEW that omits them — the only `World`/`EntityRef` a
// consumer ever sees through '@ecsia/ecsia' is the curated surface below, never the internal seams.
import { createWorld as _createWorld } from '@ecsia/core'
import type { World as _CoreWorld, EntityRef as _CoreEntityRef, WorldOptions as _WorldOptions, EntityHandle } from '@ecsia/core'

/** The `__`-prefixed wiring seams + scheduler-only loop verbs that PA-1..PA-8 keep off the public surface. */
type WorldInternalSeam =
  | '__setPhase' | '__spawnReserved' | '__apply' | '__installRelations' | '__exportShared'
  | '__serialize' | '__mergeWorkerWrites'
  | 'trackWrite' | 'advanceTick' | 'mergeCorrals' | 'maintainStructural'
  | 'observerDrain' | 'flushLogs' | 'reserveEntityBlock' | 'returnReservedIds' | 'changedRows'

/** The public World facade: the cohesive user surface with every internal `__` seam + loop verb omitted (PA-1..PA-8). */
export interface World extends Omit<_CoreWorld, WorldInternalSeam | 'entity'> {
  /** Resolve the pooled public EntityRef for `handle` (entity-model.md §6.4; the `__`-free view). */
  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRef
}

/** The public EntityRef view: typed read/write split + `handle`, with the `__bind`/resolver wiring seams omitted. */
export interface EntityRef extends Omit<_CoreEntityRef, '__setResolver' | '__bind' | '__archetypeId' | '__row'> {}

export type { WorldPhase } from '@ecsia/core'
export { ConfigError } from '@ecsia/core'

/** The single world constructor (public-api.md §2.1). Returns the frozen PUBLIC World facade (no `__` seams). */
export const createWorld: (options?: _WorldOptions) => World = _createWorld as unknown as (
  options?: _WorldOptions,
) => World
export type {
  WorldOptions,
  ReactivityOptions,
  SchedulerOptions,
  ObserverCadence,
  ChangeTracking,
  WorkerOption,
} from '@ecsia/core'

// ---------------------------------------------------------------------------
// Definitions called at module scope (public-api.md §3)
// ---------------------------------------------------------------------------
// NAMING CONVENTION (define* vs create*): this is intentional and predictable, not arbitrary.
//   • define*  = MODULE-SCOPE definitions — pure descriptors with no world attached. They can live at
//                module top-level and be shared/reused: defineComponent, defineTag, defineSystem.
//   • create*  = WORLD-SCOPED instantiation — they take (or mint) a world and bind runtime state to it:
//                createWorld, createScheduler, createRelations, createSnapshotSerializer, etc.
// Rule of thumb: if it needs a world, it's `create*`; if it's a standalone description, it's `define*`.
// (defineRelation is reached via createRelations(world).defineRelation because the relations runtime
// mints world-scoped synthetic ids — see the §3.3 reconciliation note below.)
export { defineComponent, defineTag } from '@ecsia/core'
export { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from '@ecsia/scheduler'
// NOTE (design latitude, public-api.md §3.3 reconciliation): the M8 relations runtime binds
// `defineRelation` to a world via `createRelations(world).defineRelation(...)` — there is no
// module-scope standalone the way §10's aspirational manifest sketched (the runtime mints world-scoped
// synthetic ids, so a relation def is meaningless without a world). The umbrella therefore re-exports
// the world-attach entry point (`createRelations`) + `Wildcard`; `defineRelation` + `targetOf` are
// reached through the returned Relations API. The frozen spec (public-api.md §3.3/§9.3, §12 Q-PA1) has
// been reconciled to this as-built free-function surface.
import { createRelations as _mkRel2, Wildcard as _Wildcard } from '@ecsia/relations'
import type { WildcardToken as _WildcardToken } from '@ecsia/core'
// The wildcard target sentinel for `rel.Pair(R, Wildcard)`. Re-typed as the schema-level `WildcardToken`
// (the exact type `rel.Pair`'s target parameter accepts) so a user passing the umbrella's `Wildcard`
// into `rel.Pair(...)` type-checks with no cast — the runtime symbol is unchanged.
export const Wildcard: _WildcardToken = _Wildcard as unknown as _WildcardToken
export type { PairAccessor, StorageKind } from '@ecsia/relations'

/** Attach the relations runtime to a world (relations.md §2). Accepts the public World facade. */
export const createRelations: (world: World) => ReturnType<typeof _mkRel2> = ((world: World) =>
  _mkRel2(world as unknown as _CoreWorld)) as (world: World) => ReturnType<typeof _mkRel2>

// ---------------------------------------------------------------------------
// Field tokens (public-api.md §3.1)
// ---------------------------------------------------------------------------
export { vec, vec2, vec3, vec4, staticString, object } from '@ecsia/core'
export type {
  ScalarToken,
  VecToken,
  StaticStringToken,
  ObjectToken,
  FieldToken,
  Schema,
} from '@ecsia/core'

// ---------------------------------------------------------------------------
// Query DSL (public-api.md §4.4)
// ---------------------------------------------------------------------------
export { read, write, has, without, optional, MAX_QUERY_ARITY } from '@ecsia/core'

// ---------------------------------------------------------------------------
// Reactivity / observers (public-api.md §4.6)
// ---------------------------------------------------------------------------
export { onAdd, onRemove, onChange } from '@ecsia/core'

// ---------------------------------------------------------------------------
// Scheduler — the opt-in frame loop over the single-threaded kernel (public-api.md §5, §6)
// ---------------------------------------------------------------------------
import { createScheduler as _mkSched } from '@ecsia/scheduler'
import type { SchedulerHandle as _SchedulerHandle, CreateSchedulerOptions as _CreateSchedulerOptions, SystemDef as _SystemDef } from '@ecsia/scheduler'
export type { SchedulerHandle, CreateSchedulerOptions, SystemDef, SystemContext, OrderingHint } from '@ecsia/scheduler'

/** Build the wave scheduler over a world's systems (public-api.md §5/§6). Accepts the public World facade. */
export const createScheduler: (
  world: World,
  defs: readonly _SystemDef[],
  opts?: _CreateSchedulerOptions,
) => _SchedulerHandle = ((world: World, defs: readonly _SystemDef[], opts?: _CreateSchedulerOptions) =>
  _mkSched(world as unknown as _CoreWorld, defs, opts)) as (
  world: World,
  defs: readonly _SystemDef[],
  opts?: _CreateSchedulerOptions,
) => _SchedulerHandle

// Worker-parallel path (public-api.md §7): the pool + the RoundDispatcher seam updateThreaded drives.
export { WorkerPool } from '@ecsia/scheduler'
export type { PoolConfig, PoolSystem, RoundDispatcher } from '@ecsia/scheduler'

// ---------------------------------------------------------------------------
// Serialization — copy snapshot/delta + zero-copy worker handoff (public-api.md §8). The world-taking
// entry points are wrapped to accept the public World facade (the `__serialize` seam they read stays
// internal — PA-1).
// ---------------------------------------------------------------------------
import {
  createSnapshotSerializer as _mkSnapSer,
  createSnapshotDeserializer as _mkSnapDe,
  createDeltaSerializer as _mkDelta,
  applyDelta as _applyDelta,
  bootstrapForWorker as _bootstrap,
} from '@ecsia/serialization'
export { attachWorld } from '@ecsia/serialization'
import type {
  SnapshotSerializer as _SnapshotSerializer,
  SnapshotDeserializer as _SnapshotDeserializer,
  DeltaSerializer as _DeltaSerializer,
  WorldBootstrap as _WorldBootstrap,
} from '@ecsia/serialization'
export type {
  SnapshotSerializer,
  SnapshotDeserializer,
  DeltaSerializer,
  WorldBootstrap,
} from '@ecsia/serialization'

export const createSnapshotSerializer: (world: World) => _SnapshotSerializer = ((world: World) =>
  _mkSnapSer(world as unknown as _CoreWorld)) as (world: World) => _SnapshotSerializer
export const createSnapshotDeserializer: (world: World) => _SnapshotDeserializer = ((world: World) =>
  _mkSnapDe(world as unknown as _CoreWorld)) as (world: World) => _SnapshotDeserializer
export const createDeltaSerializer: (world: World, sinceTick: number) => _DeltaSerializer = ((
  world: World,
  sinceTick: number,
) => _mkDelta(world as unknown as _CoreWorld, sinceTick)) as (world: World, sinceTick: number) => _DeltaSerializer
export const applyDelta: (
  world: World,
  bytes: Uint8Array,
  remap: ReadonlyMap<EntityHandle, EntityHandle>,
) => number = ((world: World, bytes: Uint8Array, remap: ReadonlyMap<EntityHandle, EntityHandle>) =>
  _applyDelta(world as unknown as _CoreWorld, bytes, remap)) as (
  world: World,
  bytes: Uint8Array,
  remap: ReadonlyMap<EntityHandle, EntityHandle>,
) => number
export const bootstrapForWorker: (world: World) => _WorldBootstrap = ((world: World) =>
  _bootstrap(world as unknown as _CoreWorld)) as (world: World) => _WorldBootstrap

// ---------------------------------------------------------------------------
// Branded types + inference helpers / escape hatch (public-api.md §10)
// ---------------------------------------------------------------------------
export type { Tick } from '@ecsia/schema'
export type { EntityHandle }

// The null-handle sentinel + its predicate, surfaced at the umbrella so a user can discriminate an
// absent handle (returned from e.g. a relation target lookup) without reaching into @ecsia/core or
// hand-rolling the `0xffffffff as EntityHandle` cast. NULL_ENTITY is an alias of NO_ENTITY.
export { NO_ENTITY, NULL_ENTITY, isNoEntity } from '@ecsia/core'
export type {
  EntityIndex,
  ComponentId,
  ComponentDef,
  ComponentOptions,
  RelationDef,
  RelationOptions,
  PairDef,
  WildcardToken,
  ReadView,
  WriteView,
  ReadOf,
  WriteOf,
  SchemaOf,
  Query,
  QueryChunk,
  LooseQuery,
  QueryTerm,
  QueryElement,
  Has,
  HasWrite,
  ObserverHandle,
  ObserverContext,
  ObserverTerm,
  SharedHandleManifest,
} from '@ecsia/core'
// NOTE: `World` and `EntityRef` are the PUBLIC VIEW types declared at the top of this module (the `__`
// seams omitted, PA-1..PA-8) — they are intentionally NOT re-exported from @ecsia/core here.

