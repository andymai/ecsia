# ecsia Implementation Spec — Build Plan & Milestone Roadmap

> Ordered milestone roadmap (M0..M12) with explicit inter-milestone dependencies, the spec
> modules each milestone implements, its Vitest unit + fast-check property + benchmark exit
> criteria, and the pnpm-monorepo package each module lives in.
>
> **Load-bearing ordering constraint (LOCKED):** the kernel must be **correct single-threaded
> first**. Worker dispatch, the SAB Atomics wave-sync, and the command-buffer apply path land
> together at **M7** — and **nothing** depends on workers before M7. M0–M6 produce a fully
> functional, fully tested, single-threaded ECS; M7 turns on parallelism over the same data
> structures without changing their semantics. This mirrors the report (`DESIGN-RESEARCH.md
> §5.2`) and the locked decision that becsy's executor was a stub (`becsy/src/dispatcher.ts:130-132`)
> and the worker layer is the single largest implementation risk — so it is gated behind a
> proven serial core.
>
> Provenance: `DESIGN-RESEARCH.md §5` (monorepo layout + build sequence), `§6` (hard-problem
> specs that gate specific milestones), `§7` (the five must-fix protocols), and the full set of
> thirteen module specs: the keystone `world.md` plus `public-api.md`, `entity-model.md`,
> `memory-buffers.md`, `type-system.md`, `component-schema.md`, `archetype-storage.md`,
> `relations.md`, `reactivity.md`, `scheduler.md`, `command-buffer.md`, and `serialization.md`.

---

## 0. How to read this document

Each milestone `Mn` lists:

