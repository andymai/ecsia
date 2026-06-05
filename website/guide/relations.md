# Relations

Relations are **first-class** in ecsia: integer-encoded pairs stored as real archetype members, not a
side-table of object references. That is what lets them cross a worker boundary (a JS-object pair
identity can't) and query in `O(archetypes)` via a presence bit.

The relations runtime is world-scoped — you reach it through `createRelations(world)`.

## Defining a relation: payload first

`defineRelation` takes **payload first, options second** — `defineRelation(payload | null, options?)`.
Pass `null` for a payload-free relation.

```ts
import { createWorld, defineComponent, createRelations } from 'ecsia'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })

const rel = createRelations(world)
// Payload-free, exclusive parent link. `cascade: 'deleteSubject'` means despawning a PARENT
// (the target) cascades to its CHILDREN (the subjects pointing at it).
const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
```

## Pairs

`addPair(subject, relation, target)` wires a directed pair. For an **exclusive** relation, re-pairing a
subject is an in-place write with **zero migrations**.

```ts
import { createWorld, defineComponent, createRelations } from 'ecsia'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })

const parent = world.spawnWith(Node)
const child = world.spawnWith(Node)

rel.addPair(child, ChildOf, parent)   // exclusive re-parent = in-place write
rel.targetOf(child, ChildOf)          // → parent handle (exclusive only), or null
```

For a non-exclusive relation, a subject can hold many targets; iterate them with `targetsOf` and read
the parent chain depth with `depthOf`:

```ts
import { createWorld, defineComponent, createRelations } from 'ecsia'
import type { EntityHandle } from 'ecsia'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })

const root = world.spawnWith(Node)
const a = world.spawnWith(Node)
rel.addPair(a, ChildOf, root)

let parentHandle: EntityHandle | undefined
for (const t of rel.targetsOf(a, ChildOf)) parentHandle = t
const depth = rel.depthOf(a, ChildOf)   // root = 0
```

## Payloaded relations

The first argument is the payload schema; `addPair` then carries the values.

```ts
import { createWorld, defineComponent, createRelations } from 'ecsia'

const Person = defineComponent({ id: 'i32' }, { name: 'person' })
const world = createWorld({ components: [Person], maxEntities: 1 << 16 })
const rel = createRelations(world)

const Likes = rel.defineRelation({ amount: 'f32' })   // payload-first
const alice = world.spawnWith(Person)
const bob = world.spawnWith(Person)
rel.addPair(alice, Likes, bob, { amount: 0.8 })
```

## Wildcard queries

The pair-term constructor lives on the **relations API** (`rel.Pair`), not the umbrella. `Wildcard`
matches any target via the per-relation presence bit (`O(archetypes)`).

```ts
import { createWorld, defineComponent, createRelations, Wildcard } from 'ecsia'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })

for (const e of world.query(rel.Pair(ChildOf, Wildcard))) {
  e.handle   // a node that has SOME parent
}
```

## Cascade directions

Cascade is declared on the relation and fires when a participant is despawned:

| `cascade` | Despawning a **target** does… |
|---|---|
| `'deleteSubject'` | despawns **every subject** that points at it (parent despawn deletes its children; iterative, so deep chains unwind without recursion) |
| `'removeRelation'` | drops only the dangling pairs, leaving subjects alive |
| `'none'` (default) | drops pairs to the despawned target; nothing cascades |

Despawning a **subject** always just removes its own outgoing pairs — it never deletes its target.

```ts
import { createWorld, defineComponent, createRelations } from 'ecsia'

const Mob = defineComponent({ hp: 'i32' }, { name: 'mob' })
const world = createWorld({ components: [Mob], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

const parent = world.spawnWith(Mob)
const child = world.spawnWith(Mob)
rel.addPair(child, ChildOf, parent)

world.despawn(parent)   // child is cascaded — despawned with its parent
world.isAlive(child)    // false
```

## See also

- The `scene-graph` and `dot-cascade` examples in `examples/` exercise exclusive re-parenting, `depthOf`
  ordering, and the `deleteSubject` cascade end to end.
- [Reactivity](/guide/reactivity) — observe the removals a cascade produces.
