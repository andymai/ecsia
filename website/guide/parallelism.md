# Multithreading

ecsia is an entity component system (ECS): each thing in your world is an entity (just an
id), its data lives in components (typed pieces of data attached to entities), and behavior
lives in systems (functions that run over every entity with a given set of components). This
page is about ecsia's defining feature: the same program runs single-threaded everywhere and
across a pool of worker threads where the host allows it — and the parallel result is
**bit-identical** to the serial one. Your queries, accessors, and single-threaded systems
never change shape; going parallel is a scheduler option, not a rewrite.

```ts
import { createWorld, defineComponent } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })

// Opt in at world construction: component columns get shared backings so
// worker threads can read and write them directly.
const world = createWorld({
  components: [Position],
  threaded: true,
  scheduler: { workers: 4 },
})
```

## Running on workers

Two things are yours to provide; ecsia automates the rest.

**1. A worker kernel module.** A function can't be handed to another thread, so the body of
each system you want running on workers lives in a small module that worker threads import.
It exports `buildWorkerKernels()`, returning your kernels keyed by system name (plus the
components they touch, keyed by component name — workers align ids through it):

```js
// kernels.js — imported by every worker thread.
import { defineComponent } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })

function moveKernel(view, indices, dt) {
  const id = Position.id
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    view.writeField(idx, id, 0, view.readField(idx, id, 0) + dt) // x += dt
  }
}

export function buildWorkerKernels() {
  return {
    kernels: new Map([['Move', moveKernel]]),
    components: new Map([['position', Position]]),
  }
}
```

**2. The `threading` option.** Point the scheduler at that module and `await update()`. The
scheduler creates and owns the worker pool — lazily, on the first update — derives the
dispatch list from its own plan, and runs each round's worker-eligible systems on the pool.
`dispose()` shuts the pool down.

```ts
import { createWorld, defineComponent, defineSystem, createScheduler } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], threaded: true, scheduler: { workers: 4 } })

// The system's declared reads/writes drive the schedule; its worker body is
// the 'Move' kernel in kernels.js, matched by name.
const Move = defineSystem({ name: 'Move', read: [], write: [Position], run() {} })

const scheduler = createScheduler(world, [Move], {
  threading: { kernelModule: new URL('./kernels.js', import.meta.url).href },
})

await scheduler.update(1 / 60) // worker rounds dispatch automatically
await scheduler.dispose() // terminate the pool when you're done
```

When worker execution isn't available — the world wasn't created `threaded: true`, the
environment has no `SharedArrayBuffer`, or the pool fails to start — `update()` warns once
and runs the same frame single-threaded from then on. Because the parallel result is
bit-identical to the serial one, the fallback changes your program's speed, never its
output.

::: tip Power users: bring your own pool
`scheduler.updateThreaded(pool, dt)` still accepts a hand-built `WorkerPool` for full
control over pool sizing, command-buffer capacity, and worker-entry overrides — pass it via
`threading: { pool }` to keep the unified `update()` call, or drive `updateThreaded`
directly. A pool you inject is yours to dispose.
:::

## How the scheduler derives waves

Every system declares which components it reads and which it writes (`{ read, write }`).
From those declarations the scheduler can tell when two systems **conflict**: one writes a
component the other reads, or both write the same component. In other words, two systems
conflict when one writes data the other touches — and then they can't safely run at the
same time. Systems with no such overlap are independent.

The scheduler builds a **conflict graph** out of those relationships and layers it into
**waves** — a wave is a batch of systems that can safely run at the same time because none
of them writes data another one touches. Within a wave, no two systems write the same data,
so they run concurrently; each wave's work is split into **worker batches** over component
columns backed by `SharedArrayBuffer` (memory several threads can read and write at once).
When one system needs to read what another writes, the reader lands in a later wave.

You never order systems by hand for correctness — the conflict graph does it. (Ordering
*hints* like `inAnyOrderWith`, `beforeWritersOf`, `afterReadersOf` exist to break ties, not
to enforce safety.)

You can inspect the derived waves with the [devtools](/guide/devtools) `explainPlan` —
it prints exactly which systems share a wave, which conflicts separated them, and which
systems are pinned to the main thread (they always run there, never on a worker).

### Forcing an order between systems

The conflict graph orders systems that share data. When two systems **don't** share data but you still
want a specific order — say a logger that must run *after* movement even though neither touches the
other's components — name it with **`before`** or **`after`**. Each takes the other systems (the
`defineSystem` values themselves), and the edge is honored regardless of conflicts:

```ts
import { defineComponent, defineSystem, write } from '@ecsia/kit'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'pos' })

const Move = defineSystem({
  name: 'Move',
  write: [Position],
  run({ query, dt }) {
    for (const e of query(write(Position))) e.pos.x += dt
  },
})

// LogPositions touches none of Move's components, so they'd otherwise share a wave — `after` forces it later.
const LogPositions = defineSystem({
  name: 'LogPositions',
  after: [Move],
  run() {
    // emit this frame's telemetry — a side effect, no component access
  },
})
```

`before: [X]` is the mirror — this system runs before `X`. Reference a system that isn't in
`createScheduler(world, [...])` and you get a clear error naming it. Unlike the coarse *hints*
(`inAnyOrderWith`, `beforeWritersOf`, `afterReadersOf`), `before`/`after` are exact, by-name edges —
reach for them only when you genuinely need a fixed order the data dependencies don't already give you.

### Declaring relation access

A **relation** — a link between two entities, from [Linking entities](/guide/relations) — isn't a
component, so the scheduler can't tell from a `read`/`write` of components that a system *touches* a
relation. To gate one, declare **`rel.access(R)`**: the handle that stands in for relation `R` in a
system's `read`/`write` list. A system that adds or removes `R` links declares it in `write`; a system
that queries `R` declares it in `read`. The scheduler then serializes them exactly as it would two
systems sharing a component — the writer runs in an earlier wave than the reader, so the reader always
sees the finished links.

