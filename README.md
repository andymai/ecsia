# ecsia

**A fast, type-safe Entity Component System for TypeScript.** Define components
once and get fully typed queries everywhere. When you're ready for more speed,
the scheduler spreads your systems across worker threads automatically — and
guarantees the results match a single-threaded run, bit for bit.

> **0.1.0, not yet on npm.** Feature-complete and API-frozen, but young — expect
> rough edges. Runs on Node 22+, Bun, Deno, and modern browsers.

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

ecsia publishes under the **bare name** `ecsia` (the umbrella package). Power users can pull
the scoped layers (`@ecsia/core`, `@ecsia/scheduler`, …) directly.

```sh
pnpm add ecsia
```

> **⚠️ Not yet published.** `ecsia@0.1.0` is staged but not on npm yet — the command above will
> not resolve until first publish. For now, consume it from the workspace.

## Quick start

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from 'ecsia'

// Components are schema'd numeric SoA, stored in (optionally shared) TypedArrays.
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

// Spawn into an archetype; random-access writes are typed (WriteOf<Velocity>) — no casts.
const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5
world.entity(e).read(Velocity).dx // typed number; read views are deeply readonly (assigning is a TS error)

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

> **⚠️ Pooled refs & phases.** `world.entity(h)` returns a **pooled** `EntityRef` — the *same*
> object, rebound to a new row on every call. Don't hold two live accessors across a
> `world.entity()` call; read the fields you need out first:
> ```ts
> const p = world.entity(a).read(Position)
> const px = p.x, py = p.y            // pull values out BEFORE the next resolve
> const v = world.entity(a).read(Velocity)   // rebinds the pooled ref — `p` is now stale
> ```
> A stale read/write **throws** (`stale binding for entity … — re-resolve via world.entity(h)`),
> so misuse fails loud instead of silently reading the wrong row. Separately, structural mutation
> (`spawn`/`add`/`remove`/`despawn`) is **serial-phase only**: legal before `scheduler.update()`,
> inside a serial system body via `ctx.world` (see below), or inside an observer handler — but a
> worker-wave system body cannot mutate structure (it throws).

### In-system structural mutation

The `run({ world, query, dt, tick })` context gives you the same `world` — so spawn/despawn/add/remove
happen inside a system, applied immediately at the serial slot:

```ts
import type { EntityHandle } from 'ecsia'

const Reaper = defineSystem({
  name: 'Reaper',
  read: [Health],
  write: [],
  run({ world, query }) {
    const dead: EntityHandle[] = []
    for (const e of query(read(Health))) {
      if (e.health.hp <= 0) dead.push(e.handle) // collect first, mutate after the iteration
    }
    for (const h of dead) world.despawn(h)       // despawn / world.remove(h, C) / world.add(h, C)
  },
})
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

`defineRelation` is reached through `createRelations(world)` (relation ids are world-scoped) and takes
**payload first, options second** — `defineRelation(payload | null, options?)`:

```ts
import { createRelations, Wildcard } from 'ecsia'

const rel = createRelations(world)
// Payload-free exclusive relation: pass `null` for the payload. `cascade: 'deleteSubject'` means
// despawning a PARENT (the target) cascades to its CHILDREN (the subjects pointing at it).
const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

rel.addPair(child, ChildOf, parent)  // exclusive re-parent = in-place write, zero migrations
rel.targetOf(child, ChildOf)         // → parent handle (exclusive only), or null

