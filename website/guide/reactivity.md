# Reacting to changes

ecsia is an entity component system (ECS): each thing in your world is an entity (just an
id), its data lives in components (typed pieces of data attached to entities), and behavior
lives in systems (functions that run over every entity with a given set of components). When
that data changes, you often want to react — sync a render object, log a death, send a
network update. ecsia gives you two complementary tools for that, one push and one pull:

- **Observers** are push: an observer is a callback that fires when a component is added,
  removed, or changed. ecsia calls you when it happens.
- **Changed filters** are pull: a query (which selects every entity that has a given set of
  components and hands you typed access to their fields) narrowed to only the entities
  written this frame. You ask, when you're ready.

Both are deterministic — they report the same events whether the world runs on one thread or
across workers.

## Observers: build a term, then register it

`onAdd` / `onRemove` / `onChange` only **build** an observer term. You **register** it with
`world.observe(term, handler)`, which returns a handle with `dispose()`.

```ts
import { createWorld, defineComponent, onRemove } from 'ecsia'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const world = createWorld({ components: [Health], maxEntities: 1 << 16 })

// (e: EntityRef, ctx: { kind, component, tick }) => void
const sub = world.observe(onRemove(Health), (e, ctx) => {
  console.log(`entity ${e.handle} lost Health at tick ${ctx.tick}`)
})

// onRemove(C) fires when C is removed AND when the entity is despawned
// (removed from the world entirely). Later:
sub.dispose() // unsubscribe
```

`onAdd(C)` / `onChange(C)` build the add/change variants the same way.

### Handlers fire at a deferred serial slot

Observer handlers never run in the middle of a system — not even when systems run on worker
threads. They fire at a **deferred serial slot**: after the systems finish, at a safe point
on the main thread. Mutations you make inside a handler don't apply immediately either —
they stage to a **command buffer** (a queue of changes applied later, at a safe point) and
apply at the next serial flush, the start of the next drain. That deferral is what keeps
reactivity bit-identical between the single-threaded and parallel executors.

```ts
import { createWorld, defineComponent, onAdd, onChange } from 'ecsia'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const world = createWorld({ components: [Health], maxEntities: 1 << 16 })

const added = world.observe(onAdd(Health), (e) => {
  // runs at the deferred serial slot — safe to mutate structure here
})
const changed = world.observe(onChange(Health), (e, ctx) => {
  // ctx.tick is the frame the change landed
})
```

## Changed filters: a query of this-frame writes

Chain `.changed()` onto a query to narrow it to the entities **written this frame**, then
drain it with `.eachChanged(...)`. This is the pull side: ecsia keeps a log of writes, and
the filter reads it.

```ts
import { createWorld, defineComponent, read, write } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], maxEntities: 1 << 16 })
const e = world.spawnWith([Position, { x: 0, y: 0 }])

world.entity(e).write(Position).x = 10

const changedPositions = world.query(read(Position)).changed()
changedPositions.eachChanged((el) => {
  el.position.x   // only entities whose Position was written this frame
})
```

## `changedSince`: a version-stamp predicate

ecsia keeps a **version stamp** per entity — a counter recording when a value last changed.
For a per-entity check against an arbitrary past tick (one step of the simulation),
`world.changedSince(handle, tick)` returns whether the entity's stamp moved since `tick`. It
is the same change-version mechanism the delta serializer rides — the one that emits just
the changes since a known point.

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], maxEntities: 1 << 16 })
const e = world.spawnWith([Position, { x: 0, y: 0 }])

const since = world.currentTick()
world.entity(e).write(Position).x = 5
const moved = world.changedSince(e, since)   // true
```

::: tip Two mechanisms, one set
The `.changed()` **filter** (driven by the write log) and the `changedSince` **predicate**
(driven by version stamps) report the **same** set of entities written in a frame, via two
disjoint mechanisms — and a property test asserts they agree (the suite generates many
random simulations and checks this on every one). Use whichever fits: the filter for batch
iteration, the predicate for a point check.
:::

## See also

- [Saving and syncing](/guide/serialization) — the version stamps `changedSince` reads also
  drive the version-stamp delta.
- [Linking entities](/guide/relations) — a `deleteSubject` cascade (automatic cleanup of
  linked entities: despawn a parent and its children go too) raises an `onRemove` for every
  component of every cascaded entity, so a death observer counts cascaded children too.
