# Getting started

::: warning Not published yet
ecsia is **0.x and unpublished**. There is no `ecsia` on npm to `pnpm add` today — the install
command below is the shape it will take **once published**. Until then, consume it from the local
workspace (see [Use it today](#use-it-today)).
:::

## Requirements

- **Node `>=22.13`** — the engine floor.
- **ESM-only** — `"type": "module"`. ecsia ships no CommonJS build.
- **TypeScript (strict)** — the typed accessors are the point; plain JS works but loses the surface.

## Install (when published)

```ts no-check
pnpm add ecsia   # not yet published — local workspace for now
```

## Use it today {#use-it-today}

Until the package is on npm, work inside the monorepo. Clone it and build the workspace:

```ts no-check
pnpm install
pnpm build              # tsc -b across all packages (strict, ESM, project refs)
pnpm test               # vitest: unit + property (fast-check) + worker + type-level
```

Then write your program against `ecsia` exactly as the snippets here do — every example in
`examples/` (boids, scene-graph, worker-parallel sim, damage-over-time cascade) imports from the
umbrella and runs through the same build.

## Your first world

A world owns entity storage. You register the components it can hold up front; spawning lands an entity
in the archetype for its component set.

```ts
import { createWorld, defineComponent } from 'ecsia'

// Components are schema'd numeric SoA — each field is a typed column in a (optionally shared) TypedArray.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

// Spawn into an archetype, then write fields through a typed accessor — no casts.
const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5
world.entity(e).read(Velocity).dx // typed number; read views are deeply readonly
```

You can also initialise components inline with a **value-carrying spawn**, which writes through the
tracked path in one call:

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(
  [Position, { x: 0, y: 0 }],
  [Velocity, { dx: 5, dy: -3 }],
)
```

## Your first system

A system declares its `{ read, write }` access. The scheduler reads those sets to derive a conflict
DAG; your `run` body iterates a query and mutates columns through accessors.

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 5, dy: -3 }])

const dt = 1 / 60
const Movement = defineSystem({
  name: 'Movement',
  read: [Velocity],
  write: [Position],
  run({ query }) {
    // `e.position.x` is fully typed; iteration uses monomorphic column accessors (no Proxy).
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

- [Core concepts](/guide/core-concepts) — worlds, components (including rich string/object fields),
  queries, systems, phases, and the pooled-ref rule.
- [Parallelism](/guide/parallelism) — `threaded: true`, how waves are derived, and what
  serial-equivalence means.
- [Relations](/guide/relations) · [Reactivity](/guide/reactivity) · [Serialization](/guide/serialization).
