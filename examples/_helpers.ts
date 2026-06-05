// Typed single-entity accessor helpers. The runtime EntityRef.read/write are intentionally untyped
// (`(def) => unknown`) — the precise per-component view types live on the query-iteration element
// (queries.md). For the one-off `world.entity(h)` reads/writes the examples do at setup + assertion
// time, these thin wrappers recover the inferred ReadView/WriteView so example bodies stay typed
// without scattering `as` casts. They add no mechanism — pure inference recovery over the real API.

import type { World, ComponentDef, Schema, ReadOf, WriteOf, EntityHandle } from '@ecsia/ecsia'

export function wr<C extends ComponentDef<Schema>>(world: World, h: EntityHandle, def: C): WriteOf<C> {
  return world.entity(h).write(def) as WriteOf<C>
}

export function rd<C extends ComponentDef<Schema>>(world: World, h: EntityHandle, def: C): ReadOf<C> {
  return world.entity(h).read(def) as ReadOf<C>
}
