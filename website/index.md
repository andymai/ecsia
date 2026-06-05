---
layout: home

hero:
  name: ecsia
  text: Fast, type-safe ECS for TypeScript
  tagline: Typed components and queries, first-class entity relationships, and automatic multithreading — with results identical to a single-threaded run.
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
  - title: SoA iteration, no Proxy
    details: Components are schema'd numeric columns in (optionally shared) TypedArrays. Iteration uses monomorphic column accessors — e.position.x is fully typed, no casts, no Proxy.
  - title: Auto-parallel, deterministic
    details: threaded:true changes no system, query, or accessor code. The scheduler derives a conflict DAG and splits each wave's disjoint-write work across a worker pool. The result is bit-identical to single-threaded.
  - title: First-class relations
    details: Integer-encoded pairs as real archetype members — exclusive/overflow storage, presence-bit wildcards, and cascade directions. Relations cross worker boundaries (JS-object pair identity can't).
  - title: One frozen surface
    details: "ecsia re-exports the whole cohesive API — world, components, queries, systems, scheduler, relations, serialization — and tree-shakes what you don't touch."
---

## Status {#status}

::: warning 0.x · unpublished · experimental
ecsia is **feature-complete and API-frozen**, but **not yet published to npm** and pre-1.0. Treat it
as experimental: the surface is frozen and the test suite is green, but the package has not been
released and the API may still shift before 1.0.

- **Not on npm yet** — consume it from the local workspace (see [Getting started](/guide/getting-started)).
- **Node `>=22.13`** — the engine floor. ESM-only, strict TypeScript.
- **Browser parallelism needs COOP/COEP** — `SharedArrayBuffer` requires a cross-origin-isolated
  context; without it ecsia logs a warning and runs single-threaded (never a silent failure).
- **The worker pool is Node-only today** — `worker_threads` + `Atomics`. The same user code runs
  single-threaded everywhere; the OS-thread pool is the Node path.

The numbers on the [Performance](/guide/performance) page are measured, with reproduce
instructions.
:::

## Quick start

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from 'ecsia'

// Components are schema'd numeric SoA, stored in (optionally shared) TypedArrays.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5

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

const scheduler = createScheduler(world, [Movement])
scheduler.update(dt) // run one frame
```

Go parallel with the **same** user code — `threaded: true` is a dispatcher choice, not a code-shape
change:

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })

const world = createWorld({ components: [Position], threaded: true })
```

Keep going: [Getting started →](/guide/getting-started)

## Packages

| Package | Role |
|---|---|
| `ecsia` | the batteries-included umbrella — start here |
| `@ecsia/core` | archetype storage, typed accessors, queries, change tracking |
| `@ecsia/schema` | component field tokens and query type inference |
| `@ecsia/scheduler` | system access graph, wave executor, worker pool |
| `@ecsia/relations` | entity-to-entity links with fast queries and cascades |
| `@ecsia/serialization` | snapshots, deltas, worker bootstrap |
| `@ecsia/three` | three.js bindings (opt-in, not in the umbrella) |
| `@ecsia/devtools` | world inspector and schedule explainer (opt-in) |

The kernel (`@ecsia/core`) runs standalone; `scheduler`, `relations`, and `serialization` are opt-in
layers that attach via injected seams. `@ecsia/three` and `@ecsia/devtools` sit at the top of the
graph and are deliberately **not** re-exported from the umbrella.