- **Implements** — the spec module(s) and the concrete API surface delivered.
- **Package(s)** — where the code lives (§1 layout).
- **Depends on** — the milestone(s) that must be complete first (hard edges only).
- **Gated by** — the §6 hard-problem spec(s) whose protocol must be finalized before this
  milestone may start (`§6` numbering = the report's `§7.x` hard-problem sections).
- **Exit criteria** — three buckets, all of which must pass to close the milestone:
  - **Unit (Vitest)** — example-based tests of the API surface.
  - **Property (fast-check)** — invariant tests; the report's archetype/query/codec invariants
    are encoded as fast-check properties so randomized op sequences cannot violate them.
  - **Bench (Vitest `bench` / tinybench harness)** — throughput/latency targets, the
    cross-library ones stated relative to **miniplex** and **bitECS** baselines (and becsy
    where it has a shipping path; becsy has no worker path to compare against — that is the
    gap ecsia fills).

A milestone is **not** closed until all three buckets are green in CI. The cross-cutting
invariants (`I1..I10`, `V-1..V-2`, `SIG-1`, `AR-1`, `EDGE-1`, `ROW-1`, `MIG-1/2`, `BM-1..3`,
`ACC-1`, `P1..P10`, `R-1..R-9`) from the module specs are mapped to the property suites below.

---

## 1. pnpm monorepo package layout

ESM-only, strict TS, project references, `"type": "module"`, Node ≥ 20 (resizable SAB,
`Atomics.waitAsync`). Layout follows `DESIGN-RESEARCH.md §5.1` with the spec modules mapped to
packages.

```
ecsia/
  pnpm-workspace.yaml
  tsconfig.base.json              # strict:true, ESM, composite project refs, no emit-on-error
  vitest.workspace.ts             # per-package Vitest projects + a node-worker pool project
  packages/
    core/                         # @ecsia/core — the single-threaded kernel; no runtime deps
      src/
        entity/                   # entity-model.md  -> handle codec, free-list, EntityRef, records
        memory/                   # memory-buffers.md -> Column/Region, Backing, capabilities probe
        bitmask/                  # archetype-storage.md (bitmask part) -> membership index (main-thread)
        storage/                  # archetype-storage.md -> archetype tables, edge graph, migrate, cold store
        component/                # type-system.md (runtime) -> defineComponent, accessor factory-closure
        query/                    # query DSL runtime, LiveQuery, sparse-set results, hash cache
        reactivity/               # reactivity.md -> write/shape logs, LogPointer, changeVersion, observers
        world.ts                  # world.md -> createWorld, WorldOptions, phase/tick, reserved ids, wiring order
    schema/                       # @ecsia/schema — type-system.md (type-level) field tokens + inference
                                  #   (type-only; may fold into core/component — kept separate for tsc budget)
    relations/                    # @ecsia/relations — relations.md -> defineRelation, pair IDs, presence bit,
                                  #   exclusive column + non-exclusive overflow table, back-ref, cascade, depth
    scheduler/                    # @ecsia/scheduler — access graph, waves, worker dispatch, command buffers
      src/
        graph/                    # priority-weighted DAG, transitive reduction, cycle detection
        planner/                  # access collection, topo-layering, type-level conflict (v1)
        executor/                 # single-threaded wave executor (M6) — correct before workers
        workers/                  # SAB transfer, wave dispatch, Atomics tiers + postMessage fallback (M7)
        commands/                 # command-buffer encode (worker) + serial merge/apply (main) — §6.1
    serialization/                # @ecsia/serialization — snapshot, version-stamp delta, observer log, remap
    ecsia/                        # @ecsia/ecsia — batteries-included umbrella re-export
  bench/                          # cross-library benches vs miniplex / bitECS (+ internal regression benches)
  examples/                       # boids, scene-graph hierarchy, worker-parallel sim
  docs/spec/*.md                  # the module specs + this build plan
```

**Module → package map (authoritative — all 13 specs):**

| Spec module            | Package(s)                                                  | Milestone |
|------------------------|------------------------------------------------------------|-----------|
| `world.md` (keystone)  | `@ecsia/core` (`world.ts`)                                  | M0 (scaffold) → M1–M6 (filled per layer) |
| `entity-model.md`      | `@ecsia/core` (`entity/`)                                   | M1        |
| `memory-buffers.md`    | `@ecsia/core` (`memory/`)                                   | M2        |
| `type-system.md`       | `@ecsia/schema` (types) + `@ecsia/core` (`component/` runtime) | M2 (runtime) / M4 (query types) / M11 (arity budget) |
| `component-schema.md`  | `@ecsia/core` (`component/`) + `@ecsia/schema`              | M2        |
| `archetype-storage.md` | `@ecsia/core` (`storage/` + `bitmask/`)                     | M3        |
| query DSL/runtime      | `@ecsia/core` (`query/`) + `@ecsia/schema` (query types)   | M4        |
| `reactivity.md`        | `@ecsia/core` (`reactivity/`)                               | M5        |
| observers (deferred)   | `@ecsia/core` (`reactivity/`) — drained by scheduler slot   | M5 / M9   |
| `scheduler.md`         | `@ecsia/scheduler` (`graph/`, `planner/`, `executor/`, `workers/`) | M6 (serial) / M7 (workers) |
| `command-buffer.md`    | `@ecsia/scheduler` (`commands/`)                            | M6 (format) / M7 (apply) |
| `relations.md`         | `@ecsia/relations`                                          | M8        |
| `serialization.md`     | `@ecsia/serialization`                                     | M10       |
| `public-api.md`        | `@ecsia/ecsia` (umbrella re-export)                         | M12       |

**Dependency direction (acyclic):** `schema` (leaf, type-only) ← `core` ← {`relations`,
`scheduler`, `serialization`} ← `ecsia`. The kernel (`core`) runs **without** `scheduler`
(scheduler is an opt-in layer; `DESIGN-RESEARCH.md §5.1`). The command-buffer **data format**
is owned by `scheduler/commands` but its apply path calls into `core/storage` + `core/entity`
(`commitRecord`, `isAlive`, `spawn`/`despawn`) and `core/reactivity` (log emit) — so the format
is a shared contract declared in `scheduler/commands` and consumed by `core`.

---

## 2. Milestone roadmap (M0 → M12)

### M0 — Foundations, harness & keystone scaffold

**Implements:** the `world.md` keystone scaffold + repo scaffolding. pnpm workspace,
`tsconfig.base.json` (strict, ESM, project refs), `vitest.workspace.ts`, fast-check wired into
every package's test project, the `bench/` harness (tinybench/Vitest `bench`) with **miniplex
and bitECS installed as devDependencies** so cross-library baselines run in the same process,
and a **headless worker test rig** (Node `worker_threads` + a browser-emulation lane). becsy
never tested its SAB paths (`becsy/src/dispatcher.ts:130-132`); ecsia validates SAB round-trips
from M0.

This milestone also lands the **`world.md` keystone scaffold** in `@ecsia/core` (`world.ts`):
the `WorldOptions` shape (CANON nested `reactivity:{}` / `scheduler:{}`, `maxEntities` default
`1 << 20`), the resolved-defaults table, the reserved-`ComponentId` constants
(`NO_COMPONENT = 0`, `FIRST_USER_COMPONENT_ID = 1`), and the `world.phase`/`world.tick`
contracts as typed stubs with option-validation fail-fast. The wiring/initialization order
(registry → buffers → storage → reactivity → queries → scheduler → serialization, world.md §7)
is laid down as the assembly skeleton each later milestone fills in, so every module has a
defined seam to slot into.

**Package(s):** repo root + every package skeleton + `@ecsia/core` (`world.ts` scaffold).

**Depends on:** nothing.

**Gated by:** **G-6 (world.md)** — the keystone spec must be authored before its scaffold lands
(it is: world.md is the keystone, resolving G-6).

**Exit criteria:**

- **Unit:** `pnpm -r build` type-checks all packages clean; `pnpm -r test` runs an empty green
  suite per package; a smoke test allocates a `SharedArrayBuffer`, `.grow()`s it, and reads it
  back across a `worker_threads` boundary (proves the rig + resizable-SAB capability);
  `createWorld({})` resolves the CANON defaults (`maxEntities === 1 << 20`,
  `reactivity.observerCadence === 'frame-end'`) and `world.phase === 'serial'` /
  `world.tick === 0` at construction (world.md §2.3, §4.1, §8); an invalid option
  (e.g. `generationBits` not summing to 32) throws `ConfigError` fail-fast (world.md §7).
- **Property:** a fast-check smoke property (`fc.assert` over `fc.integer()`) proves the runner
  is wired in CI and shrinking works.
- **Bench:** the harness runs a no-op bench and emits a JSON report; a CI job runs the same
  harness with **`crossOriginIsolated`/SAB disabled** to exercise the no-SAB lane from day one
  (`DESIGN-RESEARCH.md §5.2 M0`, `§6.3`).

---

### M1 — Entity layer

**Implements:** `entity-model.md` in full — branded `EntityHandle` u32 codec
(`makeHandle`/`handleIndex`/`handleGeneration`, default 22 index / 10 generation, configurable
`HandleLayout`), the dense/sparse swap-and-move free-list (`allocEntity`/`freeEntity`),
`isAlive` (dense[sparse[index]]===h, **never** the bitmask), the two-word entity record
(`recordArchetypeId`/`recordArchetypeRow`) + `commitRecord`/`resolveLocation`, the pooled
`EntityRef` identity carrier (read/write installed later by M2), and the
`reserveEntityBlock`/`returnReservedIds` worker-ID handshake (layout shipped now; the atomic
take path is exercised at M7). `World.spawn`/`despawn`/`isAlive`/`entity` plus
`encodeHandle`/`decodeHandle`/`handleStats`.

**Package(s):** `@ecsia/core` (`entity/`). Identity/record arrays allocated via `memory/`'s
`BackingStore.allocU32` — so a minimal slice of M2's memory layer (the `allocU32`
length-tracking-view primitive only) is co-delivered here.

