// The cold-archetype overflow store (archetype-storage.md §10.3). When hotCount reaches
// maxHotArchetypes, new archetypes are marked cold: they have NO dedicated columns; their entities
// live in a shared SoA block keyed per component type (NOT per archetype). Membership still uses
// the per-entity bitmask + signature, so has()/matching/iteration are transparent (§10.3).
//
// M3 ships the cold-path SCAFFOLDING with correctness: per-component blocks allocated lazily via
// Buffers.column, an (entityIndex, componentId) → row map, and an entityIndex → cold ArchetypeId
// map so resolveLocation still yields an ArchetypeId. Relation-driven fragmentation is exercised at
// M8; explicit world.warm promotion is wired here (§10.4).

import type { ComponentId, ComponentDef, Schema } from '@ecsia/schema'
import type { ArchetypeId } from '@ecsia/schema'
import type { Buffers } from '../memory/index.js'
import type { AccessorWorld, ColumnSet } from '../component/index.js'
import { buildColumnSet } from '../component/index.js'
import type { ComponentRuntime } from '../component/index.js'

const COLD_ARCHETYPE_ID = 0xffff_ff00 // synthetic archetype id keying every cold component block

export interface ColdStore {
  /** componentId → a packed SoA block (one ColumnSet per component TYPE, not per archetype). */
  readonly blocks: Map<ComponentId, ColumnSet>
  /** (entityIndex, componentId) → row in that component's block. key = entityIndex * SCALE + componentId. */
  readonly rowOf: Map<number, number>
  /** entityIndex → its cold archetype id (so resolveLocation still yields an ArchetypeId). */
  readonly archOf: Map<number, ArchetypeId>
  /** entityIndex → the full EntityHandle occupying the cold slot (for promotion's hot row list). */
  readonly handleOf: Map<number, number>
  /** Next free row per component block. */
  readonly nextRow: Map<ComponentId, number>
  /** Reclaimed rows per component block, reused before advancing nextRow (prevents leak). */
  readonly freeRows: Map<ComponentId, number[]>
}

const KEY_SCALE = 0x1_0000_0000 // entityIndex occupies the high bits, componentId the low 32

export function makeColdStore(): ColdStore {
  return {
    blocks: new Map(),
    rowOf: new Map(),
    archOf: new Map(),
    handleOf: new Map(),
    nextRow: new Map(),
    freeRows: new Map(),
  }
}

export interface ColdDeps {
  readonly buffers: Buffers
  readonly accessorWorld: AccessorWorld
  readonly initialCapacity: number
  defOf(c: ComponentId): ComponentDef<Schema> | undefined
}

function coldKey(entityIndex: number, componentId: number): number {
  return entityIndex * KEY_SCALE + componentId
}

export function blockFor(cold: ColdStore, c: ComponentId, deps: ColdDeps): ColumnSet | null {
  let block = cold.blocks.get(c)
  if (block !== undefined) return block
  const def = deps.defOf(c)
  if (def === undefined) return null
  const rt = def as ComponentRuntime<Schema>
  if (rt.columnLayouts.length === 0) return null // tag: pure membership, no cold columns
  block = buildColumnSet({
    buffers: deps.buffers,
    archetypeId: COLD_ARCHETYPE_ID,
    def,
    world: deps.accessorWorld,
    initialCapacity: deps.initialCapacity,
  })
  cold.blocks.set(c, block)
  cold.nextRow.set(c, 0)
  return block
}

/** Reserve a cold row for `componentId` under `entityIndex`, growing the block as needed. */
export function coldAllocRow(cold: ColdStore, entityIndex: number, c: ComponentId, deps: ColdDeps): number {
  const block = blockFor(cold, c, deps)
  if (block === null) return -1
  const free = cold.freeRows.get(c)
  const reclaimed = free !== undefined && free.length > 0 ? free.pop() : undefined
  if (reclaimed !== undefined) {
    cold.rowOf.set(coldKey(entityIndex, c as number), reclaimed)
    return reclaimed
  }
  const next = cold.nextRow.get(c) ?? 0
  for (const col of block.columns) {
    if (next + 1 > col.capacity()) deps.buffers.grow(col, next + 1)
  }
  cold.nextRow.set(c, next + 1)
  cold.rowOf.set(coldKey(entityIndex, c as number), next)
  return next
}

/** The cold block row for (entityIndex, componentId), or -1 if absent. */
export function coldRowOf(cold: ColdStore, entityIndex: number, c: ComponentId): number {
  return cold.rowOf.get(coldKey(entityIndex, c as number)) ?? -1
}

/**
 * Reclaim the cold rows this entity holds for the components in `comps`, returning each to its
 * block's free-list. Stale (index,componentId) mappings would otherwise leak monotonically and
 * survive generational index reuse. When `dropEntity` (the entity is leaving the cold store
 * entirely — despawn or promotion to a hot archetype) also drop its archOf/handleOf entries.
 */
export function coldReclaim(
  cold: ColdStore,
  entityIndex: number,
  comps: Iterable<number>,
  dropEntity = true,
): void {
  for (const cn of comps) {
    const c = cn as ComponentId
    const key = coldKey(entityIndex, cn)
    const row = cold.rowOf.get(key)
    if (row === undefined) continue
    cold.rowOf.delete(key)
    let free = cold.freeRows.get(c)
    if (free === undefined) {
      free = []
      cold.freeRows.set(c, free)
    }
    free.push(row)
  }
  if (dropEntity) {
    cold.archOf.delete(entityIndex)
    cold.handleOf.delete(entityIndex)
  }
}

export { COLD_ARCHETYPE_ID, coldKey }
