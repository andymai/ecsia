<div align="center">

# ecsia

Build simulations out of plain data, and let ecsia run them across threads for you.

[![CI](https://github.com/andymai/ecsia/actions/workflows/ci.yml/badge.svg)](https://github.com/andymai/ecsia/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[Getting Started](https://andymai.github.io/ecsia/guide/getting-started)** · **[Core Concepts](https://andymai.github.io/ecsia/guide/core-concepts)** · **[Multithreading](https://andymai.github.io/ecsia/guide/parallelism)** · **[Performance](https://andymai.github.io/ecsia/guide/performance)**

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
} from '@ecsia/kit'

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
import { createWorld } from '@ecsia/kit'

const world = createWorld({ components: [/* ... */], threaded: true })
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
pnpm add @ecsia/kit
```

> **Not yet published.** `@ecsia/kit` is staged but not on npm yet — the command above
> will not resolve until first publish. For now, consume it from the workspace.

The umbrella package is the intended entry point. The layers underneath
(`@ecsia/core`, `@ecsia/scheduler`, …) publish separately for anyone who wants to
compose them by hand.

## Documentation

- **[Getting Started](https://andymai.github.io/ecsia/guide/getting-started)** — install, first world, first system
- **[Core Concepts](https://andymai.github.io/ecsia/guide/core-concepts)** — entities, components, queries, and how ecsia stores them
- **[Multithreading](https://andymai.github.io/ecsia/guide/parallelism)** — how `threaded: true` works, what runs where, and why results stay identical
- **[Linking entities](https://andymai.github.io/ecsia/guide/relations)** — parent/child hierarchies and other entity-to-entity links
- **[Reacting to changes](https://andymai.github.io/ecsia/guide/reactivity)** — run code when components are added, removed, or modified
- **[Saving and syncing](https://andymai.github.io/ecsia/guide/serialization)** — snapshots, change payloads, worker handoff
- **[three.js bridge](https://andymai.github.io/ecsia/guide/three-bridge)** — keeping three.js objects in sync with your data
- **[Devtools](https://andymai.github.io/ecsia/guide/devtools)** — inspect a world and see why the scheduler made its choices
- **[Performance](https://andymai.github.io/ecsia/guide/performance)** — measured benchmarks, methodology, reproduce instructions

The full site — these guides plus a generated API reference — lives at
**[andymai.github.io/ecsia](https://andymai.github.io/ecsia/)** and redeploys on every
push to main. The sources are in [`website/`](./website) (`pnpm docs:dev` for a local
preview).

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

`@ecsia/core` is a complete single-threaded ECS on its own. Scheduling, relations,
and serialization plug into it without core knowing about them; nothing imports
upward. All packages are `sideEffects: false`, so bundlers drop whatever you don't
use.

## Benchmarks

Real measured numbers, regenerated by `pnpm bench:report` (one machine, one moment —
treat the shapes as durable, the milliseconds as a snapshot; AMD Ryzen 9 7950X3D,
Node v24.11.0).

Single-thread iteration — the classic ECS workload of adding each entity's velocity
to its position, over 50,000 entities, against bitECS 0.4.0 and miniplex 2.0.0.
Lower is faster (nanoseconds per entity):

| loop | ns per entity |
| --- | ---: |
| ecsia `bindColumns` | 0.97 |
| bitECS | 1.35 |
| ecsia `eachChunk` | 1.47 |
| ecsia `.each` | 10.14 |
| miniplex | 12.15 |

`.each` is the ergonomic accessor path from the example above; `eachChunk` loops over
the raw storage arrays directly; `bindColumns` goes one step further and compiles a
specialized loop per archetype — which is what lets it beat bitECS, and it holds that
edge as the world grows (no pre-sizing required; it falls back to a plain loop where a
strict CSP or sandbox forbids dynamic compilation).

You don't have to choose between the readable `.each` body and that speed:
[`query.compile`](https://github.com/andymai/ecsia/blob/main/website/guide/performance.md#compile-the-ergonomic-path-compile)
takes the same `e.position.x += …` callback, rewrites it into the `bindColumns`-shape loop, and lands
near `eachChunk` — roughly 6× faster than the plain `.each` it's written like — while still feeding
`.changed()`/observers. It's a pure speedup that falls back to the normal loop for anything it can't
compile.

Worker-thread speedup on a compute-heavy simulation (8,192 entities, 512 physics
steps per frame, 60 frames), with every threaded run byte-identical to the
single-threaded result:

| workers | speedup |
| ---: | ---: |
| 1 | 0.99x |
| 2 | 1.90x |
| 4 | 3.62x |
| 8 | 6.38x |

Methodology and full tables on the [performance page](https://andymai.github.io/ecsia/guide/performance).

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
