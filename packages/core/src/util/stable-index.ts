// createStableIndex — a tiny core util mapping a user-meaningful stable id (typically a 'string' rich
// field) to the entity currently holding it. Built on world.observe(onAdd/onRemove);
// ids are NOT baked into entity identity. The index rebuilds itself after a snapshot load because the
// deserialize path re-adds components, firing onAdd for every re-created entity.
//
// onRemove fires at observerDrain AFTER the entity is despawned + its index generation bumped. A RICH
// id field stays readable there through the generation-stamped pending-clear window (RF-REMOVE-READ),
// but a NUMERIC id field's row may already be reused, so the byIndex cache (populated at onAdd) keeps
// the util uniform across field kinds without depending on that window. The cache is keyed by entity
// INDEX (generation-stripped), because the handle an onRemove observer sees carries the dying
// generation when a rich pending window covers the index but the bumped one otherwise — neither is
// safe to compare against the onAdd handle.

import type { ComponentDef, EntityHandle, FieldValue, Schema, SchemaOf } from '@ecsia/schema'
import { onAdd, onRemove } from '../reactivity/index.js'

interface StableIndexWorld {
  observe(
    term: ReturnType<typeof onAdd>,
    handler: (e: { handle: EntityHandle; read(def: unknown): unknown }) => void,
  ): { dispose(): void }
  decodeHandle(handle: EntityHandle): { index: number }
}

export interface StableIndex<K> {
  /** The entity currently holding stable id `k`, or undefined. */
  get(k: K): EntityHandle | undefined
  /** Does some live entity hold `k`? */
  has(k: K): boolean
  /** Stop observing and clear the index. */
  dispose(): void
}

/**
 * Build a world-level `idField → entity` index over a component carrying a stable id field. Maintained
 * via onAdd/onRemove: when the component is added, its id field is read and the entity recorded; when
 * removed (or the entity despawned), the mapping is dropped. Last writer wins on collision.
 */
export function createStableIndex<C extends ComponentDef<Schema>, F extends keyof SchemaOf<C> & string>(
  world: StableIndexWorld,
  component: C,
  idField: F,
): StableIndex<FieldValue<SchemaOf<C>[F]>> {
  type K = FieldValue<SchemaOf<C>[F]>
  const map = new Map<K, EntityHandle>()
  const byIndex = new Map<number, K>()
  const indexOf = (h: EntityHandle): number => world.decodeHandle(h).index

  const add = world.observe(onAdd(component), (e) => {
    const id = (e.read(component) as Record<string, unknown>)[idField] as K
    map.set(id, e.handle)
    byIndex.set(indexOf(e.handle), id)
  })
  const remove = world.observe(onRemove(component) as ReturnType<typeof onAdd>, (e) => {
    // The handle here may carry either the dying or the bumped generation (see header), so it cannot be
    // compared with the handle onAdd stored. Disambiguate by entity INDEX: only drop the mapping if it
    // still points at this index (a re-add at the same index under a new id must not be clobbered by the
    // prior tenant's removal).
    const idx = indexOf(e.handle)
    const id = byIndex.get(idx)
    if (id !== undefined) {
      const current = map.get(id)
      if (current !== undefined && indexOf(current) === idx) map.delete(id)
    }
    byIndex.delete(idx)
  })

  return {
    get: (k) => map.get(k),
    has: (k) => map.has(k),
    dispose: () => {
      add.dispose()
      remove.dispose()
      map.clear()
      byIndex.clear()
    },
  }
}
