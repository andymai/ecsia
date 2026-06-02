# ecsia Specification — Authoritative Index & Decision Record

ecsia is a general-purpose, batteries-included, ESM-only, strict-TypeScript ECS for a pnpm
monorepo. It targets all JS runtimes, with multi-threading via `SharedArrayBuffer` and a
**required** `postMessage` fallback for non-cross-origin-isolated contexts (never a silent
failure). The kernel is **correct single-threaded first**: worker dispatch + `Atomics`
wave-sync + command-buffer apply land together at milestone **M7**, over the same data
structures, changing no semantics.

The spec set is **coherent and implementable.** This README is the authoritative map: the
module index, the resolved cross-spec decision record (CANON), the must-fix status, the
remaining non-blocking tuning questions, and the ready-to-implement checklist mapped to the
build-plan milestones.

---

## 1. Module index

All thirteen module specs are written and normative. **`world.md` is the keystone** — every
other module defers to it for cross-cutting facts (option shape, reserved ids, phase/tick,
shared constants); where two specs restate the same constant, **world.md is canonical.**

### Module specs (normative)

| Spec file | Module | Purpose (one line) |
|---|---|---|
| [`world.md`](./world.md) | **World & `createWorld` (KEYSTONE)** | The world-creation protocol: `WorldOptions` (CANON nested shape), validation + wiring order, the `world.phase` state machine, reserved `ComponentId` set, `maxEntities` sizing, the `Tick` ownership contract, and §9 the canonical-constant registry every other spec cites. |
| [`entity-model.md`](./entity-model.md) | Entity Model, Handles & Records | Generational `EntityHandle` (default 22 index / 10 generation), dense/sparse free-list, the two-word entity record (structural commit point), `spawn`/`despawn`/`isAlive`, worker ID-reservation handshake. |
| [`memory-buffers.md`](./memory-buffers.md) | Memory, Buffers & SAB Strategy | Per-field SoA column layout, the `Buffers` registry (3-part `ColumnKey`), SAB-vs-`ArrayBuffer` selection, length-tracking views + the `__rebind` accessor view-invalidation protocol (Must-Fix #5). |
| [`type-system.md`](./type-system.md) | Type-System & Schema Inference | `defineComponent`/`defineRelation` with full TS inference (no decorators/codegen); field tokens, branded IDs, query-arity cap (`MAX_QUERY_ARITY=8`) + escape hatch, the accessor *type* contract. |
| [`component-schema.md`](./component-schema.md) | Component & Relation Schema API | The runtime registry: id minting from `FIRST_USER_COMPONENT_ID`, schema → `ColumnSet`, `defineTag`, the setter `trackWrite` call-site contract. |
| [`accessors.md`](./accessors.md) | Monomorphic Accessor Layer | The factory-closure accessor class (one hidden class per `(archetype,component)`), `__idx`/`__rebind` bodies, the `entity.read(C)`/`entity.write(C)` split, `trackWrite(handleIndex(__eid), id, fieldIndex?)` call-site. |
| [`archetype-storage.md`](./archetype-storage.md) | Archetype Tables, Bitmask & Migration | Canonical signatures, SoA archetype tables, lazy edge-graph migration cache, swap-pop rows, `migrate`/`migrateAddingMany`/`migrateRemovingMany`, the serial-only per-entity bitmask, `ensureRowCapacity` (grows `changeVersion` too), cold-archetype fallback. |
| [`queries.md`](./queries.md) | Query Matching, Caching & Filters | The query DSL runtime, per-archetype matching (O(A)), `LiveQuery`, the canonical-hash cache (pair-target encoded), sparse-set results, single-entity incremental matcher, the `Changed` filter integration. |
| [`relations.md`](./relations.md) | First-Class Relations & Pairs | Integer-encoded `(relationId, targetIndex)` pairs as archetype members, per-relation presence bit (O(1) wildcard), payload exclusivity split (Must-Fix #4), back-ref index, cascade-on-delete. |
| [`reactivity.md`](./reactivity.md) | Change Detection & Observers | Ring write/shape logs + per-system read pointers for the `Changed` filter (no per-field atomic), per-row `changeVersion` stamps for the public predicate + delta serializer, deferred observers, recoverable log overflow, frame-loop lifecycle. |
| [`scheduler.md`](./scheduler.md) | System Scheduler & Parallel-Ready Executor | Access-graph construction, priority-weighted conflict DAG + wave extraction, the correct single-threaded executor (M6), worker dispatch + 3-tier Atomics wait (M7); sole writer of `world.phase`. |
| [`command-buffer.md`](./command-buffer.md) | Command Buffer & Deferred Structural Changes | Per-worker `Uint32Array` command-buffer layout (shared op ordinals), the direct-apply guard (`phase==='serial' && isMainThread()`), deterministic fixed-worker-index merge, validate-then-apply drop-if-dead (Must-Fix #3). |
| [`serialization.md`](./serialization.md) | Serialization & Cross-Worker Transfer | Copy-based snapshot + `changeVersion`-driven delta (no shadow map), zero-copy SAB sharing, entity-ID remap on deserialize, the `ColumnsAdded` worker handshake (G-7). |

### Assembly & roadmap specs

| Spec file | Purpose (one line) |
|---|---|
| [`public-api.md`](./public-api.md) | The cohesive end-user surface re-exported from the lower modules (`createWorld`, definitions, `entity.write(C)` vs read shorthand, `query`, `defineSystem`/`update`, observe, serialization) + a complete type-checkable worked example. Owns no mechanism; world.md is canonical for option shape/defaults. |
| [`build-plan.md`](./build-plan.md) | Ordered M0–M12 milestone roadmap, pnpm package layout, per-milestone Vitest/fast-check/bench exit criteria, the single-threaded-first → M7-parallelism gate, and the module→package→milestone map. |

---

## 2. Resolved cross-spec decision record (CANON)

The coherence pass found a set of cross-spec contradictions/gaps. They are **resolved**: the
canonical value lives in **world.md §9 (the canonical-constant registry)** plus the named owner
spec, and every referencing module cites it. This is the authoritative record.

1. **`trackWrite` signature.** `trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number)`.
   The first arg is the **LOW handle bits** (`handleIndex(__eid)`), never the raw handle.
   Accessor/type-system/component-schema setters pass `handleIndex(this.__eid)` and **forward
   `fieldIndex`** for field-granular setters. *(world.md §9.1; owner reactivity.md §3.3; resolves C1.)*

2. **Reserved `ComponentId`s.** `ComponentId 0 = NO_COMPONENT` — the "no component" sentinel,
   the CREATE/DESTROY shape-log "no component" marker, and the `changeVersion` sentinel; it is
   **never** a user component. `FIRST_USER_COMPONENT_ID = 1`. *(world.md §5; resolves C3.)*

3. **Canonical "fixed component-id count".** `registry.nextComponentId` **after `createWorld`
   registration** (includes reserved prefix + user components + one presence id per relation +
   overflow ids). **Every bit-vector/signature stride = `ceil(nextComponentId / 32)`.**
   scheduler.md drops its separate `+ numRelations` term. *(world.md §5.3/§9.3; resolves C4.)*

4. **Write/shape-log entry width.** If **any** relation type is registered, the log uses
   **two-word entries** (full 32-bit `componentId` field), selected at `createWorld` based on
   whether `defineRelation` was used; the **one-word fast path** is used **only** in
   relation-free worlds. This removes the 10-bit/1023-id overflow against unbounded synthetic
   pair ids. *(world.md §9.6; resolves C2.)*

5. **Shared structural-op ordinals.** Identical numeric values across command-buffer `Op`,
   serialization `DeltaOp`, and reactivity `ShapeKind` (names may differ): `CREATE=0`,
   `DESTROY=1`, `ADD=2`, `REMOVE=3`, `ADD_PAIR=4`, `REMOVE_PAIR=5`, `SET_PAYLOAD=6`. Each spec
   states it shares this numbering. *(world.md §9.4; resolves the Op-ordinal-drift item.)*

6. **`observerCadence` literal set.** `'frame-end' | 'per-system'`, default `'frame-end'`. The
   scheduler maps `'per-system'` to its per-wave serial-slot dispatch internally; no
   `'per-wave'`/`'end-of-frame'` literals survive in the public API. *(world.md §9.5.)*

7. **`createWorld` option shape.** `createWorld({ maxEntities?, reactivity?: {...}, scheduler?: {...} })`
   — feature knobs **nested** under feature keys. The reactivity knobs (`maxWritesPerFrame`,
   `maxShapeChangesPerFrame`, `observerCadence`, `changeTrackingDefault`, `logEntryWords`,
   `shrinkRings`) live under `reactivity:{}`; worker knobs under `scheduler:{}`. Default
   `maxEntities = 1 << 20` (1,048,576). *(world.md §2.2/§6.1.)*

8. **`world.phase` ownership.** Owned by the world, initialized to `'serial'` at construction
   (before any system runs, with or without a scheduler). The scheduler is the **only**
   component that flips it to `'wave'`, and only during parallel waves in threaded mode; in
   single-thread and kernel-only modes it stays `'serial'` permanently. command-buffer
   direct-apply guard = `world.phase==='serial' && isMainThread()`. *(world.md §4.)*

9. **`Tick` ownership.** The world owns `world.tick` (number getter); `world.currentTick()`
   returns the same value. Reactivity advances the tick at frame reset by calling into the
   world. All readers use `world.tick` — one counter, no private frame counters. *(world.md §8.)*

10. **`changeVersion` column growth.** `archetype-storage.ensureRowCapacity` grows **all**
    columns registered for the archetype, **including** reactivity's `changeVersion` column
    (registered via `buildColumnSet` under `CHANGEVERSION_COMPONENT_ID` as a hidden,
    non-query-matching column). Not an either/or — this is the pinned path. *(world.md §9.8;
    archetype-storage.md §5.3.1.)*

11. **G-7 worker column handshake.** `ColumnsAdded` postMessage notices are drained **and
    applied** by each worker during the inter-wave barrier **before** the next wave dispatches;
    `scheduler.prepareWave` guarantees notice-applied-before-dispatch. Stated normatively in
    scheduler.md and serialization.md. *(world.md §9.9.)*

12. **Combined-migration primitives (required).** Storage **must** provide
    `migrateAddingMany(handle, componentIds[])` / `migrateRemovingMany(handle, componentIds[])`
    (one combined migration computing a single target signature) — required by relations
    atomicity (P1). *(world.md §9.7; archetype-storage.md §5.6a.)*

13. **Foundational encodings (carried from the prior coherence pass, still canonical).** `eid`
    column = full u32 handle bit-pattern via `Int32Array`, `-1` null sentinel, no bit-31 flag,
    no parallel generation column (memory-buffers.md §3.4). `NO_ENTITY = 0xffffffff` canonical,
    `NULL_ENTITY` its alias (entity-model.md §2.5). `ColumnKey` = `${archetypeId}:${componentTypeId}.${fieldIndex}`
    (3-part). `EMPTY_ARCHETYPE_ID = 0` (real archetype) vs `ARCHETYPE_NONE = 0xffffffff` (record
    sentinel), owned by archetype-storage.md §3.1. Despawn ordering: `trackShape(Destroy)` +
    `enqueueRemoveLog` → `removeRow` → bitmask clear → `freeEntity` (entity-model.md §6.3).
    Exclusive-relation payload columns keyed by `presenceId(R)` as a column-bearing synthetic
    `ComponentDef` (relations.md §3.2). `RelationId` u16 cap (65,535) fail-fast at creation. The
    "bitmask module" is archetype-storage.md §6 (no separate file).

---

## 3. Must-fix status (all five resolved, with owning spec)

| # | Must-fix | Status | Owning spec(s) |
|---|---|---|---|
| **#1** | Bitmask is main-thread / serial-phase only; workers read archetype tables, never the bitmask | **RESOLVED** | archetype-storage.md §6 (serial-only asserts) + scheduler.md/command-buffer.md (worker isolation, `world.phase` gate) |
| **#2** | Read/write split: `entity.write(C)` is the only tracked mutation; the `entity.<comp>` shorthand is `Readonly` (type) **and** the runtime `.changed` filter is driven by `trackWrite` from the mutable setter | **RESOLVED** | type-system.md §9 (type-level) + reactivity.md §3.3 + accessors.md (runtime `trackWrite(handleIndex(__eid), id, fieldIndex?)` — completes the C1 runtime half) |
| **#3** | Command-buffer layout / flush / deterministic merge / validate-then-apply drop-if-dead | **RESOLVED** | command-buffer.md (full layout, shared op ordinals §2 CANON, fixed-worker-index merge, drop-if-dead) |
| **#4** | Relation payload exclusivity split (exclusive = in-place eid write, no migration; non-exclusive = overflow table) | **RESOLVED** | relations.md §3.2/§4.2 (presence bit + exclusivity split + overflow table) |
| **#5** | Accessor view-invalidation on buffer growth: length-tracking views primary, `__rebind` registry fallback | **RESOLVED** | memory-buffers.md §7.5 (V-1 length-tracking + fallback) + type-system.md §9 / accessors.md (`__rebind` body) |

The two former blockers are closed: the **world.md keystone** resolves gap G-6 (world-creation /
`world.phase` / reserved ids / wiring order), and the **command-buffer.md / scheduler.md /
queries.md / serialization.md / accessors.md / component-schema.md** specs close gaps G-1..G-5
and G-7. There are no remaining "unwritten" specs and no UNRESOLVED contradictions.

---

## 4. Remaining open questions (non-blocking tuning — deferred to gated milestones)

These are documented in-spec with a v1 default; none block implementation.

- Identical-schema nominal-branding policy — `brand` literal is the v1 answer (type-system.md §2.3).
- `MAX_QUERY_ARITY` exact value pending the M11 `tsc` budget fixture (type-system.md §6.4; cap is 8).
- SAB slab allocator vs per-archetype column SABs — per-archetype chosen (memory-buffers.md, Q-A2).
- Cached `EntityRef` row vs always-resolve — always-resolve default (entity-model.md, Q-H2).
- Pair-ID reclamation when ref-count hits 0 — retain-by-default v1 (relations.md, Q-R1).
- Automatic cold→hot archetype promotion — explicit `world.warm` only v1 (archetype-storage.md §10.4).
- Change-tracking granularity component vs field — component default (reactivity.md, Q-CD1).
- `maxHotArchetypes` default formula as a function of `maxEntities` — tune at M8 (world.md Q-W2).
- `addSystem` post-construction re-plan: full DAG rebuild vs incremental — settle at M6 (world.md Q-W1).
- Kernel-only `runFrame(world, dt)` helper vs fully-manual loop — confirm at M5 (world.md Q-W3).
- `generationBits === 0` under `threaded:true`: hard `ConfigError` (current) vs downgrade — world.md Q-W4.
- Explicit `world.dispose()` vs GC-only for SABs/workers — leaning explicit, settle at M7 (world.md Q-W5).
- `world.targetOf(subject, exclusiveRelation)` convenience naming/return — confirm at M8 (public-api Q-PA1).
- `SystemContext.commands` explicit handle vs transparent routing — leaning transparent, settle at M7 (public-api Q-PA2).
- `spawnWith` init ergonomics (tuple vs object form) — confirm against inference budget at M11 (public-api Q-PA3).
- Snapshot scope (cold archetypes + relation overflow) — default full state incl. relations (public-api Q-PA5).
- Umbrella tree-shaking (no scheduler pull-in for single-threaded bundle) — bundle fixture at M11 (public-api Q-PA6).

---

## 5. Ready-to-implement checklist (mapped to build-plan milestones)

Every module spec is written, normative, and cross-consistent (CANON §2). Each milestone is
closed only when its Vitest unit + fast-check property + bench buckets are all green
(build-plan.md). **M7 is the pivot:** M0–M6 deliver a fully tested single-threaded ECS before
any worker/Atomics/command-apply code lands.

**M0 — Foundations, harness & keystone scaffold**
- [ ] pnpm workspace, `tsconfig.base.json` (strict/ESM/project-refs), `vitest.workspace.ts`, fast-check + bench harness, headless worker rig, miniplex/bitECS baselines as devDependencies.
- [ ] **world.md keystone scaffold** in `@ecsia/core` (`world.ts`): `WorldOptions` (CANON nested, `maxEntities` default `1<<20`), reserved ids (`NO_COMPONENT=0`, `FIRST_USER_COMPONENT_ID=1`), `world.phase`/`world.tick` typed stubs, option-validation fail-fast, the §7 wiring skeleton (registry → buffers → storage → reactivity → queries → scheduler → serialization).
- [ ] Exit: `createWorld({})` resolves CANON defaults; SAB grow/round-trip across a worker boundary; no-SAB lane green from day one.

**M1 — Entity layer** (entity-model.md → `@ecsia/core` `entity/`)
- [ ] Handle codec (`makeHandle`/`handleIndex`/`handleGeneration`, 22/10 default), dense/sparse free-list, `isAlive` (never the bitmask), two-word record + `commitRecord`/`resolveLocation`, pooled `EntityRef`, `reserveEntityBlock` layout. Properties: I1–I4, I8, free-list density.

**M2 — Memory, buffers & accessors** (memory-buffers.md + accessor half of type-system.md/accessors.md → `@ecsia/core` `memory/`,`component/` + `@ecsia/schema`)
- [ ] `Column`/`Region`/`Buffers` (3-part key), backing selection, **length-tracking views (V-1)** primary + `__rebind` fallback, field-type→layout table (`eid`→i32 `-1`), the factory-closure accessor + read/write split, `trackWrite` setter call-site (stubbed until M5). **Resolves Must-Fix #5.** Gated by §6.2.

**M3 — Archetype storage + bitmask** (archetype-storage.md → `@ecsia/core` `storage/`,`bitmask/`)
- [ ] Signatures + hash, archetype tables, lazy edge graph, `allocRow`/`removeRow`/`migrate`/`migrateAddingMany`/`migrateRemovingMany`, serial-only bitmask §6, `changeVersion` registration hook (§5.3.1) + `ensureRowCapacity` growth, cold-store + `world.warm`. Properties: SIG-1, AR-1, EDGE-1, ROW-1, MIG-1/2, BM-1/2, FRAG-1. Honors Must-Fix #1 + #5.

**M4 — Queries** (queries.md → `@ecsia/core` `query/` + `@ecsia/schema`)
- [ ] DSL runtime, per-archetype matching, `LiveQuery`, canonical-hash cache (pair-target encoded), sparse-set `current`, single-entity `matchEntity`, arity overloads 1–8 + `LooseQueryElement` 9+. Properties: match equivalence, incremental-maintenance equivalence, hash canonicality. Gated by §6.5 (design).

**M5 — Reactivity** (reactivity.md → `@ecsia/core` `reactivity/`)
- [ ] `trackWrite` (O(1) ring push, no Atomics), `trackShape`/`trackShapePair` two-word log, `changedSince`/`changedRows`/`currentTick` over lazy per-row `changeVersion`, deferred observers, `LogPointer` cursors, lifecycle (`frameReset`→`mergeCorrals`→`maintainStructural`→`observerDrain`→`flushLogs`), recoverable spill. Properties: R-2, R-9, R-5, R-1. **Completes Must-Fix #2 runtime** (the C1 trackWrite signature).

**M6 — Scheduler (correct serial executor)** (scheduler.md → `@ecsia/scheduler` `graph/`,`planner/`,`executor/`)
- [ ] Access collection from declared `{read,write}`, priority-weighted DAG + transitive reduction + cycle detection (named-chain), wave extraction with type-level conflict, single-threaded wave executor. Command-buffer **format** declared (apply stubbed to direct main-thread). Properties: determinism, topological soundness, conflict correctness, cycle detection. Honors Must-Fix #2.

**M7 — Workers, Atomics & command buffers** (scheduler.md `workers/` + command-buffer.md → `@ecsia/scheduler` `commands/`) ⟵ highest risk
- [ ] SAB transfer + wave dispatch, 3-tier wait (`waitAsync`/`wait`/poll) + postMessage fallback (never silent), per-worker command buffers (shared op ordinals, drop-if-dead), reserved-ID handshake, **fixed-worker-index deterministic merge**, validate-then-apply, G-7 column handshake. Properties: serial-equivalence (headline), entity-ref safety fuzz, no-worker-bitmask, no mid-wave mutation. **Resolves Must-Fix #1 (isolation) + #3.** Gated by §6.1 + §6.3.

**M8 — Relations** (relations.md → `@ecsia/relations`)
- [ ] `defineRelation` (tag/exclusive-column/overflow-table), `mintPair` (index-keyed, O(1), idempotent), `addPair`/`removePair` (non-exclusive via `migrateAddingMany`; exclusive re-target = in-place eid write, **no migration**), presence-bit wildcard O(1), back-ref index + BFS cascade, overflow payload table, worker `OP_ADD_PAIR`/`OP_REMOVE_PAIR` drop-if-dead. Properties: P1–P6 + serial-equivalence. **Resolves Must-Fix #4.** Depends on M7; gated by §6.4.

**M9 — Observers under the parallel scheduler** (reactivity.md + scheduler serial slot)
- [ ] Deferred `onAdd`/`onRemove`/`onChange` drained at the serial slot (`'frame-end'` default, `'per-system'` opt-in), safe create/destroy inside observers (staged), bundled initial values on add. Property: R-3 no re-entrancy under fuzzed multi-worker frame.

**M10 — Serialization** (serialization.md → `@ecsia/serialization`)
- [ ] Zero-copy `sharedBacking` vs copy `snapshotInto`, snapshot serializer, `changeVersion`-driven delta (no shadow map), SAB structural observer-log stream (initial values for late joiners), entity-ID + relation-target remap on deserialize. Properties: round-trip identity, delta soundness, remap totality.

**M11 — Type-arity stress & inference budget** (type-system.md → `@ecsia/schema` + CI fixture)
- [ ] `MAX_QUERY_ARITY=8` overload family vs a `tsc` wall-clock budget fixture, 9+ → `LooseQueryElement` (never `any`), `Has<C>`/`HasWrite<C>` escape hatch, per-component hot-path resolution. Gated by §6.5 (budget assertion).

**M12 — Umbrella, DX & API freeze** (public-api.md → `@ecsia/ecsia` + `examples/`)
- [ ] Umbrella re-export (tree-shakes, no scheduler pull-in single-threaded), runnable examples (boids, scene-graph, worker-parallel sim), end-to-end docs, API freeze, consolidated cross-library macro-benches.

**Cross-cutting gates (build-plan §3/§4):**
- [ ] Single-threaded correctness (M0–M6) complete **before** any worker/Atomics/command code (M7) — locked ordering.
- [ ] M2: every column/region view constructed with **no length argument** (V-1).
- [ ] M2/M5: accessor created pre-grow reads/writes correctly post-`.grow()` (Must-Fix #5).
- [ ] M3: BM coherence property `bitmaskHas(i,c) === sigHas(currentSignature(i),c)` after every op.
- [ ] M7: determinism fuzz — fixed worker-index merge order for corrals **and** command buffers.
- [ ] M11: `tsc` instantiation-depth budget fixture at max query arity fails CI past budget.

**Hard-problem gates:** §6.2→M2, §6.5→M4(design)/M11(budget), §6.1+§6.3→M7, §6.4→M8.
**Must-fix → milestone:** #5→M2, #1→M3+M7, #2→M5+M6, #3→M7, #4→M8.
