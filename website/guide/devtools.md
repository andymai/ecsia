# Devtools

`@ecsia/devtools` is a **data layer first, renderers second**. `inspectWorld` / `explainPlan` /
`watchWorld` produce plain, serializable reports — no live handles, no class instances — so every fact
can be asserted in a headless test. `renderText` / `renderHTML` are pure functions over exactly those
report shapes.

::: tip Opt-in, and it reads the core world directly
`@ecsia/devtools` is **not** re-exported from `ecsia`, and nothing in the framework imports it —
it sits at the top of the dependency graph. Because `inspectWorld`/`watchWorld` read the world's
built-in inspection hooks, devtools consumes the `World` from `@ecsia/core` (the one that carries
those hooks), driven with `@ecsia/scheduler` + `@ecsia/relations` directly — the same wiring a real
devtools consumer uses, and the same wiring `examples/devtools-tour.ts` shows.

```sh
pnpm add @ecsia/devtools   # unpublished today — workspace-local for now
```
:::

## `inspectWorld` — a snapshot of world state

Devtools reads the world's built-in inspection hooks, which only the `@ecsia/core` `World` exposes —
so import `createWorld` from `@ecsia/core` (not the umbrella) for a world you intend to inspect.

```ts
import { createWorld } from '@ecsia/core'
import { inspectWorld } from '@ecsia/devtools'

const world = createWorld()
const report = inspectWorld(world)
report.entities.alive          // live entity count
report.components              // per-component: name, id, fields, rich fields, bytes/row, total
report.archetypes             // per-archetype: id, temperature, count, signature
report.queries                // matched queries: terms, archetype count, size
report.relations              // per-relation: name, pair count
report.memory                 // column bytes + sidecar entries
```

A quick vocabulary for reading the report: an archetype is the group of entities sharing the exact
same set of components — stored as one table. A query selects every entity with a given set of
components, with typed access to their fields. An archetype's temperature tells you how recently it
has seen activity (hot = recently active, cold = not).

## `explainPlan` — see the scheduler's waves

A wave is a batch of systems that can safely run at the same time because none writes data another
touches. `explainPlan(scheduler, componentNameMap(world))` returns the derived plan: which systems
share a wave, which conflicts separated them, and which systems are pinned to the main thread (and
why).

```ts
import { createWorld } from '@ecsia/core'
import { createScheduler } from 'ecsia'
import { explainPlan, componentNameMap } from '@ecsia/devtools'

const world = createWorld()
const scheduler = createScheduler(world, [])
const plan = explainPlan(scheduler, componentNameMap(world))
plan.waves        // each wave's batches and the systems in them
plan.conflicts    // pairwise: { a, b, on, kind } (read-write / write-write / …)
plan.pinned       // main-thread systems + reason ('main-thread' placement | 'rich-fields' ineligibility)
```

## `watchWorld` — per-frame deltas

`watchWorld(world, options)` produces a stream of plain `FrameDelta` records (entities/archetypes
created, etc.) you can assert on or render.

## Renderers: pure over the data layer

`renderText(report)` and `renderHTML(report)` accept either a `WorldReport` or a `PlanExplain` and emit
a string — no world access, no side effects.

```ts
import { createWorld } from '@ecsia/core'
import { createScheduler } from 'ecsia'
import { inspectWorld, explainPlan, renderText, componentNameMap } from '@ecsia/devtools'

const world = createWorld()
const scheduler = createScheduler(world, [])
console.log(renderText(inspectWorld(world)))
console.log(renderText(explainPlan(scheduler, componentNameMap(world))))
```

### `renderText` sample output

Running `examples/devtools-tour.ts` (a Health/Burning/Position world with a rich `label` field, a
`ChildOf` relation, and Burn/Move/Tagger systems) prints:

```text
== Entities ==
alive 4 / capacity 16384

== Components ==
name      id  fields  rich  bytes/row  total
--------  --  ------  ----  ---------  -----
health    1   1       -     4          16
burning   2   1       -     4          8
position  3   2       -     8          32
label     4   1       tag   0          0

== Archetypes ==
id  temp  count  signature
--  ----  -----  --------------------------
0   hot   0      (empty)
1   hot   1      health,position,label
2   hot   0      health,burning,position
3   hot   0      health,position
4   hot   2      health,burning,position,#5
5   hot   1      health,position,#5

== Queries ==
terms                          archetypes  size
-----------------------------  ----------  ----
write(health) write(burning)   2           2
write(position) read(burning)  2           2
read(label) write(health)      1           1

== Relations ==
name       pairs
---------  -----
Relation0  3

== Memory ==
columns 56 bytes, sidecar entries 1

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

Read it as: `Burn` writes `health`+`burning` in wave 0; `Move` and `Tagger` land in wave 1 (`Move` is
separated from `Burn` by a read-write conflict on `burning`, `Tagger` by a write-write on `health`).
`Tagger` reads the rich `label` field, so it is **worker-ineligible** (`reason: rich-fields`) — exactly
the kind of fact you'd otherwise have to discover the hard way.

## See also

- [Parallelism](/guide/parallelism) — what the waves and pins mean for the worker pool.
- `examples/devtools-tour.ts` — the asserted source of the output above.
