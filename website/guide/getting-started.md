# Getting started

ecsia is an entity component system (ECS) for TypeScript. If the pattern is new to
you, three words carry the whole thing: an **entity** is just an id — a thing in your
world; a **component** is typed data attached to an entity; a **system** is a function
that runs over every entity that has the components it asks for. This page takes you
from install to your first running simulation.

::: warning Not published yet
ecsia is **0.x and unpublished**. There is no `@ecsia/kit` on npm to `pnpm add` today — the install
command below is the shape it will take **once published**. Until then, consume it from the local
workspace (see [Use it today](#use-it-today)).
:::

## Requirements

- **Node `>=22.13`** — the engine floor.
- **ESM-only** — `"type": "module"`. ecsia ships no CommonJS build.
- **TypeScript (strict)** — the typed API is the point; plain JS works but loses the surface.

## Install (when published)

```sh
pnpm add @ecsia/kit   # not yet published — local workspace for now
```

## Use it today {#use-it-today}

Until the package is on npm, work inside the monorepo. Clone it and build the workspace:

```sh
pnpm install
pnpm build              # compile all packages
pnpm test               # run the full test suite
```

Then write your program against `ecsia` exactly as the snippets here do. The examples in
`examples/` run through the same build: a flock of birds, a parent/child scene hierarchy,
a worker-parallel simulation, and a damage-over-time effect with automatic cleanup. (Most
import from `ecsia`; the devtools and THREE.js tours import their companion packages, the
same way you would.)

## Your first world

A world holds your entities and their data. You tell it up front which components it
can store, then spawn (create) entities with whatever combination of those components
each one needs.

```ts
import { createWorld, defineComponent } from '@ecsia/kit'

// A component is a small schema of typed fields ('f32' = 32-bit float).
// Each field becomes its own contiguous array in memory — that's what makes loops fast.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

// Spawn an entity, then read and write its fields through typed accessors — no casts.
const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5
world.entity(e).read(Velocity).dx // a typed number; read views are deeply readonly
```

Behind the scenes, entities with the same set of components are stored together in one
table (ecsia calls that group an **archetype**) — that's a storage detail you mostly
won't notice, but it's why queries are fast.

You can also set component values right at spawn time, in one call:

```ts
import { createWorld, defineComponent } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(
  [Position, { x: 0, y: 0 }],
  [Velocity, { dx: 5, dy: -3 }],
)
```

## Your first system

A system declares which components it reads and which it writes. That declaration does
real work: it's how the scheduler later figures out which systems can safely run at the
same time. Inside `run`, you iterate a **query** — every entity that has the components
you ask for — and update fields through the same typed accessors.

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 5, dy: -3 }])

const dt = 1 / 60
const Movement = defineSystem({
  name: 'Movement',
  read: [Velocity],   // this system only reads velocities…
  write: [Position],  // …and only writes positions
  run({ query }) {
    // `e.position.x` is fully typed — a number, not a cast.
    for (const e of query(read(Velocity), write(Position))) {
      e.position.x += e.velocity.dx * dt
      e.position.y += e.velocity.dy * dt
    }
  },
})

const scheduler = createScheduler(world, [Movement])
scheduler.update(dt) // run one frame
```

## What's next

- [Core concepts](/guide/core-concepts) — worlds, components (including string/object
  fields), queries, systems, and one rule about entity references you'll want to know
  before writing real code.
- [Multithreading](/guide/parallelism) — turn on `threaded: true`, see what runs where,
  and why the results stay byte-for-byte identical.
- [Linking entities](/guide/relations) · [Reacting to changes](/guide/reactivity) ·
  [Saving and syncing](/guide/serialization).