**Depends on:** M0.

**Gated by:** nothing (single-thread, no growth-of-columns yet).

**Exit criteria:**

- **Unit:** spawn/despawn/`isAlive` lifecycle; `despawn` idempotent on dead handle (**I8**);
  handle codec round-trip on hand-picked bit patterns; `resolveLocation` returns committed
  `(archetypeId,row)`; generation bump on free; `NO_ENTITY`/`ARCHETYPE_NONE` sentinels;
  `generationBits===0` rejected when `threaded===true`.
- **Property (fast-check):**
  - **I1 codec round-trip:** for random `(index ∈ [0,maxIndex], generation ∈ [0,maxGeneration])`,
    `handleIndex(makeHandle(i,g))===i ∧ handleGeneration(...)===g`.
  - **I2:** for random valid `HandleLayout`, `indexBits + generationBits === 32`.
  - **I3/I4 staleness:** random `spawn`/`despawn` op sequence — an old handle is stale after its
    slot is recycled, and stays stale until exactly `2^generationBits` recycles of that exact
    slot (model-based test against a reference free-list model).
  - **I8:** `despawn` applied twice on any handle in a random sequence is a no-op.
  - Free-list density invariant: alive prefix `[0,aliveCount)` and free region
    `[aliveCount,denseLen)` are disjoint and cover `dense` for any op sequence.
- **Bench:** `alloc`/`free` throughput target **≥ bitECS `addEntity`/`removeEntity`** (bitECS
  swap-and-move is the borrowed design, `bitECS/src/core/EntityIndex.ts:104-165`); `isAlive`
  point-check ≤ 2 array loads; zero per-op heap allocation (allocation-count assertion).

---

### M2 — Memory, buffers & accessors

**Implements:** `memory-buffers.md` in full + the accessor-factory half of `type-system.md`.
`Column`/`ColumnLayout`/`Region`, the `Backing` selection (`probeCapabilities`/`selectBacking`,
the four `BackingStrategy` modes), `Buffers.column`/`region`/`grow`, **length-tracking views
over resizable backings (V-1)** as the primary growth path, the `ViewHolder.__rebind`
live-accessor registry as the **fallback** path, and the field-type → `ColumnLayout` table
(`eid`→i32 with −1 sentinel, `staticString`→smallest uint, `vecN`→stride n, `object<T>`→no
column). Plus the **factory-closure accessor class** (`AccessorFactory<S>`, one hidden class
per `(archetype,component)`, closing over column views, reading a mutable `__idx`), the
`entity.read(C)`/`entity.write(C)` split installed on `EntityRef.prototype`, and the
`trackWrite` setter side-effect call-site (the function is stubbed until M5).

**Package(s):** `@ecsia/core` (`memory/`, `component/`) + `@ecsia/schema` (field tokens +
`FieldValue`/`ReadView`/`WriteView` type-level inference, **one component at a time**).

**Depends on:** M1.

**Gated by:** **§6.2 (report §7.2)** — the SAB-view-invalidation protocol. This must be
finalized (it is: length-tracking primary, registry fallback) before M2 starts. Resolves
**Must-Fix #5**.

**Exit criteria:**

- **Unit:** `defineComponent` infers `ReadView`/`WriteView`; the bare `entity.position`
  shorthand is `Readonly` (assignment is a TS2540 compile error — verified by a `tsd`/expect-error
  fixture); `entity.write(Position).x = 5` mutates the column; eid columns initialize new + grown
  rows to `−1` not `0` (**C-2**); one large `allocBacking` site decides SAB vs AB (**B-1**).
- **Property (fast-check):**
  - **V-1 (the load-bearing one):** for a random sequence of `.grow()` calls interleaved with
    writes, every view captured **before** any grow still reads back the value written **after**
    the grow at high rows — i.e. captured accessor closures auto-widen. A negative control
    constructs a view *with* an explicit length and asserts it does **not** widen (proving the
    test discriminates).
  - **C-1:** `view.length === capacity()*stride` at every serial-phase observable point across
    random grow sequences.
  - **B-2:** SAB identity of a column is stable across growth on the primary path (same
    `.buffer` reference before/after `.grow()`).
  - Round-trip per field type: random values through `encode`/`decode` for every `ElementKind`
    + `staticString` + `eid` (`−1`↔null).
- **Bench:** **monomorphic accessor read beats an ES-Proxy baseline** (the locked rejection of
  Proxy, `becsy/src/type.ts:72-93`) — target ≥ 3× on a tight `position.x` read loop; hidden-class
  stability verified (V8 `%HaveSameMap` or a megamorphic-deopt regression bench); **post-grow
  accessor-validity bench** (write through a pre-grow accessor, read after grow, zero
  regeneration on the primary path). Column sequential-read throughput within 10% of a raw
  `Float32Array` loop.

