// ecsia — the batteries-included umbrella. Frozen at.
//
// This module owns no runtime mechanism: it is the curated assembly + re-export layer over
// @ecsia/{schema,core,relations,scheduler,serialization}. A consumer imports the whole cohesive
// surface from here — world/entity/component/query/relations/scheduler/serialization.
//
// TREE-SHAKING: every line below is a static `export ... from`. There is
// NO eager side-effecting glue at module scope, so a single-threaded bundle that only touches
// createWorld/query/accessors never pulls in @ecsia/scheduler's worker code or @ecsia/serialization —
// the bundler drops the untouched re-exports. The thin convenience helpers (see "Convenience wiring" below)
// are likewise plain re-exported functions, so they only cost what the caller actually references.

// ---------------------------------------------------------------------------
// World — the single constructor + its frozen PUBLIC facade (..8)
// ---------------------------------------------------------------------------
// The core `World`/`EntityRef` types carry `__`-prefixed wiring seams (scheduler/serialization/relations
// attach points) plus scheduler-only frame-loop verbs. .. require those seams stay NON-public.
// The umbrella therefore re-exports a PUBLIC VIEW that omits them — the only `World`/`EntityRef` a
// consumer ever sees through 'ecsia' is the curated surface below, never the internal seams.
import { createWorld as _createWorld } from '@ecsia/core'
import type { World as _CoreWorld, EntityRef as _CoreEntityRef, WorldOptions as _WorldOptions, EntityHandle } from '@ecsia/core'

/** The `__`-prefixed wiring seams + scheduler-only loop verbs that .. keep off the public surface. */
type WorldInternalSeam =
  | '__setPhase' | '__spawnReserved' | '__apply' | '__installRelations' | '__exportShared'
  | '__serialize' | '__mergeWorkerWrites' | '__topics'
  | 'trackWrite' | 'advanceTick' | 'mergeCorrals' | 'maintainStructural'
  | 'observerDrain' | 'flushLogs' | 'reserveEntityBlock' | 'returnReservedIds' | 'changedRows'

/** The public World facade: the cohesive user surface with every internal `__` seam + loop verb omitted (..). */
export interface World extends Omit<_CoreWorld, WorldInternalSeam | 'entity'> {
  /** Resolve the pooled public EntityRef for `handle` (the `__`-free view). */
  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRef
}

/** The public EntityRef view: typed read/write split + `handle`, with the `__bind`/resolver wiring seams omitted. */
export interface EntityRef extends Omit<_CoreEntityRef, '__setResolver' | '__bind' | '__archetypeId' | '__row'> {}

export type { WorldPhase } from '@ecsia/core'
export { ConfigError } from '@ecsia/core'