```ts
import { createWorld, createRelations, defineSystem } from '@ecsia/kit'

const world = createWorld({})
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null) // a link with no payload (a tag relation)

// Adds/removes ChildOf links — declare WRITE access to the relation.
const Reparent = defineSystem({
  name: 'Reparent',
  write: [rel.access(ChildOf)],
  run() {
    // rel.addPair(child, ChildOf, parent) / rel.removePair(child, ChildOf, parent)
  },
})

// Walks the hierarchy via query(rel.Pair(ChildOf, …)) — declare READ access.
// The scheduler runs WalkHierarchy in a later wave than Reparent.
const WalkHierarchy = defineSystem({
  name: 'WalkHierarchy',
  read: [rel.access(ChildOf)],
  run() {
    // for (const e of query(rel.Pair(ChildOf, Wildcard))) { … }
  },
})
```

Pass the relation itself (`write: [ChildOf]`) and you get a clear error pointing you at
`rel.access` — a relation has no component identity of its own for the scheduler to gate on.

### A real plan, rendered

This is the **actual** `renderText(explainPlan(...))` output from running `examples/devtools-tour.ts`
(a Health/Burning/Position world with a rich `label` field and three systems — `Burn`, `Move`,
`Tagger`). Nothing here is hand-drawn; it is the verbatim text the renderer emits:

```text
== Waves ==
wave 0
  batch 0: Burn r:[] w:[health,burning]
wave 1
  batch 0: Move r:[burning] w:[position]
  batch 1: Tagger* r:[label] w:[health]

== Conflicts ==
a     b       on       kind
----  ------  -------  -----------
Burn  Move    burning  read-write
Burn  Tagger  health   write-write

== Pinned (main thread) ==
system  reason
------  -----------
Burn    main-thread
Move    main-thread
Tagger  rich-fields

(* = worker-ineligible)
```

Read it top to bottom:

- **`Burn` sits alone in wave 0** because it writes `health` and `burning`, and both later
  systems touch one of those. The `== Conflicts ==` table names exactly why: `Burn`↔`Move`
  collide on `burning` (read-write), `Burn`↔`Tagger` on `health` (write-write). Each conflict
  pushes the second system into a later wave.
- **`Move` and `Tagger` share wave 1** as two separate batches — they write different
  components (`position` vs `health`), so they could run concurrently within the wave.
- **`Tagger` is starred (`*`) and pinned `rich-fields`.** It reads the `label` component,
  which carries an `object<T>()` field — an arbitrary JS object rather than a number — so it
  is **worker-ineligible** (it can't run on a worker thread) and runs on the main thread.
  That is the kind of fact you'd otherwise discover only by profiling — `explainPlan`
  surfaces it up front.

## Two systems that write different components share a wave

```ts
import { defineComponent, defineSystem, write } from '@ecsia/kit'

const PositionA = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionA' })
const PositionB = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionB' })

// These two systems never write the same component,
// so they share a wave and split into two worker batches.
const UpdateA = defineSystem({
  name: 'UpdateA',
  read: [PositionA],
  write: [PositionA],
  run({ query, dt }) {
    for (const e of query(write(PositionA))) e.positionA.x += dt
  },
})
const UpdateB = defineSystem({
  name: 'UpdateB',
  read: [PositionB],
  write: [PositionB],
  run({ query, dt }) {
    for (const e of query(write(PositionB))) e.positionB.x += dt
  },
})
```

## What serial-equivalence means

The parallel result is **bit-identical** to the single-threaded result — the same entity
set, the same component values, and the same change events.

Here is where the determinism comes from. While a wave runs, structural changes (anything
that alters what components an entity has: spawning or despawning an entity — creating or
removing it from the world — adding or removing a component) and observer events (an
observer is a callback that fires when a component is added, removed, or changed) are not
applied immediately. Each worker stages them in its own **command buffer** — a queue of
changes applied later, at a safe point. When the wave ends, those buffers merge back in a
fixed order — worker 0's changes first, then worker 1's, and so on. So the outcome never
depends on which thread happened to finish first.

::: tip This is property-tested, not promised
"Property-tested" means the suite doesn't just check a few hand-picked cases — it generates
many random simulations and checks this on every one. Each one runs twice: through a real
`worker_threads` + `Atomics` pool (Atomics being the JS primitives threads use to coordinate),
and through the single-thread executor; the test then asserts the two resulting worlds are
byte-identical. Because going parallel is a dispatcher choice, not a change to your code's
shape, the equivalence is checkable — and it is checked.
:::

## Deployment requirements

### Browser: COOP/COEP for `SharedArrayBuffer`

The worker pool shares component columns over `SharedArrayBuffer`, which the browser only
exposes in a **cross-origin-isolated** context. Cross-origin isolation is two HTTP headers
your server opts into:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

When the context **isn't** cross-origin-isolated, `SharedArrayBuffer` doesn't exist, and the
worker pool cannot share columns by reference. ecsia logs a warning and runs the same systems
single-threaded — the fallback is loud, and no work is dropped.

### Node is the pool path today

::: warning Worker pool is Node-only right now
The OS-thread pool uses `worker_threads` + `Atomics` and runs under **Node `>=22.13`**. The
*same user code* runs single-threaded in every runtime; the multi-threaded executor is the
Node path. Browser `SharedArrayBuffer` parallelism is gated on the COOP/COEP headers above.
:::

## See also

- [Devtools → `explainPlan`](/guide/devtools) — visualise the waves, conflicts, and pins.
- [Saving and syncing](/guide/serialization) — the zero-copy worker bootstrap that hands columns to workers.