---

### M3 — Archetype storage + bitmask index

**Implements:** `archetype-storage.md` in full (single-threaded). `Signature`
(`canonicalize`/`sigEquals`/`sigHash`/`sigWithAdded`/`sigWithRemoved`), `Archetype` +
`ColumnSet` (one accessor per `(archetype,component)` built once via `def.accessorFactory`),
`getOrCreateArchetype` interning, the **lazy edge graph** (`edgeAdd`/`edgeRemove`,
both-directions cache), `allocRow`/`removeRow` shuffle-pop, `migrate`
(K-shared-column copy + init-added + shuffle-pop + `commitRecord` + `bitmaskApplyDelta`),
`spawnWith`, the **main-thread-only per-entity bitmask** (`bitmaskHas`/`has`/`bitmaskApplyDelta`/
`entityShapeWords`, every access asserts `phase==='serial'`), `signatureMatches`/`sigHas` query
primitives, and the `ColdStore` + `world.warm` fallback scaffolding (cold path correctness
proven here; relation-driven fragmentation exercised at M8).

**Package(s):** `@ecsia/core` (`storage/`, `bitmask/`).

**Depends on:** M1 (records, `commitRecord`, lifecycle hooks), M2 (`Column`, `Buffers`,
length-tracking views, `AccessorFactory`).

**Gated by:** nothing new (migration is synchronous main-thread here; the worker-deferred path
is M7). Honors **Must-Fix #1** (bitmask serial-only) and **Must-Fix #5** (ACC-1).

**Exit criteria:**

- **Unit:** add/remove component drives the expected migration; tag/zero-field components
  contribute no `ColumnSet`; `world.warm(sig)` promotes a cold archetype; `EMPTY_ARCHETYPE_ID`
  spawn path.
- **Property (fast-check) — the archetype invariant suite:**
  - **SIG-1:** every `Signature` produced by any op sequence is sorted-ascending + deduped.
  - **AR-1 (interning):** adding components in any random order yields the **same** `Archetype`
    object for structurally-equal signatures.
  - **EDGE-1:** the 2nd+ `edgeAdd`/`edgeRemove` for the same `(arch,c)` is O(1) (cache-hit
    asserted via an instrumented counter); first miss caches add + reverse remove.
  - **ROW-1:** after any random `allocRow`/`removeRow` sequence, rows+columns stay dense over
    `[0,count)`, `count` is correct, and `fixSibling` fires exactly once iff `row!==count-1`.
  - **MIG-1:** `migrate` writes exactly 2 record words for the migrant + at most 1 (row) for the
    shuffle-popped sibling (instrumented `commitRecord` counter).
  - **BM-2 (coherence):** after **every** structural op in a random sequence,
    `bitmaskHas(i,c) === sigHas(currentSignature(i),c)` for all alive entities.
  - **BM-1 (serial-only):** any bitmask access with `phase!=='serial'` throws — fuzzed by
    randomly flipping the phase flag (this is the Must-Fix #1 guard; reinforced at M7).
  - Cold-store equivalence: a query over a forced-cold archetype yields the **same entity set**
    as the same archetype kept hot (FRAG-1).
- **Bench:** migration cost is **O(K shared + added)**, independent of `arch.count` (MIG-2) —
  bench migration at counts 10/1k/100k and assert flat per-entity cost; edge-graph hit makes the
  2nd transition **≥ 10× faster** than the first (cold-compute) transition; per-archetype
  signature match (one AND per word) benched as O(A), **not** O(entities).

---

### M4 — Queries

**Implements:** query DSL runtime + per-archetype matching, `LiveQuery`, the
`matchingArchetypes` pointer cache, the canonical-hash query cache (`Map<hash,LiveQuery>`,
hash **encodes pair-target IDs**), the SAB-capable `Uint32Array` sparse-set `current` result
container, the **single-entity incremental matcher** (`matchEntity` over `entityShapeWords`,
used only for re-testing one migrated entity — not the iteration path), and the query-arity
overload family (1–8 fully inferred, 9+ → typed `LooseQueryElement`, `MAX_QUERY_ARITY=8`).

**Package(s):** `@ecsia/core` (`query/`) + `@ecsia/schema` (query DSL types,
`QueryElement`/`UnionToIntersection` fold).

**Depends on:** M3 (`signatureMatches`, `matchingArchetypes`, `archetypeCreated` hook,
`entityShapeWords`), M2 (column views for iteration).

**Gated by:** **§6.5 (report §7.5)** arity-cap design must be settled (it is: cap 8 + escape
hatch); the compile-time **budget assertion** itself is deferred to M11.

**Exit criteria:**

- **Unit:** `query([read(A), write(B), With(C), Without(D)])` matches the right archetypes;
  `.each` iterates `0..count` per matching archetype with direct column access; cache-hit
  returns the same `LiveQuery` for an identical (re-ordered) term set; `optional` terms.
- **Property (fast-check):**
  - **Match equivalence:** for random component universes + random entities, the per-archetype
    iteration result set equals a brute-force per-entity `signatureMatches` oracle (proves the
    O(A) path matches the O(N) oracle).
  - **Incremental-maintenance equivalence:** after a random single migration, `matchEntity`
    re-test yields the same membership as a full re-scan for every query referencing the changed
    component.
  - **Hash canonicality:** term sets that differ only in order hash identically; sets differing
    in any Not/Or/pair-target hash differently (no collisions over a fuzzed corpus).
  - Sparse-set `current` add/remove/has invariants under random churn (dense iteration, no dup).
- **Bench:** query iteration throughput on a packed archetype **≥ bitECS** and **≥ miniplex** on
  the canonical "iterate N entities with Position+Velocity" loop (bitECS SoA is the SoA baseline;
  miniplex is the JS-object baseline ecsia must beat on iteration); archetype-match cost benched
  as **O(A)** (vary A at fixed N, assert match time independent of N).

---

### M5 — Reactivity

**Implements:** `reactivity.md` in full (single-threaded). `trackWrite` (O(1) write-log ring
push, no Atomics), `trackShape`/`trackShapePair` (two-word shape-log at structural commit),
`changedSince`/`changedRows`/`currentTick` over **lazily-allocated** per-row `changeVersion`,
`observe`/`onAdd`/`onRemove`/`onChange` **deferred** observers (fired only at a serial slot —
never synchronously), `LogPointer` + `CONSUME` per-consumer cursors, the query-flavor hooks
(`attachFlavors`/`drainChanged`), the lifecycle call order
(`frameReset`/`mergeCorrals`/`maintainStructural`/`observerDrain`/`flushLogs`), and the
**recoverable spill** on ring overflow (no hard throw). Per-worker `corral` staging is
allocated now but only merged trivially (single "worker" = main thread) until M7.

**Package(s):** `@ecsia/core` (`reactivity/`).

**Depends on:** M2 (`trackWrite` call-site in the accessor setter, now implemented), M3
(`trackShape` at the structural commit point; `changedRows` over archetype rows), M4 (query
flavors integrate with `LiveQuery`).

**Gated by:** nothing new. Honors **Must-Fix #2** (the `.changed` filter is driven by
`trackWrite` from the mutable setter; the Readonly shorthand never tracks) and the destroy
ordering (**R-8**: `trackShape(Destroy)` before identity invalidation).

