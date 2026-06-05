---
layout: home

hero:
  name: ecsia
  text: A batteries-included, TypeScript-native ECS
  tagline: Archetype/SoA storage with ergonomic typed accessors, first-class relations, and auto-parallel worker execution that is bit-identical to the serial path.
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

## Why ecsia

JavaScript ECS libraries each pick one strength and pay for it elsewhere. ecsia targets the
intersection none of them deliver together:

| | iteration (SoA) | worker parallelism | first-class relations | ergonomic typed API |
|---|:---:|:---:|:---:|:---:|
| [miniplex](https://github.com/hmans/miniplex) | ✗ (JS objects) | ✗ | ✗ | ✓ |
| [bitECS](https://github.com/NateTheGreatt/bitECS) | ✓ | ✗ | ✓ (single-thread only) | ✗ (raw arrays) |
| [becsy](https://github.com/LastOliveGames/becsy) | ✗ | *designed, never shipped*¹ | ✗ | partial |
| **ecsia** | ✓ | **✓** | **✓** | **✓** |

¹ becsy's multi-threaded executor throws `"Multithreading not yet implemented"`
(`dispatcher.ts:130-132`). ecsia ships it, proven by a serial-equivalence property test over a real
`worker_threads` + `Atomics` pool.

## Status {#status}

::: warning 0.x · unpublished · experimental
ecsia is **feature-complete and API-frozen**, but **not yet published to npm** and pre-1.0. Treat it
as experimental: the surface is frozen at M12, the test suite is green, but the package has not been
released and the API may still shift before 1.0.

- **Not on npm yet** — consume it from the local workspace (see [Getting started](/guide/getting-started)).
- **Node `>=22.13`** — the engine floor. ESM-only, strict TypeScript.
- **Browser parallelism needs COOP/COEP** — `SharedArrayBuffer` requires a cross-origin-isolated
  context; without it the scheduler uses a `postMessage` fallback (never a silent failure).
- **The worker pool is Node-only today** — `worker_threads` + `Atomics`. The same user code runs
  single-threaded everywhere; the OS-thread pool is the Node path.

The numbers on the [Performance](/guide/performance) page are deliberately honest — and that page is a
placeholder until P7 fills it with measured results.
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
| `@ecsia/core` | archetype tables · serial-only bitmask index · monomorphic accessors · queries · reactivity |
| `@ecsia/schema` | type-level field tokens + 1..8 arity query inference |
| `@ecsia/relations` | integer-encoded pairs · exclusive/overflow storage · presence-bit wildcard · cascade |
| `@ecsia/scheduler` | access-graph DAG · wave executor · workers + Atomics wave-sync + command buffers |
| `@ecsia/serialization` | snapshot · version-stamp delta · structural journal · id remap · zero-copy worker bootstrap |
| `ecsia` | batteries-included umbrella re-export (the public, frozen surface) |
| `@ecsia/three` | THREE.js bridge — bindings, transform/instanced sync, driver (opt-in) |
| `@ecsia/devtools` | inspectWorld · explainPlan · watchWorld · text/HTML renderers (opt-in) |

The kernel (`@ecsia/core`) runs standalone; `scheduler`, `relations`, and `serialization` are opt-in
layers that attach via injected seams. `@ecsia/three` and `@ecsia/devtools` sit at the top of the
graph and are deliberately **not** re-exported from the umbrella.
