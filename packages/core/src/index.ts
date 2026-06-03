// @ecsia/core — the single-threaded kernel. M0: world keystone scaffold + reserved-id constants.
export { NO_COMPONENT, FIRST_USER_COMPONENT_ID } from './ids.js'
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
export type { World, WorldPhase, WorldApplySurface } from './world.js'

export {
  makeHandle,
  handleIndex,
  handleGeneration,
  makeHandleLayout,
  NO_ENTITY,
  ARCHETYPE_NONE,
  CapacityExceeded,
  EntityRef,
  reserveEntityBlock,
  returnReservedIds,
} from './entity/index.js'
export type {
  EntityHandle,
  EntityIndex,
  EntityGeneration,
  HandleLayout,
  HandleStats,
  EntityLocation,
  EntityReservation,
  EntityAccessors,
} from './entity/index.js'

export { allocU32 } from './memory/index.js'
export type { AllocU32Options, U32Region } from './memory/index.js'

export {
  Buffers,
  probeCapabilities,
  selectBacking,
  sharedBacking,
  snapshotInto,
  rowSlice,
  columnKey,
  elementCtor,
  elementBytes,
  makeColumnLayout,
  tokenToColumnLayout,
  fieldToColumnLayout,
  stringIndexElement,
  encodeEid,
  decodeEid,
  EID_NULL,
} from './memory/index.js'
export type {
  Backing,
  ColumnKey,
  RegionKey,
  WorkerMode,
  BackingStrategy,
  RuntimeCapabilities,
  Column,
  Region,
  RegionOpts,
  ViewHolder,
  BuffersConfig,
  SharedHandleManifest,
  ExportedColumnHandle,
  ExportedRegionHandle,
  ElementKind,
  TypedArray,
  ColumnLayout,
} from './memory/index.js'

export {
  defineComponent,
  defineTag,
  registerComponentId,
  UNREGISTERED,
  resolveDescriptor,
  makeAccessorFactory,
  bindingsFor,
  buildColumnSet,
  bindAccessorRow,
} from './component/index.js'
export type {
  ComponentRuntime,
  DefKind,
  AccessorWorld,
  AccessorBinding,
  AccessorInstanceBase,
  ColumnSet,
  BuildColumnSetParams,
} from './component/index.js'

export { ComponentRegistry } from './registry.js'

export {
  ArchetypeStore,
  Storage,
  EMPTY_ARCHETYPE_ID,
  canonicalize,
  sigEquals,
  sigHash,
  sigHas,
  sigWithAdded,
  sigWithRemoved,
  buildSigWords,
  signatureMatches,
  makeColdStore,
  coldRowOf,
} from './storage/index.js'
export type {
  Archetype,
  ColdStore,
  Signature,
  MatchTerm,
  RecordSurface,
  StorageDeps,
  StorageConfig,
  DefRegistry,
} from './storage/index.js'

export { Bitmask } from './bitmask/index.js'
export type { PhaseGate } from './bitmask/index.js'

export {
  Reactivity,
  LogRing,
  WriteCorral,
  ChangeVersionStore,
  ObserverRegistry,
  ShapeKind,
  OVERFLOW_SENTINEL,
  onAdd,
  onRemove,
  onChange,
} from './reactivity/index.js'
export type {
  ReactivityDeps,
  LogPointer,
  ObserverKind,
  ObserverHandle,
  ObserverTerm,
  ObserverContext,
  ObserverHandler,
  ObserverDeps,
} from './reactivity/index.js'

export { QueryEngine, LiveQuery, SparseSetU32, compileQuery } from './query/index.js'
export type {
  QueryEngineDeps,
  LiveQueryDeps,
  ReactivityQueryHooks,
  PooledElement,
  CompiledQuery,
  CompiledValueTerm,
  CompileContext,
  ResidualTerm,
  ValueRole,
  Word,
} from './query/index.js'

// Re-export the schema surface so users import tokens/inference from @ecsia/core (the umbrella).
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
  With,
  Without,
  optional,
} from '@ecsia/schema'
export type {
  ScalarToken,
  VecToken,
  StaticStringToken,
  ObjectToken,
  FieldToken,
  ScalarValue,
  FieldValue,
  VecView,
  ReadonlyVecView,
  FieldDescriptor,
  TypedArrayCtor,
  Schema,
  ComponentDef,
  ComponentOptions,
  StorageStrategy,
  ReadView,
  WriteView,
  ReadOf,
  WriteOf,
  SchemaOf,
  AccessorInstance,
  AccessorFactory,
  TypedArrayLike,
  ColumnBinding,
  // query DSL types (queries.md / type-system.md §5–§7)
  QueryTerm,
  ReadTerm,
  WriteTerm,
  WithTerm,
  WithoutTerm,
  OptionalTerm,
  TermElement,
  QueryElement,
  UnionToIntersection,
  Query,
  WorldQuery,
  LooseQueryElement,
  Has,
  HasWrite,
  CompKey,
  RelationDef,
  RelationOptions,
  PairDef,
  WildcardToken,
} from '@ecsia/schema'
