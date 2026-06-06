// @ecsia/core — INTERNAL surface. NOT part of the published package (`package.json#exports` maps only
// `.` → index.ts). These are the kernel implementation primitives — store/bitmask/registry/query
// engine/memory backing/reactivity log classes and the low-level schema inference helpers — that this
// package's own tests reach through a RELATIVE import (`../src/internal.js`). They are deliberately
// kept OFF the public `index.ts` so the published surface stays curated.
//
// Cross-package note: the symbols genuinely needed by sibling packages (@ecsia/{relations,
// serialization}) live on the PUBLIC index.ts under an "INTERNAL (cross-package)" banner — they are
// NOT here, because removing them would break those siblings' `@ecsia/core` imports.

export {
  makeHandle,
  handleGeneration,
  CapacityExceeded,
} from './entity/index.js'
export type {
  EntityGeneration,
  HandleStats,
  EntityLocation,
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
  tokenToColumnLayout,
  fieldToColumnLayout,
  stringIndexElement,
  EID_NULL,
} from './memory/index.js'
export type {
  Backing,
  BackingStrategy,
  Region,
  RegionKey,
  RegionOpts,
  ViewHolder,
  BuffersConfig,
  ExportedColumnHandle,
  ExportedRegionHandle,
} from './memory/index.js'

export {
  registerComponentId,
  UNREGISTERED,
  resolveDescriptor,
  makeAccessorFactory,
  bindingsFor,
} from './component/index.js'
export type {
  ComponentRuntime,
  DefKind,
  AccessorWorld,
  AccessorBinding,
  AccessorInstanceBase,
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

export { Reactivity, LogRing, WriteCorral, ChangeVersionStore, ObserverRegistry, OVERFLOW_SENTINEL } from './reactivity/index.js'
export type {
  ReactivityDeps,
  LogPointer,
  ObserverKind,
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
  RowFilterTerm,
  ValueRole,
  Word,
} from './query/index.js'

// Low-level schema inference helpers re-exported through core (not on the curated public surface; the
// umbrella exposes the inference surface it needs directly).
export type {
  ScalarValue,
  FieldValue,
  VecView,
  ReadonlyVecView,
  FieldDescriptor,
  TypedArrayCtor,
  SpawnArg,
  SpawnTuple,
  SpawnArgFor,
  AccessorInstance,
  AccessorFactory,
  TypedArrayLike,
  ColumnBinding,
  ReadTerm,
  WriteTerm,
  HasTerm,
  WithoutTerm,
  OptionalTerm,
  TermElement,
  UnionToIntersection,
  WorldQuery,
  LooseQueryElement,
  CompKey,
} from '@ecsia/schema'
