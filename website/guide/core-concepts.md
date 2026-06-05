# Core concepts

This page covers the pieces you compose in every ecsia program: the **world**, **components**
(including rich string/object fields), **queries**, **systems**, **phases**, and the one rule that
trips newcomers — the **pooled `EntityRef`**.

## The world

`createWorld` builds the single owner of entity storage. You declare the components it can hold and a
capacity; spawning lands an entity in the archetype for its exact component set.

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(Position, Velocity)
world.has(e, Velocity)   // true
world.isAlive(e)         // true
world.despawn(e)
```

## Components

A component is a **schema of typed fields**. Numeric fields (`'f32'`, `'i32'`, `vec`, …) live in
columns — Structure-of-Arrays — so iteration is cache-friendly and worker-shareable.

```ts
import { defineComponent, vec3 } from 'ecsia'

const Transform = defineComponent(
  { position: vec3(), scale: 'f32' },
  { name: 'transform' },
)
```

### Rich fields: strings and objects

Two field kinds carry **non-numeric** data in a parallel sidecar instead of a TypedArray column:

- `'string'` — an arbitrary JS string.
- `object<T>()` — an arbitrary JS value of type `T`.

You can also pin a closed set of string choices with `staticString(...)`, which **is** numeric (it
stores a small index), so it stays worker-eligible.

```ts
import { defineComponent, object, staticString } from 'ecsia'

const Label = defineComponent(
  {
    text: 'string',                    // rich: arbitrary string (sidecar)
    payload: object<{ note: string }>(), // rich: arbitrary object (sidecar)
    team: staticString('red', 'blue'),   // numeric: a small index, worker-eligible
  },
  { name: 'label' },
)
```

::: tip Rich fields pin a system to the main thread
Any system that touches a `'string'` or `object<T>()` field is **worker-ineligible** — it runs on the
main thread. `staticString` does not pin (it is a numeric index). See
[Parallelism](/guide/parallelism) and [Devtools](/guide/devtools) for how this surfaces.
:::

## Queries

A query selects entities by the components they hold and binds typed accessors. Use `read(C)` / `write(C)`
to declare per-component access; the query yields one `EntityRef` per matched row.

```ts
import { createWorld, defineComponent, read, write } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 1, dy: 2 }])

for (const e of world.query(read(Velocity), write(Position))) {
  e.position.x += e.velocity.dx   // write view is mutable
  e.position.y += e.velocity.dy
  e.velocity.dx                   // read view is deeply readonly (assigning is a TS error)
}
```

Other query terms — `has(C)`, `without(C)`, and `optional(C)` — refine matches without binding (or
optionally bind) accessors.

## Systems

A system is a `run` body plus its declared `{ read, write }` access. The scheduler reads those sets to
order systems; the body iterates queries.

```ts
import { defineComponent, defineSystem, read, write } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const dt = 1 / 60
const Movement = defineSystem({
  name: 'Movement',
  read: [Velocity],
  write: [Position],
  run({ query }) {
    for (const e of query(read(Velocity), write(Position))) {
      e.position.x += e.velocity.dx * dt
      e.position.y += e.velocity.dy * dt
    }
  },
})
```

## Phases: structural mutation is serial-only

`spawn` / `add` / `remove` / `despawn` change archetype membership. ecsia keeps those **serial-phase
only** — legal before `scheduler.update()`, inside a serial system body via `ctx.world`, or inside an
observer handler. A worker-wave system body that tries to mutate structure **throws**.

The idiomatic pattern: collect targets during iteration, mutate after the loop, so you never restructure
the archetype you're walking.

```ts
import { defineComponent, defineSystem, read } from 'ecsia'
import type { EntityHandle } from 'ecsia'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })

const Reaper = defineSystem({
  name: 'Reaper',
  read: [Health],
  write: [],
  run({ world, query }) {
    const dead: EntityHandle[] = []
    for (const e of query(read(Health))) {
      if (e.health.hp <= 0) dead.push(e.handle) // collect first
    }
    for (const h of dead) world.despawn(h)       // mutate after the iteration
  },
})
```

## The pooled `EntityRef` rule

::: danger Read this before you hold two accessors
`world.entity(h)` returns a **pooled** `EntityRef` — the *same* object, rebound to a new row on every
call. Don't hold two live accessors across a `world.entity()` call. Pull the fields you need out first.
:::

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
const a = world.spawnWith([Position, { x: 1, y: 2 }], [Velocity, { dx: 3, dy: 4 }])

const p = world.entity(a).read(Position)
const px = p.x, py = p.y                    // pull values out BEFORE the next resolve
const v = world.entity(a).read(Velocity)    // rebinds the pooled ref — `p` is now stale
const speed = Math.hypot(v.dx, v.dy)
const result = { px, py, speed }
```

A stale read/write **throws** (`stale binding for entity … — re-resolve via world.entity(h)`), so misuse
fails loud instead of silently reading the wrong row.

## Where next

- [Parallelism](/guide/parallelism) — run the same systems across a worker pool, deterministically.
- [Relations](/guide/relations) — first-class `ChildOf`/`Likes`-style pairs with cascade.
- [Reactivity](/guide/reactivity) — observers and changed filters.
