# Linking entities

A **relation** links one entity to another — "this node's parent is that node". If you're
new to the pattern: ecsia is an entity component system (ECS), where each thing in your
world is an entity (just an id), its data lives in components (typed pieces of data attached
to entities), and behavior lives in systems (functions that run over every entity with a
given set of components). Relations are how entities point at each other — parent/child
hierarchies, "likes", "targets", anything directional.

Every relation has two ends: the **subject** (the entity doing the pointing) and the
**target** (the entity pointed at). In a parent/child link, the child is the subject and the
parent is the target.

Relations are **first-class** in ecsia: a link is stored as a plain number inside the same
tables that hold component data, not in a side-table of object references. That has two
practical consequences. First, links can cross a worker-thread boundary, and can be saved to
disk — a JS object identity can do neither. Second, wildcard lookups stay fast no matter how
many entities exist: the cost is `O(archetypes)`, where an archetype is the group of
entities that share the exact same set of components — ecsia stores each group as one table.

The relations runtime is world-scoped — you reach it through `createRelations(world)`.

## Defining a relation: payload first

A relation can carry data of its own — its **payload** (the `Likes` relation further down
carries an `amount`). `defineRelation` takes **payload first, options second** —
`defineRelation(payload | null, options?)`. Pass `null` for a payload-free relation.

This example also opts into **cascade** — automatic cleanup of linked entities: despawn a
parent (remove it from the world) and its children go too. More on the directions below.

```ts
import { createWorld, defineComponent, createRelations } from '@ecsia/kit'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })

const rel = createRelations(world)
// Payload-free, exclusive parent link. `cascade: 'deleteSubject'` means despawning a PARENT
// (the target) cascades to its CHILDREN (the subjects pointing at it).
const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
```

## Pairs

A **pair** is one concrete link: `addPair(subject, relation, target)` wires subject →
target. For an **exclusive** relation — one where a subject can have at most one target,
the way a child has one parent — re-pairing a subject is an in-place write, without moving
the entity between tables.

```ts
import { createWorld, defineComponent, createRelations } from '@ecsia/kit'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })

const parent = world.spawnWith(Node)   // spawn = create an entity
const child = world.spawnWith(Node)

rel.addPair(child, ChildOf, parent)   // exclusive re-parent = in-place write
rel.targetOf(child, ChildOf)          // → parent handle (exclusive only), or null
```

For a non-exclusive relation, a subject can hold many targets; iterate them with `targetsOf`
and read the parent chain depth with `depthOf`:

```ts
import { createWorld, defineComponent, createRelations } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'

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
import { createWorld, defineComponent, createRelations } from '@ecsia/kit'

const Person = defineComponent({ id: 'i32' }, { name: 'person' })
const world = createWorld({ components: [Person], maxEntities: 1 << 16 })
const rel = createRelations(world)

const Likes = rel.defineRelation({ amount: 'f32' })   // payload-first
const alice = world.spawnWith(Person)
const bob = world.spawnWith(Person)
rel.addPair(alice, Likes, bob, { amount: 0.8 })
```

## Wildcard queries

A query selects every entity that has a given set of components and hands you typed access
to their fields — and a relation pair can be a query term too. The pair-term constructor
lives on the **relations API** (`rel.Pair`), not the umbrella package. `Wildcard` matches
any target — "every entity that has *some* parent" — and the lookup stays fast no matter how
many entities exist (`O(archetypes)`).

```ts
import { createWorld, defineComponent, createRelations, Wildcard } from '@ecsia/kit'

const Node = defineComponent({ x: 'f32' }, { name: 'node' })
const world = createWorld({ components: [Node], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })

for (const e of world.query(rel.Pair(ChildOf, Wildcard))) {
  e.handle   // a node that has SOME parent
}
```

## Reverse queries

`targetsOf` walks a link forward — "who does this entity point at?". `subjectsOf` walks it
the other way: every entity pointing **at** a given target through a relation. Pass
`Wildcard` as the relation to ask across **all** relations at once — "who points at this
entity via anything?" — which is exactly the question to ask before despawning an entity
that others may depend on. Each subject comes back once, even if it points at the target
through several relations.

Both forms read the same target→subjects index the despawn cascade uses, so the lookup never
scans the world no matter how many entities exist: the typed form is O(1) to the subject set,
the wildcard form is O(R) bucket lookups (R = registered relations). If the loop body mutates
pairs (despawn, `removePair`, exclusive re-target), snapshot first —
`[...rel.subjectsOf(Wildcard, t)]` — then mutate, matching the cascade discipline.

```ts
import { createWorld, defineComponent, createRelations, Wildcard } from '@ecsia/kit'

const Mob = defineComponent({ hp: 'i32' }, { name: 'mob' })
const world = createWorld({ components: [Mob], maxEntities: 1 << 16 })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })
const Targets = rel.defineRelation(null)

const hub = world.spawnWith(Mob)
const child = world.spawnWith(Mob)
const turret = world.spawnWith(Mob)
rel.addPair(child, ChildOf, hub)
rel.addPair(turret, Targets, hub)

for (const s of rel.subjectsOf(ChildOf, hub)) {
  s // child — only ChildOf pointers
}
for (const s of rel.subjectsOf(Wildcard, hub)) {
  s // child AND turret — anyone pointing at hub via anything
}
```

## Cascade directions

Cascade is declared on the relation and fires when a participant is despawned (removed from
the world):

| `cascade` | Despawning a **target** does… |
|---|---|
| `'deleteSubject'` | despawns **every subject** that points at it (parent despawn deletes its children; iterative, so deep chains unwind without recursion) |
| `'removeRelation'` | drops only the dangling pairs, leaving subjects alive |
| `'none'` (default) | drops pairs to the despawned target; nothing cascades |

Despawning a **subject** always just removes its own outgoing pairs — it never deletes its
target.

```ts
import { createWorld, defineComponent, createRelations } from '@ecsia/kit'

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

- The `scene-graph` and `damage-over-time` examples in `examples/` exercise exclusive
  re-parenting, `depthOf` ordering, and the `deleteSubject` cascade end to end.
- [Reacting to changes](/guide/reactivity) — observe the removals a cascade produces.
