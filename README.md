<div align="center">

# ecsia

An entity component system (ECS) for TypeScript. One flag turns on worker threads, and the result matches a run on one thread, byte for byte.

[![CI](https://github.com/andymai/ecsia/actions/workflows/ci.yml/badge.svg)](https://github.com/andymai/ecsia/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[🕹 Play ECHO SURVIVORS (live demo)](https://andymai.github.io/ecsia/demo/)** · **[Getting Started](https://andymai.github.io/ecsia/guide/getting-started)** · **[Core Concepts](https://andymai.github.io/ecsia/guide/core-concepts)** · **[Multithreading](https://andymai.github.io/ecsia/guide/parallelism)** · **[Performance](https://andymai.github.io/ecsia/guide/performance)**

</div>

ecsia is an entity component system (ECS) for TypeScript. If the pattern is new to you, here is the short version. An ECS organizes a simulation (a game, a physics sandbox, an agent model) around three ideas:

- An **entity** is only an id. It is a thing in your world, with no data of its own.
- A **component** is a typed piece of data that you attach to an entity, for example a position, a velocity, or a health value.
- A **system** is a function that runs every frame over all entities that have a given set of components.

A "bird" is not a class. It is any entity that has a position and a velocity. Movement is a system that adds the velocity to the position sixty times a second. For a bird with health, attach a health component. Composition replaces class hierarchies.

This design gives you speed and type safety together. Each component field lives in its own contiguous typed array. A loop over 50,000 entities therefore walks straight through memory, which is the access pattern that CPUs prefer. A fully typed API sits over that storage: `e.position.x` is a `number`, not a cast.

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

The `read` and `write` declarations are more than documentation. The scheduler uses them to find the systems that can never interfere with each other. It runs those systems at the same time on worker threads. To turn on threads, set one flag. You do not change any system, query, or accessor code:

```ts
import { createWorld } from '@ecsia/kit'

const world = createWorld({ components: [/* ... */], threaded: true })
```

The worker pool runs on Node `worker_threads`. In the browser, it runs on Web Workers when the page has cross-origin isolation. There, the scheduler waits on the wave fence with `Atomics.waitAsync`, so the main thread of the page never blocks. CI checks that both paths give the same result as a run on one thread, byte for byte. The browser check runs in a real Chromium tab.

## Guarantees

- **Threads never change your results.** A threaded run matches a run on one thread in entities, component values, and change events, byte for byte. This is a tested property. The test suite runs the same simulations both ways, on a real worker pool, and checks that the outputs are the same.
- **Stale references throw.** `world.entity()` gives you a reusable reference object. It does not allocate a new object for each call. If you keep a reference after ecsia points it at another entity, you get an error, never the data of another entity.
- **No silent slowdowns.** Threads need shared memory (`SharedArrayBuffer`). In browsers, shared memory needs cross-origin isolation, which the server must turn on. Where shared memory is not available, ecsia logs a warning and runs on one thread. ecsia never drops work silently.

## The demo: ECHO SURVIVORS

**[Play it in your browser →](https://andymai.github.io/ecsia/demo/)**

ECHO SURVIVORS is a retro-CRT, time-loop survivors game built on ecsia. It is also a live proof of the guarantees above. Survive a 90-second loop against a horde of tens of thousands of entities. When you die, time rewinds, and **your past self fights beside you and replays your exact inputs**. You get eight lives in one timeline.

Everything in the demo is the real engine, not a staged capture:

- The steering of the horde runs on ecsia's **browser Web-Worker pool** over `SharedArrayBuffer`. A service worker adds the cross-origin isolation headers, because GitHub Pages cannot send them. Turn threads on and off while you play. The state hash in the corner does not change, because the parallel result equals the serial result.
- The **echo mechanic is deterministic replay**. A ghost is only a recorded input stream that the demo feeds into the same simulation again.
- A finished run **compresses into its URL** (seed + inputs). When you open the link, the demo runs the full simulation again and checks the recorded state hash. The hash is the same, byte for byte, on any machine.

The source is in [`demo/`](./demo). The game logic uses ordinary ecsia components and systems.

## What ecsia leaves to you

ecsia is the data layer and the scheduler under a simulation, not an engine. Rendering, physics, input, audio, and networking stay in your code. [`@ecsia/three`](./packages/three) keeps three.js objects in sync with your components. [`@ecsia/serialization`](./packages/serialization) turns world state into payloads that you can save or send over a network. Your code draws the frames and sends the packets.

Know two constraints before you start. You declare the fields of every component ahead of time, because the memory layout and the type inference both depend on them. Also, ecsia is ESM-only.

## Status

ecsia is at 0.x (pre-1.0). The API is frozen, and the feature set is complete. The project is young, so expect rough edges. It runs on Node 22.13 or later, Bun, Deno, and browsers.

## Install

```sh
pnpm add @ecsia/kit
```

Start with the umbrella package. ecsia also publishes the layers under it (`@ecsia/core`, `@ecsia/scheduler`, …) as separate packages, so you can compose them by hand.

## Documentation

- **[Getting Started](https://andymai.github.io/ecsia/guide/getting-started)**: install, first world, first system
- **[Core Concepts](https://andymai.github.io/ecsia/guide/core-concepts)**: entities, components, queries, and how ecsia stores them
- **[Multithreading](https://andymai.github.io/ecsia/guide/parallelism)**: how `threaded: true` works, what runs where, and why results stay the same
- **[Linking entities](https://andymai.github.io/ecsia/guide/relations)**: parent/child hierarchies and other entity-to-entity links
- **[Reacting to changes](https://andymai.github.io/ecsia/guide/reactivity)**: run code when something adds, removes, or changes a component
- **[Saving and syncing](https://andymai.github.io/ecsia/guide/serialization)**: snapshots, change payloads, worker handoff
- **[three.js bridge](https://andymai.github.io/ecsia/guide/three-bridge)**: keep three.js objects in sync with your data
- **[Devtools](https://andymai.github.io/ecsia/guide/devtools)**: inspect a world and see why the scheduler made its choices
- **[Performance](https://andymai.github.io/ecsia/guide/performance)**: measured benchmarks, methodology, and steps to reproduce them

The full site is at **[andymai.github.io/ecsia](https://andymai.github.io/ecsia/)**. It has these guides and a generated API reference, and it redeploys on each push to main. The sources are in [`website/`](./website). Run `pnpm docs:dev` for a local preview.

## Packages

| Package | Role |
|---|---|
| `@ecsia/kit` | the umbrella package that re-exports core, schema, relations, scheduler, and serialization; start here |
| `@ecsia/core` | component storage, typed accessors, queries, change tracking |
| `@ecsia/schema` | component field types and query type inference |
| `@ecsia/scheduler` | works out which systems can run together, and runs them across threads |
| `@ecsia/relations` | entity-to-entity links, queries over them, and automatic cleanup |
| `@ecsia/serialization` | snapshots, change payloads, worker bootstrap |
| `@ecsia/three` | three.js bindings (opt-in, not in the umbrella) |
| `@ecsia/devtools` | world inspector and schedule explainer (opt-in) |

`@ecsia/core` alone is a complete ECS that runs on one thread. The scheduler, relations, and serialization packages plug into it, and core does not know about them. No package imports a package above it. All packages are `sideEffects: false`, so bundlers drop the code that you do not use.

## Benchmarks

The numbers come from `pnpm bench:report` on one machine at one moment (AMD Ryzen 9 7950X3D, Node v24.11.0). Treat the shapes as durable and the milliseconds as a snapshot.

The first table measures iteration on one thread. Each loop does the classic ECS workload: it adds the velocity of each entity to its position, over 50,000 entities. It compares ecsia with bitECS 0.4.0 and miniplex 2.0.0. Lower is faster (nanoseconds per entity):

| loop | ns per entity |
| --- | ---: |
| ecsia `bindColumns` | 0.97 |
| bitECS | 1.35 |
| ecsia `eachChunk` | 1.47 |
| ecsia `.each` | 10.14 |
| miniplex | 12.15 |

`.each` is the accessor path from the example above. `eachChunk` loops over the raw storage arrays directly. `bindColumns` goes one step further and compiles a specialized loop for each archetype. That compiled loop lets it beat bitECS, and it keeps that lead as the world grows, with no pre-sizing. Where a strict CSP or sandbox forbids dynamic compilation, it falls back to a plain loop.

You do not have to choose between the `.each` body and that speed. [`query.compile`](https://github.com/andymai/ecsia/blob/main/website/guide/performance.md#compile-the-ergonomic-path-compile) takes the same `e.position.x += …` callback and rewrites it into a loop with the `bindColumns` shape. The result lands near `eachChunk`, roughly 6× faster than a plain `.each` loop with the same body. It still feeds `.changed()` filters and observers. For anything that it cannot compile, it falls back to the normal loop, so it only changes the speed.

The second table shows the speedup with worker threads on a compute-heavy simulation (8,192 entities, 512 physics steps per frame, 60 frames). Each threaded run gives the same result as the run on one thread, byte for byte:

| workers | speedup |
| ---: | ---: |
| 1 | 0.99x |
| 2 | 1.90x |
| 4 | 3.62x |
| 8 | 6.38x |

The [performance page](https://andymai.github.io/ecsia/guide/performance) has the methodology and the full tables.

## Development

```sh
pnpm install
pnpm build              # tsc -b across all packages
pnpm test               # vitest: unit + property + worker + type-level
pnpm typecheck:extras   # type-check examples/ and bench/
pnpm bench:macro        # cross-library macro-benchmarks
```

[`examples/`](./examples) has runnable examples: a flock of birds, a parent/child scene hierarchy, a worker-parallel simulation, and a damage-over-time effect with automatic cleanup.

## License

[MIT](./LICENSE)