**Exit criteria:**

- **Unit:** `onChange(C)` fires for a tracked `write(C)` but **not** for a read through the
  Readonly shorthand (**Must-Fix #2 / R-2**); observers fire only during `observerDrain`, never
  mid-system (**R-3**); `changedSince(h, t)` strict `> since`; field-vs-component granularity opt-in.
- **Property (fast-check):**
  - **R-2 mechanism separation:** the `.changed` *filter* (write-log driven) and the public
    `.changed`-since-tick *predicate* (changeVersion driven) agree on which entities changed for
    any random write sequence, yet never read each other's mechanism.
  - **R-9 coalescing:** add-then-remove of the same component within one frame yields **no** net
    added/removed delta (single deferred drain).
  - **R-5 recoverable overflow:** force the ring past capacity with a random burst — no entry is
    lost (ring + spill, drained in chronological order); the public delta is identical to a
    same-sequence run that never overflowed.
  - **R-1 no per-field atomic:** instrument the `trackWrite` chain and assert **zero** `Atomics.*`
    calls on the write-log push path across a fuzzed write sequence.
- **Bench:** `trackWrite` adds ≤ one ring store to the setter (write-loop throughput within ~10%
  of the no-tracking M2 baseline); a `changed`-filtered query scan touches only logged entries,
  not all rows (sub-linear in archetype size when few entities changed); observer drain cost is
  O(changes × subscribed-handlers), not O(entities).

---

### M6 — Scheduler (single-process, the correct serial executor)

**Implements:** the scheduler **graph + planner + serial executor** — access collection from
typed `{read,write}` query declarations (`Map<ComponentId,Set<SystemId>>`, pair IDs as
component IDs), the priority-weighted DAG (5 explicit before/after, 3 component-class, 1
implicit write-before-read), Floyd-Warshall closure + transitive reduction + DFS cycle
detection with named-chain error reporting, **topological wave extraction** with **type-level
conflict** (v1, T5), and a **single-threaded `executor/`** that runs waves in order on the main
thread. **No workers, no Atomics, no command buffers execute here** — but the command-buffer
**encoding format** and the access-declaration API are defined so M7 is purely additive. This
is the "correct single-threaded executor first" milestone (`DESIGN-RESEARCH.md §2.5`,
`dispatcher.ts:130-132` is the becsy stub ecsia replaces).

**Package(s):** `@ecsia/scheduler` (`graph/`, `planner/`, `executor/`; `commands/` format
declared, apply path stubbed to direct main-thread application).

**Depends on:** M4 (queries supply read/write access masks), M5 (systems observe reactivity
deterministically at wave/frame boundaries).

**Gated by:** nothing new. Honors **Must-Fix #2** (declared write-intent is the contract).

**Exit criteria:**

- **Unit:** a system set produces the expected wave layering; a write-before-read pair is
  ordered; a cycle reports the full named chain + a suggested break edge; `entity.write(C)` calls
  in a system whose declaration omits `C` are flagged (dev-mode assertion).
- **Property (fast-check):**
  - **Determinism:** for a random DAG of systems with random `{read,write}` sets, the serial
    executor produces a **deterministic, repeatable** execution order across runs.
  - **Topological soundness:** every executed order is a valid topological order of the reduced
    DAG; no system runs before a system it write-before-reads.
  - **Conflict correctness:** two systems placed in the same wave always have disjoint write-sets
    and neither reads the other's writes (type-level conflict, T5) — checked against an
    independent conflict oracle over random access sets.
  - **Cycle detection:** any randomly-injected cycle is detected (no false negatives) and any
    acyclic graph is never reported as cyclic (no false positives).
- **Bench:** graph build (Floyd-Warshall + reduction) **< 1ms for < 100 systems**
  (`DESIGN-RESEARCH.md §2.5`); serial wave execution overhead per frame is O(waves + systems),
  negligible vs system bodies; a full single-threaded sim (boids) runs end-to-end and its
  per-frame cost is dominated by user system code, not scheduling.

---

### M7 — Workers, Atomics wave-sync & command buffers  ⟵ the becsy gap, highest risk

**Implements:** the parallel execution layer over the **unchanged** M0–M6 data structures.
`scheduler/workers/`: SAB allocation + one-time transfer of columns/regions to a fixed worker
pool at startup, the **wave dispatch loop**, and the **three-tier wait strategy** (`§6.3` /
report `§7.3`): (1) `Atomics.waitAsync` on a capable browser main thread, (2) blocking
`Atomics.wait` on a coordinator/worker thread or Node main, (3) Promise-polling fallback;
plus the **no-SAB postMessage fallback** (Transferable column hand-off, single-thread default
when `crossOriginIsolated===false`, **never silent failure**). `scheduler/commands/`: the
per-worker plain-`Uint32Array` command buffers (`OP_CREATE`/`DESTROY`/`ADD`/`REMOVE`/
`ADD_PAIR`/`REMOVE_PAIR`), the pre-reserved entity-ID block handshake (`reserveEntityBlock` via
`Atomics.sub`, the M1 layout now exercised), **deterministic merge in fixed worker-index order**
between waves, and the **validate-then-apply, drop-if-dead** entity-reference safety rule. The
apply path drives `core/storage.migrate` + `core/entity.spawn`/`despawn` + `core/reactivity`
log emit serially on the main thread.

**Package(s):** `@ecsia/scheduler` (`workers/`, `commands/`).

**Depends on:** M6 (waves + access graph), M3 (the serial structural-mutation path the apply
step reuses), M5 (log emit on apply), M1 (`reserveEntityBlock`/`returnReservedIds`).

**Gated by:** **§6.1 (report §7.1) command buffers** AND **§6.3 (report §7.3) Atomics +
no-SAB fallback** — both must be finalized before M7 starts. Resolves **Must-Fix #1** (workers
read tables only, never the bitmask) and **Must-Fix #3** (command-buffer layout/flush/merge).

