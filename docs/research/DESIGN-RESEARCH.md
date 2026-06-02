# ecsia Design-Research Report

> Authoritative synthesis of source-level research into three reference ECS libraries —
> **miniplex** (JS-object archetype-less), **bitECS** (SoA + sparse bitmasks), and
> **becsy** (SharedArrayBuffer-capable, auto-scheduled) — across nine design dimensions.
> Every claim is grounded in a `file:line` citation from the reading of the real source.
>
> Status: pre-implementation. This document doubles as a research survey **and** an
> implementation specification. §3 validates each locked decision; §4 resolves cross-cutting
> tensions; **§7 specifies the five hard problems** (command buffers, SAB view invalidation,
> Atomics sync, archetype fragmentation, type-inference scaling) that must be settled before
> coding. **§8 (Must-Fix)** lists the blocking decisions, each resolved to a concrete protocol.

---

## 1. Executive Summary & Differentiated Thesis

ecsia is a **batteries-included, ESM-only, strict-TypeScript ECS** that targets the
intersection of three properties that **no single reference library delivers together**:

1. **Cache-coherent SoA iteration** (archetype-table column access) — present in neither
   becsy (per-type sparse/packed arrays, pointer-chasing entity-handle lists,
   `becsy/src/datatypes/entitylist.ts:55-119`) nor miniplex (JS-object entities,
   `miniplex/packages/core/src/core.ts:128-162`).
2. **SharedArrayBuffer worker parallelism** with auto-derived scheduling — designed but
   **never shipped** in becsy (`ThreadedPlan` is a stub; `becsy/src/dispatcher.ts:130-132`
   throws `'Multithreading not yet implemented'`), and architecturally impossible in
   miniplex (JS-object entities cannot cross worker boundaries).
3. **First-class Flecs-style relations** with typed payloads — present in bitECS
   (`bitECS/src/core/Relation.ts:69-93`) but built on JS object identity that cannot
   cross SAB/worker boundaries, and absent from becsy (only `Type.ref` fields,
   `becsy/src/refindexer.ts:280-284`).

**Honest framing of the difficulty.** Worker parallelism over SAB with an auto-derived
schedule has **no shipped prior art in JS** — becsy designed the planner but never built the
execution layer (`becsy/src/dispatcher.ts:130-132`). ecsia is not assembling proven parts; it
is building the part everyone stopped at. The bulk of the implementation risk lives in three
places, each given a dedicated specification in §7: the **command-buffer protocol** for
deferred structural changes (§7.1), **SAB view invalidation on growth** (§7.2), and
**Atomics-based cross-worker wave synchronization with a postMessage fallback** (§7.3). The
remaining two hard problems — **archetype fragmentation under relations** (§7.4) and
**TypeScript type-inference scaling** (§7.5) — are not concurrency problems but they equally
block a usable v1.

### The thesis

> **ecsia = archetype-table SoA storage (for iteration throughput) layered over a
> per-entity SharedArrayBuffer bitmask used for O(1) single-entity membership tests
> (`entity.has`) and incremental query maintenance, with integer-encoded relation pairs as
> first-class archetype members, driven by a wave scheduler (topological layering + a worker
> pool + command buffers) that becsy designed but never finished.**

The central architectural insight, repeated across the dimensions below, is that the
reference libraries each pick **one** of {fast iteration, cross-worker sharing, flexible
relations} as their *strong suit* and pay for it elsewhere. (This is a framing, not a
theorem: bitECS, for example, has both SoA storage **and** first-class relations in the same
library — what it lacks is cross-worker sharing of those relations, because pair identity is a
JS object, `bitECS/src/core/Relation.ts:69-93`.) ecsia's differentiation is that the three can
be made **complementary** when two parallel representations are kept in sync — provided the
coherence protocol between them is fully specified (it was not, in earlier drafts; see §7 and
§8).

