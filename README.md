<div align="center">

# ecsia

Entity Component System for TypeScript.

[![CI](https://github.com/andymai/ecsia/actions/workflows/ci.yml/badge.svg)](https://github.com/andymai/ecsia/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[Getting Started](./website/guide/getting-started.md)** · **[Core Concepts](./website/guide/core-concepts.md)** · **[Parallelism](./website/guide/parallelism.md)** · **[Performance](./website/guide/performance.md)**

</div>

Components are stored as typed-array columns, so iteration is fast and queries are
fully typed — `e.position.x` is a real `number`, no casts. Systems declare what they
read and write, and the scheduler runs non-conflicting systems across worker threads
automatically, with results identical to a single-threaded run, bit for bit.

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from 'ecsia'

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

Going parallel changes no system, query, or accessor code:

```ts
const world = createWorld({ components: [...], threaded: true })
```

## Scope

To set expectations, this project deliberately does not:

- **Render anything** — ecsia manages entity data; [`@ecsia/three`](./packages/three) binds
  components to three.js objects, but drawing is three's job.
- **Try to be a game engine** — no physics, input, assets, or audio. It's the data and
  scheduling layer you build those on.
- **Provide networking** — snapshots and deltas in [`@ecsia/serialization`](./packages/serialization)
  are good transport payloads, but there is no netcode, prediction, or rollback.
- **Support CommonJS** — ESM only.
- **Allow dynamic component schemas** — components are declared up front; the typed-array
  layout and the query type inference both depend on it.

## Status

0.1.0, not yet on npm. Feature-complete and API-frozen, but young — expect rough edges.
Runs on Node 22+, Bun, Deno, and modern browsers; parallel execution needs
`SharedArrayBuffer` (cross-origin isolation in browsers) and falls back to
single-threaded execution everywhere else, never silently dropping work.

## Install

ecsia publishes under the bare name `ecsia` (the umbrella package). The scoped layers
(`@ecsia/core`, `@ecsia/scheduler`, …) are available separately if you want to compose
them by hand.

```sh
pnpm add ecsia
```

> **Not yet published.** `ecsia@0.1.0` is staged but not on npm yet — the command above
> will not resolve until first publish. For now, consume it from the workspace.

## Documentation

- **[Getting Started](./website/guide/getting-started.md)** — install, first world, first system
- **[Core Concepts](./website/guide/core-concepts.md)** — entities, components, queries, archetypes, pooled refs
- **[Parallelism](./website/guide/parallelism.md)** — how `threaded: true` works, what runs where, determinism
- **[Relations](./website/guide/relations.md)** — entity-to-entity links, hierarchies, cascades
- **[Reactivity](./website/guide/reactivity.md)** — `onAdd` / `onRemove` / `onChange` observers
- **[Serialization](./website/guide/serialization.md)** — snapshots, deltas, worker handoff
- **[three.js bridge](./website/guide/three-bridge.md)** — driving Object3D and instanced meshes
- **[Devtools](./website/guide/devtools.md)** — world inspection, schedule explainer
- **[Performance](./website/guide/performance.md)** — benchmarks, methodology, reproduce instructions

The same pages build into a VitePress site (`pnpm docs:build`), including a generated
API reference.

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

`@ecsia/core` runs standalone; everything else is an opt-in layer on top.

## Architecture

```
umbrella   ecsia                                    curated public surface
layers     scheduler/, relations/, serialization/   opt-in, attach via seams
kernel     core/                                    storage, queries, reactivity
types      schema/                                  field tokens, query inference
```

Dependencies flow downward only; the graph is acyclic and the umbrella tree-shakes.

## Benchmarks

Real measured numbers, regenerated by `pnpm bench:report` (one machine, one moment —
treat the shapes as durable, the milliseconds as a snapshot; AMD Ryzen 9 7950X3D,
Node v24.11.0).

Single-thread iteration, Position += Velocity·dt over 50,000 entities:

| loop | ns/entity |
| --- | ---: |
| bitECS | 1.05 |
| ecsia `eachChunk` | 1.46 |
| ecsia `.each` | 10.12 |
| miniplex | 13.30 |

Worker-pool speedup, 8,192 entities × 512 sub-steps × 60 frames, every run
byte-identical to single-threaded:

| workers | speedup |
| ---: | ---: |
| 1 | 0.98x |
| 2 | 1.89x |
| 4 | 3.60x |
| 8 | 6.48x |

Methodology and full tables on the [performance page](./website/guide/performance.md).

## Development

```sh
pnpm install
pnpm build              # tsc -b across all packages
pnpm test               # vitest: unit + property + worker + type-level
pnpm typecheck:extras   # type-check examples/ and bench/
pnpm bench:macro        # cross-library macro-benchmarks
```

Runnable examples in [`examples/`](./examples): boids, scene-graph hierarchy,
worker-parallel sim, and a damage-over-time sim.

## License

[MIT](./LICENSE)
