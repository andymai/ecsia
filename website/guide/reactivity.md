# Reactivity

ecsia gives you two complementary ways to react to change: **observers** (push: a handler fires when a
component is added/removed/changed) and **changed filters** (pull: a query that yields only the entities
written this frame). Both are deterministic — they agree across the serial and worker paths.

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

// onRemove(C) fires when C is removed AND when the entity is despawned. Later:
sub.dispose() // unsubscribe
```

`onAdd(C)` / `onChange(C)` build the add/change variants the same way.

### Handlers fire at a deferred serial slot

Observer handlers never run mid-system — not even under workers. They fire at a **deferred serial
slot**, and mutations you make inside a handler stage to a command buffer and apply at that same slot.
That is what keeps reactivity bit-identical between the serial and parallel executors.

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

Chain `.changed()` onto a query to narrow it to the entities **written this frame**, then drain it with
`.eachChanged(...)`. This is the write-log-driven pull side.

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

For a per-entity check against an arbitrary past tick, `world.changedSince(handle, tick)` returns
whether the entity's stamp moved since `tick`. It is the same change-version mechanism the delta
serializer rides.

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
The `.changed()` **filter** (write-log driven) and the `changedSince` **predicate** (change-version
driven) report the **same** set of entities written in a frame, via two disjoint mechanisms — and a
property test asserts they agree. Use whichever fits: the filter for batch iteration, the predicate for
a point check.
:::

## See also

- [Serialization](/guide/serialization) — the version stamps `changedSince` reads also drive the
  version-stamp delta.
- [Relations](/guide/relations) — a `deleteSubject` cascade raises an `onRemove` for every component of
  every cascaded entity, so a death observer counts cascaded children too.
