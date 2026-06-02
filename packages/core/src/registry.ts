// The component registry + accessor wiring the world owns (component-schema.md §7; world.md §7
// step 1). Mints dense ComponentIds from FIRST_USER_COMPONENT_ID, wires each def's accessor
// factory, and resolves the read/write accessor singleton for an entity by binding the cached
// (archetype, component) column set's row.
//
// ARCHETYPE-BINDING SEAM (M3): there is no archetype storage yet, so for M2 column sets are keyed
// purely by (archetypeId, componentId) and the entity's archetypeId/row come from its record. M3's
// storage will own column-set lifecycle per real archetype; this resolver's shape is unchanged.

import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/schema'
import { FIRST_USER_COMPONENT_ID } from './ids.js'
import type { Buffers } from './memory/index.js'
import { registerComponentId } from './component/index.js'
import { buildColumnSet, bindAccessorRow } from './component/index.js'
import type { ColumnSet } from './component/index.js'
import type { AccessorWorld } from './component/index.js'
import type { ComponentRuntime } from './component/index.js'
import type { AccessorResolver } from './entity/index.js'

const DEFAULT_COLUMN_CAPACITY = 1024

export class ComponentRegistry implements AccessorResolver {
  readonly #buffers: Buffers
  readonly #world: AccessorWorld
  readonly #initialCapacity: number
  #nextId: number = FIRST_USER_COMPONENT_ID as unknown as number
  readonly #byDef = new Map<ComponentDef<Schema>, ComponentId>()
  // (archetypeId, componentId) → its column set (the M2 binding seam; M3 keys per real archetype).
  readonly #columnSets = new Map<string, ColumnSet>()

  constructor(buffers: Buffers, world: AccessorWorld, initialCapacity = DEFAULT_COLUMN_CAPACITY) {
    this.#buffers = buffers
    this.#world = world
    this.#initialCapacity = initialCapacity
  }

  // §7.2: deterministic dense id assignment in createWorld({ components }) declaration order.
  register(components: readonly ComponentDef<Schema>[]): void {
    for (const def of components) {
      const id = this.#nextId as ComponentId
      this.#nextId += 1
      registerComponentId(def, id)
      this.#byDef.set(def, id)
    }
  }

  idOf(def: ComponentDef<Schema>): ComponentId | undefined {
    return this.#byDef.get(def)
  }

  get nextComponentId(): number {
    return this.#nextId
  }

  #columnSetFor(archetypeId: number, def: ComponentDef<Schema>): ColumnSet {
    const componentId = (def as ComponentRuntime<Schema>).id
    const key = `${archetypeId}:${componentId}`
    let set = this.#columnSets.get(key)
    if (set === undefined) {
      set = buildColumnSet({
        buffers: this.#buffers,
        archetypeId,
        def,
        world: this.#world,
        initialCapacity: this.#initialCapacity,
      })
      this.#columnSets.set(key, set)
    }
    return set
  }

  // The read path and write path resolve to the SAME singleton (I-ACC-3); only the static type
  // differs (Readonly vs mutable), applied at the entity.read/write call boundary.
  resolveRead(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown {
    return this.#resolve(handle, archetypeId, row, def as ComponentDef<Schema>)
  }

  resolveWrite(handle: EntityHandle, archetypeId: number, row: number, def: unknown): unknown {
    return this.#resolve(handle, archetypeId, row, def as ComponentDef<Schema>)
  }

  #resolve(handle: EntityHandle, archetypeId: number, row: number, def: ComponentDef<Schema>): unknown {
    if (this.idOf(def) === undefined) {
      throw new Error(`component '${def.name}' is not registered with this world`)
    }
    const set = this.#columnSetFor(archetypeId, def)
    return bindAccessorRow(set, row, handle)
  }
}
