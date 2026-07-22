// @ecsia/core — the single-threaded kernel. PUBLIC surface.
//
// This barrel is split into two sections:
// • PUBLIC — the documented user/umbrella surface: createWorld + config, component/tag definition,
// entity sentinels, reactivity observer builders, and the schema token/inference re-exports the
// umbrella (ecsia) curates.
// • INTERNAL (cross-package) — kernel seams that sibling packages (@ecsia/{relations,serialization})
// import via '@ecsia/core'. They are NOT user API, but removing them would break those siblings,
// so they stay exported here under a clearly-marked banner rather than on a hidden subpath
// (package.json#exports maps only `.`).
//
// The rest of the kernel (store/bitmask/registry/query-engine/memory-backing classes + low-level
// schema helpers) is implementation detail and lives in ./internal.ts — NOT re-exported here. This
// package's own tests reach those through a relative `../src/internal.js` import.

// ===========================================================================
// PUBLIC
// ===========================================================================

export type { ComponentId } from './ids.js'
export { ConfigError, resolveOptions } from './config.js'
export type {
  WorldOptions,
  ResolvedWorldOptions,
  ResolvedReactivityOptions,
  ReactivityOptions,
  SchedulerOptions,
  ObserverCadence,
  ChangeTracking,
  WorkerOption,
} from './config.js'
export { createWorld } from './world.js'
export type { World, WorldPhase } from './world.js'

export { NO_ENTITY, NULL_ENTITY, isNoEntity, EntityRef, handleIndex } from './entity/index.js'
export type { EntityHandle, EntityIndex, HandleLayout } from './entity/index.js'

export {
  defineComponent,
  defineTag,
} from './component/index.js'

export { createStableIndex } from './util/stable-index.js'
export type { StableIndex } from './util/stable-index.js'

export { defineTopic } from './topics/index.js'
export type { TopicDef, TopicEvent, TopicEventInit, TopicFieldValue } from './topics/index.js'

export {
  ShapeKind,
  onAdd,
  onRemove,
  onChange,
  onPairAdded,
  onPairRemoved,
} from './reactivity/index.js'
export type {
  ObserverHandle,
  ObserverTerm,
  ComponentObserverTerm,
  PairObserverTerm,
  PairObserverKind,
  ObserverContext,
} from './reactivity/index.js'

export type { SharedHandleManifest, ColumnGrowthNotice, RegionGrowthNotice, GrowthNotice, ColumnGrowthLog } from './memory/index.js'

// Schema surface re-exported so users import tokens/inference from @ecsia/core (the umbrella).
export {
  vec,
  vec2,
  vec3,
  vec4,
  staticString,
  object,
  field,
  MAX_QUERY_ARITY,
  read,
  write,
  has,
  without,
  optional,
} from '@ecsia/schema'
export type {
  ScalarToken,
  VecToken,
  StaticStringToken,
  ObjectToken,
  RichToken,
  FieldToken,
  FieldSpec,
  FieldValue,
  FieldDefault,
  Schema,
  ComponentDef,
  ComponentOptions,
  ReadView,
  WriteView,
  ReadOf,
  WriteOf,
  SchemaOf,
  // query DSL types
  QueryTerm,
  QueryOptionsTerm,
  QueryElement,
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
  Has,
  HasWrite,
  RelationDef,
  RelationOptions,
  PairDef,
  WildcardToken,
  Tick,
} from '@ecsia/schema'

// ===========================================================================
// INTERNAL (cross-package) — imported by @ecsia/{relations,serialization} via '@ecsia/core'.
// NOT user API; kept here only because those siblings need them and exports map only `.`.
// ===========================================================================

export { NO_COMPONENT, FIRST_USER_COMPONENT_ID } from './ids.js'
export type { WorldApplySurface, RelationsHost } from './world.js'
// @ecsia/scheduler's topic seam: the store class behind `world.__topics`, plus the shared payload
// codec the worker-side OP_PUBLISH encoder reuses (one codec ⇒ byte-identical streams).
export { Topics, buildTopicCodec, TOPIC_HEADER_WORDS, TOPIC_HDR_HEAD_REL, TOPIC_HDR_BASE_REL, TOPIC_HDR_WORDS } from './topics/index.js'
export type { TopicCodec, TopicFieldCodec } from './topics/index.js'
export type {
  SerializationSurface,
  SerializeArchetype,
  SerializeComponentColumns,
  SerializeComponentMeta,
  SerializeRichField,
  SerializePair,
  SerializeRelationProvider,
  SerializeStructuralRecord,
} from './serialize-surface.js'
// / @ecsia/devtools introspection seam (read-only): the FULL archetype census + live-query
// enumeration that __serialize (snapshot-shaped) does not reach. Imported by @ecsia/devtools via '.'.
export type { InspectSurface, InspectArchetype, InspectQuery } from './inspect-surface.js'
// Rollback seam (`world.__installRollback`): the core-private state a handle-stable whole-world
// image must reach. Imported by @ecsia/rollback, which owns the image format + capture/restore.
// TYPE-ONLY on purpose — the mechanism lives in the sibling, so a world that never rolls back
// bundles none of it (opposite handle semantics to `__serialize`; see ./rollback-surface.ts).
export type { RollbackHost } from './rollback-surface.js'
export type { EntityStore, EntityIdentityImage } from './entity/index.js'
export type { Bitmask } from './bitmask/index.js'
export type { ArchetypeStore, Archetype } from './storage/index.js'
export type { ChangeVersionStore } from './reactivity/index.js'
// The leaf column memcpy (@ecsia/rollback's per-archetype capture reads through it).
export { snapshotInto } from './memory/index.js'

export { makeHandleLayout, ARCHETYPE_NONE, reserveEntityBlock, returnReservedIds } from './entity/index.js'
export type { EntityReservation } from './entity/index.js'

export {
  encodeEid,
  decodeEid,
  elementCtor,
  elementBytes,
  makeColumnLayout,
} from './memory/index.js'
export type {
  ColumnKey,
  RegionKey,
  RuntimeCapabilities,
  Column,
  ElementKind,
  TypedArray,
  ColumnLayout,
} from './memory/index.js'

export { buildColumnSet, bindAccessorRow, initColumnSetRow } from './component/index.js'
export type { ColumnSet } from './component/index.js'

export type { StorageStrategy } from '@ecsia/schema'
export type { ResolvedPair } from './query/index.js'

// INTERNAL (cross-package): portable dev-mode flag
export { IS_DEV } from './env.js'
