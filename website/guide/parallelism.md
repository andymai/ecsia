# Parallelism

ecsia's defining feature: **`threaded: true` changes no system, query, or accessor code.** The same
program runs single-threaded everywhere and across a worker pool where the host allows it — and the
parallel result is **bit-identical** to the serial one.

```ts
import { createWorld, defineComponent } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })

// Opt in at world construction. Systems, queries, and accessors are untouched.
const world = createWorld({ components: [Position], threaded: true })
```

## How the scheduler derives waves

Every system declares its `{ read, write }` component access. From those sets the scheduler builds an
**access-graph DAG**: two systems conflict when one writes a component the other reads or writes
(read-after-write, write-after-read, write-write). Non-conflicting systems are independent.

The scheduler then lays systems out in **waves**. Within a wave, systems have **disjoint write-sets**,
so they can run concurrently; each wave's work is split into **worker batches** over the
`SharedArrayBuffer`-backed columns. A read-after-write conflict pushes the reader into a later wave.

You never order systems by hand for correctness — the conflict DAG does it. (Ordering *hints* like
`inAnyOrderWith`, `beforeWritersOf`, `afterReadersOf` exist to break ties, not to enforce safety.)

You can inspect the derived waves with the [devtools](/guide/devtools) `explainPlan` —
it prints exactly which systems share a wave, which conflicts separated them, and which systems are
pinned to the main thread.

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

- **`Burn` sits alone in wave 0** because it writes `health` and `burning`, and both later systems
  touch one of those. The `== Conflicts ==` table names exactly why: `Burn`↔`Move` collide on
  `burning` (read-write), `Burn`↔`Tagger` on `health` (write-write). Each conflict pushes the second
  system into a later wave.
- **`Move` and `Tagger` share wave 1** as two separate batches — their write-sets (`position` vs
  `health`) are disjoint, so they could run concurrently within the wave.
- **`Tagger` is starred (`*`) and pinned `rich-fields`.** It reads the `label` component, which carries
  an `object<T>()` field, so it is **worker-ineligible** and runs on the main thread. That is the kind
  of fact you'd otherwise discover only by profiling — `explainPlan` surfaces it up front.

## Two disjoint-write systems share a wave

```ts
import { defineComponent, defineSystem, write } from 'ecsia'

const PositionA = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionA' })
const PositionB = defineComponent({ x: 'f32', y: 'f32' }, { name: 'positionB' })

// Disjoint write-sets ⇒ same wave ⇒ split into two worker batches.
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

The parallel result is **bit-identical** to the single-threaded result — the same entity set, the same
component values, and the same reactivity deltas. Determinism comes from a **fixed worker-index
command-buffer merge**: structural mutations and observer events stage per worker and merge back in a
fixed order, so the outcome never depends on which worker happened to finish first.

::: tip This is property-tested, not promised
A serial-equivalence **property test** runs the same systems through a real `worker_threads` + `Atomics`
pool and through the single-thread executor, then asserts the two worlds are byte-identical. The
parallel path is a dispatcher choice, not a code-shape change — so the equivalence is checkable, and it
is checked.
:::

## Deployment requirements

### Browser: COOP/COEP for `SharedArrayBuffer`

The worker pool shares component columns over `SharedArrayBuffer`, which the browser only exposes in a
**cross-origin-isolated** context. That means serving your app with both headers:

```ts no-check
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

When the context **isn't** cross-origin-isolated, ecsia falls back to a `postMessage` transport rather
than failing silently — the same systems still run, just without the zero-copy SAB fast path.

### Node is the pool path today

::: warning Worker pool is Node-only right now
The OS-thread pool uses `worker_threads` + `Atomics` and runs under **Node `>=22.13`**. The *same user
code* runs single-threaded in every runtime; the multi-threaded executor is the Node path. Browser SAB
parallelism is gated on the COOP/COEP headers above.
:::

## See also

- [Devtools → `explainPlan`](/guide/devtools) — visualise the waves, conflicts, and pins.
- [Serialization](/guide/serialization) — the zero-copy worker bootstrap that hands columns to workers.
