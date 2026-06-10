# @ecsia/relations

Entity-to-entity links for [**ecsia**](https://github.com/andymai/ecsia), an entity
component system (ECS) for TypeScript — entities are ids, components are typed data
attached to them, and systems are functions that run over entities with matching
components.

A relation links one entity to another — "this node's parent is that node".
`@ecsia/relations` stores those links as plain numbers right next to your component
data, which is why they can cross worker threads and be saved along with everything
else. Wildcard queries ("every entity that has any parent") stay fast no matter how
many entities exist. And cleanup can be automatic: despawn a parent and, if you opt
in, its children go too (`deleteSubject` / `removeRelation` / `none`). It attaches to
a world via `createRelations(world)`.

> **Status:** 0.x, API-frozen. New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), which re-exports `createRelations`
> and `Wildcard`. Use `@ecsia/relations` directly only when composing the layers by
> hand.

## Install

```sh
pnpm add @ecsia/relations @ecsia/core
```

## Reverse queries

Every link has two ends: the **subject** (the entity doing the pointing) and the
**target** (the entity pointed at). `subjectsOf` answers the reverse question — "who
points at this entity?" — either for one relation, or across **all** relations at once
by passing `Wildcard` in the relation position:

```ts
import { createWorld } from '@ecsia/core'
import { createRelations, Wildcard } from '@ecsia/relations'

const world = createWorld({ components: [] })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })
const parent = world.spawn()

rel.subjectsOf(ChildOf, parent)    // every child of `parent`
rel.subjectsOf(Wildcard, parent)   // anyone pointing at `parent` via ANY relation
```

The wildcard form is the pre-despawn audit: every entity directly linked to `parent`,
each one once — the first ring a `world.despawn(parent)` would touch. Both forms read
the same target→subjects index the cascade machinery maintains, so the lookup never
scans the world: the typed form is O(1) to the subject set, the wildcard form is O(R)
bucket lookups (R = registered relations).

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Relations guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