**Exit criteria:**

- **Unit:** a 2–4 worker pool runs a disjoint-write wave with bit-identical results to the M6
  serial executor; `crossOriginIsolated===false` startup emits a diagnostic and runs
  single-threaded (or postMessage fallback when requested); each wait tier is unit-selected by a
  forced capability probe; `OP_DESTROY` of an already-dead entity is a no-op.
- **Property (fast-check) — the parallelism safety suite:**
  - **Serial-equivalence (the headline invariant):** for a random system+entity workload, the
    multi-worker result (entity set, component values, reactivity deltas) is **identical** to the
    single-threaded M6 result — determinism under fixed worker-index merge despite nondeterministic
    completion order.
  - **Command-buffer entity-reference safety (fuzzed, the M7-gating fuzz test):** randomly
    interleave commands where one worker references an entity another worker destroys in the same
    flush — every dangling reference is **dropped**, never applied to a recycled slot; `OP_ADD_PAIR`
    with a dead target is dropped; reserved-ID create-then-use chains within a flush always succeed.
  - **No worker bitmask access (Must-Fix #1):** instrument the bitmask module; assert **zero**
    bitmask reads occur off the main thread / during a wave across a fuzzed multi-worker run.
  - **No mid-wave structural mutation (CO-1):** assert no archetype `count`/`rows`/record/bitmask
    word is mutated while `phase==='wave'`.
- **Bench:** a real multi-worker sim (e.g. N-body or particle update with disjoint writes) shows
  **near-linear speedup** to the core count on the SAB path vs the M6 single-thread baseline;
  per-wave sync latency dominated by one notify wakeup (tier 1), not polling; **this is the
  capability becsy designed but never shipped** — the bench is the proof-of-existence, with no
  cross-library baseline because none exists (miniplex/bitECS have no auto-parallel worker path).

---

### M8 — Relations

**Implements:** `relations.md` in full. `defineRelation` (tag / exclusive-column /
overflow-table via `resolveStorageKind`), eager `mintPair` (index-keyed `pairKey64`, O(1),
idempotent), `addPair`/`removePair` (non-exclusive = `migrateAddingMany` pair+presence in one
move; **exclusive re-target = in-place eid column write, no migration**), `hasPair`/`hasRelation`,
`getPair` monomorphic accessor, the **per-relation presence bit** for **O(1) wildcard**
(`Pair(R,Wildcard)`), the **main-thread sparse back-ref index** + iterative-BFS cascade
(`onPreDespawn`, `'none'|'removeRelation'|'deleteSubject'`), the **non-exclusive overflow
payload table**, lazy hierarchy `depthOf`, and the worker command-apply path for
`OP_ADD_PAIR`/`OP_REMOVE_PAIR` with **drop-if-dead on subject OR target**.

**Package(s):** `@ecsia/relations`.

**Depends on:** M7 (the relation design is validated against **real worker/SAB constraints** and
the command-apply path — `DESIGN-RESEARCH.md §5.2` order rationale: M7 precedes M8), M3
(`migrateAddingMany`, synthetic ComponentId minting, cold-store fallback), M4 (presence/pair-ID
query resolution + canonical hash), M5 (writeLog on `getPair().write()`).

**Gated by:** **§6.4 (report §7.4) fragmentation + cold-archetype fallback** must be finalized
(it is: exclusive-as-column eliminates scene-graph blow-up; presence bit keeps wildcard O(1);
cold store for residual non-exclusive blow-up). Resolves **Must-Fix #4** (payload exclusivity
split).

