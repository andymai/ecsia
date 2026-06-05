// @ecsia/core — the single-threaded kernel. PUBLIC surface (P0.5 surface diet).
//
// This barrel is split into two sections:
//   • PUBLIC — the documented user/umbrella surface: createWorld + config, component/tag definition,
//     entity sentinels, reactivity observer builders, and the schema token/inference re-exports the
//     umbrella (@ecsia/ecsia) curates.
//   • INTERNAL (cross-package) — kernel seams that sibling packages (@ecsia/{relations,serialization})
//     import via '@ecsia/core'. They are NOT user API, but removing them would break those siblings,
//     so they stay exported here under a clearly-marked banner rather than on a hidden subpath
//     (package.json#exports maps only `.`).
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

export {
  ShapeKind,
  onAdd,
  onRemove,
  onChange,
} from './reactivity/index.js'
export type {
  ObserverHandle,
  ObserverTerm,
  ObserverContext,
} from './reactivity/index.js'

export type { SharedHandleManifest } from './memory/index.js'

// Schema surface re-exported so users import tokens/inference from @ecsia/core (the umbrella).
export {
  vec,
  vec2,
  vec3,
  vec4,
  staticString,
  object,
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
  FieldToken,
  Schema,
  ComponentDef,
  ComponentOptions,
  ReadView,
  WriteView,
  ReadOf,
  WriteOf,
  SchemaOf,
  // query DSL types (queries.md / type-system.md §5–§7)
  QueryTerm,
  QueryElement,
  Query,
  QueryChunk,
  LooseQuery,
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
export type {
  SerializationSurface,
  SerializeArchetype,
  SerializeComponentColumns,
  SerializeComponentMeta,
  SerializePair,
  SerializeRelationProvider,
  SerializeStructuralRecord,
} from './serialize-surface.js'

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

export { buildColumnSet, bindAccessorRow } from './component/index.js'
export type { ColumnSet } from './component/index.js'

export type { StorageStrategy } from '@ecsia/schema'
export type { ResolvedPair } from './query/index.js'
