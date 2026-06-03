// The internal seam @ecsia/serialization (M10) reads/writes through, exposed on World as `__serialize`.
// Keeps the dependency direction acyclic: serialization imports @ecsia/core for this surface; core
// NEVER imports serialization. Everything here is serial / main-thread (snapshots run at a flush
// point, serialization.md §4.3 / §12). The world wires a concrete implementation in createWorld.

import type { ComponentId, EntityHandle, FieldDescriptor, RelationId, StorageStrategy } from '@ecsia/schema'
import type { Column, RuntimeCapabilities } from './memory/index.js'

/** One column-bearing component's columns on a hot archetype, with its field descriptors. */
export interface SerializeComponentColumns {
  readonly componentId: ComponentId
  /** One Column per column-backed field (object fields contribute no column). */
  readonly columns: readonly Column[]
  /** The resolved field descriptors for the column-backed fields (parallel to `columns`). */
  readonly fields: readonly FieldDescriptor[]
}

/** A hot archetype's serializable view: identity, signature, occupants, and column-bearing members. */
export interface SerializeArchetype {
  readonly id: number
  /** The sorted canonical signature (ComponentIds, including tag/pair/presence ids). */
  readonly signature: readonly number[]
  readonly count: number
  /** rows[r] = the FULL EntityHandle occupying row r (memory-buffers §3.5). */
  readonly rows: Uint32Array
  /** Column-bearing components only (tags skipped — serialization.md §4.5). */
  readonly components: readonly SerializeComponentColumns[]
}

/** Component-registry metadata for the snapshot registry section (serialization.md §4.1). */
export interface SerializeComponentMeta {
  readonly name: string
  readonly id: ComponentId
  readonly fieldCount: number
  readonly storage: StorageStrategy
}

/** One logical live relation pair (serialization.md §4.6 / §8.3 — never the synthetic pair id). */
export interface SerializePair {
  readonly subject: EntityHandle
  readonly relationId: RelationId
  /** The target handle, or null for a cleared exclusive target. */
  readonly target: EntityHandle | null
  /** Payload field values keyed by field name, or undefined for tag relations. */
  readonly payload: Record<string, unknown> | undefined
}

/** Relation metadata + live-pair enumeration + re-apply, provided by @ecsia/relations (M8 seam). */
export interface SerializeRelationProvider {
  /** Dense relation metadata, in registration (relationId-ascending) order. */
  relations(): readonly {
    readonly name: string
    readonly id: RelationId
    readonly exclusive: boolean
    readonly hasPayload: boolean
    readonly presenceId: ComponentId
  }[]
  /** Every live pair across all relations, in deterministic (relationId, subject, target) order. */
  livePairs(): readonly SerializePair[]
  /** Re-establish a pair on deserialize (re-mints the receiver-local pair id, serialization.md §8.3). */
  addPair(subject: EntityHandle, relationId: RelationId, target: EntityHandle | null, payload: Record<string, unknown> | undefined): void
}

/** The full surface @ecsia/serialization drives. All members are serial / main-thread. */
export interface SerializationSurface {
  /** FNV-1a hash of the canonical (componentName, fieldName, token)* + relation names (§3.2). */
  schemaHash(): number
  /** Registry component metadata in dense-id order (real user components only; not synthetic). */
  components(): readonly SerializeComponentMeta[]
  /** A registered component's resolved field descriptors (for payload encode/decode by name). */
  fieldsOf(id: ComponentId): readonly FieldDescriptor[] | undefined
  /** Resolve a component id by registered name (deserialize id-remap-by-name, §5.2). */
  componentIdByName(name: string): ComponentId | undefined
  /** Number of registered component types at snapshot time (sanity check, §3.2). */
  numComponentTypes(): number

  /** Hot archetypes with >=1 row, in id-ascending order (serialization.md §4.3 determinism). */
  archetypes(): readonly SerializeArchetype[]

  /** Relation provider, or undefined in a relation-free world. */
  relations(): SerializeRelationProvider | undefined

  // --- deserialize-side world construction (serialization.md §5) ---
  /** Spawn a fresh entity (PASS 1 remap-table build, §5.3). */
  spawn(): EntityHandle
  /** Place a live handle into the target signature in ONE migration (§5.3 PASS 1b). */
  spawnInto(handle: EntityHandle, componentIds: readonly ComponentId[]): void
  /** The (hot) ColumnSet columns + row for `componentId` on `handle`, or null if absent/cold/tag. */
  columnsOf(handle: EntityHandle, componentId: ComponentId): { columns: readonly Column[]; fields: readonly FieldDescriptor[]; row: number } | null
  /** Despawn every alive entity (mode:'replace' precondition, §5.6 / world.clear). */
  clearAll(): void
  /** Count of currently-alive entities (mode:'replace' empty-check). */
  aliveCount(): number

  readonly indexBits: number
  handleIndex(handle: EntityHandle): number
  /** Frozen runtime capabilities (memory-buffers §4.1) for the worker bootstrap manifest (§3.1). */
  capabilities(): RuntimeCapabilities
}
