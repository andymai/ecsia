# ecsia Implementation Spec — Module: System Scheduler & Parallel-Ready Executor

> Module owner: `@ecsia/scheduler` (`packages/scheduler/src/{graph,planner,workers,commands}/`).
> This module owns the **system access graph** (read/write declarations → conflict DAG), the
> **wave-level topological layering** with **type-level conflict detection (v1)**, the **CORRECT
> single-threaded executor** (wave order + serial slots for command-buffer flush and deferred
> observers), the **`world.update()` frame loop**, and the **parallel-READY seams** (worker
> dispatch + Atomics wave-sync interface) — *specified as an interface, not implemented as the
> worker body* (the worker thread implementation lands at M7).
>
> The kernel runs single-threaded **without** this module; the scheduler is an opt-in layer
> (report §5.1 dependency note: "the kernel must run single-threaded **without** `scheduler`").
> The single-threaded executor is the v1 baseline and must be *correct first*; the threaded path
> produces the **same observable result** (report §3 #5; public-api.md §5 item 4).
>
> Citations: `DESIGN-RESEARCH.md §x.y` is the report; `lib/path:line` is the original reference
> source the report read; `entity-model.md §x`, `archetype-storage.md §x`, `type-system.md §x`,
> `command-buffer.md §x`, `reactivity.md §x`, `memory-buffers.md §x`, `public-api.md §x` are the
> sibling specs whose contracts this module honors **verbatim**.

---

## 0. Scope & Non-Goals

**In scope (this module owns these contracts):**

1. The `SystemDef` → registered `SystemBox` lowering, the access-set aggregation
   (`readers`/`writers: Map<ComponentId, Set<SystemId>>`), and pair-ID treatment as component IDs. (§3)
2. The **conflict DAG** construction: priority-weighted edges (becsy weight scheme), transitive
   reduction, DFS cycle detection with named-chain reporting. (§4)
3. **Wave-level topological layering** + **type-level conflict detection v1** (the *rejection* of
   becsy lane-merging): the exact rule deciding whether two systems in a layer may run concurrently,
   and the `Wave[] → SystemBatch[]` data layout. (§5)
4. The **single-threaded executor**: the precise wave-by-wave run order, the **serial slots** for
   command-buffer flush (command-buffer.md §7) and deferred observers (reactivity.md §7), and the
   `world.update(dt)` loop. (§6)
5. The **parallel-ready seams**: the `WaveSync` interface (Atomics wave counter + three-tier wait
   primitive), the `WorkerDispatch` interface, the per-worker buffer reset/reserve handshake, and
   the `WorkerMode` capability gate. *Interfaces only — worker bodies are M7.* (§7)
6. Memory/data layout: the `SystemBox` fields, the access-bit signature words used for the
   disjointness test, the wave/batch arrays, and the SAB wave-counter control block. (§3.3, §5.4, §7.2)

**Out of scope (consumed from / handed to other modules):**

- `defineSystem` *public type* and `SystemAccess` shape — **type-system.md §7.4**, **public-api.md
  §3.4/§5**. This module consumes the validated `SystemDef`; it does not define the inference.
- Command-buffer encoding, the per-worker buffer layout, the deterministic merge + apply, and the
  validate-then-apply safety invariant — **command-buffer.md** (this module *drives* `flushAll()`
  and `prepareWave()`; it owns *when*, not *how*).
- Reactivity rings, `LogPointer`, corral merge, observer drain, version stamps — **reactivity.md**
  (this module *calls* `frameReset`/`mergeCorrals`/`maintainStructural`/`observerDrain`/`flushLogs`
  at fixed points; reactivity owns their bodies).
- The free-list, `reserveEntityBlock`/`returnReservedIds`, `spawn`/`despawn`/`isAlive` — **entity-model.md §5/§6**.
- Archetype tables, `migrate`, the `world.phase` flag, `signatureMatches`, `matchingArchetypes` —
  **archetype-storage.md** (this module sets `world.phase`; storage asserts it).
- SAB-vs-AB selection, `RuntimeCapabilities` probe (`waitAsync`/`waitBlocking`/`crossOriginIsolated`),
  `BackingStrategy`, `exportSharedHandles` — **memory-buffers.md §4** (this module *reads* the probe
  result to pick the `WaveSync` tier and the `WorkerMode`).
- The query module's `LiveQuery`, hash cache, per-archetype matching, incremental maintenance —
  **query** content (lives in `core/query`; this module hands the planner the access masks gathered
  from the declared `{read,write}` sets, not from per-execute query introspection — report §2.5).

---

## 1. How this module satisfies the locked decisions

| Locked decision / report ref | Where satisfied in this spec |
|---|---|
| Systems **declare** read/write access (`{read,write}` sets); declaration is the sole write-intent source (Must-Fix #2, report §2.8) | §3.1 (aggregate from declared sets only), §3.4 (no runtime-setter inference). |
| Conflict DAG; priority-weighted edges (5 explicit / 4 denial / 3 hint / 1 implicit write-before-read) (report §2.5 step 2) | §4.2 (edge weights), §4.3 (build), §4.4 (transitive reduction + cycle detect). |
| **Wave-level topological parallelism**; **type-level conflict v1**; **REJECT becsy lane-merging** (report §2.5 step 3, T5; `becsy/planner.ts:212-226`) | §5.2 (the disjointness rule), §5.3 (batch packing), §5.6 (why not lane-merging). |
| CORRECT single-threaded executor FIRST; parallel-READY seams | §6 (single-thread executor is the normative semantics), §7 (seams are interfaces only). |
| Serial slot for command-buffer flush (command-buffer.md §7) and deferred observers (reactivity.md §7) | §6.2 step 3 (flush), step 4 (observer drain); §6.3 (serial-slot invariant). |
| Worker dispatch + Atomics wave-sync at M7 (report §6.3 three-tier wait + postMessage fallback) | §7.1 (`WaveSync` interface), §7.3 (tier selection), §7.5 (postMessage fallback), §7.6 (M7 gating). |
| All structural mutation serial / main-thread; workers stage to command buffers; `world.phase` is the gate (Must-Fix #1, T2) | §6.4 (phase transitions: only this module flips `world.phase`), §7.2 (workers encode-only). |
| `world.update()` frame loop fixed order (public-api.md §6) | §6.2 (the canonical order, byte-identical to public-api.md §6). |
| Determinism across worker completion order (report §6.1) | §5.5 (intra-wave batch order is fixed), §6.5 (single-thread == threaded observable result). |
| ESM-only, strict TS, SAB + postMessage fallback (decision #9) | §7.3 (tier probe), §7.5 (fallback), §8 (no-`scheduler` degenerate path). |

---

## 2. Position in the execution model

### 2.1 The two phases (owned by archetype-storage; this module is the only writer)

`world.phase ∈ {'serial', 'wave'}` (archetype-storage.md §2 "Phase"; command-buffer.md §2.1).
**`world.phase` is OWNED and initialized to `'serial'` by the world at `createWorld`, before any
system runs and whether or not this module is present** (world.md §4.1, W-1 — the world *seeds* the
field; this module does not create it). Structural mutation is legal only in `'serial'`. **This
module is the sole component that *flips* `world.phase` to `'wave'`** — and only during parallel
waves in threaded mode: it is `'serial'` everywhere except strictly between `dispatchWave()` and the
wave fence, during which it is `'wave'`. **In single-thread mode (`workerCount === 0`) and
kernel-only mode (no scheduler package) the phase stays `'serial'` permanently** (PHASE-1, §6.4;
world.md §4.3) so the direct-apply path works. Every storage/entity/bitmask mutation primitive
asserts `world.phase === 'serial'` (archetype-storage.md §9; entity-model.md §6.2). The world's seed
plus this module's flips are the load-bearing seam that makes "all structural mutation serial"
(Must-Fix #1) checkable; command-buffer's direct-apply guard remains `world.phase === 'serial' &&
isMainThread()` (world.md §4.4).

```
  serial            wave            serial           wave            serial
  ┌──────┐  phase=  ┌──────────┐    ┌──────────┐     ┌──────────┐    ┌──────────┐
  │frame │  'wave'  │ wave 0   │    │ flush 0  │     │ wave 1   │    │ flush 1  │ ...
  │reset │ ───────▶ │ batches  │──▶ │ merge+   │ ──▶ │ batches  │──▶ │ ...      │
  │      │          │ run      │    │ apply +  │     │ run      │    │          │
  │      │          │ (encode  │    │ maintain │     │          │    │          │
  └──────┘          │ commands)│    │ + observe│     └──────────┘    └──────────┘
                    └──────────┘    └──────────┘
   phase=serial      phase=wave      phase=serial
```

### 2.2 Single-threaded is the normative semantics

The single-threaded executor (§6) **defines** the observable result. The threaded path (§7) is a
performance transform that must reproduce it exactly (report §3 #5: "a correct executor with the
same observable result as the threaded path"). Concretely: a wave's batches run *concurrently*
under `threaded:true` but *sequentially in batch-index order* under `threaded:false`; because
batches within a wave are **conflict-free by construction** (§5.2), the two produce identical
column state, and the deterministic command-merge order (command-buffer.md §7.2) makes the
structural result identical too (§6.5).

---

## 3. System registration & access aggregation

### 3.1 `SystemBox` — the internal lowered form

`defineSystem(def)` returns a branded `SystemDef` (public-api.md §3.4; type-system.md §7.4). At
`createWorld({ systems })`, each `SystemDef` is lowered **once** into an immutable `SystemBox`. The
report warns against mutable planner metadata on the system object that goes stale across re-plans
(report §2.5 "Planner metadata on `SystemBox` mutable fields — stale across re-plans (HMR)";
`becsy/system.ts:347-349`); ecsia therefore keeps all *plan-derived* state in the separate
`SchedulePlan` (§5.4), and `SystemBox` carries only *declaration-derived* immutable data.

```ts
export type SystemId = Brand<number, 'SystemId'>;   // dense 0..S-1, registration order (type-system.md §8)

export interface SystemBox {
  readonly id: SystemId;
  readonly name: string;
  readonly run: (ctx: SystemContext) => void;        // user body (public-api.md §3.4)

  /** Declared access, resolved to dense ComponentIds (pair IDs included — §3.2). */
  readonly readIds:  ReadonlyArray<ComponentId>;     // sorted ascending, de-duped
  readonly writeIds: ReadonlyArray<ComponentId>;     // sorted ascending, de-duped

  /** Packed access signatures for the O(words) disjointness test (§5.2). */
  readonly readWords:  Uint32Array;                  // bit c set iff c ∈ readIds  ; length = accessStrideWords
  readonly writeWords: Uint32Array;                  // bit c set iff c ∈ writeIds ; length = accessStrideWords

  /** Explicit ordering edges, resolved to SystemIds (public-api.md SystemDef.before/after). */
  readonly before: ReadonlyArray<SystemId>;          // this runs BEFORE these
  readonly after:  ReadonlyArray<SystemId>;          // this runs AFTER these

  /** Reservation sizing for OP_CREATE mid-wave (command-buffer.md §6.1; entity-model.md §5.2). */
  readonly maxSpawnsPerWave: number;                 // default 64

  /** Worker-eligibility: false if the system reads/writes any object<T> (restrictedToMainThread)
   *  component (type-system.md §3.8 / memory-buffers.md §3.8) or calls a main-thread-only API. */
  readonly workerEligible: boolean;
}
```

- `maxSpawnsPerWave` is read from `SystemDef.maxSpawnsPerWave` (optional, default 64) and forwarded
  to `prepareWave` (§7.4) so the command-buffer's reservation block is sized (command-buffer.md §6.1
  `perWorkerSpawnHint`; entity-model.md §5.2 default 64).
- `workerEligible` is computed once: a system referencing any component whose `FieldDescriptor.shareable === false`
  (object token, type-system.md §1.4) is **never** dispatched to a worker. Such a system is pinned
  to a main-thread batch (§5.3). This makes the object-field non-shareable boundary structural at
  schedule time, not a runtime throw (report §2.2 "Make the split structural at the type level").

### 3.2 Pair IDs are component IDs

A relation pair `(relationId, target)` mints a synthetic `ComponentId` (relations.md §2.2;
type-system.md §7.2). For access aggregation, **a declared read/write of a relation `R` expands to
the relation's `presenceId(R)`** (archetype-storage.md §3.6 — the per-relation presence component
that every holder of any `R` pair carries). The scheduler reasons at *relation granularity*, not
per-target pair granularity, because:

- Per-target pair IDs are minted lazily at `addPair` (relations.md §5.6), so they do not exist at
  plan time; the plan is built once at `createWorld`.
- The presence ID is the stable, plan-time-known proxy for "touches relation R". Two systems that
  both touch `R` (any target) conflict iff one writes — the conservative, correct v1 choice.

So `readIds`/`writeIds` contain ordinary `ComponentId`s plus relation `presenceId`s, all in the same
dense ID space (report §2.5 step 1: "Pair IDs treated as component IDs").

### 3.3 Access aggregation (plan-time)

```
aggregateAccess(systems):                              # serial, at createWorld
  readers := Map<ComponentId, Set<SystemId>>()         # who reads each id
  writers := Map<ComponentId, Set<SystemId>>()         # who writes each id
  for sb in systems:
     for c in sb.readIds:  readers.getOrInit(c).add(sb.id)
     for c in sb.writeIds: writers.getOrInit(c).add(sb.id)
  return { readers, writers }
```

- `accessStrideWords = ceil(registry.registeredComponentCount / 32)` — the **single canonical
  fixed-component-id width** shared by the bitmask (archetype-storage.md §3.3 `bmStride`) and the
  registry (component-schema.md §7.4 `bmStride`), pinned by world.md §5.3/§9.3 (W-5) as the one
  stride every bit-vector and signature derives from. `registeredComponentCount` is
  `nextComponentId` *after* `createWorld` registration and **already includes** user components, the
  reserved ids (NO_COMPONENT=0, CHANGEVERSION_COMPONENT_ID), and the one relation **presence** id per
  relation (component-schema.md §7.3/§7.4; world.md §5.3). This module therefore **DROPS its earlier
  separate `+ numRelations` term**: presence ids are already counted; the old
  `ceil((numComponentTypes + numRelations)/32)` formula double-counted and misaligned the
  `presenceId(R)` bit index (resolves punch-list C4). The per-target pair IDs are
  **not** in the access words (they are excluded by §3.2 — systems declare access against the
  relation's `presenceId`, never a per-target pair id), and they are minted past
  `registeredComponentCount`, so the access words have a *fixed* width known at `createWorld`, never
  growing with pair minting. This matches the bitmask sigWords width exactly, so a system's
  `readWords[presenceId(R) >>> 5]` bit aligns with the archetype signature bit for the same id.
- `readWords`/`writeWords` are built once per `SystemBox`: `words[c >>> 5] |= 1 << (c & 31)` for each
  id. This is the becsy `ShapeArray` packing (`becsy/shapearray.ts:21-108`) reused for access masks.

Complexity: O(Σ |readIds| + |writeIds|) over all systems; O(1) per id. No allocation per frame.

### 3.4 Write-intent is declared, never inferred (Must-Fix #2)

The scheduler reads write-intent **only** from `SystemBox.writeIds` (public-api.md §5 item 3;
report §2.8). `entity.write(C)` setters push to the reactivity write-log (reactivity.md §3.3) for
the `Changed` *filter*; that is a *separate* mechanism and is **never** consulted for conflict
detection. A dev-mode guard (§6.6) may flag an accessor write to a component absent from the running
system's `writeIds`, but the declaration remains authoritative — an undeclared write is a scheduling
*bug* the user must fix, not a fact the scheduler discovers.

---

## 4. Conflict DAG

### 4.1 Edge meaning

A directed edge `A → B` means *A must run before B*. Edges arise from explicit ordering, from
read-after-write / write-after-write / write-after-read access conflicts, and from optional hints.
Each edge carries a **priority weight** (becsy weight scheme, `becsy/planner.ts:187-195`,
`becsy/schedule.ts:108-258`; report §2.5 step 2) so a stronger declaration overrides a weaker
inferred one and the user can *deny* (suppress) an auto-edge they know is safe.

### 4.2 Edge weights (highest wins)

```ts
export const enum EdgeWeight {
  EXPLICIT     = 5,   // SystemDef.before / after — user-declared, never overridden  (becsy weight 5)
  DENY         = 4,   // inAnyOrderWith(A, B): user asserts "no implicit edge between these" (becsy negative/denial edge)
  CLASS_HINT   = 3,   // beforeWritersOf(C) / afterReadersOf(C) coarse hints          (becsy weight 3)
  IMPLICIT     = 1,   // auto write-before-read / write-before-write conflict edge     (becsy weight 1)
}
```

- **EXPLICIT (5):** `B.after = [A]` (or `A.before = [B]`) ⇒ edge `A → B`, weight 5.
- **DENY (4):** `inAnyOrderWith(A, B)` records a *suppression* of any IMPLICIT edge between A and B
  in *both* directions (the report's "Negative 'denial' edges suppress auto-ordering where the user
  knows it is safe", report §2.5; `becsy/datatypes/graph.ts:50-65`). It does **not** override an
  EXPLICIT edge (5 > 4): if the user both `after`s and `inAnyOrderWith`es, the explicit ordering wins
  and a dev-mode warning reports the contradiction.
- **CLASS_HINT (3):** coarse helpers (`beforeWritersOf(C)`, `afterReadersOf(C)`) add weight-3 edges
  to *all* current writers/readers of `C`. Override IMPLICIT, overridden by DENY/EXPLICIT.
- **IMPLICIT (1):** the auto-derived conflict edges (§4.3). Lowest weight; the only weight DENY can
  suppress.

The resolved edge between an ordered pair `(A,B)` is the **max-weight** edge; a DENY removes the
IMPLICIT edge only (it cannot remove a 3/5 edge). This is becsy's max-weight resolution
(`becsy/schedule.ts:108-258`) applied to ecsia's four weights.

### 4.3 Implicit conflict-edge derivation

For every component id `c` with both readers and writers (or multiple writers), derive ordering so
that no two *ordered-by-conflict* systems run in a way that violates read/write semantics. The
**direction** of an implicit edge is *not* free — without an explicit hint, two systems that
conflict on `c` (one writes, the other reads or writes) **must be serialized**, and the default
direction follows **registration order** (the order in `createWorld({ systems })`), which the report
treats as the user's intended baseline ordering (public-api.md §3.4 "systems?: ordered").

```
deriveImplicitEdges(systems, readers, writers):          # serial, at createWorld
  edges := []
  for c in allAccessedIds:
     W := writers.get(c) ?? ∅
     R := readers.get(c) ?? ∅
     # write-before-read and write-before-write: any pair {a,b} conflicting on c gets an edge.
     conflictSet := W ∪ (R if W nonempty else ∅)        # a pure reader-reader pair does NOT conflict
     for each unordered pair {a, b} ⊆ conflictSet, a≠b:
        if a and b conflict on c (at least one writes c):
           # default direction = registration order; suppressed if DENY(a,b) present
           if not denied(a, b):
              (lo, hi) := (a.id < b.id) ? (a, b) : (b, a)   # earlier-registered runs first
              edges.push({ from: lo.id, to: hi.id, weight: IMPLICIT, cause: c })
  return edges
```

- **Reader–reader pairs never conflict** (both only read `c`): no edge — they may parallelize. This
  is the foundation of wave parallelism (§5.2) and the precise *opposite* of becsy's lane-merging,
  which serializes all readers+writers of a non-shared type into one lane (report §2.5 "What to
  avoid"; `becsy/planner.ts:212-226`).
- A pair conflicting on *multiple* components produces one merged edge (max weight, causes
  accumulated for diagnostics), not N parallel edges.
- Complexity: worst case O(Σ_c |conflictSet(c)|²). For the common case (few systems write any given
  component) this is near-linear. Above ~200 systems, switch the pairwise scan to a writers-driven
  pass (each writer edges to every other accessor of `c`) — O(Σ_c |W(c)|·(|W(c)|+|R(c)|)) — the
  report's Q-S1 mitigation ("above ~200 systems, switch to a sparse reachability algorithm").

### 4.4 Transitive reduction & cycle detection

```
buildDAG(systems, edges):                                # serial, at createWorld
  1. adj := adjacency from resolved max-weight edges (DENY-suppressed IMPLICIT removed)
  2. cycle := detectCycle(adj)                           # DFS with colors (white/gray/black)
       if cycle: throw CycleError(reportChain(cycle))    # §4.5
  3. reduced := transitiveReduction(adj)                 # remove edge A→C if A→B→C exists
  4. return reduced
```

- **Cycle detection:** DFS three-color (Johnson-style is overkill; a single DFS finds *a* cycle and
  the gray-stack gives the full chain). The report cites becsy's Floyd-Warshall + transitive
  reduction + Johnson (`becsy/datatypes/graph.ts:91-98, 258-313, 100-165`) but also flags O(n³)
  Floyd-Warshall as degrading past a few hundred systems (report §2.5 "What to avoid"). ecsia v1 uses
  **DFS cycle detect (O(V+E)) + DFS-based transitive reduction (O(V·E))** rather than Floyd-Warshall,
  acceptable for <200 systems and trivially extensible to the sparse algorithm at the Q-S1 threshold.
- **Transitive reduction** keeps the DAG minimal so the topological layering (§5) produces the
  *widest* possible waves (more parallelism). Redundant edge `A→C` when `A→B→C` exists adds no
  ordering constraint and would only narrow a wave.
- The reduced DAG is **immutable** after `createWorld` unless systems are added/removed (HMR /
  `world.addSystem`), which triggers a full re-plan (the plan is rebuilt from `SystemBox` data, never
  patched — avoiding becsy's stale-metadata hazard, report §2.5).

### 4.5 Cycle UX

```
reportChain(cycle: SystemId[]) -> string:
  # cycle = [A, B, C, A]; print the named chain and the *cause* of each edge.
  "System cycle detected:
     Movement → Combat   (Combat.after = [Movement])              [explicit]
     Combat   → Movement (both access Health: Movement writes, Combat reads) [implicit]
   Break it by declaring inAnyOrderWith(Movement, Combat) if the order is irrelevant,
   or remove one of the conflicting declarations."
```

This is the report's "report full cycle path; suggest the specific `inAnyOrderWith` to break it"
(report §2.5 "Cycle UX"). Fail-fast at `createWorld`, never at frame time.

---

## 5. Wave extraction & type-level conflict (v1)

### 5.1 Topological layering

The reduced DAG is layered into **waves**: wave 0 is all systems with no incoming edges; removing
them exposes wave 1; etc. (Kahn's algorithm by in-degree). Every edge crosses from an earlier wave
to a later one, so **a system's ordering dependencies are all satisfied before its wave runs** — the
necessary condition for running a wave's members "in any order / concurrently."

```
extractWaves(reduced):                                  # serial, at createWorld
  indeg := in-degree per system over `reduced`
  ready := { s : indeg[s] === 0 }                        # the becsy traverse() ready-queue idea
  waves := []
  while ready nonempty:
     wave := sort(ready) by SystemId asc                 # deterministic order within a wave (§5.5)
     waves.push(wave)
     next := ∅
     for s in wave:
        for t in reduced.succ(s):
           if (--indeg[t]) === 0: next.add(t)
     ready := next
  assert(Σ|waves| === systems.length)                    # else a cycle slipped through (impossible post §4.4)
  return waves
```

- `ready` / `indeg` are plain arrays — this is becsy's `traverse()` ready-queue primitive
  (`becsy/datatypes/graph.ts:334-361`), which the report explicitly corrects from "lock-free" to
  **single-threaded** (report §2.5 boxed correction). It runs **only on the main thread**, at plan
  time; it *produces* the batches the worker pool later runs (report §2.5: "a main-thread ready-queue
  that produces the batches").

### 5.2 Type-level conflict detection v1 — the intra-wave concurrency rule

Within a wave, all *ordering* dependencies are already satisfied, but two systems may still **share
mutable state**. Two systems `A`, `B` in the same wave may run **concurrently** (same batch-set,
different batches) iff their access is **disjoint** at component-type granularity (report §2.5 step
3; T5):

> **Rule WAVE-CONFLICT (v1).** `A` and `B` are concurrency-compatible iff:
> 1. `A.writeWords ∩ B.writeWords === ∅`  (write-sets disjoint), AND
> 2. `A.writeWords ∩ B.readWords  === ∅`  (A does not write what B reads), AND
> 3. `A.readWords  ∩ B.writeWords === ∅`  (B does not write what A reads).
> Pure read–read overlap (`A.readWords ∩ B.readWords`) is **allowed** — concurrent reads are safe.

```ts
function concurrencyCompatible(a: SystemBox, b: SystemBox): boolean {
  const n = a.writeWords.length;                 // === accessStrideWords for all systems
  for (let w = 0; w < n; w++) {
    const aw = a.writeWords[w], bw = b.writeWords[w];
    if (aw & bw)               return false;      // write/write
    if (aw & b.readWords[w])   return false;      // a-write / b-read
    if (a.readWords[w] & bw)   return false;      // a-read  / b-write
  }
  return true;
}
```

- Complexity: O(accessStrideWords) per pair, a handful of u32 ANDs. **Not** per-entity, **not** per
  archetype — purely over the fixed-width access masks. This is the v1 "type-level conflict" cost.
- **Why this is sound under the serial-mutation invariant:** during a wave, *structural* mutation is
  illegal (Must-Fix #1); the only concurrent writes are *column value* writes to components in
  `writeWords`. WAVE-CONFLICT guarantees no two concurrent batches write the same component, and no
  batch reads a component another concurrently writes — so every concurrent column access is either a
  disjoint write or a read of an unwritten column (archetype-storage.md §9: "Column value write:
  disjoint per scheduler"). No atomic, no lock needed (report T5; T3).
- **v2 refinement (documented, not built):** archetype-column-level conflict — two systems writing
  the *same* component but provably *disjoint archetype sets* could parallelize. v1 is type-level
  (the report's locked v1 default); v2 narrows the AND to per-archetype-column granularity. The
  `concurrencyCompatible` seam is the single choke point a v2 build replaces (report T5: "column-level
  is a strictly-additive later win").

### 5.3 Batch packing within a wave (graph coloring)

A wave's systems are partitioned into **batches** such that all systems within one wave can run, but
systems that are *not* mutually concurrency-compatible must land in *different* batch-rounds. v1 uses
the simplest correct scheme that maximizes the first round's width: **greedy interval/graph coloring**
over the wave's incompatibility graph (`A—B` edge iff `!concurrencyCompatible(A,B)`).

```
packBatches(wave):                                       # serial, at plan time
  # incompat[a][b] = !concurrencyCompatible(a,b) for a,b in wave
  rounds := []                                            # each round is a set of mutually-compatible systems
  for s in wave (SystemId asc, deterministic):
     placed := false
     for round in rounds:
        if s is compatible with EVERY member of round AND (s.workerEligible || round is the main-thread round):
           round.add(s); placed := true; break
     if not placed: rounds.push(newRound(s))
  return rounds   # rounds run SEQUENTIALLY; members of one round run CONCURRENTLY (§5.4)
```

- A `SystemBatch` = one *round member* assigned to one worker (or the main thread). All members of a
  round run concurrently; rounds run in sequence within the wave. A wave with one round is fully
  parallel; a wave whose systems all conflict degrades to N sequential single-system rounds (still
  correct).
- **Worker-ineligible systems** (`workerEligible === false`, §3.1) are pinned: each round has at most
  one *main-thread slot*, and an ineligible system always takes that slot. Two ineligible systems in
  the same wave that are mutually compatible can still share a round only if one runs main-thread and
  the other... cannot (only one main-thread slot) — so two ineligible-but-compatible systems land in
  consecutive rounds. This is a correctness-preserving conservatism (a rare case; object-field
  systems are uncommon).
- Coloring is greedy (not optimal) — optimal graph coloring is NP-hard and unnecessary; greedy gives
  good-enough batch width and is O(wave² · words). Done once at plan time; zero per-frame cost.

### 5.4 The `SchedulePlan` data layout

All plan-derived state lives here, *separate* from `SystemBox` (report §2.5 stale-metadata avoidance):

```ts
export interface SystemBatch {
  readonly systemId: SystemId;
  readonly workerIndex: number;          // 0..workerCount-1 for worker batches; -1 = main-thread slot
}

export interface ScheduleWave {
  /** Sequential rounds; rounds[r] runs after rounds[r-1] completes. */
  readonly rounds: ReadonlyArray<ReadonlyArray<SystemBatch>>;
  /** Sum of maxSpawnsPerWave for systems dispatched to each worker this wave (reservation sizing). */
  readonly perWorkerSpawnHint: Uint32Array;     // length = workerCount
}

export interface SchedulePlan {
  readonly waves: ReadonlyArray<ScheduleWave>;
  readonly systems: ReadonlyArray<SystemBox>;   // by SystemId
  readonly accessStrideWords: number;
  /** Frozen; rebuilt wholesale on system add/remove (never patched). */
}
```

- `perWorkerSpawnHint[w]` is precomputed per wave by summing `maxSpawnsPerWave` of the systems whose
  `SystemBatch.workerIndex === w` (across all rounds of the wave) so `prepareWave` (§7.4) sizes each
  worker's reservation block in one call (command-buffer.md §6.1; entity-model.md §5.2).

### 5.5 Determinism: fixed intra-wave order

Two sources of nondeterminism are eliminated at plan time so the threaded result equals the
single-threaded result (report §6.1; §6.5 below):

1. **Round/batch order is fixed by SystemId ascending** (§5.3 iterates `SystemId asc`). The plan is
   pure-functional in the registration order, so two `createWorld` calls with the same systems produce
   the identical plan.
2. **Command application order is fixed by worker index then append order** (command-buffer.md §7.2),
   independent of which worker finished first.

Therefore: column writes within a round are to disjoint components (WAVE-CONFLICT), so their relative
timing is unobservable; structural changes are applied in a fixed deterministic merge order. The
observable post-update state is a pure function of (input state, plan, dt) — *independent of thread
scheduling* (report §6.1 "important for replay and for tests").

### 5.6 Why NOT becsy lane-merging (explicit rejection)

becsy assigns each non-`shared` component a *lane* and forces **all** readers and writers of that
component into the single lane, serializing them (`becsy/planner.ts:212-226`; report §2.5 "What to
avoid"). Consequence: in a typical world where most systems touch a few common components (Position,
Transform), nearly every system collapses into one lane → no parallelism, and the user must manually
mark components `shared` to recover it. ecsia **rejects** this:

- ecsia serializes only *conflicting* pairs (one writes), and **lets all readers of a component run
  concurrently** (§5.2 rule, read–read allowed). Users never mark a component `shared`.
- The cost is the per-pair WAVE-CONFLICT test (O(words) per pair, plan-time only), versus becsy's
  per-component lane assignment. ecsia trades a one-time plan-time coloring for runtime parallelism
  that lane-merging structurally cannot achieve (report T5: "This already beats becsy's lane-merging
  without per-archetype tracking on day one").

---

## 6. The single-threaded executor (CORRECT FIRST)

This is the **normative** semantics. `threaded:false` (default) runs it directly; `threaded:true`
(§7) reproduces its observable result.

### 6.1 `world.update(dt)` — entry point

```ts
interface World {
  /** Run one tick: the whole schedule + reactivity flush. Main-thread only. */
  update(dt: number): void;
  readonly currentTick: Tick;
  phase: 'serial' | 'wave';          // written ONLY by this module (§2.1)
}
```

### 6.2 The fixed frame order (byte-identical to public-api.md §6)

```
update(dt):                                              # main thread; world.phase starts 'serial'
  assert(world.phase === 'serial')
  # ---- 1. frame start ----
  reactivity.frameReset()                                # advance currentTick; reset transient query lists (reactivity.md §3.7)
  # ---- 2..4. run every wave, flushing structural + reactivity between waves ----
  for wave in plan.waves:
     runWave(wave, dt)                                   # §6.3
  # ---- 5. end-of-frame reactivity ----
  reactivity.flushLogs()                                 # drain spill, schedule ring resize (reactivity.md §8.2)
  assert(world.phase === 'serial')
```

The `for wave` loop *is* steps 2–4 of public-api.md §6; `frameReset` is step 1; `flushLogs` is step 5.

### 6.3 `runWave` — one wave, with the serial flush slot after it

```
runWave(wave, dt):                                       # main thread
  # ---- WAVE PHASE: systems execute, structural intents staged, NOT applied ----
  prepareWave(wave)                                      # §7.4: reset CBs + reactivity corrals + reserve IDs
  world.phase := 'wave'
  for round in wave.rounds:                              # rounds run sequentially
     for batch in round:                                 # single-thread: sequential; threaded: concurrent (§7)
        runSystem(plan.systems[batch.systemId], dt)      # §6.4
     # (threaded path: here the main thread waits on the wave-sync fence for the round — §7.1)
  world.phase := 'serial'
  # ---- SERIAL SLOT: apply staged structural changes + maintain queries + (maybe) observers ----
  reactivity.mergeCorrals()                              # merge per-worker write-log corrals (reactivity.md §9.2) — no-op single-thread
  commands.flushAll(workers)                             # apply per-worker command buffers, deterministic merge (command-buffer.md §7)
  reactivity.maintainStructural()                        # incremental Added/Removed query maintenance (reactivity.md §5.2)
  if observerCadence === 'per-system': reactivity.observerDrain()   # §6.7 (Q-S2); public 'per-system' drains in each wave's serial slot; default 'frame-end' drains at frame end via the trailing wave
```

- **Single-thread degenerate path:** `runSystem` runs on the main thread; `runSystem` calls
  structural verbs through the **direct-apply fast path** (command-buffer.md §2.2: `world.phase` is
  flipped to `'wave'` here, BUT in single-thread mode `isMainThread()` is true and the op would
  defer... — see §6.4 resolution). `commands.flushAll` is a no-op when there are zero workers
  (command-buffer.md §7.1 degenerate case), and `mergeCorrals` is a no-op. So the single-thread
  executor's structural changes apply via the direct-apply path *during* the system (see §6.4), and
  the post-wave flush slot is empty work — the machinery imposes **zero cost** single-threaded
  (report §3 #5; command-buffer.md §7.1).

### 6.4 Phase handling in single-thread vs threaded (the load-bearing subtlety)

`command-buffer.md §2.2` routes a structural op to the **direct-apply fast path** iff
`world.phase === 'serial' && isMainThread()`, else to the deferred command buffer. The naive
`runWave` above sets `world.phase := 'wave'` for the whole wave, which would force even
*single-threaded* main-thread systems to defer (wrong — single-thread must be allowed to apply
synchronously for "correct single-threaded first" simplicity). The resolution:

> **Rule PHASE-1.** In **single-thread mode** (`workerCount === 0`), `runWave` does **NOT** set
> `world.phase := 'wave'`. The phase stays `'serial'` for the entire `update`, so every structural
> op a system performs takes the synchronous direct-apply fast path (command-buffer.md §2.2), and
> there are no command buffers to flush. The post-wave serial slot's `flushAll`/`mergeCorrals` are
> no-ops. This is the literal "correct single-threaded executor first; zero command buffers if no
> worker is ever spawned" (command-buffer.md §7.1; report §3 #5).
>
> **Rule PHASE-2.** In **threaded mode** (`workerCount > 0`), `runWave` sets `world.phase := 'wave'`
> across the round dispatch (workers execute), then `'serial'` for the flush slot. A worker mid-wave
> always defers (command-buffer.md §2.2 `!isMainThread()`); a main-thread *coordinator* never runs a
> user system during `'wave'` in v1 (the main thread dispatches and waits — §7.1), so no
> main-thread direct-apply happens mid-wave. Structural changes apply only in the serial slot via
> `flushAll`.

This is why command-buffer.md §2.2 is correct as written: its guard (`'serial' && isMainThread`) is
*true* throughout single-thread mode (PHASE-1) and *false* for workers in threaded mode (PHASE-2),
exactly partitioning the two apply paths.

### 6.5 `runSystem`

```
runSystem(sb, dt):                                       # main thread (single-thread) or worker (threaded)
  ctx := { world, dt, tick: world.currentTick, query: scopedQuery(sb) }
  sb.run(ctx)                                            # user body; iterates queries, reads/writes columns
```

- `scopedQuery(sb)` returns the world `query()` (public-api.md §3.4 `SystemContext.query`) with a
  dev-mode assertion that every term's component is a subset of `sb.readIds ∪ sb.writeIds`
  (public-api.md §5 item 2) and that `write(C)` terms reference `C ∈ sb.writeIds`. This keeps the
  declared access honest without inferring it (Must-Fix #2).
- Iteration is **per-archetype** over `query.matchingArchetypes` (archetype-storage.md §8); the
  scheduler does not touch the per-entity bitmask (Must-Fix #1). A worker establishes membership from
  the archetype signature it iterates (archetype-storage.md §9.4), never from `entity.has`.

### 6.6 Dev-mode access guards

- **Undeclared write:** if a `write(C)` term or an `entity.write(C)` call names `C ∉ sb.writeIds`,
  emit a dev warning (the scheduling-bug flag, public-api.md §3.4). Authoritative source remains the
  declaration; the running system is not blocked (production silent).
- **Undeclared read:** a `read(C)`/iteration of `C ∉ sb.readIds ∪ sb.writeIds` is a dev warning.
- **Structural op from a worker without a command buffer:** a dev-mode thread-id guard asserts a
  worker never reaches `applyDirect` (command-buffer.md §2.2; entity-model.md I10).
- These guards are stripped in production builds (`if (DEV)`), so the hot path is unaffected.

### 6.7 Observer cadence (Q-S2)

The public literal set is `observerCadence ∈ {'frame-end', 'per-system'}`, default `'frame-end'`
(world.md §9.5; reactivity.md §7; report Q-S2). It is a `reactivity:{}` knob (createWorld nesting,
world.md §2.2); the scheduler **reads the resolved value** and drives the drain. `'per-system'` maps
internally to a per-wave serial-slot drain:

- **`'frame-end'` (default):** `reactivity.observerDrain()` is called **once**, after the last wave's
  serial flush (folded into the final `runWave`'s slot or appended after the wave loop). Observers
  see all of the frame's structural changes at one quiescent point.
- **`'per-system'`:** `observerDrain()` runs in every wave's serial slot (§6.3) — i.e. once per
  scheduling wave, the finest granularity v1 exposes. Higher reactivity granularity (observers fire
  between waves), at the cost of more drain passes. Either way every log entry is observed exactly
  once (reactivity.md §7.5 monotonic pointer).

Observers run at a **serial slot**, never mid-system (reactivity.md §7; report §2.7) — so observer
mutations stage to the (main-thread) command buffer and apply at the next serial flush
(reactivity.md §7.4). The scheduler guarantees the slot is serial by only calling `observerDrain`
while `world.phase === 'serial'`.

---

## 7. Parallel-ready seams (interfaces; worker bodies are M7)

This section specifies the **interface contracts** the threaded executor uses. Per the locked
decision ("parallel-READY seams … worker dispatch + Atomics wave-sync at M7"), the worker thread
*body* is not implemented here; this fixes the seams so the single-thread executor (§6) and the M7
worker layer interoperate with no public-API change (public-api.md §7 "no user code changes").

### 7.1 `WaveSync` — Atomics wave-completion fence

The main thread dispatches a round's batches to workers, then waits until all have completed. The
fence is a single SAB-backed counter (report §2.5 step 4: "a SAB counter initialized to
`batches.length`; each worker `Atomics.add`-decrements on completion; the main thread waits on the
counter").

```ts
/** SAB control block for one round's completion fence. */
export interface WaveCounter {
  readonly sab: SharedArrayBuffer;     // length-4 Int32Array view; Atomics-capable
  readonly view: Int32Array;
  // word 0: remaining   — initialized to batchCount; each worker Atomics.sub(.,0,1) on completion
  // word 1: epoch       — bumped per round so a stale wake is ignored (Atomics.wait value guard)
  // word 2: errorFlag   — a worker sets this (Atomics.store) if its system threw (§7.7)
  // word 3: padding
}

export interface WaveSync {
  /** Reset the counter to `batchCount` and bump the epoch. Main thread, before dispatch. */
  begin(c: WaveCounter, batchCount: number): void;
  /** Called by a worker on batch completion: Atomics.sub(remaining,1); if 0, Atomics.notify(epoch). */
  complete(c: WaveCounter): void;       // (worker-side; body is M7)
  /** Main thread: wait until remaining === 0. Tier chosen by capability probe (§7.3). */
  await(c: WaveCounter): Promise<void> | void;
}
```

- `begin` does `Atomics.store(view, 0, batchCount); Atomics.add(view, 1, 1)` (epoch bump), then
  `Atomics.store(view, 2, 0)` (clear error). The epoch guards against a worker from a *previous*
  round notifying after the counter was reset (the standard Atomics.wait staleness guard).
- `complete` is the worker side: `if (Atomics.sub(view, 0, 1) === 1) Atomics.notify(view, 0)` (the
  last decrementer wakes the waiter).
- `await` is the three-tier wait (§7.3). It resolves when `Atomics.load(view, 0) === 0`.

### 7.2 `WorkerDispatch` — round dispatch (encode-only workers)

```ts
export interface WorkerHandle {
  readonly index: number;                // 0..workerCount-1
  readonly commandBuffer: CommandBuffer; // command-buffer.md §3 (plain AB, worker-local)
  readonly writeCorral: Uint32Array;     // reactivity.md §9.1 (plain AB, worker-local)
}

export interface WorkerDispatch {
  /** Post a batch's systemId + ctx slice to a worker. Worker runs runSystem then WaveSync.complete. */
  dispatch(w: WorkerHandle, batch: SystemBatch, dt: number, tick: Tick): void;   // body M7
  readonly workers: ReadonlyArray<WorkerHandle>;
  readonly mode: WorkerMode;             // 'single' | 'sab' | 'postMessage-fallback'
}
```

- A worker, on `dispatch`, runs `runSystem` (§6.5) reading/writing **archetype columns directly over
  the shared SABs** (memory-buffers.md SAB path; report §2.5 step 4). It performs **no structural
  mutation** — all create/destroy/add/remove/setRelation are encoded into its `commandBuffer`
  (command-buffer.md §5), and field writes to non-disjoint columns into its `writeCorral`
  (reactivity.md §9.1). On finishing it calls `WaveSync.complete`.
- The main thread **does not run user systems during `'wave'`** in v1 (it dispatches and awaits).
  Whether the main thread acts as a coordinator-on-thread or delegates to a coordinator worker is the
  `WaveSync` tier choice (§7.3 tier 2); either way no main-thread user-system runs mid-wave (PHASE-2,
  §6.4).

### 7.3 Three-tier wait selection (report §6.3; memory-buffers.md §4 probe)

`WaveSync.await` is chosen **once at world creation** from the `RuntimeCapabilities` probe
(memory-buffers.md §4.2: `waitAsync`, `waitBlocking`, `crossOriginIsolated`). Report §6.3 tiers:

```
selectWaitTier(caps):                                    # at createWorld
  if caps.waitAsync:        return 'waitAsync'           # tier 1: browser main thread, non-blocking
  if caps.waitBlocking:     return 'coordinator-block'   # tier 2: blocking Atomics.wait OFF main thread
                                                         #   (Node main may block directly; browser uses a coordinator worker)
  if caps.sabAvailable:     return 'promise-poll'        # tier 3: Atomics.load poll on microtask/setTimeout(0)
  return 'postMessage'                                   # no SAB: §7.5 fallback
```

| Tier | `await` implementation | Context |
|---|---|---|
| 1 `waitAsync` | `await Atomics.waitAsync(view,0,nonzero).value` (loop until `load===0`) | browser main thread (Chrome 87+/FF100+/Safari16.4+, report §6.3) |
| 2 `coordinator-block` | a dedicated coordinator worker `Atomics.wait`s; page thread `await`s one `postMessage` per round; pure Node main may `Atomics.wait` directly | Node `worker_threads`, browser-with-coordinator |
| 3 `promise-poll` | `while (Atomics.load(view,0) !== 0) await microtask/timeout` | SAB present, `waitAsync` absent (degraded; documented) |
| — postMessage | no Atomics; §7.5 | no SAB / no cross-origin isolation |

- The tier is a property of the `WaveSync` instance; `runWave` (§6.3, threaded path) just calls
  `await waveSync.await(counter)` after dispatching a round and is **agnostic** to the tier.
- `await` MUST loop on `Atomics.load(view,0)` even after a `waitAsync`/`wait` wake (spurious wakeups
  and the epoch guard), resolving only when `remaining === 0`.

### 7.4 `prepareWave` — pre-wave reset & reservation handshake

Called by `runWave` (§6.3) before flipping to `'wave'` (threaded mode):

```
prepareWave(wave):                                       # main thread, serial
  # ---- G-7: drain AND apply pending ColumnsAdded notices on every worker FIRST ----
  for w in workers:
     for notice in w.pendingColumnsAdded:                # serialization.md §3.4 postMessage notices
        w.applyColumnsAdded(notice)                      # serialization.md §applyColumnsAdded: re-wrap new column views
     w.pendingColumnsAdded.clear()
  # ---- per-worker buffer reset + entity-ID reservation ----
  for w in workers:
     commands.resetBuffer(w.commandBuffer)               # command-buffer.md §3.4 (head→0, retain backing)
     reactivity.resetCorral(w.writeCorral)               # reactivity.md §9.1 (count→0)
     n := wave.perWorkerSpawnHint[w.index]               # §5.4
     w.commandBuffer.reservation := world.reserveEntityBlock(w.index, n)   # entity-model.md §5.1
     w.commandBuffer.reservationCursor := 0
```

This is exactly command-buffer.md §6.1 `prepareWave`, driven here. The scheduler owns the *call site*
(per wave, serial, before dispatch); command-buffer/entity own the bodies.

> **Invariant SCH-COLS (G-7 worker column handshake, CANON).** When a new archetype/column is
> lazily created during a serial flush, serialization emits a `ColumnsAdded` postMessage notice to
> each worker (serialization.md §3.4). **`prepareWave` GUARANTEES every such notice is drained AND
> applied by each worker during the inter-wave barrier BEFORE the next wave dispatches** — no worker
> touches a column it has not yet re-wrapped (world.md §9.9, W-10). Because `prepareWave` runs in the
> serial slot before `world.phase` flips to `'wave'`, notice-applied-before-dispatch is structural,
> not best-effort. This is stated normatively here and in serialization.md §applyColumnsAdded.

### 7.5 postMessage fallback (no SAB; report §6.3; public-api.md §7)

When `mode === 'postMessage-fallback'` (no cross-origin isolation, or `workers:'postMessage-fallback'`
requested):

- Archetype columns are plain `ArrayBuffer`s. Per round, the main thread **transfers** (zero-copy
  `Transferable`, not structured-clone) each batch's needed columns to its worker; the worker
  transfers them back on completion (report §6.3 no-SAB fallback; memory-buffers.md §4.3
  `postMessage-fallback`).
- The `WaveCounter` is replaced by a **per-round `postMessage` completion message**: the worker posts
  `{ done: batch.systemId, commandBuffer, writeCorral }` (transferring its AB-backed buffers, §7.2);
  the main thread counts completions and resolves the round when `count === batchCount`. `WaveSync` in
  this mode is implemented over the message channel, not Atomics — but the `await` *interface* is
  identical, so `runWave` is unchanged.
- The command-buffer apply (command-buffer.md §7.6) and corral merge (reactivity.md §9.4) read the
  transferred buffers byte-for-byte the same. **Determinism is preserved** (fixed worker-index merge
  order, §5.5; command-buffer.md §7.2) even though message arrival order is nondeterministic.
- **Never silent:** a `threaded:true` request in a non-isolated context emits a clear startup
  diagnostic and downgrades to single-thread or this fallback deterministically (report §6.3;
  public-api.md §7 "Never silent"). The user's components/systems/queries are byte-identical across
  all modes.

### 7.6 M7 gating (what is interface-only here)

Per build-plan / report §5.2 M7, the following are **specified as interfaces above** and
**implemented at M7**, not in v1's single-thread executor:

- `WaveSync.complete` / the worker-side decrement+notify body.
- `WorkerDispatch.dispatch` body (the worker message protocol, SAB transfer at startup via
  `exportSharedHandles` — memory-buffers.md §6 / public-api.md §8).
- The coordinator-worker for tier 2, and the postMessage transport for the fallback.

v1 ships: §3 (registration), §4 (DAG), §5 (waves + WAVE-CONFLICT + batches), §6 (single-thread
executor), and the §7 **interface declarations** + `selectWaitTier` (so the plan already knows the
tier and `perWorkerSpawnHint`, and M7 only fills the bodies). The single-thread executor must pass
its full test suite *before* M7 (report §5.2 ordering: M6 scheduler single-process precedes M7
workers).

### 7.7 Worker error propagation

If a worker's system throws, the worker sets `Atomics.store(WaveCounter.view, 2, 1)` (errorFlag),
posts the error detail, and still calls `complete` (so the fence releases). After `await`, the main
thread checks `Atomics.load(view, 2)`; if set, it raises the aggregated error **after** completing
the serial flush of *that round's* already-staged (non-throwing) command buffers — so a thrown system
does not corrupt structure (the throwing system's partial column writes are to its disjoint columns
and are simply not relied upon; its command buffer is applied or, in dev mode, discarded with a
diagnostic). Single-thread mode propagates the throw directly out of `runSystem` (no fence).

---

## 8. Degenerate / no-scheduler operation

The kernel runs **without** `@ecsia/scheduler` (report §5.1). In that mode there is no plan, no
waves, and no `world.update` from this module — the user calls systems manually or via a trivial
loop, and every structural op is a synchronous main-thread direct-apply (command-buffer.md §2.2,
`world.phase === 'serial'` always). Importing `@ecsia/scheduler` and passing `systems` to
`createWorld` opts into the DAG + waves; nothing else changes for the user (public-api.md §7.4
"`defineSystem` + `world.update` pull in the scheduler layer"). This preserves the "correct
single-threaded executor first" decision at the *package* level: scheduling is additive.

> **Who initializes `world.phase` when this module is absent (ownership note).** This module is the
> sole component that **flips** `world.phase` between `'serial'` and `'wave'` (§2.1), but it does
> **not** create the field. **world.md §4.1 (the keystone) owns `world.phase` and initializes it to
> `'serial'`** at `createWorld`, before any system runs and whether or not
> `@ecsia/scheduler` is imported. So in kernel-only mode the field exists and is permanently
> `'serial'` (nothing ever sets it to `'wave'`), and every assertion in archetype-storage / accessors
> / queries / serialization that reads `world.phase` holds. When the scheduler **is** present, it
> takes over flipping the field per PHASE-1/PHASE-2 (§6.4) but never re-initializes it. This pins the
> default that scheduler §2.1 ("sole writer") and command-buffer.md §2.2 (direct-apply guard) both
> rely on.

---

## 9. Complexity summary

| Operation | Time | When | Space |
|---|---|---|---|
| `aggregateAccess` | O(Σ access-set sizes) | createWorld (once) | `O(ids)` maps |
| build `readWords`/`writeWords` per system | O(accessStrideWords) | createWorld | `2·S·accessStrideWords` u32 |
| `deriveImplicitEdges` | O(Σ_c \|conflictSet(c)\|²) (writers-driven O(Σ \|W\|·(\|W\|+\|R\|)) above ~200 sys) | createWorld | O(edges) |
| cycle detect (DFS) | O(V+E) | createWorld | O(V) stack |
| transitive reduction (DFS) | O(V·E) | createWorld | O(V+E) |
| `extractWaves` (Kahn) | O(V+E) | createWorld | O(V) |
| `concurrencyCompatible` | O(accessStrideWords) per pair | plan-time (packBatches) | 0 |
| `packBatches` (greedy color) | O(wave²·words) per wave | createWorld | O(wave) |
| `runWave` dispatch | O(rounds·batches) | per frame | 0 alloc |
| `concurrencyCompatible` hot path | **never** at runtime | — | — |
| `WaveSync.await` (tier 1) | one notify wake + O(1) loop | per round, threaded | 0 |

The entire conflict-analysis cost (DAG, waves, batches) is **paid once at `createWorld`**; the per-
frame cost is the wave/round/batch *walk* plus the systems' own work plus the serial-slot flush —
**no graph algorithm runs per frame** (report §2.5 "graph construction … at init"; <1ms for <100
systems).

---

## 10. Concurrency & memory-ordering summary

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| plan build (§3–§5) | Main | Serial (createWorld) | None (single-writer). |
| `world.phase` write | Main (this module only) | wave↔serial transition | Plain store; the only writer (§2.1). |
| `runSystem` column read | Main or worker | wave (threaded) / serial (single) | Plain TypedArray load over SAB; widening-safe (memory-buffers.md V-1). |
| `runSystem` column write | Worker (disjoint per WAVE-CONFLICT) or main | wave / serial | Plain store; disjointness from §5.2 — no atomic. |
| structural op (spawn/add/...) | Worker → command buffer; Main → direct-apply | wave (encode) / serial (apply) | command-buffer.md §7 (serial merge, no atomic). |
| `WaveCounter` remaining | Workers decrement, main waits | wave | `Atomics.sub`/`Atomics.wait(Async)` — the ONLY scheduler hot-path atomic. |
| `WaveCounter` epoch/error | Main bumps, workers read/set | wave boundaries | `Atomics.store`/`load`. |
| `flushAll`/`mergeCorrals`/`maintainStructural`/`observerDrain`/`flushLogs` | Main | Serial slot | None (single-threaded merge). |

The single load-bearing rule: **only this module writes `world.phase`, and it is `'serial'`
everywhere except the dispatch-and-wait window**; combined with WAVE-CONFLICT disjointness, the v1
threaded executor needs exactly one atomic family (the `WaveCounter`) and **no atomic on any column,
record, bitmask, or reactivity store** (Must-Fix #1; report T2/T3/T5).

---

## 11. Invariants (testable assertions)

- **SCH-1.** Every edge in the reduced DAG goes from an earlier wave to a strictly later wave
  (topological soundness); `Σ |waves[i]| === systemCount` (no system dropped, no cycle).
- **SCH-2.** Within any round of any wave, every pair of `SystemBatch`es is
  `concurrencyCompatible` (WAVE-CONFLICT holds) — a fuzz test asserts no two same-round systems
  write the same component or read-vs-write conflict.
- **SCH-3.** The single-thread executor and the threaded executor produce **identical** observable
  world state for the same (state, plan, dt) — the determinism guarantee (§5.5; report §6.1). Tested
  by running a fixture under `threaded:false` and `threaded:true` (and postMessage fallback) and
  asserting snapshot equality (serialization spec).
- **SCH-4.** `world.phase === 'serial'` at every `update` entry and exit, and during every
  `flushAll`/`observerDrain` call (the serial-slot invariant); `world.phase === 'wave'` only between
  a round's dispatch and its fence (threaded mode); always `'serial'` in single-thread mode (PHASE-1).
- **SCH-5.** No graph algorithm (cycle detect, reduction, layering, coloring, `concurrencyCompatible`)
  runs during `update` — a profiling test asserts zero plan-mutation calls per frame.
- **SCH-6.** Write-intent used for conflict detection comes **only** from `SystemBox.writeIds`; a
  test stubs the reactivity write-log and asserts the DAG is unchanged when systems mutate via
  `entity.write(C)` without declaring it (Must-Fix #2).
- **SCH-7.** A worker-ineligible system (object-field) is never placed in a worker `SystemBatch`
  (`workerIndex === -1`).
- **SCH-8.** `WaveSync.await` resolves only when `Atomics.load(remaining) === 0`, and ignores stale
  wakes via the epoch guard.
- **SCH-9.** A registered cycle throws `CycleError` at `createWorld` with the full named chain and at
  least one `inAnyOrderWith` suggestion (§4.5) — never a frame-time error.
- **SCH-10.** `reserveEntityBlock` is called exactly once per worker per wave with
  `n === perWorkerSpawnHint[workerIndex]`, and `returnReservedIds` exactly once per worker per flush
  (command-buffer.md §6).
- **SCH-11 (G-7 column handshake).** Every pending `ColumnsAdded` notice is applied by each worker
  in `prepareWave` (serial slot) **before** the wave dispatches; a test that lazily creates a column
  during a flush asserts no worker reads the new column before it has re-wrapped it (world.md §9.9,
  W-10). (`prepareWave` SCH-COLS, §7.4)

---

## 12. Public API surface (this module owns)

```ts
// @ecsia/scheduler
export { defineSystem } from '@ecsia/schema';            // re-export; SystemDef/SystemAccess type (type-system.md §7.4)
export function inAnyOrderWith(a: SystemDef, b: SystemDef): OrderingHint;   // DENY edge (§4.2)
export function beforeWritersOf(c: ComponentDef<Schema>): OrderingHint;     // CLASS_HINT (§4.2)
export function afterReadersOf(c: ComponentDef<Schema>): OrderingHint;      // CLASS_HINT (§4.2)

// Internal-but-specified contracts (consumed by world.ts / M7 workers):
export interface SystemBox { /* §3.1 */ }
export interface SchedulePlan { /* §5.4 */ }
export interface ScheduleWave { /* §5.4 */ }
export interface SystemBatch { /* §5.4 */ }
export interface WaveSync { /* §7.1 */ }
export interface WaveCounter { /* §7.1 */ }
export interface WorkerDispatch { /* §7.2 */ }
export interface WorkerHandle { /* §7.2 */ }
export type WorkerMode = 'single' | 'sab' | 'postMessage-fallback';

/** Build the immutable plan from registered systems. Called once at createWorld (and on re-plan). */
export function buildSchedulePlan(
  systems: ReadonlyArray<SystemBox>,
  // `registeredComponentCount` is the registry's nextComponentId after createWorld registration
  // (user components + reserved ids + one presence id per relation); accessStrideWords =
  // ceil(registeredComponentCount / 32). Do NOT pass numRelations separately — presence ids are
  // already counted (component-schema.md §7.4; §3.3 of this spec).
  opts: { registeredComponentCount: number; workerCount: number },
): SchedulePlan;

/** Run one tick under the plan. Installed as world.update by world.ts. */
export function runUpdate(world: World, plan: SchedulePlan, dt: number): void;   // §6.2
```

`createWorld` options this module reads (public-api.md §7; report §2.5 / Q-S2):

```ts
interface SchedulerOptions {
  threaded?: boolean;                         // default false (single-thread executor)
  workers?: number | 'postMessage-fallback' | 'auto';   // worker count or mode (memory-buffers.md §4.2 WorkerMode)
  maxSystems?: number;                        // Q-S1: above ~200 use the sparse edge derivation (§4.3)
  // NOTE: observerCadence is NOT a SchedulerOptions field — it is a reactivity:{} knob
  // ('frame-end' | 'per-system', default 'frame-end'; world.md §9.5). The scheduler READS the
  // resolved reactivity option and drives the drain (§6.7).
}
```

---

## 13. Open questions deferred (non-blocking, from report §8)

- **Q-S1** (max system count / Floyd-Warshall → sparse): v1 uses DFS-based O(V+E) cycle detect +
  O(V·E) reduction; switch the implicit-edge derivation to the writers-driven pass above ~200 systems
  (§4.3). The exact threshold is a tuning constant.
- **Q-S2** (apply cadence between every wave vs frame end): mechanism specified (§6.3 serial slot per
  wave; `observerCadence` knob, §6.7). v1 default `'frame-end'`.
- **Q-S4** (`onAnyWorker` / stateless replicated systems): deferred to v2. The `workerEligible` flag
  (§3.1) is the enabling hook; a replicated system would dispatch to all workers with a partitioned
  entity range — not v1.
- **v2 column-level conflict** (§5.2): `concurrencyCompatible` is the single seam a v2 build narrows
  from type-level to archetype-column-level granularity (report T5).
- **v2 worker-side structural mutation** (Atomics record CAS): not v1; the command-buffer serial
  apply (command-buffer.md §7) and the entity record `commitRecord` indirection (entity-model.md §4.2)
  are the enabling seams.
