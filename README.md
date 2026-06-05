<div align="center">

# ecsia

Entity component system for TypeScript with automatic multithreading.

[![CI](https://github.com/andymai/ecsia/actions/workflows/ci.yml/badge.svg)](https://github.com/andymai/ecsia/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[Getting Started](./website/guide/getting-started.md)** · **[Core Concepts](./website/guide/core-concepts.md)** · **[Parallelism](./website/guide/parallelism.md)** · **[Performance](./website/guide/performance.md)**

</div>

ecsia is an entity component system for TypeScript. Component data lives in
typed-array columns, and the API you touch is fully typed on top of it —
`e.position.x` is a `number`, not a cast. Each system declares what it reads and
writes; the scheduler works out the rest, running systems that can't conflict
across worker threads at the same time. The outcome of a threaded run is
bit-for-bit identical to running everything on one thread.

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

Going parallel is one flag — no system, query, or accessor code changes:

```ts
const world = createWorld({ components: [...], threaded: true })
```

## Guarantees

- **Parallel equals serial.** A threaded run produces the same entity set, the same
  component values, and the same observer deltas as a single-threaded run — byte for
  byte, property-tested against a real worker pool.
- **Stale references throw.** `world.entity()` hands out a pooled ref; touch it after
  it's been re-bound and you get an error, not another entity's data.
- **No silent degradation.** Without `SharedArrayBuffer` (in browsers: without
  cross-origin isolation), ecsia logs a warning and runs single-threaded. Work is
  never silently dropped.

## What ecsia leaves to you

Rendering, physics, input, audio, netcode — ecsia is the data and scheduling layer
underneath a simulation, not an engine. [`@ecsia/three`](./packages/three) keeps
three.js objects in sync with your components, and
[`@ecsia/serialization`](./packages/serialization) produces snapshot and delta payloads
you could put on a wire — but drawing frames and shipping packets is your code.

Two constraints worth knowing: component schemas are declared up
front (both the typed-array layout and the query type inference depend on it), and the
whole thing is ESM-only.

## Status

0.1.0 — feature-complete, API-frozen, not yet on npm. Young; expect rough edges.
Runs on Node 22+, Bun, Deno, and modern browsers.

## Install

```sh
pnpm add ecsia
```

> **Not yet published.** `ecsia@0.1.0` is staged but not on npm yet — the command above
> will not resolve until first publish. For now, consume it from the workspace.

The umbrella package is the intended entry point. The layers underneath
(`@ecsia/core`, `@ecsia/scheduler`, …) publish separately for anyone who wants to
compose them by hand.

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

`@ecsia/core` is a complete single-threaded ECS on its own. Scheduling, relations,
and serialization attach to it through injected seams; nothing imports upward. All
packages are `sideEffects: false`.

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
