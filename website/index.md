---
layout: home

hero:
  name: ecsia
  text: A fast, type-safe entity component system for TypeScript
  tagline: Build simulations out of plain data — typed components and queries, links between entities, and automatic multithreading with results identical to a single-threaded run.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Core concepts
      link: /guide/core-concepts
    - theme: alt
      text: API reference
      link: /reference/

features:
  - title: Fast iteration, fully typed
    details: Each component field is stored in its own contiguous array, so loops over thousands of entities walk straight through memory. On top sits a typed API — e.position.x is a number, no casts, no Proxy.
  - title: Multithreading without rewrites
    details: Each system declares what it reads and writes; set threaded:true, point the scheduler at your worker kernels, and await update() — ecsia runs the systems that can't interfere with each other on worker threads, byte-for-byte identical to running on one thread.
  - title: Entities can link to each other
    details: "Parent/child trees, ownership, targeting — links are stored as plain numbers next to your component data, so they're fast to query, survive saving and loading, and work across threads. Cleanup can cascade: despawn a parent and its children go too."
  - title: One import, pay for what you use
    details: "The ecsia package re-exports the whole API — world, components, queries, systems, scheduler, links, saving. Bundlers drop whatever you don't touch."
---

## Status {#status}

::: warning 0.x · unpublished · experimental
ecsia is **feature-complete and API-frozen**, but **not yet published to npm** and pre-1.0. Treat it
as experimental: the surface is frozen and the test suite is green, but the package has not been
released and the API may still shift before 1.0.

- **Not on npm yet** — consume it from the local workspace (see [Getting started](/guide/getting-started)).
- **Node `>=22.13`** — the engine floor. ESM-only, strict TypeScript.
- **Browser multithreading needs two HTTP headers** — threads share memory through
  `SharedArrayBuffer`, which browsers only allow on cross-origin-isolated pages (a server-side
  opt-in via the COOP/COEP headers). Without it, ecsia logs a warning and runs single-threaded —
  never a silent failure.
- **The worker pool is Node-only today** — `worker_threads` + `Atomics`. The same user code runs
  single-threaded everywhere; the OS-thread pool is the Node path.

The numbers on the [Performance](/guide/performance) page are measured, with reproduce
instructions.
:::

## Quick start

If you're new to the pattern: an entity component system (ECS) builds a simulation from
three pieces. An **entity** is just an id. A **component** is typed data attached to an
entity — here, a position and a velocity. A **system** is a function that runs over every
entity that has the components it asks for.

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from '@ecsia/kit'

// Each field ('f32' = 32-bit float) becomes its own typed-array column in memory.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5

const dt = 1 / 60
const Movement = defineSystem({
  name: 'Movement',
  read: [Velocity],   // this system only reads velocities…
  write: [Position],  // …and only writes positions
  run({ query }) {
    for (const e of query(read(Velocity), write(Position))) {
      e.position.x += e.velocity.dx * dt
      e.position.y += e.velocity.dy * dt
    }
  },
})

const scheduler = createScheduler(world, [Movement])
scheduler.update(dt) // run one frame
```

Go parallel without changing your queries or accessors — `threaded: true` gives the
columns shared backings, and the scheduler dispatches worker-eligible systems to a pool
it creates and owns:

```ts
import { createWorld, defineComponent, defineSystem, createScheduler } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], threaded: true, scheduler: { workers: 4 } })

const Move = defineSystem({ name: 'Move', read: [], write: [Position], run() {} })
const scheduler = createScheduler(world, [Move], {
  // Worker threads import their system bodies (kernels) from this module —
  // see the Multithreading guide for the 10-line kernels.js.
  threading: { kernelModule: new URL('./kernels.js', import.meta.url).href },
})

await scheduler.update(1 / 60) // worker rounds dispatch automatically; identical output guaranteed
```

Keep going: [Getting started →](/guide/getting-started)

## Packages

| Package | Role |
|---|---|
| `@ecsia/kit` | the batteries-included umbrella — start here |
| `@ecsia/core` | component storage, typed accessors, queries, change tracking |
| `@ecsia/schema` | component field types and query type inference |
| `@ecsia/scheduler` | works out which systems can run together, and runs them across threads |
| `@ecsia/relations` | entity-to-entity links with fast queries and automatic cleanup |
| `@ecsia/serialization` | snapshots, change payloads, worker bootstrap |
| `@ecsia/three` | three.js bindings (opt-in, not in the umbrella) |
| `@ecsia/devtools` | world inspector and schedule explainer (opt-in) |

`@ecsia/core` is a complete single-threaded ECS on its own; the scheduler, links, and
saving layers plug into it without core knowing about them. `@ecsia/three` and
`@ecsia/devtools` sit at the top of the graph and are deliberately **not** re-exported
from the umbrella.
