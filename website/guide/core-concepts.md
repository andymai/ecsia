# Core concepts

This page covers the pieces you compose in every ecsia program: the **world**,
**components** (including string/object fields), **queries**, **systems**, when you're
allowed to add and remove things, and the one rule that trips newcomers — the pooled
`EntityRef`.

If you're arriving here first: ecsia is an entity component system (ECS). An **entity**
is just an id, a **component** is typed data attached to an entity, and a **system** is
a function that runs over every entity with a given set of components.

## The world

`createWorld` builds the single owner of all entity data. You declare the components it
can hold and a capacity up front. Inside, ecsia groups entities by which components they
have — every entity with exactly `{Position, Velocity}` lives together in one table.
That group is called an **archetype**, and it's the reason queries don't have to check
entities one by one.

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(Position, Velocity)  // spawn = create an entity
world.has(e, Velocity)   // true
world.isAlive(e)         // true
world.despawn(e)         // despawn = remove it from the world
```

## Components

A component is a **schema of typed fields**. Numeric fields (`'f32'`, `'i32'`, `vec`, …)
are each stored in their own contiguous array — one array of all the `x` values, one of
all the `y` values (a layout called Structure-of-Arrays). Loops walk straight through
memory, which CPUs are very good at, and the same arrays can be shared with worker
threads.

```ts
import { defineComponent, vec3 } from 'ecsia'

const Transform = defineComponent(
  { position: vec3(), scale: 'f32' },
  { name: 'transform' },
)
```

### Rich fields: strings and objects

Two field kinds carry **non-numeric** data. They can't live in a numeric array, so ecsia
stores them in a parallel side store:

- `'string'` — an arbitrary JS string.
- `object<T>()` — an arbitrary JS value of type `T`.

If your strings come from a fixed set of choices, use `staticString(...)` instead — it
stores a small number under the hood, so it keeps all the numeric-storage benefits.

```ts
import { defineComponent, object, staticString } from 'ecsia'

const Label = defineComponent(
  {
    text: 'string',                       // arbitrary string (side store)
    payload: object<{ note: string }>(),  // arbitrary object (side store)
    team: staticString('red', 'blue'),    // stored as a small number
  },
  { name: 'label' },
)
```

::: tip Rich fields keep a system on the main thread
JS strings and objects can't be shared across threads, so any system that touches a
`'string'` or `object<T>()` field always runs on the main thread. `staticString` doesn't
have this restriction (it's a number underneath). See
[Multithreading](/guide/parallelism) and [Devtools](/guide/devtools) for how this
surfaces.
:::

## Queries

A query selects every entity that has the components you ask for, and hands you typed
access to their fields. Wrap each component in `read(C)` or `write(C)` to say what you
intend to do with it — reads come back deeply readonly, writes are mutable.

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

Other query terms — `has(C)`, `without(C)`, and `optional(C)` — refine which entities
match without (or optionally) binding accessors.

For the rare loop that needs every nanosecond, queries also offer a bind-once fast path,
[`bindColumns`](/guide/performance#bind-your-loop-once-bindcolumns) — the
[performance page](/guide/performance) covers it.

## Systems

A system is a `run` body plus its declared `{ read, write }` access. The declaration
isn't busywork: the scheduler uses it to order systems and — when threading is on — to
decide which systems can safely run at the same time.

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

## When you can add and remove things

Changing *what an entity is made of* — `spawn`, `despawn`, adding or removing a
component — is called a **structural change**, and it moves the entity between storage
tables. ecsia only allows structural changes at safe, single-threaded moments: before
`scheduler.update()`, inside a main-thread system body via `ctx.world`, or inside an
observer handler. A system body running on a worker thread that tries one **throws**.

The idiomatic pattern: collect targets while you iterate, mutate after the loop — that
way you never restructure the very table you're walking.

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
`world.entity(h)` doesn't allocate a new object on every call — it returns the *same*
reusable ("pooled") `EntityRef`, re-pointed at whichever entity you asked for. So don't
hold two live accessors across a `world.entity()` call. Pull the values you need out
first.
:::

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
const a = world.spawnWith([Position, { x: 1, y: 2 }], [Velocity, { dx: 3, dy: 4 }])

const p = world.entity(a).read(Position)
const px = p.x, py = p.y                    // pull values out BEFORE the next resolve
const v = world.entity(a).read(Velocity)    // re-points the pooled ref — `p` is now stale
const speed = Math.hypot(v.dx, v.dy)
const result = { px, py, speed }
```

Why pool at all? So that iterating a query allocates nothing — important when a loop
runs sixty times a second over thousands of entities. And misuse fails loud: a stale
read or write **throws** (`stale binding for entity … — re-resolve via world.entity(h)`)
instead of silently reading another entity's data.

## Where next

- [Multithreading](/guide/parallelism) — run the same systems across worker threads,
  with results identical to a single-threaded run.
- [Linking entities](/guide/relations) — parent/child trees and other entity-to-entity
  links, with automatic cleanup.
- [Reacting to changes](/guide/reactivity) — run code when components are added,
  removed, or modified.
