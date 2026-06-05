# ecsia

**A batteries-included, TypeScript-native Entity Component System** — archetype/SoA
storage with ergonomic typed accessors, first-class relations, and *auto-parallel
worker execution that is bit-identical to the serial path*.

> Status: feature-complete, API-frozen, experimental. 416 tests, strict-TypeScript,
> ESM-only. Not yet published to npm.

## Why ecsia

JavaScript ECS libraries each pick one strength and pay for it elsewhere. ecsia targets
the intersection none of them deliver together:

| | iteration (SoA) | worker parallelism | first-class relations | ergonomic typed API |
|---|:---:|:---:|:---:|:---:|
| [miniplex](https://github.com/hmans/miniplex) | ✗ (JS objects) | ✗ | ✗ | ✓ |
| [bitECS](https://github.com/NateTheGreatt/bitECS) | ✓ | ✗ | ✓ (single-thread only) | ✗ (raw arrays) |
| [becsy](https://github.com/LastOliveGames/becsy) | ✗ | *designed, never shipped*¹ | ✗ | partial |
| **ecsia** | ✓ | **✓** | **✓** | **✓** |

¹ becsy's multi-threaded executor throws `"Multithreading not yet implemented"`
(`dispatcher.ts:130-132`). ecsia ships it, proven by a serial-equivalence property test
over a real `worker_threads` + `Atomics` pool.

## Install

```sh
pnpm add @ecsia/ecsia   # not yet published — local workspace for now
```

## Quick start

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from '@ecsia/ecsia'

// Components are schema'd numeric SoA, stored in (optionally shared) TypedArrays.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

// Spawn into an archetype; random-access writes are typed (WriteOf<Velocity>).
const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5 // don't hold the ref across calls — it's pooled

// Systems declare their {read, write} access; the scheduler derives a conflict DAG.
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

### Go parallel — same user code

```ts
// threaded:true changes no system, query, or accessor code. The scheduler splits each
// wave's disjoint-write work across a worker pool over SharedArrayBuffer columns, with a
// postMessage fallback when the context isn't cross-origin-isolated (never silent failure).
const world = createWorld({ components: [...], threaded: true })
```

The parallel result is **bit-identical** to the single-threaded result (entity set,
component values, and reactivity deltas) — determinism comes from a fixed worker-index
command-buffer merge.

### Relations

```ts
import { createRelations, Wildcard } from '@ecsia/ecsia'

const rel = createRelations(world)
const ChildOf = rel.defineRelation({ name: 'ChildOf', exclusive: true })

rel.addPair(child, ChildOf, parent)  // exclusive re-parent = in-place write, zero migrations
rel.targetOf(child, ChildOf)         // → parent
// query holders of any ChildOf pair via the per-relation presence bit (O(archetypes)):
//   query(Pair(ChildOf, Wildcard))
```

### Reactivity & serialization

```ts
import { onChange } from '@ecsia/ecsia'
// onChange/onAdd/onRemove fire at a deferred serial slot (never mid-system, even under workers).

import { createSnapshotSerializer, createDeltaSerializer } from '@ecsia/ecsia'
// Snapshot round-trips a world bit-exactly; the version-stamp delta carries value + structural
// changes since a tick with no shadow map; entity ids and relation targets remap on load.
```

## Packages

| Package | Role |
|---|---|
| `@ecsia/core` | archetype tables · serial-only bitmask index · monomorphic accessors · queries · reactivity |
| `@ecsia/schema` | type-level field tokens + 1..8 arity query inference |
| `@ecsia/relations` | integer-encoded pairs · exclusive/overflow storage · presence-bit wildcard · cascade |
| `@ecsia/scheduler` | access-graph DAG · wave executor · workers + Atomics wave-sync + command buffers |
| `@ecsia/serialization` | snapshot · version-stamp delta · structural journal · id remap · zero-copy worker bootstrap |
| `@ecsia/ecsia` | batteries-included umbrella re-export (the public, frozen surface) |

The kernel (`@ecsia/core`) runs standalone; `scheduler`, `relations`, and `serialization`
are opt-in layers that attach via injected seams (the dependency graph is acyclic and the
umbrella tree-shakes).

## Design & architecture

Architecture in one line:

> archetype-table SoA storage (iteration) layered over a serial-only per-entity bitmask
> (membership), with integer-encoded relation pairs as first-class archetype members, driven
> by a wave scheduler with a worker pool and command buffers.

## Benchmarks — honest numbers

`pnpm bench:macro` runs a [tinybench](https://github.com/tinylibs/tinybench) suite vs miniplex
and bitECS. On a **single thread**, bitECS's raw SoA loop and miniplex's array iteration still
out-iterate ecsia's accessor-indirected `query.each`. ecsia's edge is **parallelism** (no JS
reference library has an auto-parallel worker path) and **cross-worker relations** (bitECS's
JS-object pair identity can't cross a worker boundary). A near-linear-speedup demonstration
wants a cross-origin-isolated host.

## Development

```sh
pnpm install
pnpm build              # tsc -b across all packages (strict, ESM, project refs)
pnpm test               # vitest: unit + property (fast-check) + worker + type-level
pnpm typecheck:extras   # type-check examples/ and bench/
pnpm bench:macro        # cross-library macro-benchmarks
```

Runnable examples in [`examples/`](./examples): boids, scene-graph hierarchy, worker-parallel sim.

## License

[MIT](./LICENSE)
