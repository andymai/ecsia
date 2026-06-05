// The component registry the world owns. Mints dense
// ComponentIds from FIRST_USER_COMPONENT_ID in createWorld({ components }) declaration order, wires
// each def's accessor factory, and exposes id↔def lookup. Column-set lifecycle moved to the storage
// module at (each real archetype owns its own ColumnSets); the registry no longer holds a
// (archetypeId, componentId) column cache or act as the accessor resolver.

import type { ComponentDef, ComponentId, Schema } from '@ecsia/schema'
import { FIRST_USER_COMPONENT_ID } from './ids.js'
import { registerComponentId } from './component/index.js'
import type { ComponentRuntime } from './component/index.js'

export class ComponentRegistry {
  #nextId: number = FIRST_USER_COMPONENT_ID as unknown as number
  readonly #byDef = new Map<ComponentDef<Schema>, ComponentId>()
  readonly #byId: ComponentDef<Schema>[] = []

  // The legacy (buffers, world) constructor args are no longer used by the registry (storage owns
  // column-set lifecycle at ); they are accepted and ignored so call sites that only mint ids
  // through `new ComponentRegistry(buffers, world).register(...)` keep compiling.
  constructor(..._legacy: readonly unknown[]) {}

  // Deterministic dense id assignment in createWorld({ components }) declaration order.
  register(components: readonly ComponentDef<Schema>[]): void {
    for (const def of components) {
      const id = this.#nextId as ComponentId
      this.#nextId += 1
      registerComponentId(def, id)
      this.#byDef.set(def, id)
      this.#byId[id as number] = def
    }
  }

  /**
   * Mint the next dense ComponentId WITHOUT binding a def (allocSyntheticComponentId).
   * Pair/presence/overflow ids draw from the SAME dense space as ordinary
   * components so storage, queries, and the bitmask treat them identically. Serial / main-thread.
   */
  allocSyntheticId(): ComponentId {
    const id = this.#nextId as ComponentId
    this.#nextId += 1
    return id
  }

  /**
   * Intern a synthetic ComponentDef (a relation presence/overflow def, or a per-pair def) at an id
   * already minted by `allocSyntheticId`, so `defOf`/`idOf` resolve it and storage can build its
   * ColumnSet. Serial / main-thread; relations is the only caller (the acyclic boundary holds —
   * the world exposes this through a seam, core never imports relations).
   */
  registerSynthetic(def: ComponentDef<Schema>, id: ComponentId): void {
    registerComponentId(def, id)
    this.#byDef.set(def, id)
    this.#byId[id as number] = def
  }

  idOf(def: ComponentDef<Schema>): ComponentId | undefined {
    return this.#byDef.get(def)
  }

  defOf(id: ComponentId): ComponentDef<Schema> | undefined {
    return this.#byId[id as number]
  }

  /**: seeds the bitmask/sigWords fixed stride = ceil(nextComponentId/32) ( C4). */
  get nextComponentId(): number {
    return this.#nextId
  }
}

export type { ComponentRuntime }