// Query relation holders via rel.Pair(...) (the term constructor lives on the relations API, not the
// umbrella). Wildcard matches any pair via the per-relation presence bit (O(archetypes)):
for (const e of world.query(rel.Pair(ChildOf, Wildcard))) {
  // e.handle is a node that has SOME parent
}
```

**Cascade direction.** Cascade is declared on the relation, fired when a participant is despawned:
- `'deleteSubject'` — despawning a **target** despawns every **subject** that points at it (a parent
  despawn deletes its children; the cascade is iterative, so deep chains unwind without recursion).
- `'removeRelation'` — despawning a target only drops the dangling pairs, leaving subjects alive.
- `'none'` (default) — pairs to a despawned target are dropped; nothing cascades.

Despawning a **subject** always just removes its own outgoing pairs (it never deletes its target).

#### Payloaded relations

`defineRelation` takes a payload schema as the first argument; `addPair` then carries the values:

```ts
const Likes = rel.defineRelation({ amount: 'f32' })   // payload-first
rel.addPair(alice, Likes, bob, { amount: 0.8 })
```

### Reactivity & serialization

`onAdd`/`onRemove`/`onChange` only **build** an observer term — you **register** it with
`world.observe(term, handler)`, which returns a handle with `dispose()`. Handlers fire at a deferred
serial slot (never mid-system, even under workers); the handler receives the entity ref and a context:

```ts
import { onRemove } from 'ecsia'

// (e: EntityRef, ctx: { kind, component: ComponentId, tick: number }) => void
const sub = world.observe(onRemove(Health), (e, ctx) => {
  console.log(`entity ${e.handle} lost Health at tick ${ctx.tick}`)
})
// onRemove(C) fires when C is removed AND when the entity is despawned. Later:
sub.dispose() // unsubscribe

import { onChange } from 'ecsia'
// onChange/onAdd/onRemove fire at a deferred serial slot (never mid-system, even under workers).
// Mutations inside a handler stage to a command buffer and apply at the same serial slot.

import { createSnapshotSerializer, createDeltaSerializer } from 'ecsia'
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
| `ecsia` | batteries-included umbrella re-export (the public, frozen surface) |

The kernel (`@ecsia/core`) runs standalone; `scheduler`, `relations`, and `serialization`
are opt-in layers that attach via injected seams (the dependency graph is acyclic and the
umbrella tree-shakes).

## Design & architecture

Architecture in one line:

> archetype-table SoA storage (iteration) layered over a serial-only per-entity bitmask
> (membership), with integer-encoded relation pairs as first-class archetype members, driven
> by a wave scheduler with a worker pool and command buffers.

## Benchmarks — honest numbers

These are real, measured numbers regenerated by `pnpm bench:report` (which writes
`bench/RESULTS.json` + the docs tables, so the page can never disagree with the artifact). One
machine, one moment — treat the **shapes** as durable, the milliseconds as a snapshot.
*(AMD Ryzen 9 7950X3D, Node v24.11.0.)*

**Single-thread iteration** — Position += Velocity·dt over 50,000 entities:

| loop | ns/entity | vs bitECS |
| --- | ---: | ---: |
| ecsia `.each` | 10.12 | 9.59x |
| ecsia `eachChunk` | 1.46 | 1.39x |
| miniplex | 13.30 | 12.46x |
| **bitECS** | **1.05** | **1.00x** |

bitECS wins raw single-thread iteration — we don't pretend otherwise. ecsia's `eachChunk`
column cursor lands within ~1.4x; its ergonomic `.each` still beats miniplex.

**Worker-pool speedup** — real `worker_threads` + `Atomics`, 8,192 entities × 512 sub-steps ×
60 frames, every run byte-identical to single-thread:

| workers | speedup | byte-identical |
| ---: | ---: | :---: |
| 1 | 0.98x | yes |
| 2 | 1.89x | yes |
| 4 | 3.60x | yes |
| 8 | **6.48x** | yes |

The parallel curve is the capability no other JS ECS ships. Full tables, methodology, and the
tracked-write cost are on the **[performance page](./website/guide/performance.md)** (docs site
once Pages is live). The speedup demo wants a cross-origin-isolated host (`SharedArrayBuffer`).

## Development

```sh
pnpm install
pnpm build              # tsc -b across all packages (strict, ESM, project refs)
pnpm test               # vitest: unit + property (fast-check) + worker + type-level
pnpm typecheck:extras   # type-check examples/ and bench/
pnpm bench:macro        # cross-library macro-benchmarks
```

Runnable examples in [`examples/`](./examples): boids, scene-graph hierarchy, worker-parallel sim,
and a damage-over-time sim (in-system despawn, `onRemove` death observer, and a `ChildOf` cascade).

## License

[MIT](./LICENSE)