**Exit criteria:**

- **Unit:** exclusive `ChildOf` re-parent is a field write (assert **zero migrations**, **P3**);
  cascade `deleteSubject` removes a subtree; `getPair(s,Damage,t).weight` reads/writes the
  overflow row; `Pair(R,Wildcard)` matches all holders of any R-pair.
- **Property (fast-check):**
  - **P1 presence invariant:** after any random pair add/remove sequence, an entity's signature
    contains `presenceId(R)` **iff** it holds ≥1 R-pair.
  - **P2 pair stability:** `mintPair(relationId,targetIndex)` is idempotent and the ID is stable
    across target generation bumps (keyed by index, not handle).
  - **P4 no dangling pair:** no live pair references a dead target after any random
    despawn-with-cascade sequence (relies on identity-invalidated-LAST ordering, entity-model §6.3).
  - **P5 cascade termination:** iterative BFS visits each entity once and terminates on cyclic
    relation graphs (no recursion blowup, no infinite loop).
  - **P6 wildcard O(1):** `Pair(R,Wildcard)` match cost is O(archetypes), independent of the
    number of distinct targets T (vary T, assert flat).
  - **Serial-equivalence (carried from M7):** worker-staged `OP_ADD_PAIR`/`OP_REMOVE_PAIR` with
    fuzzed dead subjects/targets produce the same relation state as a serial application.