- The **bitmask layer** (becsy's `ShapeArray`, `becsy/src/datatypes/shapearray.ts:21-204`)
  is a *per-entity membership index*. Its job is precise:
  - **O(1) `entity.has(C)`** point checks (one word load + mask).
  - **Incremental query maintenance**: when a single entity migrates, re-test it against the
    queries that reference the changed component (`becsy/src/query.ts:148-181`).
  - It is **NOT** the mechanism for full query iteration. **Query iteration matches per
    archetype, not per entity** — there are at most `A` archetypes, each tested with one
    bitwise AND per signature word (O(A) matching, the standard Flecs/archetype-table
    approach). Iterating all entities and AND-ing each entity's bitmask would be strictly
    worse than archetype-level matching and is **not** what ecsia does. (Earlier drafts'
    "O(C/32) query match" claim conflated single-entity matching with query iteration; it is
    corrected throughout — see §2.4 and §3 #4.)
- The **archetype table** (Flecs-style, absent from becsy) is the *storage*: contiguous
  SoA columns for cache-coherent iteration and a natural SAB allocation unit.

Everything else — accessors, scheduler, relations, reactivity, serialization — is built to
preserve both representations cheaply on the hot path. The **single hardest correctness
question** the dual representation creates is *who reads the bitmask, when, and under what
memory ordering*. That question is **resolved (not deferred) in §8 Must-Fix #1**: the
per-entity bitmask is **main-thread / serial-phase only**; worker threads during a wave read
the **archetype tables only** and never consult the bitmask. This removes the need for an
atomic bitmask/record commit and is the load-bearing decision behind T2.

---

## 2. The Nine Dimensions

For each dimension: **what works** (with library + citation), **what to avoid**, and the
**concrete recommended design for ecsia**.

### 2.1 Archetype Storage

**What works**

- **Flat bitmask shape array** (becsy). Entity membership is a
  `Uint32Array[maxEntities * stride]`, `stride = ceil(numBits/32)`; presence is
  `(array[entityId*stride + offset] & mask) === value`. O(1) per-entity check, SAB-capable
  via an `AtomicSharedShapeArray` variant using `Atomics.or/and`. — `becsy/src/datatypes/shapearray.ts:21-108, 112-204`;
  `becsy/src/registry.ts:108-113`. (Used in ecsia only for `entity.has` and incremental
  maintenance, **not** for query iteration; see §1 and §2.4.)
- **Three parallel shape arrays + deferred removal log** (becsy): `shapes`, `staleShapes`,
  `removedShapes` give a reactivity window (recently-deleted data visible to observers)
  without freezing live state; cleanup is O(removals) via a packed ring buffer. —
  `becsy/src/registry.ts:83-86, 320-356, 412-423`.
- **Storage decoupled from identity** (becsy): three orthogonal strategies — `sparse`
  (entityId == index), `packed` (indirect map + free-list), `compact` (linear scan for
  singletons) — so rare tag components cost no per-entity allocation. —
  `becsy/src/component.ts:179-270, 273-340, 423-485`.
- **Per-component reverse query index** (becsy): only queries that reference a changed
  component are re-evaluated, via `shapeQueriesByComponent[typeId]`. —
  `becsy/src/query.ts:148-181, 562-577`.
- **Zero-migration bucket model** (miniplex): entities are reference-counted into multiple
  live `Bucket` views; shuffle-pop removal keeps arrays dense. Excellent for small counts;
  fundamentally incompatible with SoA. — `miniplex/packages/bucket/src/Bucket.ts:125-148`;
  `miniplex/packages/core/src/core.ts:71-86`.

**What to avoid**

- **No archetype grouping at all** (becsy): without grouping identical component sets,
  iteration is pointer-chasing through entity-handle lists and component B follows
  component A by jumping between separate arrays — defeats cache locality. —
  `becsy/src/datatypes/entitylist.ts:55-119`; `becsy/src/component.ts:437-444`.
- **JS-object entities** (miniplex): property-presence as membership; no SoA, no SAB, no
  workers. — `miniplex/packages/core/src/core.ts:128-136, 149-162`.
- **Global reindex on every mutation** (miniplex): O(Q) per add/remove where Q = query
  count; surprises users who add systems. — `miniplex/packages/core/src/core.ts:251-258`.
- **Monolithic pre-allocated `maxEntities * numComponentBits` array** (becsy): inflexible
  for ecsia's dynamic relation-pair component space. — `becsy/src/registry.ts:106-113`.

**Recommended design**

Classic **Flecs-style archetype table + lazy edge-graph + per-entity bitmask (membership
index)**:

- *Archetype identity*: sorted `Uint32Array` of component IDs (canonical signature) for
  fast equality/hash. Each archetype owns one TypedArray column per component in SoA
  (`columns[componentId][row]`); all columns grow together.
- *Entity records*: two flat global arrays — `archetypeId[maxEntities]` and
  `archetypeRow[maxEntities]`. A migration touches only these two words per entity.
- *Edge graph*: each archetype node holds `Map<ComponentId, {add, remove}>`. `entity.add(C)`
  follows `currentArchetype.edges.get(C)?.add` (O(1) amortized) or computes the new sorted
  signature and caches the edge. This is what becsy lacks
  (`becsy/src/registry.ts:399-423` just flips bits).
- *Migration protocol*: copy shared columns A→B, init added column, fire `onRemove` (via the
  log, **deferred**, not synchronously) for removed, shuffle-pop the vacated source row
  (updating the moved entity's `archetypeRow`), then write the two entity-record words.
  **All migrations execute on the main thread / serial phase** (workers never migrate during
  a wave — see §7.1), so the commit is a plain pair of stores, not an atomic CAS, in the
  single-threaded case.
- *Per-entity bitmask (membership index, retained from becsy)*: a separate flat (or
  lazily-grown sparse) bit-vector for **O(1) `has`** and **incremental query re-test of a
  single migrated entity**. **Consulted only on the main thread / serial phase.** Workers
  during a wave do not read it (§8 #1). Its memory cost and stride determination are
  specified in §7.4 (it is *not* a full `maxEntities × pairIdSpace` matrix — pair IDs use a
  separate lazily-grown sparse vector, and the stride for ordinary components is fixed at
  world creation from the registered component count, growing only when new component types,
  not new pairs, are minted).
- *Relations*: each unique `(relation, target)` pair gets a synthetic `ComponentId`; edges
  work identically for pair IDs. Use a **lazily-grown** sparse bit-vector (not becsy's
  fixed-width pre-alloc) for the pair-ID region of the bitmask, to handle the unbounded pair
  ID space. The fragmentation consequences and the cold-archetype fallback are specified in
  §7.4.
- *Deferred structural changes*: buffer add/remove/create/destroy into per-worker command
  buffers; **the buffer layout, merge order, and entity-reference safety invariants are
  fully specified in §7.1** (this was previously underspecified). Flush at wave boundaries on
  the main thread.
- *Query iteration*: each query caches matching-archetype pointers; iterate
  `0..archetype.count` with direct column access — no pointer chasing. Matching is **per
  archetype signature** (O(A)), not per entity.
- *Version stamps*: per-archetype-column `changeVersion: Uint32Array[count]`, stamped on
  write; `changed` queries filter `changeVersion[row] > query.lastRunTick`.
- *Commit point*: in the single-threaded case, a plain two-store write of the entity record
  after column copies. In the threaded case there is **no concurrent structural write** (all
  migrations are serial, §8 #1), so an atomic CAS on the record is **not** required for
  correctness; if a future v2 ever allows worker-side structural mutation, the CAS protocol
  is written out in §7.1 as a contingency, but v1 does not use it.

---

### 2.2 Component Schemas & SoA

**What works**

- **Schema-driven SoA allocation** (bitECS legacy): `defineComponent({x:'f32'})` allocates
  one TypedArray per field; `Position.x[eid]` is a single typed-array read. TS infers
  `ComponentType<T>`. — `bitECS/src/legacy/index.ts:167-189`.
- **Nested vector via `[type, length]`** (bitECS legacy): `Array<TypedArray>`, one array per
  axis — keeps SoA for multi-element fields (SIMD-friendly per-axis bulk ops). —
  `bitECS/src/legacy/index.ts:100-101, 171-173`.
- **Central `Buffers` registry with 2× growth** (becsy): `register(key,len,Type,cb)`
  allocates SAB (threaded) or AB, copies old data in before swapping the reference (no torn
  reads), and in threaded mode emits a patch (`makePatch`/`applyPatch`) so workers re-wrap
  the new SAB. — `becsy/src/buffers.ts:96-125`; `becsy/src/component.ts:229-250`.
- **Monomorphic accessor via shared-prototype `defineProperty`** (becsy): one
  `writableMaster`/`readonlyMaster` per component type, a mutable `binding.writableIndex`
  poked before use — keeps the hidden class stable so V8 inlines the getter. — `becsy/src/type.ts:72-93, 142-163`.
- **Static strings as typed-array indices** + **entity refs as `Int32Array` with -1
  sentinel and bit-31 stale flag** + **non-shareable `Type.object` escape hatch
  (`shared=false`)** — all keep data in transferable storage or explicitly opt out. —
  `becsy/src/type.ts:566-784, 787-931, 1024-1082, 26-27`.
- **Variable-width index upgrade** (becsy): `PackedStorage` upgrades Int8→Int16→Int32 as
  capacity crosses range boundaries. — `becsy/src/component.ts:209, 266-270`.

**What to avoid**

- **No-op `soa`** (new bitECS core): `soa = <S>(spec)=>spec` — components are untyped
  `any`, no storage, no SAB. Copying this loses everything. —
  `bitECS/src/core/utils/soa.ts:1`; `bitECS/src/core/Component.ts:22`.
- **Unbounded dynamic strings in SAB** (becsy): require a declared `maxUtf8Length`, waste
  bytes per entity, and need TextEncoder/Decoder on every access. —
  `becsy/src/type.ts:676-784`.
- **`Type.object` as a `any[]`** that can't transfer to workers, enforced only at
  world-definition time (opt-in). ecsia should make the non-shareable boundary structural
  and early. — `becsy/src/type.ts:1024-1028`.

> **Note on `defineProperty`-on-prototype (claim withdrawn).** An earlier draft listed
> becsy's `configurable:true` prototype-`defineProperty` under "what to avoid" while
> *simultaneously* calling it the model to emulate — a direct contradiction, and the "can
> break some V8 optimizations" assertion was **uncited and unbenchmarked**. That claim is
> **withdrawn**. becsy's shared-prototype accessor (`type.ts:72-93`) is a legitimate,
> measured-in-the-wild pattern. ecsia chooses the **closure-capture factory** pattern
> (below) over it not because `defineProperty` is slow — that is unproven — but because the
> closure pattern removes the `binding.writableIndex` indirection and captures the column
> TypedArray reference directly, which is a *simpler* monomorphic shape. If benchmarking in
> M2 shows the two are equivalent, either is acceptable; the closure factory is the default
> and the contradiction is resolved by deleting the unsupported avoidance claim.

**Recommended design**

- *Field types*: `bool, i8/u8, i16/u16, i32/u32, f32/f64, eid, vec2/vec3/vecN(type,n),
  staticString(choices), object<T>` (the last marked non-shareable). **No `dynamicString`
  in v1**; add `fixedString(maxBytes)` later if needed (becsy `type.ts:681-685` pattern).
- *Layout*: one TypedArray per scalar field, one per vector field (`len = capacity*stride`);
  separate buffers per field (avoids alignment bugs) via a central `Buffers` keyed by
  `${componentTypeId}.${fieldIndex}`.
- *Growth*: see **§7.2** — the growth strategy is tied to the accessor view-invalidation
  protocol and **cannot** be specified independently. ecsia uses **resizable SABs with
  length-tracking TypedArray views** as the primary strategy, falling back to becsy's
  grow-and-patch (`becsy/src/buffers.ts:102-124`) only where resizable SABs are unavailable.
  The full protocol, including which views auto-track and which must be re-created, is §7.2.
- *SAB strategy*: one `threaded` boolean at world creation; numeric buffers are SAB when
  threaded, `field.object` always plain JS array + component marked `restrictedToMainThread`.
  Make the split **structural at the type level** — a worker-tagged system referencing an
  object-field component is a TS error.
- *Accessors — the factory-closure pattern (NOT runtime codegen)*: the locked decision #6
  "**no codegen**" means **no build-time textual code emission and no `new Function()`/`eval`
  at runtime** (the latter is CSP-blocked, `becsy/src/component.ts:105-133`). The recommended
  approach is a **factory function returning a closure-bound accessor class** — a plain JS
  class whose getters/setters close over the column TypedArrays and read a mutable `__idx`.
  This is *not* code generation in the textual sense; it is a parameterised closure. The word
  "codegen" is **removed** from the monorepo layout (§5) to avoid confusion. The factory is
  produced once at `defineComponent` time (or once per `(archetype, component)` pair at
  archetype creation — see §2.3), never re-emitted as source.

```ts
// factory invoked once, e.g. at archetype creation for Position { x: f32, y: f32 }.
// xData / yData are LENGTH-TRACKING views over a resizable SAB (see §7.2) so they
// remain valid after .grow(); on the grow-and-patch fallback path the factory is
// re-invoked and live instances are updated via the accessor registry (§7.2).
function makePositionAccessor(xData: Float32Array, yData: Float32Array) {
  return class PositionAccessor {
    __idx = 0;
    get x() { return xData[this.__idx]; } set x(v) { xData[this.__idx] = v; }
    get y() { return yData[this.__idx]; } set y(v) { yData[this.__idx] = v; }
  };
}
```

- *Tag components* (zero fields): skip all buffer registration; presence is pure bitmask /
  archetype membership (becsy `sparse` path, `component.ts:387-389`).

---

### 2.3 Entity Handles & Accessors

**What works**

- **Generational bit-packed u32 handle** (bitECS): index in low bits, generation in high
  bits; staleness is one AND. `isEntityIdAlive` checks `dense[sparse[id]] === id`. No heap
  alloc. The split is **configurable via `withVersioning(versionBits)`** —
  the 8-version-bit (256-generation) default is not forced on the user. —
  `bitECS/src/core/EntityIndex.ts:31-52, 76-96, 104-165`.
- **Dense/sparse free-list with swap-and-move recycling** (bitECS): O(1) alloc/free, no
  extra heap objects. — `bitECS/src/core/EntityIndex.ts:104-165`.
- **Shared-per-type accessor singleton with `binding.writableIndex`** (becsy): zero
  allocation per iteration; `__bind(id, writable)` pokes the index and returns the existing
  singleton. — `becsy/src/component.ts:136-162`; `becsy/src/type.ts:126-193`.
- **`EntityPool` with borrow-count** (becsy): wrapper objects pooled; `borrow(id)`/`return(id)`
  bracket a system, not per-entity. — `becsy/src/registry.ts:26-74`.
- **`Uint32Pool` with `Atomics.sub` for lock-free ID take** (becsy): multi-worker entity
  creation with a single atomic. — `becsy/src/datatypes/intpool.ts:98-105`.

**What to avoid**

- **JS-object entities** (miniplex): `addComponent` mutates hidden class → megamorphic hot
  loops. — `miniplex/packages/core/src/core.ts:128-162`.
- **Lazy `Map<entity,number>` IDs without generation/recycling** (miniplex): can't detect
  stale refs; Map entries leak. — `miniplex/packages/core/src/core.ts:263-297`.
- **ES `Proxy` accessors** — disables V8 ICs, ~3-5× per-access overhead, not transferable to
  workers. becsy deliberately avoids it. — `becsy/src/type.ts:72-93`.
- **Disabling versioning under SAB** (bitECS): stale handle can alias a reused index. —
  `bitECS/src/core/EntityIndex.ts:128-165`.

**Recommended design**

- *Handle*: generational u32, **configurable split, defaulting to 22-bit index / 10-bit
  generation**, with the split chosen by the *target workload*, not picked arbitrarily (see
  the derivation below and §3 #3). Branded `type EntityHandle = number & { __brand }`.
  ecsia exposes the split as a `createWorld({ generationBits })` option (mirroring bitECS's
  `withVersioning`, `EntityIndex.ts:76-96`) so long-running sims can trade index space for
  generation space.

  > **Generation-bit derivation (replacing the unsupported "256 wraps too fast" claim).**
  > The earlier draft asserted bitECS's "24/8 default wraps after 256, too fast" — this was
  > both **technically inaccurate** (bitECS has no fixed 24/8 the user must accept; the split
  > is configurable via `withVersioning`, `EntityIndex.ts:76-96`) and **quantitatively
  > unsupported** (no churn-rate analysis). Corrected analysis: a generation wraps when a
  > single index slot is recycled `2^genBits` times. At a slot-recycle rate `r`
  > (destroy+recreate of entities landing on the *same* slot) the wrap time is
  > `2^genBits / r`. With 8 bits (256 gens) and an aggressive 10k recycles/s spread over,
  > say, a 1M-slot space, per-slot recycle is far below 1/s and 256 is fine; but for a
  > **small entity space with high churn on a hot slot** (e.g. a 1k-slot pool of bullets
  > recycled thousands of times per second), 256 wraps in well under a second and 10 bits
  > (1024) only buys ~4×. **There is no universally safe split.** ecsia therefore makes the
  > split **configurable** and documents the wrap-time formula, defaulting to 22/10, and
  > recommends 16/16 for hours-long high-churn sims. The locked decision is "configurable
  > generation split, default 22/10," **not** a fixed magic number.

- *Alloc*: bitECS swap-and-move free-list (`EntityIndex.ts:104-165`) with the configured
  generation field; `dense`/`sparse` are `Int32Array` (or SAB `Uint32Array` for workers).
  Multi-worker `allocEntity` uses `Atomics.sub` (becsy `intpool.ts:98-105`); `freeEntity` is
  single-writer (main thread, between waves — workers stage destroys to command buffers,
  §7.1).
- *Wrapper*: **one pooled `EntityRef` class per world**, NOT per entity, NOT a Proxy.
  Component accessors are getters on `EntityRef.prototype` installed once at world build;
  the getter resolves the entity's current archetype + row and returns the
  **archetype-component accessor singleton** with `__idx` poked.
- *Archetype accessor singletons*: **one per `(archetype, component)` pair**, closing over
  that archetype's exact column slice. The memory and growth-maintenance cost of these
  singletons (`A × C` of them) is **quantified and bounded in §7.2** (it is not free — that
  section specifies the live-accessor registry that the grow-and-patch fallback needs, and
  the length-tracking-view path that avoids the registry entirely).
- *Stale detection*: `world.isAlive(handle)`. **Never store `EntityRef` across system
  boundaries** — store the raw `EntityHandle` and validate before access
  (becsy `entity.ts:19-20`).
- *Typing*: branded handle + schema-inferred accessor types so `entity.position.x` is
  `number` with no `any` — subject to the arity limits and mitigations in **§7.5**.

---

### 2.4 Queries

**What works**

- **Multi-generation per-entity bitmask with per-word rollover** (bitECS): single-entity
  match is O(words) ≈ O(1). — `bitECS/src/core/Component.ts:63-76`; `Query.ts:391-411`.
- **Component-indexed reverse lookup** (bitECS): each `ComponentData` holds `Set<Query>`;
  mutation re-evaluates only relevant queries. — `bitECS/src/core/Component.ts:34-41,
  237-243, 328-335`.
- **String-hash query dedup** (bitECS): identical term sets share one `SparseSet`. —
  `bitECS/src/core/Query.ts:217-227, 329-336`.
- **Deferred removal via `toRemove` + `dirtyQueries`** (bitECS): coalesces remove-then-add
  within a frame. — `bitECS/src/core/Query.ts:436-494, 459-478`.
- **`SparseSet` (SAB-backed Uint32 variant) as the live result container** (bitECS): O(1)
  add/remove/has, dense iteration, shareable. — `bitECS/src/core/utils/SparseSet.ts:11-117`.
- **`shapeLog`/`writeLog` ring journals with per-system pointers** (becsy): scan only
  entries since last pointer; dispatch only to subscribed queries. —
  `becsy/src/registry.ts:399-422`; `becsy/src/system.ts:496-537`.
- **`QueryFlavor` bitmask** (becsy): current/added/removed/changed lists allocated only when
  declared; zero cost for unused flavors. — `becsy/src/query.ts:11-14, 97-109, 148-182`.
- **`processedEntities` Bitset dedup** (becsy): each entity evaluated at most once per frame
  even with multiple shape changes. — `becsy/src/query.ts:148-150`.

**What to avoid**

- **`number[][]` entity masks** (bitECS): poor cache locality, not SAB-shareable. —
  `bitECS/src/core/World.ts:13`.
- **Naive string-sort query hash** that may collide if component IDs aren't globally unique
  integers (relevant once relation pairs are encoded). — `bitECS/src/core/Query.ts:217-227`.
- **Query results tied to system scope** (becsy): pooled entities invalidated after
  `execute()`. ecsia's stable numeric handles avoid this. — `becsy/src/registry.ts:37-73`.
- **Pre-declared-only component list** (becsy): blocks runtime pair-component registration
  needed for relations. — `becsy/src/registry.ts:101-126`.

**Recommended design**

> **Correction — what the bitmask is for.** Query *iteration* is **per-archetype**: each
> compiled query caches the set of matching archetype signatures and iterates their columns
> directly. Matching a new archetype against a query is one bitwise AND per signature word
> (O(A) archetypes total). The **per-entity bitmask** is used only for (a) `entity.has(C)`
> point checks and (b) re-testing a *single* migrated entity against the queries that
> reference the changed component (incremental maintenance). The word-AND loop below is the
> **single-entity** matcher used for (b), **not** the query-iteration path.

- *Archetype matching (the iteration path)*: each query holds `withWords`/`notWords`/`orWords`
  signature masks. When an archetype is created (or first seen), test its signature once and,
  if it matches, append a pointer to the query's `matchingArchetypes`. Iteration walks
  `matchingArchetypes`, then `0..archetype.count` per archetype with direct column access.
- *Single-entity matcher (incremental maintenance only)*: per-entity `Uint32Array` shape
  words in a flat SAB region (main-thread-only, §8 #1); each component gets a
  `{wordIndex, bitMask}` binding. After a migration, re-test just the moved entity:

```ts
// Used ONLY to re-test a single migrated entity against the queries that reference
// the changed component. NOT the query-iteration path (that is per-archetype, above).
function matchEntity(shape: Uint32Array, q: CompiledQuery): boolean {
  for (const t of q.notWords)  if ((shape[t.wordIndex] & t.mask) !== 0)      return false;
  for (const t of q.withWords) if ((shape[t.wordIndex] & t.mask) !== t.mask) return false;
  for (const c of q.orWords)   if ((shape[c.wordIndex] & c.mask) === 0)      return false;
  return true;
}
```

- *Caching*: `Map<string, LiveQuery>` keyed by a canonical hash (sorted numeric IDs +
  distinct Not/Or prefixes). **Hash must encode relation-pair targets** (bitECS registers
  pairs as distinct component IDs so they hash naturally).
- *Result storage*: SAB-capable `Uint32Array` sparse set for `current`; transient
  `added`/`removed`/`changed` arrays cleared each frame.
- *Incremental maintenance*: each binding holds `Set<LiveQuery>`; a single entity's migration
  re-evaluates only those via `matchEntity`. Deferred-removal `toRemove` + `commitRemovals()`
  (bitECS) for cancel-in-flight.
- *Change flavors*: becsy's `QueryFlavor` flags **integrated with ecsia's version stamps** —
  `changed` driven by accessor writes (`world.trackWrite`, see §8 #2 for how write-intent is
  established) dispatched via `writeQueriesByComponent[typeId]`, guarded by a per-frame
  `changedSet` bitset to dedup.
- *Scheduler integration*: query builder accumulates read/write masks handed to the planner
  at world-setup (not per-execute), unlike becsy's per-execute path.
- *Typing*: `Has<C>` lifts accessor props onto the entity type so `entity.position.x` infers
  — bounded by the arity limits in §7.5.

**Hybrid mode (key refinement)**: support **both** bitECS-style lazy `query()` anywhere
(cached, no scheduler metadata) **and** becsy-style system-scoped pre-declaration (carries
read/write access masks for the parallel planner). One global live set per hash + per-system
transient lists.

---

### 2.5 Scheduler & Parallelism

**What works**

- **Priority-weighted dependency graph** (becsy): weights 1–5; explicit `before/after` (5)
  override `beforeReadersOf` etc. (3) override implicit read-after-write (1). Negative
  "denial" edges suppress auto-ordering where the user knows it is safe. —
  `becsy/src/datatypes/graph.ts:50-65`; `becsy/src/planner.ts:187-195`;
  `becsy/src/schedule.ts:108-258`.
- **Floyd-Warshall closure + transitive reduction + Johnson cycle detection** at init. —
  `becsy/src/datatypes/graph.ts:91-98, 258-313, 100-165`.
- **`Buffers` abstraction** picking SAB vs AB once at creation. —
  `becsy/src/buffers.ts:96-124`; `becsy/src/dispatcher.ts:141`.
- **`Graph.traverse()` ready-queue primitive** (becsy): `traverse()` returns zero-dependency
  systems; `traverse(done)` unlocks successors — a usable **single-threaded** dispatch
  primitive (traversal state is plain `number[]` arrays, `graph.ts:334-361`).

  > **Correction — "lock-free" misuse.** The earlier draft called `traverse()` "lock-free."
  > It is **not** lock-free in the concurrent-data-structure sense (no claim of progress
  > under contention applies); it is simply **single-threaded** — `traversalCounts` and
  > `dependencyCounts` are plain `number[]` (`graph.ts:334-361`). The word "lock-free" is
  > **withdrawn**; `traverse()` is a main-thread ready-queue that *produces* the batches the
  > worker pool then runs. It must **not** be called from workers.

- **`onManyThreads` / stateless replication** concept. — `becsy/src/schedule.ts:89-94`;
  `becsy/src/planner.ts:141-158`.
- **Resizable SAB sparse set** (bitECS): `SharedArrayBuffer(n,{maxByteLength})` + `.grow()`.
  — `bitECS/src/utils/threading/Uint32SparseSet/Uint32SparseSet.ts:26-67`.

  > **Qualification — bitECS "resizable SAB" is not pure in-place.** `growBuffer.ts` uses a
  > `try/catch` around `.grow()` and **falls back to allocating a fresh SAB and copying** when
  > `grow()` throws (e.g. when `maxByteLength` was not reserved or the platform rejects the
  > grow). So bitECS demonstrates a *hybrid*: in-place where possible, allocate-and-copy
  > otherwise — functionally the same family as becsy's patch approach on the fallback path.
  > ecsia's §7.2 accounts for both paths explicitly; the claim that bitECS proves clean
  > in-place resizable growth is **withdrawn**.

**What to avoid**

- **becsy's `ThreadedPlan` is a stub** — returns resolved promises; dispatcher throws on
  `threads>1`. The *planner algorithms* are good; the *execution layer was never built*. —
  `becsy/src/planner.ts:97-109`; `becsy/src/dispatcher.ts:130-132`. **This is the prior-art
  gap ecsia must fill from scratch; it is the single largest implementation risk.**
- **Lane-merging by component-type access** (becsy): forces ALL readers+writers of a
  non-shared component into one lane → most systems collapse to a single lane, defeating
  parallelism. — `becsy/src/planner.ts:212-226`.
- **Planner metadata on `SystemBox` mutable fields** — stale across re-plans (HMR). —
  `becsy/src/system.ts:347-349`; `becsy/src/planner.ts:206-209`.
- **O(n²) matrix / O(n³) Floyd-Warshall** degrades past a few hundred systems. —
  `becsy/src/datatypes/graph.ts:31, 258-296`.

**Recommended design** — four init-time phases, then a hot dispatch loop. **The design is
described in JS terms, not by analogy to Bevy.**

> **On the Bevy analogy (dropped from the design description).** Bevy schedules systems on a
> multi-threaded OS thread pool with Rust's ownership model enforcing disjoint access *at
> compile time*. JS has no language-level ownership and only one concurrency boundary (Worker
> threads + SABs). "Topological wave extraction + worker pool + command buffers" is the
> **standard CPU-ECS base approach**, not a Bevy-specific technique — the analogy overstated
> how much is borrowed and understated the implementation distance. ecsia borrows from Bevy
> exactly **one** thing: the **access-declaration API shape** (a system declares `.read`/
> `.write` component sets). Everything else is described below in plain JS/SAB terms.

1. **Access collection**: aggregate `readers`/`writers: Map<ComponentTypeId, Set<SystemId>>`
   from typed query declarations. Pair IDs treated as component IDs.
2. **Graph construction**: becsy's priority-weight scheme (5 explicit before/after, 4 denial,
   3 component-class hints, 1 implicit write-before-read). Floyd-Warshall + transitive
   reduction + DFS cycle detection with named-chain reporting. <1ms for <100 systems
   (above ~200 systems, switch to a sparse reachability algorithm — Q-S1).
3. **Topological wave extraction**: layer the reduced DAG topologically. Within a layer, two
   systems may run concurrently if their write-sets are disjoint AND neither reads what the
   other writes. **v1 conflict granularity is component-type-level** (T5); archetype-column
   granularity is a v2 refinement. Produce ordered `Wave[]` each holding concurrent
   `SystemBatch[]`.
4. **Worker dispatch (the layer becsy never shipped)**: per wave, post each batch to a worker
   from a fixed pool; a SAB counter initialized to `batches.length`; each worker
   `Atomics.add`-decrements on completion; the main thread waits on the counter. **The exact
   wait primitive (`Atomics.waitAsync` on browser main threads where supported,
   `Atomics.wait` on worker threads / Node, and the Promise-polling and postMessage fallbacks
   for environments lacking either SAB or `waitAsync`) is fully specified in §7.3.** Workers
   read/write archetype columns directly over shared SABs during a wave and **never perform
   structural mutation** — all create/destroy/add/remove are staged to **per-worker command
   buffers** (layout and merge protocol in **§7.1**) and applied by the main thread **between
   waves**.

- *Access API* inferred from the query DSL (`.read`/`.write`), never a manual `addReader`.
- *Write-intent*: the scheduler's correctness depends on knowing which components each system
  writes. This is **established at declaration time** (`{ read, write }` sets), **not**
  inferred from runtime setter calls — see §8 #2, which closes the previously-open question
  Q-H1. Runtime `entity.position.x = 5` does **not** participate in scheduler write-tracking;
  the `.changed` *reactivity* filter is driven separately by the write log (§2.7).
- *`onAnyWorker`* (stateless) replicates a system to all workers for load balancing.
- *SABs* transferred to workers once at startup, not per frame (bitECS SAB pattern).
- *Cycle UX*: report full cycle path; suggest the specific `inAnyOrderWith` to break it.
- **Do NOT** use lane-merging; use wave-level parallelism with type-level conflict (v1) /
  column-level conflict (v2) so users never need to mark components `shared`.

---

### 2.6 Relations

**What works**

- **Pair as lazily-minted synthetic component** (bitECS): `Pair(ChildOf, parent)` returns a
  cached stable component; archetype bitmask treats it like any component. —
  `bitECS/src/core/Relation.ts:69-93`; `Component.ts:232-234`.
- **Wildcard bookkeeping pairs** for reverse lookup without a separate index (enables
  cascade). — `bitECS/src/core/Component.ts:250-267`.
- **Cascade-on-delete via Wildcard query + iterative BFS** (no recursion blowup). —
  `bitECS/src/core/Entity.ts:75-138`.
- **`exclusiveRelation` enforced at add time**. — `bitECS/src/core/Component.ts:270-275`.
- **Lazy depth cache for hierarchy** (bitECS): per-relation depth array + dirty set; sort
  in-place by depth. — `bitECS/src/core/Hierarchy.ts:131-146, 368-403`.
- **Per-pair payload store via `withStore`** (bitECS). — `bitECS/src/core/Relation.ts:102-106`.
- **becsy's typed `backrefs` field** — cleanest back-reference API observed (live `Entity[]`
  view, zero manual maintenance). — `becsy/src/type.ts:936-1017`;
  `becsy/src/refindexer.ts:239-278`.

**What to avoid**

- **Eager Wildcard bookkeeping components** (bitECS): four ghost components per edge multiply
  archetype fragmentation in the table model. — `bitECS/src/core/Component.ts:250-267`.
- **JS-object pair identity** (bitECS): cannot cross SAB/worker boundaries. —
  `bitECS/src/core/Relation.ts:69-93`.
- **Full entity scan on lazy pair registration** (bitECS): O(entities×queries) at an
  unpredictable time. — `bitECS/src/core/Component.ts:220`; `Query.ts:302-311`.
- **Unbounded depth array keyed by volatile entity ID** (bitECS). —
  `bitECS/src/core/Hierarchy.ts:23-33`.
- **becsy refs only as `Type.ref` fields** — no pair-as-archetype-member, loses bitmask
  fast-path for relation-type queries. — `becsy/src/refindexer.ts:280-284`.

**Recommended design**

- *Pair identity = stable integers*: relation has a `relationId` (u16, assigned at world
  creation). A pair `(relationId, targetEntityId)` encodes to u32/u64 and is a component
  type key in the archetype signature. Adding/removing a pair is an ordinary archetype move.
  ID allocation via `Map<u64, u32>` populated eagerly on `addPair` (no mid-frame scans);
  workers receive ID→column metadata at startup.
- *Storage*: `defineRelation()` (tag) or `defineRelation({weight: f32})` (payload). **Payload
  storage depends on whether the relation is exclusive** — this is no longer an open question;
  see §8 #4:
  - **Exclusive relations** (`exclusive: true`, e.g. `ChildOf`): a subject holds at most one
    target, so the payload lives in a column on the **subject archetype**, indexed by row,
    identical to a normal component. Re-targeting writes the `eid` target field in place
    (no migration) — the T1 pressure-release valve.
  - **Non-exclusive payload relations** (a subject holds the *same* relation to *multiple*
    targets, each with its own payload — e.g. `Damage(B)=50`, `Damage(C)=30`): the
    subject-archetype-column layout is **fundamentally incompatible** (the subject would need
    two rows in two archetypes for one entity). These use a separate **pair-keyed overflow
    table**: a hash map `Map<(relationId, subjectEid, targetEid) → payloadRow>` over a
    dedicated SoA payload column block, with the *presence* still recorded as a per-relation
    archetype bit (below) so queries stay archetype-driven. The overflow table is the
    documented cost of non-exclusive payload relations; tag (payload-free) non-exclusive
    relations do **not** need it.
  Tag pairs occupy zero bytes.
- *Querying*: `query([Pair(ChildOf, parent)])` → standard archetype filter, O(archetypes).
  `query([Pair(ChildOf, Wildcard)])` → **O(1) per-archetype check via a per-relation presence
  bit** (below), **not** an O(T) scan over allocated pair IDs.

  > **Wildcard query design (replacing the O(T) OR-scan).** An earlier draft proposed
  > resolving `Pair(R, Wildcard)` as "an OR over the per-relation set of allocated pair IDs."
  > That is an **O(T)** scan over `T` unique targets — exactly the fragmentation problem it
  > was meant to avoid, and it is hereby **rejected**. ecsia instead allocates **one
  > synthetic per-relation presence component ID** per relation *type* (not per pair). Every
  > entity that holds *any* pair of relation `R` also carries `R`'s presence bit. A wildcard
  > query is then a single bitmask/signature check (O(1) per archetype). The presence bit
  > costs one extra archetype transition when the *first* pair of a relation is attached to
  > an entity (cheap relative to the pair migration itself) and is removed when the last pair
  > of that relation is removed. This is exactly Flecs's "wildcard id" approach and is the
  > standard solution. (Q-QR2 is thereby resolved, not deferred.)

- *Back-references*: **main-thread sparse index** `relationBackrefIndex[relationId]:
  SparseSet<target → Set<subject>>`, NOT bitECS's Wildcard ghost components. Consulted only
  during (always main-thread, serial) structural changes.
- *Cascade*: on delete of T, look up subjects via the back-ref index, remove pairs, and per
  `cascade: 'deleteSubject'` push subjects onto a BFS queue (bitECS `Entity.ts:75-138`).
  No two-phase stale-mark needed — version stamps cover the removal event in-tick.
- *Exclusive*: `exclusive: true` → on `addPair`, remove the prior target first.
- *Hierarchy*: per-relation `Int32Array` keyed by **stable slot index** (not volatile entity
  ID), lazy depth compute + dirty `SparseSet`, in-place depth sort.
- *Trait flags*: `{exclusive, cascade: 'none'|'deleteSubject'|'removeRelation',
  onTargetRemoved?, schema?}`.
- *Payload access* via the same monomorphic accessor path: `getPairData(item, Owns,
  owner).weight = 5`.
- *Fragmentation*: relation-as-archetype-member is the source of the worst-case archetype
  explosion (e.g. a scene graph with 10k entities each `ChildOf` one of thousands of parents
  produces thousands of distinct archetypes). This is **not waved away** — §7.4 quantifies
  the blow-up, specifies the cold-archetype fallback store, and defines how queries behave
  for entities in it.

---

### 2.7 Change Detection & Observers

**What works**

- **SAB-backed circular `shapeLog`/`writeLog`** with per-system `LogPointer` (entries pack
  `entityId | typeId<<bits`; wraparound via a generation counter; independent consumption
  rates). — `becsy/src/datatypes/log.ts:29-162`; `becsy/src/system.ts:339, 366`.
- **Two separate logs (structural vs field), consumed lazily** — `hasUpdatesSince` lets
  uninterested systems skip all scanning. — `becsy/src/registry.ts:399-427`;
  `becsy/src/system.ts:475-493`.
- **`QueryFlavor` deltas deduped by `changedEntities` Bitset**; transient lists cleared per
  system. — `becsy/src/query.ts:11-25, 128-200`; `becsy/src/system.ts:483-493`.
- **Component-indexed dispatch + RLE log headers** → O(changes × affected-queries). —
  `becsy/src/system.ts:496-537`; `becsy/src/datatypes/log.ts:99-140`.
- **Per-query / per-component observables** (bitECS): synchronous subscribe/notify for
  add/remove/set/get. — `bitECS/src/core/utils/Observer.ts:10-30`;
  `bitECS/src/core/Component.ts:59-67, 244-249`; `Query.ts:192-208`.
- **Deferred `toRemove` cancels spurious remove+add within a frame** (bitECS). —
  `bitECS/src/core/Query.ts:436-494`.
- **`corral` single-writer batching stage** for log writes. — `becsy/src/datatypes/log.ts:65-97`.

  > **Qualification — `corral` is single-writer, not "lock-free multi-writer."** An earlier
  > draft called `corral` a "lock-free multi-writer log merge." That is **unsupported**: in
  > becsy, `corral` batches writes from a *single* system before committing to the ring
  > (`log.ts:65-97`), and becsy's threading never shipped (`dispatcher.ts:131` throws on
  > `threads>1`), so `corral` was **never validated in any multi-writer context**. The
  > "multi-writer" claim is **withdrawn**. ecsia's multi-writer story is **not** `corral`; it
  > is **per-worker staging logs merged serially by the main thread between waves** (Q-CD2
  > resolved toward single-writer-per-worker; see §7.1, which the command-buffer protocol
  > shares). `corral` is retained only as a single-writer-per-worker batching stage.

**What to avoid**

- **Synchronous mid-frame observer dispatch** (bitECS): re-entrancy hazard, incompatible
  with an auto-parallel scheduler's deterministic read/write windows. —
  `bitECS/src/core/Query.ts:436-494`; `Component.ts:244-249`.
- **`Array.from(set).reduce()` in the notify hot path** (bitECS): per-call allocation, GC
  pressure; closures can't cross workers. — `bitECS/src/core/utils/Observer.ts:19-23`.
- **Fixed-capacity log with hard-throw on overflow as the *only* path** (becsy): cap must be
  set at creation. — `becsy/src/datatypes/log.ts:67`; `becsy/src/dispatcher.ts:127`. ecsia
  does **not** copy this unconditionally; see the recoverable-overflow design below.
- **No built-in `changed` filter** (bitECS): only structural tracking; `onSet` is push-only.
  — `bitECS/src/core/Query.ts:179, 181`.

**Recommended design** — two orthogonal layers over one log infrastructure:

- **Layer 1 — change logs for query filters**: SAB `Uint32Array` ring per kind (`shapeLog`,
  `writeLog`), entry = `entityId | typeId<<ENTITY_ID_BITS`, header `[writeIndex, generation]`,
  plus per-worker `corral` staging arrays merged serially between waves (§7.1). Every accessor
  setter inlines `writeLog.push(eid, typeId)`. Each system gets fresh `LogPointer`s before
  `execute()` → deterministic frame-boundary snapshot. Sort corral by `typeId` to skip
  unsubscribed runs. Worker-safety comes from the **scheduler's read/write fence**, not
  per-entry atomics — one `Atomics.load` of the generation counter per system per frame.

  > **Reconciliation with the "tick stamps" decision**: becsy does *not* stamp individual
  > values; it uses a ring log + per-system pointers (`log.ts:164-176`; `system.ts:478`),
  > which is **strictly better for SAB workers** (no atomic write per field mutation). ecsia
  > adopts the **log-pointer model** for the `changed` filter. Per-row `changeVersion` stamps
  > (§2.1) remain useful for the public `.changed` *query predicate* and the delta serializer
  > (§2.8); the two are complementary, see §4 T3.

- **Layer 2 — deferred observers**: observers do NOT fire mid-system. A dedicated
  `ObserverSystem` runs at a scheduler-defined serial slot (end of frame or after each
  write-declaring system), drains the logs from a saved pointer, and dispatches via a
  `(kind, typeId)` handler table (main-thread JS only). Safe to create/destroy entities
  inside observers (mutations staged to command buffers, §7.1).

```ts
world.observe(onAdd(Position, Velocity), e => { /* ... */ });
world.observe(onRemove(Health),         e => { /* ... */ });
world.observe(onChange(Transform),      e => { /* ... */ });
```

- *Capacity & overflow (recoverable, not a hard ceiling)*: `maxShapeChangesPerFrame`
  (default `maxEntities*2`), `maxWritesPerFrame` (default `maxEntities*4`) size the SAB ring.
  Because ecsia targets batteries-included use and a single frame can legitimately produce a
  burst of structural changes (scene load, many spawns merged from multiple worker command
  buffers), a **fixed ring that throws on overflow is a reliability hazard**. ecsia therefore
  uses a **double-buffered ring with an overflow spill**: when the SAB ring fills mid-frame,
  further entries spill into a main-thread-owned growable `Array` (the *spill list*), which is
  drained-and-merged at the next serial flush and the ring is resized (next-frame) to
  `2× peak observed`. In **development mode**, hitting the spill emits a console warning with
  the peak count so the user can raise the config; in production it is silent and correct.
  The config parameters are surfaced as **top-level `createWorld` options**, not buried.
  (Replaces becsy's hard-throw, `log.ts:67`.)
- **Do NOT**: `Set<Observer>` hot notify; synchronous setter-time observers; `onGet`
  reactivity.

---

### 2.8 Type System & API

**What works**

- **Structural `With<E,P>`/`Without<E,P>` narrowing through method chains** (miniplex): zero
  casts from query definition to iteration. — `miniplex/packages/core/src/core.ts:12-14,
  199-205, 377-382`.
- **Composable `IQueryableBucket<E>`** shared by World and Query. —
  `miniplex/packages/core/src/core.ts:37-61`.
- **Branded nominal IDs** (becsy): `EntityId`, `ComponentId`, `SystemId` as
  `number & {brand}`. — `becsy/src/entity.ts:8`; `component.ts:18`; `system.ts:25`.
- **`ComponentType<C>` threading through `read<C>`/`write<C>`** (becsy): field types flow
  with no cast. — `becsy/src/entity.ts:237-244, 259-265`.
- **`Relation<T>` typed pair generic** (bitECS). — `bitECS/src/core/Relation.ts:62-63`.

**What to avoid**

- **`ComponentRef = any`** everywhere (bitECS): results are `Readonly<Uint32Array>`; all type
  safety is user convention. — `bitECS/src/core/Component.ts:21-22`; `Query.ts:14-16`. **This
  is the failure mode ecsia's §7.5 mitigations exist to avoid — but it is also the escape
  hatch ecsia falls back to past the arity limit, deliberately.**
- **Symbol-keyed untyped query operators** (bitECS): illegal compositions compile. —
  `bitECS/src/core/Query.ts:67-91`.
- **Decorator schemas** (becsy): need `experimentalDecorators`, mutate prototypes via `any`,
  and **infer nothing** — no link between `@field.float32 x` and `read(C).x`. —
  `becsy/src/decorators.ts:12-26, 58-76`.
- **`as unknown as S` placeholder injection** (becsy): a property typed `SystemFoo` is
  actually a placeholder at construction. — `becsy/src/system.ts:218, 308-316`.
- **`new Function()` codegen for init** (becsy): CSP-blocked, type-erased. —
  `becsy/src/component.ts:105-133`. (This is the *only* thing "no codegen" in decision #6
  forbids — see §2.2 on the factory-closure pattern, which is **not** this.)
- **`World<E=any>` default** + `any[]` query config (miniplex): silent miss on a wrong
  component name. — `miniplex/packages/core/src/core.ts:32-35`.

**Recommended design**

- *`defineComponent`* takes a literal schema object → opaque branded `ComponentDef<S>`. The
  brand makes `Position !== Velocity` even with identical shapes. No decorators, no class, no
  textual codegen, no `as`.

```ts
const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' });
```

- *Read/write-split query* infers the iteration element type from the component tuple;
  `entity.read(Position)` → `Readonly<{x,y,z:number}>`, `entity.write(Velocity)` → mutable.
  This mirrors becsy's `read/write` split **but infers from the literal schema** and avoids
  the placeholder cast. **The deep-tuple inference cost and the arity cap / escape hatch are
  specified in §7.5** — this is not free at 10+ components.
- *Monomorphic accessor class* produced by the factory-closure pattern (§2.2), not a Proxy,
  not `new Function()`.
- *System access* declared via the query DSL (`{ read: [Position], write: [Velocity] }`); the
  scheduler reads the same stable `ComponentDef` references the type system uses. **This
  declaration is the sole source of write-intent for the scheduler** (§8 #2).
- *No deferred placeholders*: dependencies passed explicitly through
  `createWorld({ systems, components })`, validated at construction (fail-fast).
- *Relations*: `defineRelation<void>()` (tag) / `defineRelation({amount:'f32'})` (payload);
  `RelationDef<Payload>` carries the payload schema through queries.

**Public API write-tracking (the previously-open question, now closed — see §8 #2):** the
scheduler cannot infer write-intent from a runtime assignment such as `entity.position.x = 5`
(TypeScript does not perform control-flow analysis across setter invocations on getter/setter
objects). ecsia therefore **mandates that scheduler-visible writes are declared, not
inferred**:

- A system declares its writes via `{ read: [...], write: [...] }`. The scheduler trusts the
  declaration; the declaration is the contract.
- `entity.read(Position)` returns a `Readonly` accessor; `entity.write(Velocity)` returns a
  mutable accessor. The bare `entity.position` shorthand is **`Readonly`**. Mutating through
  it is a TS error (the accessor is `Readonly`), so there is no silent un-tracked write.
- The `.changed` *reactivity* filter is **separate** and is driven by the write log: every
  mutable accessor setter pushes `(eid, typeId)` to `writeLog` (§2.7), regardless of system
  declarations. Reactivity and scheduling use **two different mechanisms** by design.

---

### 2.9 Serialization & Cross-Worker Transfer

**What works**

- **Per-field change-mask diff** (bitECS `SoASerializer`): `[eid][cid][mask]` + only changed
  fields; mask width scales with field count. — `bitECS/src/serialization/SoASerializer.ts:373-405`.
- **Shadow-map float epsilon comparison**. — `SoASerializer.ts:284-328`.
- **Two-phase snapshot** (structure then SoA data) + **entity-ID remapping table** on
  deserialize. — `bitECS/src/serialization/SnapshotSerializer.ts:148-216, 238-246`;
  `SoASerializer.ts:436-449`.
- **Structural-delta stream with enum op types** (bitECS `ObserverSerializer`):
  Add/RemoveEntity/Component/Relation. — `ObserverSerializer.ts:18-25, 159-243`.
- **Transparent SAB/AB selection** + **patch-based growth propagation** + **`Atomics.or/and`
  membership** + **`Atomics.sub` ID alloc** + **resizable SAB (with allocate-and-copy
  fallback)** (becsy + bitECS). —
  `becsy/src/buffers.ts:96-144`; `becsy/src/datatypes/shapearray.ts:112-168`;
  `becsy/src/datatypes/intpool.ts:88-104`;
  `bitECS/src/utils/threading/Uint32SparseSet/Uint32SparseSet.ts:29-43`.

**What to avoid**

- **100 MB static backing buffer** + **`buffer.slice(0,offset)` per call** (bitECS): GC
  pressure, can't be a SAB, forces structured-clone transfer. —
  `SoASerializer.ts:547, 562`.
- **Double-copy sub-buffer round-trip** in snapshot. — `SnapshotSerializer.ts:203-206`.
- **Observer packets carry no values on add** (bitECS): a late joiner gets structure but no
  state. ecsia must bundle initial values. — `ObserverSerializer.ts:166-168, 202-208`.
- **becsy `makePatch`/`applyPatch`** is a fragile manual protocol (every subsystem must catch
  every patch cycle). — `becsy/src/buffers.ts:115-144`. ecsia's §7.2 length-tracking-view
  path eliminates the patch cycle for the common case.
- **Object-tuple observer queue** (bitECS): per-event heap alloc. —
  `ObserverSerializer.ts:163`.

**Recommended design** — three layers sharing the archetype SABs:

- **Layer 1 — SAB component storage (zero-copy, intra-process)**: archetype columns are SABs
  when threaded; read-only cross-worker access needs *no serialization*. Membership via SAB
  `Uint32Array` + `Atomics.or/and`; liveness via `Atomics.load`. Growth via resizable SAB
  `.grow()` with length-tracking views (§7.2), else allocate-and-copy + patch. **This layer
  requires cross-origin isolation (COOP/COEP) in browsers; the postMessage fallback for
  environments without it is specified in §7.3 — the "all runtimes via SAB" claim is
  qualified accordingly (see §3 #9).**
- **Layer 2 — structural delta stream**: SAB ring of u32 records
  `[tick][eid][op][componentId][...payload]` (op enum: EntityCreate/Destroy,
  ComponentAdd/Remove, RelationAdd/Remove). **Unlike bitECS, include initial field values on
  ComponentAdd** so late joiners reconstruct from the stream. `Atomics.add` advances the
  write head; readers keep their own read head. No GC, no postMessage for intra-process subs.
- **Layer 3 — snapshot + delta (persistence/network)**: detached `ArrayBuffer` output.
  Snapshot = header + per-entity `[id][componentBitmask]` + per-component SoA section written
  with single `set()` calls from contiguous archetype column slices. Delta = bitECS diff mode
  **driven by ecsia's version stamps** (the `changed`-since-tick predicate), not a shadow map
  — no extra shadow memory. Entity-ID remap table on deserialize; `eid` fields translated
  through it.
- *Buffer discipline*: no 100 MB default; size by entity count, double on growth, `slice`
  only at the process boundary, reuse the output buffer across ticks.
- *API* (`@ecsia/serialization`): `createSnapshotSerializer`, `createDeltaSerializer(sinceTick)`,
  `createObserverLog` (SAB ring). Relations serialized as
  `[sourceEid][relationId][targetEid][...fields]`, both eids remapped.

---

## 3. Decision Validation

| # | Locked decision | Verdict | Rationale (with evidence) |
|---|---|---|---|
| 1 | **Storage: archetype (table-based)** | **Confirm (with additive refinement)** | Required by every other locked decision. becsy proves the bitmask layer (`shapearray.ts:21-108`) but skips archetype grouping → pointer-chasing iteration (`entitylist.ts:55-119`). miniplex is the opposite extreme: zero overhead, no SoA/SAB/workers. SoA-in-TypedArrays + SAB + auto-parallel cannot be satisfied without grouping. **Refinement**: keep a flat per-entity bitmask **as a single-entity membership index only** (`has` + incremental maintenance) AND archetype tables (storage + per-archetype query matching). Query iteration is per-archetype, not per-entity. Plus an edge-graph migration cache becsy lacks. Fragmentation risk is real and specified in §7.4, not waved away. |
| 2 | **Components: schema'd numeric SoA in TypedArrays (SAB-capable) + ergonomic accessors** | **Refine** | SoA-per-field confirmed by bitECS legacy (`legacy/index.ts:167-189`) and becsy. Refinements: (a) include non-numeric encodable fields (eid/staticString/bool) as first-class (`becsy/src/type.ts:566-931`); (b) "monomorphic accessor" = **factory-closure class**, not `new Function()` and not necessarily becsy's `defineProperty` (the earlier "defineProperty breaks V8" avoidance claim is **withdrawn as uncited**); (c) buffer growth + accessor view-invalidation is a **must-fix protocol**, specified in §7.2 — not "regenerate on growth" hand-waving. |
| 3 | **Public API: typed entity handles with component proxies (`entity.position.x = 5`)** | **Refine** | becsy proves zero-alloc property ergonomics via shared-prototype singletons (`type.ts:72-93`). Refinements: (a) "proxy" must NEVER mean ES `Proxy` — use monomorphic accessor singletons per archetype-component pair; (b) the bare `entity.position.x = 5` form is **`Readonly`** shorthand; scheduler-visible writes go through `entity.write(Position)` and are **declared**, not inferred (§8 #2 closes Q-H1 — runtime setter write-inference is **not statically feasible in TS** and is abandoned). Generational handle: **configurable split, default 22/10** — the earlier "bitECS 24/8 wraps after 256, too fast" claim is **withdrawn** (bitECS is configurable via `withVersioning`, `EntityIndex.ts:76-96`; no churn analysis backed "too fast"). |
| 4 | **Accessors: generated MONOMORPHIC accessor objects (NOT ES Proxy)** | **Confirm** | Directly validated. Proxy disables V8 ICs (~3-5× overhead) and is not worker-transferable (`type.ts:72-93`). "Generated" = **factory-closure class** (one hidden class per `(archetype, component)`) closing over the column TypedArrays — **not** `new Function()`, **not** build-time emission. The `A×C` singleton population is bounded and its growth-maintenance cost is quantified in §7.2. |
| 5 | **Scheduler: auto-parallel from read/write declarations, workers** | **Refine** | Graph construction validated by becsy's priority-weight DAG (`planner.ts:187-195`; `schedule.ts:108-258`) and `traverse()` ready-queue (`graph.ts:334-361`, which is **single-threaded, not "lock-free"** — claim corrected). Two mandatory refinements: (a) becsy's `ThreadedPlan` is a **stub** (`dispatcher.ts:130-132`) — **the dispatch + worker-sync + command-buffer layers must be built fresh and are the largest implementation risk** (§7.1, §7.3); (b) use **wave-level parallelism with type-level conflict (v1)** instead of becsy's lane-merging (`planner.ts:212-226`). The "Bevy-style" attribution is **dropped** from the design (only the `.read`/`.write` API shape is borrowed). |
| 6 | **Type system: schema builder with TS inference (no decorators, no codegen)** | **Confirm (with scaling caveat)** | Validated from three angles: miniplex's `With<E,P>` narrowing (`core.ts:12-14`), becsy's `ComponentType<C>` threading (`entity.ts:237-265`), bitECS's `ComponentRef=any` failure (`Component.ts:21-22`). "**no codegen**" = no build-time emission and no `new Function()` (`becsy/component.ts:105-133`); the factory-closure pattern is permitted and is **not** codegen. **Caveat (new):** deep tuple inference over 10+ components hits TS instantiation-depth limits and multi-second compiles; ecsia caps query arity and provides an explicit-annotation escape hatch — §7.5. The "codegen" directory name is removed from §5. |
| 7 | **Relations: first-class entity pairs (Flecs-style)** | **Refine** | bitECS validates pairs-as-synthetic-components (`Relation.ts:69-93`). Not to copy: (a) JS-object pair identity → integer-encoded `(relationId, targetId)`; (b) eager Wildcard bookkeeping components (`Component.ts:250-260`) → **one per-relation presence bit** for O(1) wildcard match (Q-QR2 resolved) + main-thread sparse back-ref index; (c) lazy pair registration O(entities) scans (`Query.ts:302-311`) → mint pair IDs eagerly. **Payload storage split by exclusivity** (Q-R2 resolved, §8 #4): exclusive → subject column; non-exclusive → pair-keyed overflow table. Fragmentation quantified + cold-archetype fallback in §7.4. |
| 8 | **Reactivity: tick-based added/changed/removed (version stamps) + observers** | **Refine** | Two clarifications. (a) "version stamps" is imprecise for the `changed` *filter*: becsy uses a ring log + per-system pointers (`log.ts:164-176`; `system.ts:478`), strictly better under SAB — adopt the log-pointer model for the filter; keep per-row stamps for the public predicate + delta serializer. (b) "observers" are **deferred to a scheduler serial slot**, not bitECS's synchronous mid-frame dispatch (`Query.ts:441-451`). Log overflow is **recoverable (spill list)**, not a hard throw (the becsy hard-throw is **not** copied). |
| 9 | **Runtimes: all + workers via SAB; pnpm monorepo, ESM-only, strict TS; batteries-included** | **Confirm (SAB availability qualified)** | SAB viability confirmed (`becsy/buffers.ts:96-124`; bitECS resizable SAB *with allocate-and-copy fallback* — pure in-place claim withdrawn). **Qualification (new):** SAB requires cross-origin isolation (COOP/COEP) in browsers; "all runtimes via SAB" is **only** honest if a **postMessage fallback** exists for non-isolated contexts. That fallback is specified in §7.3 (Q-S3 resolved: yes, required). Serialization split: zero-copy SAB sharing vs copy-based snapshot/delta; deltas driven by version stamps, not shadow maps. |

---

## 4. Cross-Cutting Tensions & Resolutions

These tensions arise specifically because ecsia holds **two representations** (per-entity
bitmask index + archetype table) and adds **two more axes** (relations, workers).

### T1 — Archetype migration cost vs relation churn

**Tension**: every component add/remove is an archetype move (column copies + shuffle-pop).
Relations encode `(relation, target)` as components, so relation churn (re-parenting,
projectiles acquiring/losing targets) causes archetype churn — potentially many archetypes
and constant migration. The worst case (a unique archetype per parent in a scene graph) is
**real and quantified in §7.4**, not hypothetical.

**Resolution**:
- Cache transitions in the **edge graph** (§2.1) so the *second* add/remove of a given
  component on a given archetype is O(1) lookup + O(K) column copy.
- Make migration cost proportional to **shared column count K** (typically small), not total
  components, via shuffle-pop.
- For **high-churn exclusive relations** (single-target, e.g. `ChildOf`), store the target as
  an `eid` payload field on a *stable* relation-presence component (§2.6, exclusive path), so
  re-targeting is a field write (no migration). **This is now a locked design choice for
  exclusive relations (§8 #4), not an open question.**
- **Defer structural changes** to command buffers flushed at wave boundaries — batches a
  remove+add into one migration and avoids mid-iteration table mutation. The buffer protocol
  is §7.1.
- For the residual fragmentation that none of the above removes, §7.4 specifies the
  cold-archetype fallback store and the query semantics for entities in it.

### T2 — Two representations (bitmask + table) must stay coherent

**Tension** (this was the document's most serious unresolved contradiction): the thesis
claimed both that (a) the bitmask is "only consulted during serial shape-log processing" *and*
(b) workers do "lock-free bitmask reads" during waves. **These are mutually exclusive.** If a
worker reads the bitmask before the record commit, it can see the new membership bit but not
the new archetype row, then index the wrong column.

**Resolution (the contradiction is removed by choosing one mode — see §8 #1):**
- **The per-entity bitmask is main-thread / serial-phase ONLY.** Worker threads during a wave
  read the **archetype tables only**; they never consult the bitmask. The thesis (§1) and all
  §2.1 framing are corrected to state this.
- Because there are **no concurrent structural writes** (all migrations are serial, all
  worker structural intents are staged to command buffers and applied between waves, §7.1),
  the bitmask and the table cannot be observed mid-migration by any reader on the hot path.
  The bitmask therefore does **not** need to be atomic w.r.t. the table.
- The entity-record commit in the single-threaded / serial phase is a plain pair of stores.
  No CAS is required for v1 correctness. (A CAS protocol is written out in §7.1 only as a
  contingency for a hypothetical future worker-side-mutation v2; v1 does not use it.)
- `entity.has(C)` is a **main-thread** API. Systems running on workers that need membership
  facts use the archetype signature they are already iterating, not the bitmask.

This is the load-bearing coherence decision. With it, T2 is no longer a tension — it is a
one-way invariant: *the bitmask is a main-thread index over a structure that only the main
thread mutates.*

### T3 — Change-stamp cost on the hot path vs reactivity fidelity

**Tension**: stamping `changeVersion[row] = tick` on every write adds a store to every setter
and doubles column memory; per-field granularity multiplies log volume.

**Resolution** (the key reconciliation of decision #8):
- Use the **log-pointer model** (becsy `log.ts`) as the primary `changed`-filter mechanism:
  setters push `(eid, typeId)` to a SAB ring once per component-write, consumed per-system
  via independent pointers. No per-field stamp, no atomic-per-mutation.
- Keep **per-row `changeVersion` stamps** only where they pay for themselves: the public
  `.changed`-since-tick *query predicate* and the *delta serializer* (§2.8).
- Track at **component granularity, not field granularity**, by default (becsy
  `registry.ts:425`); offer field-granularity as an opt-in (Q-CD1).
- Because the scheduler fences read/write windows, the log generation counter needs only
  **one `Atomics.load` per system per frame** — the scheduler sequencing *is* the
  synchronization (this depends on T2's serial-mutation invariant).

### T4 — Lazy archetype allocation vs SAB pre-allocation

**Tension**: SABs work best pre-allocated and transferred once at worker startup; relations
make the archetype set dynamic and potentially huge, so eager allocation of every archetype's
columns is infeasible. This interacts with **view invalidation on growth (§7.2)** — lazy
allocation means new SABs appear after workers have started.

**Resolution**:
- Pre-allocate the **flat per-entity structures** (bitmask words, entity records, ID pool) as
  SABs sized by `maxEntities` at world creation — these are bounded.
- Allocate **archetype column SABs lazily** on first archetype creation. Propagation to
  workers and the per-archetype capacity-growth protocol are **§7.2** (resizable SAB +
  length-tracking views as the primary path; allocate-and-copy + patch fallback otherwise).
- Cap archetype count and route cold overflow archetypes to the **fallback store specified in
  §7.4** (this replaces the earlier non-answer "consider a hash-based fallback").

### T5 — Worker parallelism granularity vs scheduling simplicity

**Tension**: type-level conflict detection (becsy's lane model) is simple but collapses
parallelism; column-level detection is maximally parallel but more complex.

**Resolution**: adopt **wave-level topological parallelism with type-level conflict as the
v1 default**, with archetype-column-level conflict detection as a v2 optimization. Two
systems in the same topo level parallelize if their component write-sets are disjoint and
neither reads the other's writes. This already beats becsy's lane-merging (which serializes
*all* readers+writers of a type) without per-archetype tracking on day one; column-level is a
strictly-additive later win.

---

## 5. Proposed Monorepo Layout & Build Sequence

### 5.1 Package layout (pnpm workspace, ESM-only, strict TS)

```
ecsia/
  pnpm-workspace.yaml
  tsconfig.base.json            # strict, ESM, project references
  packages/
    core/                       # @ecsia/core — the kernel; no deps
      src/
        entity/                 # generational handle, dense/sparse free-list, EntityRef pool
        storage/                # archetype table, edge-graph, column buffers, Buffers registry
        bitmask/                # flat per-entity membership index (main-thread index)
        component/              # defineComponent, schema → SoA, accessor factory (closure, NOT codegen)
        query/                  # compiled masks, LiveQuery, sparse-set results, hashing/cache
        reactivity/             # change logs (shape/write), LogPointer, version stamps
        world.ts                # createWorld, registration, validation
    schema/                     # @ecsia/schema — field type builder + TS inference (could fold into core)
    scheduler/                  # @ecsia/scheduler — access graph, Floyd-Warshall, waves, worker dispatch
      src/
        graph/                  # priority-weighted DAG, transitive reduction, cycle detection
        planner/                # access collection, topo-layering, conflict detection
        workers/                # SAB transfer, wave dispatch loop, Atomics sync (+ postMessage fallback)
        commands/               # per-worker command-buffer encoding, serial merge/apply (§7.1)
    relations/                  # @ecsia/relations — defineRelation, pair IDs, presence bit, back-ref index, hierarchy
    observers/                  # @ecsia/observers — deferred ObserverSystem, onAdd/onRemove/onChange
    serialization/              # @ecsia/serialization — snapshot, delta (version-stamp driven), observer log
    ecsia/                      # @ecsia/ecsia — batteries-included umbrella re-export
  bench/                        # criterion-style micro/macro benchmarks (iteration, migration, query, workers)
  examples/                     # runnable examples (boids, hierarchy, worker-parallel sim)
  docs/
    research/DESIGN-RESEARCH.md # this document
```

> The previous "accessor codegen" naming is removed; the directory is `component/` and the
> accessor mechanism is the **factory-closure** pattern (§2.2), not codegen.

**Dependency direction** (acyclic): `core` ← {`relations`, `observers`, `scheduler`,
`serialization`} ← `ecsia` (umbrella). `schema` is leaf-most (or folded into `core`).
`scheduler` depends on `core` for access metadata but the kernel must run single-threaded
**without** `scheduler` (it is an opt-in layer). The **command-buffer encoding lives in
`scheduler/commands`** but its data format is shared with `core/storage` (apply path) and
`observers` (drains the same logs).

### 5.2 Milestones / build sequence

- **M0 — Foundations & harness**: pnpm workspace, `tsconfig.base`, CI, the bench harness, and
  a headless worker test rig (validate SAB round-trips early — becsy never tested its SAB
  paths, `dispatcher.ts:130-132`). **Includes a COOP/COEP-less environment in CI to exercise
  the postMessage fallback (§7.3) from day one.**
- **M1 — Entity layer**: generational configurable-split handle (default 22/10), dense/sparse
  free-list, `isAlive`, pooled `EntityRef`. *Exit: alloc/free/stale-detect tests + bench;
  generation-wrap formula test.*
- **M2 — Component schema + SoA + accessors**: `defineComponent`, per-field buffers, factory-
  closure accessor classes, growth via **resizable SAB + length-tracking views (§7.2)**.
  *Exit: monomorphic-read bench beats a Proxy baseline; hidden-class stability verified;
  **post-grow accessor-validity test** (write through an accessor created before `.grow()`,
  read it back after).*
- **M3 — Archetype storage + bitmask index**: tables, edge-graph migration, shuffle-pop, the
  flat **main-thread** bitmask index, two-word entity record. *Exit: migration bench;
  bitmask/table coherence test asserting the bitmask is never read off-main-thread (§8 #1).*
- **M4 — Queries**: per-archetype matching, `LiveQuery`, sparse-set results, hash cache,
  single-entity incremental maintenance, `current` flavor. *Exit: query-match bench is
  **per-archetype** (not per-entity); cache-hit test.*
- **M5 — Reactivity**: change logs, per-system pointers, version stamps,
  `added/removed/changed` flavors, per-worker corral staging, **recoverable spill on
  overflow**. *Exit: per-frame delta semantics test; dedup correctness; overflow-spill
  recovery test.*
- **M6 — Scheduler (single-process first)**: access collection, priority DAG, cycle
  detection, topo waves, serial execution, **declared write-intent** (§8 #2). *Exit:
  deterministic ordering tests; cycle-error UX.*
- **M7 — Workers (the becsy gap; highest risk)**: SAB allocation/transfer, wave dispatch with
  the **§7.3 Atomics sync (waitAsync / wait / Promise-poll / postMessage fallback)**, **§7.1
  command buffers** (encode on worker, merge+apply on main thread between waves), structural
  flush. *Exit: a real multi-worker sim with no data races; a fuzz test for the
  command-buffer entity-reference safety invariant (command referencing an entity deleted by
  another worker's command in the same flush, §7.1).*
- **M8 — Relations**: `defineRelation`, integer pair IDs, archetype membership, **per-relation
  presence bit** wildcard, back-ref index, cascade, exclusive, hierarchy depth, **non-
  exclusive payload overflow table (§7.4 / §8 #4)**. *Exit: re-parent + cascade tests; churn
  bench (T1); **fragmentation/fallback-store test** (10k entities × thousands of parents).*
- **M9 — Observers**: deferred `ObserverSystem`, `onAdd/onRemove/onChange`. *Exit: no
  re-entrancy hazard under the parallel scheduler.*
- **M10 — Serialization**: snapshot, version-stamp-driven delta, SAB observer-log, ID remap.
  *Exit: round-trip + late-joiner reconstruction tests.*
- **M11 — Umbrella + DX**: `@ecsia/ecsia`, docs, examples, **§7.5 type-arity stress test**
  (compile-time budget assertion), API freeze review.

Order rationale: each milestone is independently benchmarkable; **M7 (workers) precedes M8
(relations)** so the relation design is validated against real worker/SAB constraints. **The
three hard-problem specs (§7.1, §7.2, §7.3) gate M7; §7.4 gates M8; §7.5 gates M11.** None may
be deferred past their gating milestone.

---

## 6. Hard-Problem Specifications

These five sections specify the problems the earlier draft either omitted or hand-waved. Each
is a precondition for the milestone noted in §5.2.

### 6.1 (§7.1) Command buffers / deferred structural changes

*Gates M7. Referenced from §2.1, §2.5, §2.6, §2.7, T1, T2, T4.*

**Problem.** Workers may not mutate the archetype tables, the entity records, the ID pool, or
the bitmask during a wave (T2 invariant). But systems running on workers must be able to
*request* entity creation, destruction, component add/remove, and pair add/remove. The earlier
draft said only "buffer add/remove into per-thread command buffers, flush at sync points" and
never specified the layout, the merge, ownership under SAB, or what happens when one worker's
command references an entity another worker's command deletes in the same flush.

**Buffer layout.** Each worker owns one **command buffer**: a plain, growable per-worker
`ArrayBuffer`-backed `Uint32Array` (NOT a SAB — it is written only by its owning worker and
read only by the main thread after the wave, so no cross-thread concurrent access occurs and
no atomics are needed). Records are variable-length, tagged by an opcode in the first word:

```
opcode (u32) | argCount-implied-by-opcode | args...
  OP_CREATE     reservedEid                          // eid pre-reserved by worker (see below)
  OP_DESTROY    eid
  OP_ADD        eid  componentId  [field words...]   // field words present iff component has a payload
  OP_REMOVE     eid  componentId
  OP_ADD_PAIR   eid  relationId   targetEid [payload words...]
  OP_REMOVE_PAIR eid relationId   targetEid
```

A worker appends records in execution order. The buffer is reset (write head → 0) at the start
of each wave; it is read by the main thread after the wave completes.

**Entity-ID reservation (so OP_CREATE can return a usable handle mid-wave).** A worker cannot
allocate from the shared ID pool's free-list mid-wave without mutating shared structure. So the
main thread, before each wave, hands each worker a small **pre-reserved block of entity IDs**
(taken from the free-list via `Atomics.sub`, becsy `intpool.ts:98-105`). `OP_CREATE` consumes
one ID from the worker's block and the worker may immediately use that handle as a target in
later records *in the same buffer*. Unused reserved IDs are returned to the pool at flush.
(This makes a created entity referenceable within the wave without any shared mutation.)

**Merge order (deterministic).** Between waves, the main thread merges the per-worker buffers
in **fixed worker-index order** (worker 0's buffer fully applied, then worker 1's, …). Within a
buffer, records apply in append order. This makes the result deterministic regardless of the
nondeterministic completion order of the wave (important for replay and for tests). The merge
is **single-threaded** — no atomics, no locks.

**Entity-reference safety invariant (the previously-unspecified hazard).** A command may
reference an entity that an earlier-applied command (possibly from another worker) destroyed.
The rule:

- **Every record that names a non-reserved `eid` is validated against `world.isAlive(eid)` at
  apply time.** If the entity is dead, the record is **dropped** (not an error in production;
  a dev-mode warning records the dropped op and the destroying op for debugging).
- `OP_DESTROY` of an already-dead entity is a no-op.
- `OP_ADD_PAIR`/`OP_REMOVE_PAIR` whose `targetEid` is dead at apply time is dropped (with the
  same dev-mode warning); a relation to a destroyed target is meaningless.
- Reserved IDs from `OP_CREATE` are always alive at apply time (the main thread commits the
  create before any later record in merge order can reference them), so created-then-used
  chains within one flush are safe by construction.

This "**validate-then-apply, drop-if-dead**" rule is the entire safety story; it is cheap (one
`isAlive` per referenced eid) and it removes the only race the command model could otherwise
introduce. It is fuzz-tested at M7 exit.

**Who owns the buffers under SAB.** The buffers are **not** SAB. Worker-local plain arrays
avoid the entire class of concurrent-write hazards. The only shared state a worker touches
mid-wave is (a) reading archetype columns (read-only or disjoint-write per the scheduler) and
(b) consuming from its pre-reserved ID block (no shared mutation). All structural mutation is
the main thread replaying the buffers serially.

**Reactivity interaction.** Applying a buffer emits the corresponding `shapeLog`/`writeLog`
entries on the main thread, so observers (§2.7) and `changed` filters see structural changes
exactly once, in deterministic merge order, after the wave.

### 6.2 (§7.2) SharedArrayBuffer view invalidation on growth

*Gates M2. Referenced from §2.2, §2.3, §2.9, T4. Resolves §8 #5.*

**Problem.** The accessor closure captures `xData` (a `Float32Array` view over an archetype
column SAB). When the column grows, a TypedArray view constructed **with an explicit length**
does **not** widen — its `.byteLength`/`.length` are fixed at construction. A stale view is not
an error (it does not throw) but its length no longer covers the grown region, so high rows
read/write out of the old window. The earlier draft's "regenerate (re-close) on buffer growth"
gave no mechanism and was insufficient.

**The ECMAScript fact this turns on.** A TypedArray constructed over a **resizable**
`SharedArrayBuffer` **with the length argument omitted** is a **length-tracking** view: per
ECMA-262 (TypedArray over a resizable buffer with auto-length), its length auto-tracks the
buffer's current byte length. So `new Float32Array(sab)` (no length) over a resizable SAB
**does** widen on `.grow()`; `new Float32Array(sab, 0, n)` (explicit length) does **not**.

**Primary strategy — length-tracking views (the correctness invariant).** Archetype column
SABs are allocated **resizable** (`new SharedArrayBuffer(initialBytes, { maxByteLength })`).
Every column TypedArray view is constructed **without a length argument** (`new
Float32Array(sab)`), making it length-tracking. On `.grow()`, all existing views — including
those captured in already-constructed accessor closures and those held by workers — **remain
valid and widen automatically**. No accessor regeneration, no registry, no patch message for
the common case.

- This is the **stated correctness invariant for column views**: *column TypedArray views
  MUST be length-tracking (no explicit length argument), and column SABs MUST be resizable.*
  A unit test at M2 enforces it (constructing a column view with a length argument fails the
  test).
- Offsetting: if a per-row field needs a non-zero `byteOffset`, the view is
  `new Float32Array(sab, byteOffset)` — still length-tracking (length omitted), so it still
  widens. Per-axis vector views use one length-tracking view per axis.

**Fallback strategy — grow-and-patch (only where resizable SAB is unavailable).** Some targets
lack resizable SAB, or `maxByteLength` cannot be reserved. There ecsia falls back to becsy's
allocate-new-SAB-and-copy (`becsy/src/buffers.ts:102-124`) — and **then** the view-invalidation
problem is real and needs the registry:

- ecsia maintains a **live-accessor registry per `(archetype, component)`**: since accessor
  *singletons* are one-per-pair (§2.3), the registry is just that singleton set plus the
  worker handles. On a fallback grow, the main thread (a) quiesces — growth only ever happens
  at a **serial flush point**, never mid-wave (guaranteed by the command-buffer model, §7.1,
  since only the main thread mutates structure), (b) re-binds each live accessor's captured
  view to the new SAB via an updater closure, and (c) posts the new SAB to workers, which
  re-wrap before the next wave. Because growth is serial, no worker holds a stale view during
  a wave.
- The registry cost is `O(A×C)` updater calls on a fallback grow. This is the **quantified**
  maintenance cost the earlier draft never stated: with 1000 archetypes × 100 components the
  worst case is 100k cheap re-bind calls *per fallback grow event*, which is acceptable because
  (a) fallback grows are rare (capacity doubles, so O(log capacity) grows total) and (b) on
  the **primary** (resizable-SAB) path the registry is **never walked at all**.

**Decision.** ecsia commits to the **length-tracking resizable-SAB path as primary** and the
registry-backed grow-and-patch only as a portability fallback. The accessor design is finalized
on this basis — this closes the must-fix (§8 #5).

### 6.3 (§7.3) Atomics-based cross-worker synchronization (and the no-SAB fallback)

*Gates M7. Referenced from §2.5, §2.9, §3 #9. Resolves Q-S3.*

**Problem.** The wave dispatch loop has the main thread wait on a SAB counter that workers
decrement. But `Atomics.waitAsync` (non-blocking, usable on a browser main thread) is only
available on Chrome 87+, Firefox 100+, Safari 16.4+. `Atomics.wait` (blocking) is available on
worker threads and in Node but **must not** block a browser main thread. And SAB itself is
unavailable without cross-origin isolation (COOP/COEP). The earlier draft mentioned only
`Atomics.waitAsync` and left COOP/COEP as an open question.

**Three-tier wait strategy, selected once at world creation by capability probe:**

1. **`Atomics.waitAsync` (preferred, browser main thread).** Main thread issues the dispatch,
   then `await Atomics.waitAsync(counter, 0, batchCount).value`; each worker `Atomics.sub`s the
   counter and `Atomics.notify`s on the last decrement. Workers themselves may use blocking
   `Atomics.wait` while idle between waves. Latency: one notify wakeup, no polling.
2. **Worker-thread blocking wait (Node `worker_threads`, and inside browser workers).** The
   main "scheduler" role can be delegated to a dedicated coordinator worker that uses blocking
   `Atomics.wait`; the page thread `await`s a single `postMessage` from the coordinator per
   frame. This keeps the page thread responsive while using the lower-latency blocking wait
   off-main-thread. In pure Node, the main thread *may* block on `Atomics.wait` directly.
3. **Promise-polling fallback (SAB present, `waitAsync` absent, main-thread context).** Main
   thread polls the counter via `Atomics.load` on a microtask/`setTimeout(0)` loop until zero.
   Higher latency (poll granularity) and CPU cost; used only where tiers 1–2 are unavailable.
   Documented as a degraded path.

**No-SAB fallback (Q-S3 answered: yes, required for "all runtimes").** When SAB is unavailable
(no COOP/COEP, or a runtime without SAB), ecsia runs in **single-thread mode** by default and,
if the user opted into workers, falls back to a **postMessage data-transfer model**:

- Archetype columns are plain `ArrayBuffer`s. Per wave, the main thread **transfers** (zero-copy
  `Transferable`, not structured-clone-copy) the columns each batch needs to its worker, and the
  worker transfers them back on completion. This is strictly slower than SAB sharing (transfer
  latency, serialized waves) and **does not parallelize disjoint-column writes as cheaply**, but
  it is correct and keeps the public API identical.
- The **structural delta stream** (§2.9 Layer 2) is the transport in this mode: structural
  changes flow as postMessage delta records rather than shared-ring reads.
- ecsia **detects** the absence of cross-origin isolation (`globalThis.crossOriginIsolated ===
  false`) and either (a) emits a clear startup diagnostic and runs single-threaded, or (b) uses
  the postMessage fallback if `{ workers: 'postMessage-fallback' }` was requested. It **never
  silently fails** — the earlier "silently fails when headers are missing" hazard is removed.

**Honest claim.** §1/§3 #9 are corrected to: *"worker parallelism via SAB where cross-origin
isolation is available; transparent single-thread or postMessage fallback otherwise."* "All
runtimes via SAB" without qualification is **withdrawn**.

### 6.4 (§7.4) Archetype fragmentation under relations + cold-archetype fallback

*Gates M8. Referenced from §2.1, §2.6, T1, T4, Q-A1.*

**The blow-up, quantified.** With pairs as archetype members, an entity's archetype signature
includes every distinct pair it holds. A scene graph of `N=10,000` entities, each with one
`ChildOf(parent)` pair where `parent` ranges over `P` distinct values, produces **up to `P`
distinct archetypes** (one per unique parent), each holding only the children of that parent —
even though all those entities share the same *non-relation* component set. With `P` in the
thousands, that is thousands of tiny archetypes: column allocations are dominated by per-
archetype overhead, iteration loses its cache-coherence advantage (each archetype holds a
handful of rows), and the edge-graph and query-matching costs grow with `A`.

This is the **defining cost of first-class pair-as-archetype-member relations** and it is not
removable in general — it is the price of treating `(ChildOf, parentX)` and `(ChildOf, parentY)`
as different component IDs (which is exactly what makes `query([Pair(ChildOf, parentX)])` an
O(archetypes) filter rather than a per-entity scan).

**Mitigations (in order of preference):**

1. **Exclusive single-target relations store the target as an `eid` payload, not as a distinct
   pair-per-target** (§2.6 exclusive path, §8 #4). `ChildOf` is exclusive, so all children sit
   in **one** archetype carrying the synthetic `ChildOf`-presence component plus an `eid` target
   field — re-parenting is a field write, **no new archetype per parent**. *This eliminates the
   scene-graph blow-up entirely for the common (exclusive) case.* The blow-up only survives for
   **non-exclusive** relations where an entity genuinely holds the relation to many targets at
   once.
2. **Per-relation presence bit for wildcard queries** (§2.6) keeps `Pair(R, Wildcard)` O(1) per
   archetype even when many distinct pair IDs exist, so fragmentation does not also degrade
   wildcard matching.
3. **Cold-archetype fallback store (the previously-missing design).** Even with (1), pathological
   non-exclusive relation-heavy workloads can mint archetypes faster than they are used. ecsia
   caps the number of **hot** (column-backed) archetypes at `maxHotArchetypes` (a `createWorld`
   option). Beyond the cap, a newly-created archetype is **cold**: its entities are stored not in
   dedicated SoA columns but in a **shared overflow store** — a single SoA block keyed by
   `(entityId → componentId → value)` via a hash map, identical in spirit to becsy's `compact`
   storage for singletons (`becsy/src/component.ts:423-485`). Cold archetypes trade per-entity
   iteration speed for bounded archetype count.
   - **Query semantics for cold entities (the previously-missing answer).** A query that matches
     a cold archetype's signature iterates the overflow store filtered by that signature. The
     query API is **unchanged** — `query([...])` transparently iterates both hot column-backed
     archetypes and the matching cold entities; the only observable difference is throughput.
     Cold entities still carry the per-entity bitmask, so `entity.has` and incremental
     maintenance work identically.
   - **Promotion/demotion.** An archetype that crosses an access-frequency threshold can be
     promoted from cold to hot (allocate columns, migrate its entities in) at a serial flush
     point; the reverse on cap pressure. v1 ships promotion only on explicit `world.warm(sig)`;
     automatic promotion is a v2 heuristic (Q-A1 follow-up).

**Resolution of Q-A1.** The cap is `maxHotArchetypes` (default sized from `maxEntities`); cold
overflow goes to the shared hash-backed store with transparent query semantics above. This
replaces the earlier non-answer "consider a hash-based fallback store."

### 6.5 (§7.5) TypeScript type-inference scaling limits

*Gates M11. Referenced from §2.3, §2.4, §2.8, §3 #6.*

**Problem.** Decision #6 threads component types through query tuples, e.g.
`query([read(Position), write(Velocity), read(Health)])`, and lifts field types onto the entity
type. TypeScript conditional + mapped types over large tuples (≈10+ elements) hit the
instantiation-depth limit and produce multi-second compile times — the same class of failure
that drove bitECS to `ComponentRef = any` (`bitECS/src/core/Component.ts:21-22`). The earlier
draft cited that warning but gave **no evidence the deep inference works at scale and no
mitigation**.

**Evidence from the reference libs.** None of the three demonstrates *deep* tuple inference at
high arity: bitECS gives up entirely (`ComponentRef=any`); becsy threads `ComponentType<C>` but
**one component at a time** through `read<C>`/`write<C>` (`becsy/src/entity.ts:237-265`) — it
does **not** infer over a tuple of many components in one call; miniplex's `With<E,P>` narrows
the *entity* type but composes one predicate per chained call (`core.ts:199-205`), again not a
single deep tuple. So the honest finding is: **no reference lib proves N-ary tuple inference is
cheap, and the closest analogues all avoid it.** ecsia must therefore not assume it scales.

**Mitigations (all shipped in v1):**

1. **Cap query arity for full inference.** Tuple-position inference is supported up to a fixed
   arity (target: 8 components per `query(...)` call, validated against a compile-time budget in
   the M11 stress test). Past the cap, the tuple element type degrades to a documented
   `Readonly<Record<...>>`-style union rather than exploding compile time.
2. **Per-component accessor calls, not deep tuples, on the hot path.** Following becsy, the
   *iteration* API resolves field types **one component at a time**: `e.read(Position).x`,
   `e.write(Velocity).x`. Each call is a single `ComponentType<C>` lookup (cheap), avoiding any
   N-ary tuple instantiation during iteration. The tuple in `query([...])` is used for
   *matching/declaration*, where it can be kept shallow.
3. **Explicit-annotation escape hatch.** Users may annotate the iteration variable explicitly
   (`(e: Has<Position> & Has<Velocity>) => ...`) to bypass inference entirely for very wide
   systems — the deliberate, *typed* fallback (contrast bitECS's untyped `any`).
4. **Compile-time budget as a CI gate.** M11 includes a fixture with the maximum supported arity
   and asserts `tsc` stays under a wall-clock budget; regressions fail CI. This is the only way
   to keep the inference honest as the type machinery evolves.

**Resolution.** Decision #6 stands, **qualified**: deep inference is bounded by an explicit
arity cap with a documented escape hatch and a CI budget; per-component resolution carries the
hot path. The `ComponentRef=any` failure is avoided by *capping*, not by abandoning typing.

---

## 7. Must-Fix Decisions (Resolved Before Coding)

Each item was previously an open question or an unresolved contradiction that would block
implementation. Each is resolved here to a concrete protocol; the pointer is to the full spec.

**Must-Fix #1 — Bitmask role / two-representation coherence.**
*Decision:* the per-entity bitmask is **main-thread / serial-phase ONLY**; worker threads
during a wave read the **archetype tables only** and never the bitmask. All structural mutation
is serial (command buffers applied between waves). Therefore the bitmask need not be atomic
w.r.t. the table, the entity-record commit is a plain store (no CAS in v1), and the §1 "lock-
free worker bitmask reads" framing is **removed**. *Full protocol:* §4 T2, §6.1 (§7.1).

**Must-Fix #2 — Scheduler write-tracking (Q-H1 closed).**
*Decision:* scheduler-visible write-intent is **declared**, not inferred — a system's
`{ read, write }` sets are the contract. `entity.write(Position)` returns a mutable accessor;
the bare `entity.position` shorthand is **`Readonly`** (mutating it is a TS error). Runtime
setter write-inference is **abandoned** as statically infeasible in TS. The `.changed`
reactivity filter is driven *separately* by the write log (every mutable setter pushes to
`writeLog`), independent of scheduler declarations. *Full protocol:* §2.8 (write-tracking), §2.5.

**Must-Fix #3 — Command-buffer layout & flush.**
*Decision:* per-worker plain (non-SAB) `Uint32Array` command buffers with the opcode layout in
§6.1; pre-reserved entity-ID blocks for mid-wave `OP_CREATE`; deterministic merge in fixed
worker-index order on the main thread between waves; **validate-then-apply, drop-if-dead** for
every referenced eid (the entity-reference safety invariant). *Full protocol:* §6.1 (§7.1).

**Must-Fix #4 — Relation payload storage for non-exclusive relations (Q-R2 closed).**
*Decision:* payload storage is split by exclusivity. **Exclusive** relations store the payload
in a column on the subject archetype (re-target = field write, no migration). **Non-exclusive**
payload relations (one subject, many targets, distinct payloads) use a separate **pair-keyed
overflow table** (hash map over a dedicated SoA payload block), with presence still recorded as
a per-relation archetype bit so queries stay archetype-driven. Tag (payload-free) non-exclusive
relations need no overflow table. *Full protocol:* §2.6 (storage), §6.4 (§7.4).

**Must-Fix #5 — Accessor view invalidation on buffer growth (Q resolved).**
*Decision:* commit to **length-tracking TypedArray views over resizable SABs** as the primary
path — column views are constructed without a length argument and therefore widen automatically
on `.grow()`, so no accessor regeneration is needed. The grow-and-patch model (with a live-
accessor registry and serial-quiescence re-bind) is retained only as a portability fallback
where resizable SAB is unavailable. *Full protocol:* §6.2 (§7.2).

---

## 8. Remaining Open Questions (Non-Blocking)

These do not block coding; they are tuning/scope choices to settle during the gated milestones.

**Storage / archetypes**
- **Q-A2**: One large SAB slab (zero-copy cross-worker, needs a custom allocator) vs
  per-archetype SABs (simpler lifecycle, fragmentation)? (Leaning per-archetype, §7.2.)
- **Q-A3**: Synchronous migration (immediate visibility, needs caller write access) vs always
  command-buffer-deferred? (Workers: always deferred, §7.1. Main thread: may be synchronous.)
- **Q-A4**: `changeVersion` per-row (2× column memory) vs per-archetype (false positives)?

**Components / SoA**
- **Q-C1**: `maxEntities` target (sets index width and minimum SAB size).
- **Q-C2**: Archetype-packed buffers (fewer transfers) vs per-field independent buffers
  (simpler resize, and the length-tracking-view invariant of §7.2 is per-buffer)?
- **Q-C3**: Include `field.object` in v1 (forces an explicit non-shareable contract) or defer?
- **Q-C4**: Fixed-capacity components (no growth) as a perf opt-in?

**Handles / accessors**
- **Q-H2**: EntityRef row cache invalidated on migration vs always go through the sparse
  entity→row table (one extra deref, no stale-row bug class)?
- **Q-H3**: Default generation/index split per profile (the split is configurable, §2.3; this
  is only about good defaults per workload class).

**Queries / relations**
- **Q-QR1**: Global vs per-system query cache (hybrid: global live set + per-system transient
  lists is the leading candidate).
- **Q-R1**: Pair-ID lifecycle — free a pair ID when no entity holds it? What happens to
  archetypes that included it (and their potential demotion to cold, §7.4)?
- **Q-A1-followup**: Automatic cold→hot archetype promotion heuristic (v2; v1 is explicit
  `world.warm`).

**Scheduler / workers**
- **Q-S1**: Max system count? Switch from O(n³) Floyd-Warshall to a sparse algorithm above
  ~200 systems.
- **Q-S2**: Apply structural commands between every wave (reactive, sync overhead) or only at
  frame end? (Determines whether observers can fire between waves vs only at frame end.)
- **Q-S4**: `onAnyWorker` / stateless replicated systems in v1 or deferred?

**Reactivity / serialization**
- **Q-CD1**: `onChange` granularity — per component (default) or per field (higher log volume)?
- **Q-CD2**: Corral commit — per-worker single-writer staging merged serially (the chosen
  default, §6.1/§2.7) vs any concurrent-writer variant (rejected: no validated prior art).
- **Q-CD3**: Exact API for "all entities where component C changed since tick T" (the delta
  serializer and `.changed` predicate both depend on it).
