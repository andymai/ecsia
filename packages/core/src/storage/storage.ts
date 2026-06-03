// The storage facade (archetype-storage.md): ties the entity record + the per-entity bitmask + the
// ArchetypeStore into the world's structural-verb surface and the accessor-resolution path. It is
// the AccessorResolver the pooled EntityRef calls (resolveRead/resolveWrite) — resolving the
// (archetype, component) ColumnSet from the entity's REAL archetype now, replacing the M2 seam that
// keyed column sets purely by (archetypeId, componentId) on the registry.
//
// All structural verbs run serial / main-thread (Must-Fix #1). In the single-thread executor
// world.phase stays 'serial' permanently, so every op takes the synchronous direct-apply path
// (world.md §4.3).

import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/schema'
import { bindAccessorRow } from '../component/index.js'
import type { AccessorWorld, ColumnSet, ComponentRuntime } from '../component/index.js'
import type { Bitmask } from '../bitmask/index.js'
import { ArchetypeStore, EMPTY_ARCHETYPE_ID } from './store.js'
import type { RecordSurface, StorageDeps } from './store.js'
import type { Archetype } from './archetype.js'
import { coldRowOf } from './cold-store.js'
import { canonicalize } from './signature.js'
import type { Signature } from './signature.js'

export interface DefRegistry {
  idOf(def: ComponentDef<Schema>): ComponentId | undefined
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
}

export interface StorageConfig {
  readonly buffers: StorageDeps['buffers']
  readonly accessorWorld: AccessorWorld
  readonly bitmask: Bitmask
  readonly record: RecordSurface
  readonly registry: DefRegistry
  readonly maxHotArchetypes: number
  readonly stride: number
  readonly maxEntities: number
  enqueueRemoveLog(index: number, c: ComponentId): void
  tick(): number
  handleIndex(handle: EntityHandle): number
}

export class Storage {
  readonly archetypes: ArchetypeStore
  readonly #cfg: StorageConfig

  constructor(cfg: StorageConfig) {
    this.#cfg = cfg
    this.archetypes = new ArchetypeStore({
      buffers: cfg.buffers,
      accessorWorld: cfg.accessorWorld,
      bitmask: cfg.bitmask,
      record: cfg.record,
      maxHotArchetypes: cfg.maxHotArchetypes,
      stride: cfg.stride,
      maxEntities: cfg.maxEntities,
      enqueueRemoveLog: cfg.enqueueRemoveLog,
      tick: cfg.tick,
      defOf: (c) => cfg.registry.defOf(c),
      handleIndex: (h) => cfg.handleIndex(h as EntityHandle),
    })
  }

  // --- entity lifecycle hooks (driven by EntityStore.spawn/despawn) ----------

  onSpawn(handle: EntityHandle): void {
    const index = this.#cfg.handleIndex(handle)
    const empty = this.archetypes.emptyArchetype
    const row = this.archetypes.allocRow(empty, handle as number)
    this.#cfg.record.commitRecord(index, EMPTY_ARCHETYPE_ID as number, row)
    // Empty signature → no bits set; bitmaskApplyDelta from empty to empty is a no-op but keeps the
    // coherence discipline explicit.
    this.#cfg.bitmask.bitmaskApplyDelta(index, empty.signature, empty.signature)
  }

  onDespawn(handle: EntityHandle): void {
    const index = this.#cfg.handleIndex(handle)
    const archId = this.#cfg.record.archetypeIdOf(index)
    const arch = this.archetypes.byId[archId] as Archetype
    // Removal reactivity for every held component, BEFORE the row is reclaimed (§6.3 step 2).
    for (let i = 0; i < arch.signature.length; i++) {
      this.#cfg.enqueueRemoveLog(index, arch.signature[i] as number as ComponentId)
    }
    const row = this.#cfg.record.rowOf(index)
    this.archetypes.removeRow(arch, row, (movedIndex, newRow) => {
      this.#cfg.record.commitRecord(movedIndex, archId, newRow)
    })
    this.#cfg.bitmask.bitmaskClear(index)
  }

  // --- structural verbs ------------------------------------------------------

  add(handle: EntityHandle, def: ComponentDef<Schema>): void {
    const id = this.#requireId(def)
    this.archetypes.migrateAdding(handle as number, id)
  }

  remove(handle: EntityHandle, def: ComponentDef<Schema>): void {
    const id = this.#requireId(def)
    this.archetypes.migrateRemoving(handle as number, id)
  }

  spawnWith(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void {
    for (const d of defs) this.#requireId(d)
    this.archetypes.spawnWith(handle as number, defs)
  }

  /** Atomic multi-id add — ONE migration to a single target signature (§5.6a; relations P1 path). */
  addMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void {
    const ids: ComponentId[] = []
    for (const d of defs) ids.push(this.#requireId(d))
    this.archetypes.migrateAddingMany(handle as number, ids)
  }

  /** Atomic multi-id remove — symmetric to addMany (§5.6a). */
  removeMany(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void {
    const ids: ComponentId[] = []
    for (const d of defs) ids.push(this.#requireId(d))
    this.archetypes.migrateRemovingMany(handle as number, ids)
  }

  warm(defs: readonly ComponentDef<Schema>[]): void {
    const ids: number[] = []
    for (const d of defs) ids.push(this.#requireId(d) as number)
    this.archetypes.warm(canonicalize(ids) as Signature)
  }

  /**
   * §6.4 membership point-test. The caller has already checked liveness (has() never reads the
   * bitmask for a dead handle); this asserts world.phase === 'serial' inside bitmaskHas (BM-1).
   */
  has(handle: EntityHandle, def: ComponentDef<Schema>): boolean {
    const id = this.#requireId(def)
    return this.#cfg.bitmask.bitmaskHas(this.#cfg.handleIndex(handle), id)
  }

  // --- AccessorResolver (entity-model.md §6.4) -------------------------------

  resolveRead(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown {
    return this.#resolve(handle, archetypeId, row, def as ComponentDef<Schema>)
  }

  resolveWrite(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown {
    return this.#resolve(handle, archetypeId, row, def as ComponentDef<Schema>)
  }

  #resolve(handle: EntityHandle, archetypeId: number, row: number, def: ComponentDef<Schema>): unknown {
    const id = this.#requireId(def)
    const arch = this.archetypes.byId[archetypeId] as Archetype | undefined
    if (arch === undefined) throw new Error(`storage.resolve: unknown archetype ${archetypeId}`)
    let set: ColumnSet | undefined
    let boundRow = row
    if (arch.cold) {
      set = this.archetypes.cold.blocks.get(id)
      boundRow = coldRowOf(this.archetypes.cold, this.#cfg.handleIndex(handle), id)
    } else {
      set = arch.columnSets.get(id)
    }
    if (set === undefined) {
      const rt = def as ComponentRuntime<Schema>
      if (rt.columnLayouts.length === 0) {
        throw new Error(`storage.resolve: component '${def.name}' is a tag (no fields to read/write)`)
      }
      throw new Error(`storage.resolve: entity does not hold component '${def.name}'`)
    }
    return bindAccessorRow(set, boundRow, handle)
  }

  #requireId(def: ComponentDef<Schema>): ComponentId {
    const id = this.#cfg.registry.idOf(def)
    if (id === undefined) throw new Error(`component '${def.name}' is not registered with this world`)
    return id
  }
}