- **Bench:** **T1 churn bench** — re-parent 10k entities/frame via exclusive relations stays flat
  (no archetype churn); **fragmentation/fallback-store bench** — 10k entities × thousands of
  parents (non-exclusive) stays within the `maxHotArchetypes` cap and queries iterate hot+cold
  transparently with bounded archetype count; pair-as-archetype-member query
  **≥ bitECS relation query** throughput (`bitECS/src/core/Relation.ts:69-93` is the relation
  baseline; ecsia's win is cross-worker pair identity, which bitECS cannot do).

---

### M9 — Observers (deferred dispatch under the parallel scheduler)

**Implements:** the deferred `ObserverSystem` wiring confirmed under the M7 scheduler —
`onAdd`/`onRemove`/`onChange` drained at the scheduler serial slot (`'frame-end'` default,
`'per-system'` opt-in via `observerCadence` — canonical literal set `'frame-end' | 'per-system'`,
world.md §9.5; the scheduler maps `'per-system'` to its per-wave serial-slot dispatch internally),
safe entity create/destroy **inside** observers
(staged to command buffers), and bundled initial values on add (for serialization late-joiners).
The mechanism shipped at M5; M9 proves it has **no re-entrancy hazard** once real workers and
command-buffer application are in play.

**Package(s):** `@ecsia/core` (`reactivity/`) + `@ecsia/scheduler` (the serial drain slot).

**Depends on:** M7 (workers + command-buffer apply), M5 (observer mechanism), M8 (relation
shape entries — `AddPair`/`RemovePair` observers).

**Gated by:** nothing new.

**Exit criteria:**

- **Unit:** an observer that spawns/despawns entities does not corrupt the wave it runs after;
  `onChange` fires once per coalesced change; relation add/remove observers fire.
- **Property (fast-check):** **R-3 no re-entrancy:** under a fuzzed multi-worker frame where
  observers themselves stage structural commands, every observer fires exactly once per
  net-change in deterministic merge order, and no observer observes a partially-applied wave.
- **Bench:** observer drain under a multi-worker frame adds O(changes) cost at the serial slot,
  not per-wave; no measurable contention with worker execution (drain is off the wave critical path).

---

### M10 — Serialization

**Implements:** `@ecsia/serialization` — zero-copy SAB sharing boundary (`sharedBacking`)
vs copy-based `snapshotInto`; the snapshot serializer (header + per-entity
`[id][componentBitmask]` + per-component SoA section via contiguous `set()` from column slices);
the **version-stamp-driven delta** serializer (`changedSince`/`changedRows`, **no shadow map**);
the SAB structural observer-log stream (op enum, **initial values on ComponentAdd** for late
joiners); and the entity-ID remap table on deserialize (`eid` fields + relation pair targets
remapped).

**Package(s):** `@ecsia/serialization`.

**Depends on:** M5 (`changedSince`/`changedRows`/`changeVersion`), M8 (relations serialized as
`[sourceEid][relationId][targetEid][...fields]`), M2 (column slices, field encode/decode).

**Gated by:** nothing new.

**Exit criteria:**

- **Unit:** snapshot → deserialize round-trips a world bit-exactly; a delta since tick T applied
  to a stale copy reconstructs the live world; a late joiner reconstructs full state from the
  observer-log stream (incl. initial values); eid + relation-target remap correctness.
- **Property (fast-check):**
  - **Round-trip identity:** `deserialize(serialize(world)) ≡ world` (entity set, component
    values, relations) for random worlds.
  - **Delta soundness:** for a random tick range, applying the delta equals replaying the writes
    (delta driven by version stamps, not shadow maps — assert no shadow memory allocated).
  - **Remap totality:** every `eid`/pair-target field survives a deserialize into a world with a
    disjoint ID space (no dangling reference, no aliasing onto a live unrelated entity).
- **Bench:** snapshot/delta throughput with no 100 MB static buffer and `slice` only at the
  process boundary (the bitECS anti-pattern, `SoASerializer.ts:547,562`, is avoided); delta size
  scales with changed-field count, not entity count.

---

### M11 — Type-arity stress & inference budget

**Implements:** the `§6.5` (report §7.5) compile-time guard — the `MAX_QUERY_ARITY=8` overload
family validated against a **`tsc` wall-clock budget fixture**, the 9+ → typed
`LooseQueryElement` degradation (never `any`), the `Has<C>`/`HasWrite<C>` explicit-annotation
escape hatch past the cap, and the per-component (`read(C).x`) hot-path resolution that keeps
iteration off the N-ary tuple path.

**Package(s):** `@ecsia/schema` (types) + a `bench/`/CI fixture asserting the compile budget.

**Depends on:** M4 (query DSL types), M8 (pair query types in the arity fold).

**Gated by:** **§6.5 (report §7.5)** — the arity cap + budget assertion is this milestone's
whole point.

**Exit criteria:**

- **Unit (type-level, `tsd`/expect-error):** arity-8 `query([...])` infers every element type
  with no `any`; arity-9 degrades to `LooseQueryElement` (a typed `Record`, **not** `any`);
  `(e: Has<A> & Has<B>) => ...` annotation bypasses inference; the Readonly-shorthand
  assignment remains TS2540.
- **Property:** N/A (type-level milestone) — replaced by a **matrix of generated fixtures**
  across arities 1..8 each asserting clean inference.
- **Bench (CI gate):** `tsc` over the maximum-supported-arity fixture stays **under the wall-clock
  budget**; a regression past the budget **fails CI** (the only mechanism that keeps inference
  honest as the type machinery evolves, `DESIGN-RESEARCH.md §6.5`).

---

### M12 — Umbrella, DX & API freeze

**Implements:** `@ecsia/ecsia` batteries-included umbrella re-export, the runnable `examples/`
(boids, scene-graph hierarchy, worker-parallel sim), end-to-end docs, and the **API freeze
review**. Cross-library macro-benchmarks consolidated into a published comparison report.

**Package(s):** `@ecsia/ecsia` + `examples/` + `bench/`.

**Depends on:** M9, M10, M11.

**Gated by:** nothing new (consolidation milestone).

**Exit criteria:**

- **Unit:** every example runs green in CI on both the SAB lane and the no-SAB/postMessage lane;
  the umbrella re-export type-checks and tree-shakes (no accidental whole-monorepo pull-in).
- **Property:** a cross-package end-to-end fast-check: random world ops through the umbrella API
  preserve all invariants (`I*`, `BM-*`, `P*`, `R-*`) — a final integration fuzz.
- **Bench:** consolidated macro-benches vs **miniplex** (iteration, churn) and **bitECS**
  (SoA iteration, relations, serialization delta) published; the worker-parallel example
  demonstrates the speedup no reference library can match. API freeze sign-off.

---

## 3. Dependency graph (hard edges)

```
M0 ─┬─> M1 ─┬─> M2 ─┬─> M3 ─┬─> M4 ─┬─> M5 ─┬─> M6 ─> M7 ─┬─> M8 ─┬─> M9
    │       │       │       │       │       │            │       ├─> M10
    │       │       │       │       │       │            │       └─> M11
    │       │       │       │       │       │            │
    └───────┴───────┴───────┴───────┴───────┴────────────┴─> (M9,M10,M11) ─> M12
```

- **M7 is the pivot.** M1–M6 are single-thread-correct and fully tested **before** M7 turns on
  workers/Atomics/command-buffer apply. M7 changes **no data-structure semantics** — its
  serial-equivalence property is the proof.
- **M8 (relations) depends on M7**, not the reverse, so the relation design meets real worker/SAB
  constraints (`DESIGN-RESEARCH.md §5.2` order rationale).
- **Hard-problem gates:** §6.2→M2, §6.1+§6.3→M7, §6.4→M8, §6.5→M4(design)/M11(budget). None may
  be deferred past its gating milestone.
- **Must-Fix mapping:** #5→M2, #1→M3(serial-only)+M7(worker-isolation), #2→M5+M6, #3→M7, #4→M8.

---

## 4. Cross-milestone test infrastructure (built at M0, used throughout)

- **fast-check model-based testing:** a reference in-memory model (plain `Map`-backed ECS) is the
  oracle for the archetype/query/relation property suites — random op sequences are applied to
  both ecsia and the model and their observable states compared (`fc.commands`). This is how
  `I*`/`BM-*`/`SIG-*`/`P*`/`R-*` invariants are enforced against arbitrary histories rather than
  hand-picked cases.
- **Instrumentation counters:** `commitRecord` writes, `Atomics.*` calls, bitmask reads,
  migration column-copies, archetype-cache hits — exposed under a test flag so property tests can
  assert the cost/serial-only invariants (MIG-1, R-1, BM-1, EDGE-1) directly.
- **Cross-library bench baselines:** miniplex + bitECS are devDependencies; each perf-sensitive
  milestone (M1, M2, M4, M8, M10) runs the same workload through ecsia and the baselines in one
  process and asserts the stated relative target. M7's worker speedup has **no** baseline (the
  gap ecsia fills) and is measured against ecsia's own M6 serial executor.
- **Dual-capability CI lanes:** every suite runs on (a) the SAB / cross-origin-isolated lane and
  (b) the no-SAB / postMessage-fallback lane (`DESIGN-RESEARCH.md §5.2 M0`), so the fallback path
  is never untested (becsy's was).