/** The single world constructor. Returns the frozen PUBLIC World facade (no `__` seams). */
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
// Definitions called at module scope
// ---------------------------------------------------------------------------
// NAMING CONVENTION (define* vs create*): this is intentional and predictable, not arbitrary.
// • define* = MODULE-SCOPE definitions — pure descriptors with no world attached. They can live at
// module top-level and be shared/reused: defineComponent, defineTag, defineSystem.
// • create* = WORLD-SCOPED instantiation — they take (or mint) a world and bind runtime state to it:
// createWorld, createScheduler, createRelations, createSnapshotSerializer, etc.
// Rule of thumb: if it needs a world, it's `create*`; if it's a standalone description, it's `define*`.
// (defineRelation is reached via createRelations(world).defineRelation because the relations runtime
// mints world-scoped synthetic ids — see the )
export { defineComponent, defineTag } from '@ecsia/core'
// Topics — typed inter-system event queues. defineTopic is a module-scope definition like
// defineComponent; systems declare interest via the publish:/consume: keys on defineSystem, and
// code outside systems publishes between frames via world.publish.
export { defineTopic } from '@ecsia/core'
export type { TopicDef, TopicEvent, TopicEventInit, TopicFieldValue } from '@ecsia/core'
export { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from '@ecsia/scheduler'
// NOTE (design latitude): the relations runtime binds
// `defineRelation` to a world via `createRelations(world).defineRelation(...)` — there is no
// module-scope standalone the way 's aspirational manifest sketched (the runtime mints world-scoped
// synthetic ids, so a relation def is meaningless without a world). The umbrella therefore re-exports
// the world-attach entry point (`createRelations`) + `Wildcard`; `defineRelation` + `targetOf` are
// reached through the returned Relations API. The frozen spec has
// been reconciled to this as-built free-function surface.
import { createRelations as _mkRel2, Wildcard as _Wildcard } from '@ecsia/relations'
import type { WildcardToken as _WildcardToken } from '@ecsia/core'
// The wildcard target sentinel for `rel.Pair(R, Wildcard)`. Re-typed as the schema-level `WildcardToken`
// (the exact type `rel.Pair`'s target parameter accepts) so a user passing the umbrella's `Wildcard`
// into `rel.Pair(...)` type-checks with no cast — the runtime symbol is unchanged.
export const Wildcard: _WildcardToken = _Wildcard as unknown as _WildcardToken
export type { DefinePrefabOptions, PairAccessor, StorageKind } from '@ecsia/relations'
// Prefabs (createWorld({ prefabs: true })): the `Prefab` tag and `IsA` relation are PER-WORLD
// built-ins (a ComponentDef registers to exactly one world; a RelationDef's id is world-scoped),
// so they ride the relations surface — `const { definePrefab, spawnFrom, IsA, Prefab } =
// createRelations(world)` — exactly like defineRelation (see the design-latitude note above).

/** Attach the relations runtime to a world. Accepts the public World facade. */
export const createRelations: (world: World) => ReturnType<typeof _mkRel2> = ((world: World) =>
  _mkRel2(world as unknown as _CoreWorld)) as (world: World) => ReturnType<typeof _mkRel2>

// ---------------------------------------------------------------------------
// Field tokens
// ---------------------------------------------------------------------------
export { vec, vec2, vec3, vec4, staticString, object, field } from '@ecsia/core'
export type {
  ScalarToken,
  VecToken,
  StaticStringToken,
  ObjectToken,
  RichToken,
  FieldToken,
  FieldSpec,
  FieldValue,
  Schema,
} from '@ecsia/core'

// ---------------------------------------------------------------------------
// Query DSL
// ---------------------------------------------------------------------------
export { read, write, has, without, optional, MAX_QUERY_ARITY } from '@ecsia/core'

// ---------------------------------------------------------------------------
// Reactivity / observers
// ---------------------------------------------------------------------------
export { onAdd, onRemove, onChange } from '@ecsia/core'

// ---------------------------------------------------------------------------
// Stable IDs — id→entity index built on observers, re-exported from the umbrella.
// ---------------------------------------------------------------------------
import { createStableIndex as _createStableIndex } from '@ecsia/core'
import type { ComponentDef as _ComponentDef, Schema as _Schema, SchemaOf as _SchemaOf, FieldValue as _FieldValue } from '@ecsia/core'
export type { StableIndex } from '@ecsia/core'
/** Build a world-level `idField → entity` index over a stable-id-carrying component. */
export const createStableIndex: <C extends _ComponentDef<_Schema>, F extends keyof _SchemaOf<C> & string>(
  world: World,
  component: C,
  idField: F,
) => import('@ecsia/core').StableIndex<_FieldValue<_SchemaOf<C>[F]>> = _createStableIndex as never

// ---------------------------------------------------------------------------
// Scheduler — the opt-in frame loop over the single-threaded kernel
// ---------------------------------------------------------------------------
import { createScheduler as _mkSched } from '@ecsia/scheduler'
import type { SchedulerHandle as _SchedulerHandle, CreateSchedulerOptions as _CreateSchedulerOptions, SystemDef as _SystemDef } from '@ecsia/scheduler'
export type { SchedulerHandle, CreateSchedulerOptions, SystemDef, SystemContext, OrderingHint } from '@ecsia/scheduler'

/** Build the wave scheduler over a world's systems. Accepts the public World facade. */
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

// Worker-parallel path: the pool + the RoundDispatcher seam updateThreaded drives.
export { WorkerPool } from '@ecsia/scheduler'
export type { PoolConfig, PoolSystem, RoundDispatcher } from '@ecsia/scheduler'

// ---------------------------------------------------------------------------
// Serialization — copy snapshot/delta + zero-copy worker handoff. The world-taking
// entry points are wrapped to accept the public World facade (the `__serialize` seam they read stays
// internal — ).
// ---------------------------------------------------------------------------
import {
  createSnapshotSerializer as _mkSnapSer,
  createSnapshotDeserializer as _mkSnapDe,
  createDeltaSerializer as _mkDelta,
  applyDelta as _applyDelta,
  bootstrapForWorker as _bootstrap,
  createReplicationStream as _mkRepStream,
  createReplicationReceiver as _mkRepReceiver,
} from '@ecsia/serialization'
export { attachWorld, encodeReplicationMessage, decodeReplicationMessage } from '@ecsia/serialization'
import type {
  SnapshotSerializer as _SnapshotSerializer,
  SnapshotDeserializer as _SnapshotDeserializer,
  DeltaSerializer as _DeltaSerializer,
  WorldBootstrap as _WorldBootstrap,
  ReplicationStream as _ReplicationStream,
  ReplicationStreamOptions as _ReplicationStreamOptions,
  ReplicationReceiver as _ReplicationReceiver,
} from '@ecsia/serialization'
export type {
  SnapshotSerializer,
  SnapshotDeserializer,
  DeltaSerializer,
  WorldBootstrap,
  ReplicationMessage,
  ReplicationStream,
  ReplicationStreamOptions,
  ReplicationReceiver,
  ReplicationApplyResult,
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
export const createReplicationStream: (world: World, opts?: _ReplicationStreamOptions) => _ReplicationStream = ((
  world: World,
  opts?: _ReplicationStreamOptions,
) => _mkRepStream(world as unknown as _CoreWorld, opts)) as (
  world: World,
  opts?: _ReplicationStreamOptions,
) => _ReplicationStream
export const createReplicationReceiver: (world: World) => _ReplicationReceiver = ((world: World) =>
  _mkRepReceiver(world as unknown as _CoreWorld)) as (world: World) => _ReplicationReceiver

// ---------------------------------------------------------------------------
// Branded types + inference helpers / escape hatch
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
  ColumnSpec,
  ColumnSpecFor,
  ColumnFieldName,
  ColumnViewOf,
  ColumnViews,
  BoundColumnsMeta,
  DerivedQuery,
  QueryTerm,
  QueryOptionsTerm,
  QueryElement,
  Has,
  HasWrite,
  ObserverHandle,
  ObserverContext,
  ObserverTerm,
  SharedHandleManifest,
} from '@ecsia/core'
// NOTE: `World` and `EntityRef` are the PUBLIC VIEW types declared at the top of this module (the `__`
// seams omitted, ..) — they are intentionally NOT re-exported from @ecsia/core here.

