<div align="center">

# ecsia

Build simulations out of plain data, and let ecsia run them across threads for you.

[![CI](https://github.com/andymai/ecsia/actions/workflows/ci.yml/badge.svg)](https://github.com/andymai/ecsia/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[Getting Started](./website/guide/getting-started.md)** · **[Core Concepts](./website/guide/core-concepts.md)** · **[Multithreading](./website/guide/parallelism.md)** · **[Performance](./website/guide/performance.md)**

</div>

ecsia is an entity component system (ECS) for TypeScript. If you haven't met the
pattern before, it's a way of organizing a simulation — a game, a physics sandbox, an
agent model — around three simple ideas:

- An **entity** is just an id. A thing in your world, with no data of its own.
- A **component** is a typed piece of data you attach to an entity — a position, a
  velocity, a health value.
- A **system** is a function that runs every frame over all entities that have a
  particular set of components.

A "bird" isn't a class — it's whatever entity happens to have a position and a
velocity, and movement is a system that adds one to the other sixty times a second.
Want a bird with health? Attach a health component. Composition replaces class
hierarchies.

The payoff is speed and safety at the same time. Under the hood, each component field
lives in its own contiguous typed array, so looping over 50,000 entities walks
straight through memory the way CPUs like. On top of that sits a fully typed API —
`e.position.x` is a `number`, not a cast.

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

Those `read` and `write` declarations aren't just documentation. From them, the
scheduler works out which systems can never interfere with each other — and runs
those at the same time on worker threads. Going parallel is one flag, with no changes
to any system, query, or accessor code:

```ts
const world = createWorld({ components: [...], threaded: true })
```

## Guarantees

- **Threads never change your results.** A threaded run produces exactly the same
  entities, the same component values, and the same change events as running
  everything on one thread — byte for byte. This isn't a promise, it's a tested
  property: the test suite runs the same simulations both ways, against a real worker
  pool, and checks the outputs are identical.
- **Stale references throw.** `world.entity()` hands out a reusable reference object
  rather than allocating a new one each call. If you hold onto one after it has been
  re-pointed at another entity, you get an error — never another entity's data.
- **No silent slowdowns.** Threading needs shared memory (`SharedArrayBuffer`; in
  browsers that requires cross-origin isolation, a server-side opt-in). Where it's
  unavailable, ecsia logs a warning and runs on one thread. Work is never silently
  dropped.

## What ecsia leaves to you

Rendering, physics, input, audio, networking — ecsia is the data and scheduling layer
underneath a simulation, not an engine. [`@ecsia/three`](./packages/three) keeps
three.js objects in sync with your components, and
[`@ecsia/serialization`](./packages/serialization) turns world state into payloads you
could save or send over a network — but drawing frames and shipping packets is your
code.

Two constraints worth knowing up front: every component's fields are declared ahead
of time (both the memory layout and the type inference depend on it), and the whole
thing is ESM-only.

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
- **[Core Concepts](./website/guide/core-concepts.md)** — entities, components, queries, and how ecsia stores them
- **[Multithreading](./website/guide/parallelism.md)** — how `threaded: true` works, what runs where, and why results stay identical
- **[Linking entities](./website/guide/relations.md)** — parent/child hierarchies and other entity-to-entity links
- **[Reacting to changes](./website/guide/reactivity.md)** — run code when components are added, removed, or modified
- **[Saving and syncing](./website/guide/serialization.md)** — snapshots, change payloads, worker handoff
- **[three.js bridge](./website/guide/three-bridge.md)** — keeping three.js objects in sync with your data
- **[Devtools](./website/guide/devtools.md)** — inspect a world and see why the scheduler made its choices
- **[Performance](./website/guide/performance.md)** — measured benchmarks, methodology, reproduce instructions

The same pages build into a VitePress site (`pnpm docs:build`), including a generated
API reference.

## Packages

| Package | Role |
|---|---|
| `ecsia` | the batteries-included umbrella — start here |
| `@ecsia/core` | component storage, typed accessors, queries, change tracking |
| `@ecsia/schema` | component field types and query type inference |
| `@ecsia/scheduler` | works out which systems can run together, and runs them across threads |
| `@ecsia/relations` | entity-to-entity links with fast queries and automatic cleanup |
| `@ecsia/serialization` | snapshots, change payloads, worker bootstrap |
| `@ecsia/three` | three.js bindings (opt-in, not in the umbrella) |
| `@ecsia/devtools` | world inspector and schedule explainer (opt-in) |

`@ecsia/core` is a complete single-threaded ECS on its own. Scheduling, relations,
and serialization plug into it without core knowing about them; nothing imports
upward. All packages are `sideEffects: false`, so bundlers drop whatever you don't
use.

## Benchmarks

Real measured numbers, regenerated by `pnpm bench:report` (one machine, one moment —
treat the shapes as durable, the milliseconds as a snapshot; AMD Ryzen 9 7950X3D,
Node v24.11.0).

Single-thread iteration — the classic ECS workload of adding each entity's velocity
to its position, over 50,000 entities. Lower is faster (nanoseconds per entity):

| loop | ns per entity |
| --- | ---: |
| bitECS | 1.05 |
| ecsia `eachChunk` | 1.46 |
| ecsia `.each` | 10.12 |
| miniplex | 13.30 |

Worker-thread speedup on a compute-heavy simulation (8,192 entities, 512 physics
steps per frame, 60 frames), with every threaded run byte-identical to the
single-threaded result:

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

Runnable examples in [`examples/`](./examples): a flock of birds, a parent/child
scene hierarchy, a worker-parallel simulation, and a damage-over-time effect with
automatic cleanup.

## License

[MIT](./LICENSE)
