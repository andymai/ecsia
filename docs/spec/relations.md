# ecsia Implementation Spec — Module: First-Class Relations & Pairs

> Module owner: `@ecsia/relations` (`packages/relations/src/`). Consumes `@ecsia/core`
> (entity, storage, bitmask, buffers) and `@ecsia/schema` (type system). Status:
> implementable.
>
> This module owns **integer-encoded `(relationId, targetId)` pairs as first-class archetype
> members**: pair-ID minting, the per-relation **presence bit** for O(1) wildcard match, the
> **payload-storage exclusivity split** (Must-Fix #4), the **main-thread sparse back-ref
> index**, and **cascade-on-delete / re-parent churn handling** (report T1). It does NOT own
> archetype tables, the edge graph, the per-entity bitmask layout, or column allocation —
> those are consumed from the storage/bitmask/buffers modules and only *driven* here.
>
> Citations: `DESIGN-RESEARCH.md §x.y` is the report; `lib/path:line` is the original source
> the report read. This module **borrows** bitECS's pair-as-synthetic-component
> (`bitECS/src/core/Relation.ts:69-93`), **borrows** bitECS's iterative-BFS cascade
> (`bitECS/src/core/Entity.ts:75-138`), **adapts** bitECS's exclusive-relation enforcement
> (`bitECS/src/core/Component.ts:270-275`), and **rejects** bitECS's eager Wildcard ghost
> components (`bitECS/src/core/Component.ts:250-267`), JS-object pair identity
> (`Relation.ts:69-93`), lazy O(entities) pair registration (`Component.ts:220`,
> `Query.ts:302-311`), and entity-ID-keyed hierarchy arrays (`Hierarchy.ts:23-33`).

---

## 0. Scope & Non-Goals

**In scope (this module owns these contracts):**

1. `defineRelation` runtime construction (the *type* contract is fixed in type-system §7.1;
   this spec gives it a body and assigns `RelationId`).
2. Pair-ID minting: the `(relationId, targetIndex) → ComponentId` map, eager on `addPair`,
   never a mid-frame scan. (§2)
3. The **per-relation presence component** for O(1) `Pair(R, Wildcard)` matching. (§3)
4. The **payload exclusivity split** (Must-Fix #4): exclusive → subject column; non-exclusive
   → pair-keyed overflow table. (§4)
5. `addPair` / `removePair` / `getPair` structural operations and how they drive `migrate`. (§5)
6. The **main-thread sparse back-ref index** `target → {subjects}` per relation. (§6)
7. **Cascade-on-delete** (iterative BFS) and **re-target without migration** (T1 valve). (§7)
8. Relation query terms: `Pair(R, target)`, `Pair(R, Wildcard)`, and their canonical hash
   contribution. (§8)
9. Hierarchy depth cache keyed by stable slot index, lazy compute. (§9)

**Out of scope (consumed, not owned):**

- Archetype tables, the edge graph, `migrate`, `removeRow` shuffle-pop, `allocRow` — *storage*
  module. This spec calls them; it does not define them.
- `commitRecord` / two-word record / `isAlive` / `handleIndex` / `freeEntity` / lifecycle
  hooks (`spawn`/`preDespawn`/`despawn`) — *entity* module (entity-model.md). This module
  *registers* a `preDespawn` hook (§7) and *re-enters* `despawn` for cascaded subjects.
- Per-entity bitmask word layout, `entity.has`, incremental query maintenance — the bitmask
  submodule, owned by **archetype-storage.md §6** (not a separate spec file). This spec only
  states that a pair ID and a presence-component ID are ordinary
  `ComponentId`s that occupy ordinary bitmask bits (§3.4).
- Column allocation/growth, the `Buffers` registry, the overflow `ColumnSet` mechanics —
  *buffers* module (memory-buffers.md §3.7). This spec defines *which* columns to register and
  *how* they are keyed/indexed, not how they grow.
- `RelationDef`/`PairDef`/`PairAccessor`/`Wildcard` **types**, `PairValue` inference — *type
  system* module (type-system.md §7). This spec implements the runtime that satisfies them.
- Command-buffer `OP_ADD_PAIR`/`OP_REMOVE_PAIR` encoding and the validate-then-apply drop rule
  — *scheduler/commands* module (report §6.1). This spec defines the *apply-time* function the
  command buffer calls and the drop-if-target-dead semantics it must enforce (§5.5).

---

## 1. How this module satisfies the locked decisions

| Locked decision (report / Must-Fix) | Where satisfied |
|---|---|
| Relations: first-class **integer-encoded** `(relationId, targetId)` pairs as archetype members (decision #7, §2.6) | §2 pair-ID minting → synthetic `ComponentId`; pairs are ordinary signature members. Rejects JS-object identity (`Relation.ts:69-93`) — IDs are integers, SAB/worker-safe. |
| Payload storage **split by exclusivity** (Must-Fix #4, §2.6/§6.4) | §4: exclusive → subject column (`eid` target + payload columns on the subject archetype); non-exclusive → pair-keyed overflow table. |
| **One per-relation presence bit** for O(1) wildcard match (§2.6 boxed note, §6.4 #2; Q-QR2 resolved) | §3: one synthetic presence `ComponentId` per relation *type*; `Pair(R, Wildcard)` is one signature check (O(archetypes)). Rejects bitECS eager Wildcard ghosts (`Component.ts:250-267`) and the O(T) OR-scan. |
| **Main-thread sparse back-ref index** for cascade (§2.6) | §6: `relationBackref[relationId]: Map<targetIndex, Set<subjectHandle>>`, consulted only on (always-serial) structural changes. Rejects becsy's `Type.ref` backrefs as the only model but borrows its "live back-reference" intent (`becsy/src/refindexer.ts:239-278`). |
| **Cascade-on-delete**, no recursion blowup (§2.6) | §7: iterative BFS work-queue (`bitECS/src/core/Entity.ts:75-138`). |
| **Re-parenting churn** valve — exclusive re-target is a field write, no migration (T1, §6.4 #1) | §5.4: exclusive `addPair` to a new target rewrites the subject's `eid` payload in place; no archetype move. |
| Pair IDs eager (no mid-frame O(entities) scan) (§2.6 "ID allocation … eagerly on `addPair`") | §2.2: minting touches only the map + (lazily) the bitmask stride; no entity scan. Rejects `Component.ts:220`/`Query.ts:302-311`. |
| Bitmask main-thread/serial-only (Must-Fix #1) | §3.4, §6.1: presence bits, pair bits, and the back-ref index are all main-thread structures; workers stage pair changes to command buffers (§5.5). |
| ESM-only, strict TS, SAB + postMessage fallback (decision #9) | All structural mutation is serial/main-thread; the back-ref index and overflow hash map are plain JS (main-thread) structures; only the overflow *payload columns* are SAB-backed via the buffers module. |
| Fragmentation quantified + cold-archetype fallback (§7.4) | §10 ties exclusive-relation storage to the §7.4 blow-up mitigation; cold archetypes are storage-module concern but this spec states how relation queries behave over them. |

---

## 2. Pair identity & ID minting

### 2.1 The encoding

A relation has a dense `RelationId` (`u16`, assigned at world creation; type-system §8). The
`u16` ceiling caps a world at **65 535 relation types**; `createWorld`/`defineRelation`
registration validates `numRelations <= 65535` and throws a `ConfigError` on overflow (fail-fast
at world creation, never a silent wrap — type-system §8). A
**pair** is the ordered tuple `(relationId, targetIndex)` where `targetIndex` is the **index
portion** of the target's `EntityHandle` (low `indexBits`, default 22) — *not* the full
handle. We key by index, not handle, because:

- A pair `(ChildOf, parentP)` must remain the *same* component ID for the lifetime of the
  parent's slot, and the index is the stable lifetime key (the generation portion changes only
  when the slot is recycled, at which point the pair is meaningless and is torn down by cascade
  — §7). Keying by the full handle would mint a *new* pair ID every time the parent's
  generation bumped, leaking IDs.
- The back-ref index (§6) and cascade (§7) address the target by index for the same reason the
  entity record is index-addressed (entity-model.md §4.1).

> **Generation-validity guard.** Because a pair is keyed by `targetIndex`, a pair could in
> principle outlive a *recycled* target (the slot freed and re-spawned at a new generation).
> This never produces a stale pair because the target's `despawn` runs the `preDespawn` hook
> (§7) which removes *all* pairs whose target is that index **before** `freeEntity` bumps the
> generation (entity-model.md §6.3 ordering: identity invalidated LAST). So at any instant,
> every live pair's `targetIndex` belongs to a live target at the generation recorded in the
> back-ref index. The recorded generation is stored alongside the pair (§2.3) for a dev-mode
> assertion only.

The 64-bit logical key used for the mint map:

```
pairKey64(relationId: u16, targetIndex: u22) -> bigint    // logical key, NOT a stored column value
  = (BigInt(relationId) << 22n) | BigInt(targetIndex)
```

We use a `bigint` (or a `number`-pair string key — §2.4) for the map only; the **stored**
artifact is a plain integer `ComponentId`. No 64-bit value is ever stored in a TypedArray.

### 2.2 The mint map

```ts
interface PairRegistry {
  /** logical pairKey64 -> synthetic ComponentId. Populated eagerly on first addPair. */
  readonly pairIdByKey: Map<bigint, ComponentId>;
  /** Reverse: synthetic ComponentId -> { relationId, targetIndex }. For cascade/query/teardown. */
  readonly pairKeyById: Map<ComponentId, { relationId: RelationId; targetIndex: number }>;
  /** Per relation: the set of pair ComponentIds currently minted for it (for wildcard teardown, §3.3). */
  readonly pairsByRelation: Map<RelationId, Set<ComponentId>>;
  /** Live reference count: how many entities currently hold this pair ID (for Q-R1 reclamation). */
  readonly pairRefCount: Map<ComponentId, number>;
}
```

`mintPair(relationId, targetIndex)`:

```
mintPair(relationId, targetIndex) -> ComponentId:
  key := pairKey64(relationId, targetIndex)
  existing := pairIdByKey.get(key)
  if existing !== undefined: return existing
  cid := componentRegistry.allocSyntheticComponentId()   // storage module: next dense ComponentId
  pairIdByKey.set(key, cid)
  pairKeyById.set(cid, { relationId, targetIndex })
  pairsByRelation.get(relationId)!.add(cid)
  pairRefCount.set(cid, 0)
  bitmask.ensureStrideFor(cid)                            // §3.4 — may grow the per-entity bitmask stride
  return cid
```

- **Complexity:** O(1) amortized (map insert + the rare bitmask stride grow). **No entity
  scan** — this is the explicit rejection of bitECS's lazy registration that scans all
  entities/queries (`Component.ts:220`; `Query.ts:302-311`, report §2.6 "what to avoid").
- `allocSyntheticComponentId` draws from the **same dense `ComponentId` space** as ordinary
  components (report §2.6 "each unique `(relation, target)` pair gets a synthetic
  `ComponentId`; edges work identically for pair IDs"). A pair ID is indistinguishable from a
  component ID to storage, queries, and the bitmask — the entire point of integer encoding.
- Minting is **main-thread / serial** (it grows the dense component space and possibly the
  bitmask). Workers never mint; they reference a pre-existing pair via `OP_ADD_PAIR` with the
  raw `targetEid`, and the **main thread mints at apply time** if needed (§5.5).
- **Reactivity log-width interlock (CANON — world.md §9.6, resolves C2).** Because `mintPair` grows
  `nextComponentId` *unboundedly at runtime*, a world that registers **any** relation cannot safely
  use the one-word reactivity write/shape-log entry (whose `componentId` field is only
  `COMPONENT_ID_BITS` wide — 10 bits at the default split, ≤1023 ids). Per CANON, **a world in which any
  relation type is registered uses two-word log entries** (`logEntryWords` defaults to `2`,
  world.md §9.6; reactivity.md §3.1/§3.5), whose **full 32-bit `componentId` field** addresses any
  `nextComponentId` value the lazily-minted pair ids reach. The one-word fast path is used **ONLY in
  relation-free worlds**. Consequently a **pair write logs per CANON**: a `.changed`-tracked pair-payload
  write (`writeLog.push(subject, pairOrPresenceComponentId)`, §4.4/§5.4) and a pair shape event
  (`ADD_PAIR`/`REMOVE_PAIR`, world.md §9.4) pack their synthetic pair/presence `ComponentId` into the
  two-word entry **without overflowing the `componentId` field**. The width is selected **once at
  `createWorld`** from the *presence* of relations (world.md §7 step 1), so later unbounded `mintPair`
  calls never invalidate it — replacing the former creation-time fail-fast guard against 1023. In
  dev-mode, one-word mode (if explicitly forced via `createWorld({ reactivity: { logEntryWords: 1 } })`)
  asserts `nextComponentId < 2**COMPONENT_ID_BITS` on every `mintPair`.

### 2.3 Pair ID lifecycle & reclamation (Q-R1)

`pairRefCount[cid]` is incremented on every successful `addPair` that newly places the pair on
an entity and decremented on every `removePair` / cascade removal. When it reaches `0`:

- v1 default: **retain** the minted ID (do not free the `ComponentId`). Rationale: freeing a
  dense `ComponentId` would require renumbering or a free-list in the component space and would
  invalidate every query's cached signature word; the cost is not worth it for the common case.
  The archetype that included the now-unused pair becomes empty and is eligible for the
  storage module's empty-archetype reclamation (independent of pair-ID reclamation).
- The minted ID and its (empty) bitmask bit are reclaimed only at `world.compactRelations()`
  (an explicit, serial, rarely-called maintenance call) which renumbers the pair-ID region of
  the bitmask. v1 ships the retain-by-default policy; auto-reclamation is **Q-R1**, deferred.

### 2.4 Engine note on the map key

`Map<bigint, …>` is correct and exact. If `bigint` map-key hashing proves a measured hot spot
(M8 bench), the equivalent `Map<number, Map<number, ComponentId>>` two-level map (outer keyed
by `relationId`, inner by `targetIndex`) is a drop-in with identical complexity and no bigint
allocation. The two-level form is also what the back-ref index uses (§6), so a single
two-level structure can serve both. The spec mandates the *behavior* (eager, O(1), index-keyed)
and leaves the concrete map shape as an implementation choice validated at M8.

---

## 3. Per-relation presence component (O(1) wildcard)

### 3.1 Why a presence component, not ghost pairs

`Pair(R, Wildcard)` asks "does this entity hold *any* pair of relation `R`?". The rejected
designs:

- **bitECS eager Wildcard ghost components** (`Component.ts:250-267`): four bookkeeping
  components per edge. In a *table* model each ghost multiplies archetype fragmentation
  (report §2.6 "what to avoid"). **Rejected.**
- **O(T) OR-scan** over the per-relation set of allocated pair IDs (an earlier ecsia draft):
  O(number of distinct targets) per archetype — exactly the fragmentation cost it tried to
  avoid (report §2.6 boxed "Wildcard query design"). **Rejected.**

### 3.2 The design

Each relation `R` gets **one** synthetic presence `ComponentId`, `presenceId(R)`, minted at
`defineRelation` time (eager, one per relation *type*, not per pair — Flecs's "wildcard id",
report §2.6 boxed note, §6.4 #2). Its backing `ComponentDef` is **zero-field** for `tag` and
`overflow-table` relations, and **column-bearing** (synthetic `eid` target field + payload `P`
fields) for `exclusive-column` relations (§4.2) — so a single ID is both the wildcard bit and,
when exclusive, the column owner:

```ts
interface RelationRuntime<P extends Schema | void> {
  readonly def: RelationDef<P>;
  readonly relationId: RelationId;
  readonly presenceId: ComponentId;          // per-relation wildcard bit. For 'exclusive-column'
                                             // relations this ID is ALSO the column-bearing synthetic
                                             // ComponentDef holding the eid target + payload columns
                                             // on the subject archetype (§4.2). Zero-field tag for
                                             // 'tag'/'overflow-table' kinds.
  readonly exclusive: boolean;
  readonly cascade: 'none' | 'deleteSubject' | 'removeRelation';
  readonly payloadSchema: P extends Schema ? P : null;
  // storage routing (§4):
  readonly storageKind: 'tag' | 'exclusive-column' | 'overflow-table';
  readonly subjectTargetFieldIndex: number | -1;   // for exclusive: the eid field index; else -1
  readonly overflow: OverflowTable | null;          // for non-exclusive payload; else null
  // back-ref + hierarchy:
  readonly backref: Map<number, Set<EntityHandle>>; // targetIndex -> subject handles (§6)
  readonly depth: HierarchyDepthCache | null;        // §9, allocated lazily on first depth query
}
```

**Invariant P1 (presence implies a pair, and vice versa).** An entity carries `presenceId(R)`
in its archetype signature **iff** it holds at least one pair of relation `R`. Maintained by:

- `addPair(s, R, t)`: if `s` did not already hold any `R`-pair (i.e. `presenceId(R)` not in
  `s`'s signature), the migration that adds the pair ID *also* adds `presenceId(R)` (one
  combined signature delta — §5.3). The presence add costs nothing extra beyond being one more
  bit in the same migration.
- `removePair(s, R, t)`: after removing the pair ID, if `s` now holds no `R`-pair, the
  migration *also* removes `presenceId(R)`. "Holds no `R`-pair" is an O(1) check via a
  per-subject relation-pair counter (§3.3), not a scan.

### 3.3 Per-subject relation-pair counter

To answer "does `s` still hold any `R`-pair after this removal?" in O(1) without scanning the
signature, maintain a small main-thread map:

```ts
// subjectIndex -> (relationId -> count of pairs of that relation the subject currently holds)
relationPairCount: Map<number, Map<RelationId, number>>;
```

- `addPair` increments `relationPairCount[sIdx][R]`; if it goes `0 → 1`, the presence bit is
  added in the same migration.
- `removePair` decrements; if it goes `1 → 0`, the presence bit is removed in the same
  migration and the inner entry is deleted.
- On `despawn(s)` (preDespawn hook, §7), the entire `relationPairCount[sIdx]` is dropped.
- Memory: O(distinct (subject, relation) pairs that currently exist) — bounded by total live
  pairs, main-thread only. For a 10k-entity scene graph with one `ChildOf` each, this is 10k
  tiny inner maps of one entry; acceptable, and it is the price of O(1) presence maintenance.

### 3.4 Bitmask interaction (main-thread only)

Both `pair ComponentId`s and `presenceId(R)` are ordinary dense `ComponentId`s, so they occupy
ordinary bits in the per-entity membership bitmask and ordinary words in archetype signatures.
The report (§2.1, §7.4) mandates that the **stride for ordinary components is fixed at world
creation** from the registered component count, while **pair IDs use a lazily-grown sparse
vector** for the bitmask's pair region. This spec's contract to the bitmask module:

- `presenceId(R)` is minted at `defineRelation` (world-setup time) and is counted in the
  **fixed** component-stride region (presence IDs are bounded by relation count, known early).
- Pair `ComponentId`s are minted at runtime (`addPair`) and go in the bitmask's **lazily-grown
  pair-bit region**; `bitmask.ensureStrideFor(cid)` (called from `mintPair`, §2.2) grows that
  region if needed. This growth is **main-thread, serial, re-pointed in place** — it never uses
  the worker re-bind path (memory-buffers.md §5.4, §7.6; Must-Fix #1). Workers never read the
  bitmask, so they never need the grown pair-bit region mid-wave.

---

## 4. Payload storage — the exclusivity split (Must-Fix #4)

This is the load-bearing must-fix for this module. The *type* is identical for both storage
shapes (type-system §7.3: "the storage location … is invisible to the type system"); this
section fixes the *runtime storage*.

`defineRelation` resolves `storageKind` once:

```
resolveStorageKind(payloadSchema, exclusive):
  if payloadSchema === null:            return 'tag'                // payload-free: zero bytes either way
  if exclusive:                         return 'exclusive-column'
  else:                                 return 'overflow-table'
```

| `storageKind` | When | Where the payload lives | Re-target cost |
|---|---|---|---|
| `tag` | no payload (any exclusivity) | nowhere (pair ID + presence bit only) | migration (add/remove pair ID) |
| `exclusive-column` | payload + `exclusive: true` | columns on the **subject** archetype, indexed by the subject's row | **field write, no migration** (T1 valve) |
| `overflow-table` | payload + `exclusive: false` | **pair-keyed overflow SoA table**, keyed by `(relationId, subjectIndex, targetIndex)` | overflow-row write (no subject migration for re-target; pair add/remove still migrates) |

### 4.1 `tag` relations

No payload. The only artifacts are (a) the pair `ComponentId` in the subject's signature and
(b) the per-relation presence bit. Both are bitmask bits — **zero bytes of column storage**
(report §2.6 "Tag pairs occupy zero bytes"). `addPair`/`removePair` are pure migrations.

### 4.2 `exclusive-column` relations (e.g. `ChildOf` with a `{weight: f32}` payload)

An exclusive relation guarantees a subject holds **at most one** target. Therefore the target
identity *and* the payload can live as ordinary columns on the subject archetype, indexed by
the subject's `archetypeRow` — identical to a normal component (report §2.6 exclusive path;
§6.4 #1).

The subject carries, for an exclusive relation `R` with payload schema `P`:

- one **`eid` target column** (`subjectTargetFieldIndex`), storing the current target handle
  (encoded `i32`, `-1` sentinel — memory-buffers.md §3.4). This is the field whose in-place
  rewrite makes re-targeting migration-free.
- one column per field of `P` (registered through the buffers module identically to a normal
  component's fields — memory-buffers.md §3.7 "Exclusive relation payload → an ordinary
  column").

> **Which `ComponentId` keys these columns (resolving the registration gap).** The exclusive
> payload columns are an **ordinary `ColumnSet`** (archetype-storage.md §3.6) and therefore need
> a `ComponentDef`/`ComponentId` for `buildColumnSet` to key on. For an `exclusive-column`
> relation, `presenceId(R)` is **not** a zero-field tag — at `defineRelation` time the module
> mints `presenceId(R)` as a **column-bearing synthetic `ComponentDef`** whose `fields` are a
> synthetic `FieldDescriptor` for the `eid` target (field index `subjectTargetFieldIndex = 0`)
> followed by the resolved descriptors of payload schema `P` (field indices `1..|P|`). Thus the
> single `presenceId(R)` component serves **both** roles: it is the wildcard presence bit in the
> signature (one membership bit) AND the component whose `ColumnSet` holds the target + payload
> columns on the subject archetype. `storage.migrateAddingMany(subject, [rt.presenceId])` (§5.4)
> therefore allocates the target/payload columns via the normal §3.7 path — no separate ID, no
> separate migration. (For `tag` exclusive relations, `P === null` and `presenceId(R)` reverts to
> a zero-field tag carrying only the `eid` target column, or — for a truly payload-free exclusive
> relation — just the target column, which is still one synthetic field.)

> **Critical fragmentation consequence (the T1/§7.4 win).** Because the *target* is stored as
> a column value, **not** as a distinct pair `ComponentId` per target, all subjects of an
> exclusive relation with the same non-relation component set sit in **one** archetype carrying
> a single synthetic `R`-presence/`R`-exclusive component — re-parenting is a field write and
> mints **no new archetype per parent** (report §6.4 #1 "eliminates the scene-graph blow-up
> entirely for the common case"). This is the reason exclusivity is the primary fragmentation
> mitigation (§10).

> **Wildcard vs specific-target queries for exclusive relations.** For an exclusive relation
> stored as a column, `query([Pair(R, Wildcard)])` matches via the single `R`-exclusive
> presence component (O(archetypes)). `query([Pair(R, specificParent)])` cannot be a pure
> signature match (the target is a column value, not a signature bit), so it degrades to: match
> the `R`-presence archetypes, then **filter rows** by `targetColumn[row] === specificParent`.
> This is O(rows-in-matching-archetypes), or O(1) via the back-ref index (§6) when the caller
> wants "subjects of parent P" directly. The query module is told (via `PairDef.storageKind`)
> to use the back-ref index for specific-target exclusive queries — see §8.2.

### 4.3 `overflow-table` relations (non-exclusive payload, e.g. `Damage(B)=50, Damage(C)=30`)

A non-exclusive payload relation lets one subject hold the **same** relation to **many**
targets, each with its **own** payload. The subject-archetype-column layout is *fundamentally
incompatible* (the subject would need N rows for N targets — report §2.6 "what to avoid",
§6.4). These use a dedicated **pair-keyed overflow SoA table**:

```ts
interface OverflowTable {
  /** Synthetic componentTypeId reserved for this relation's overflow ColumnSet (memory-buffers §3.7). */
  readonly overflowComponentId: ComponentId;
  /** The SoA payload columns (one per payload field), rows indexed by overflowRow (NOT entity rows). */
  readonly columns: ColumnSet;             // owned/grown by the buffers module
  /** (relationId implicit) (subjectIndex<<22 | targetIndex) -> overflowRow. Main-thread map. */
  readonly rowByPairKey: Map<bigint, number>;
  /** Reverse, for teardown on remove/cascade: overflowRow -> { subjectIndex, targetIndex }. */
  readonly pairByRow: Map<number, { subjectIndex: number; targetIndex: number }>;
  /** Dense free-list of overflow rows (swap-and-move shuffle-pop, mirrors storage rows). */
  freeRows: number[];
  count: number;                            // high-water / live overflow rows
}
```

- The overflow table is **per relation** (one `OverflowTable` on the `RelationRuntime`), holding
  the payloads for *all* `(subject, target)` pairs of that relation. Its `columns` register
  through the buffers module with a synthetic `overflowComponentId` and grow via the standard
  growth protocol (memory-buffers.md §3.7, §7); **its rows are NOT entity rows** (a single
  subject occupies as many overflow rows as it has targets).
- **Presence is still an archetype bit.** Even though the payload is off in the overflow table,
  the subject still carries the pair `ComponentId` **and** the `R`-presence bit in its
  archetype signature, so `query([Pair(R, t)])` and `query([Pair(R, Wildcard)])` remain
  **archetype-driven** (report §2.6 "with the *presence* still recorded as a per-relation
  archetype bit … so queries stay archetype-driven"). The overflow table is consulted only to
  read/write the *payload*, never to *match*.
- **Tag** non-exclusive relations need **no** overflow table (`storageKind === 'tag'`): only the
  pair bit + presence bit. The overflow table is the documented cost of *non-exclusive payload*
  relations specifically (report §6.4, Must-Fix #4 "Tag (payload-free) non-exclusive relations
  do not need it").

`overflowRowFor(relationId, subjectIndex, targetIndex, createIfAbsent)`:

```
overflowRowFor(R, sIdx, tIdx, create):
  key := (BigInt(sIdx) << 22n) | BigInt(tIdx)
  row := overflow.rowByPairKey.get(key)
  if row !== undefined: return row
  if not create: return -1
  row := overflow.freeRows.pop() ?? overflow.count++       // dense alloc; grow ColumnSet if needed
  buffers.ensureCapacity(overflow.columns, overflow.count) // serial growth (memory-buffers §7)
  initRow(overflow.columns, row)                           // zero/-1 init (eid fields -> -1)
  overflow.rowByPairKey.set(key, row)
  overflow.pairByRow.set(row, { subjectIndex: sIdx, targetIndex: tIdx })
  return row
```

`releaseOverflowRow(row)` (on `removePair`/cascade): delete both map entries, push `row` onto
`freeRows`. No shuffle-pop of *other* rows is needed because the map is keyed by pair key, not
by dense position, so a freed row is simply reusable — overflow rows do not need to stay dense
for iteration (the payload is accessed by key, not iterated as a column for queries). `count`
is the high-water mark for growth sizing only.

### 4.4 Payload accessor path

Both storage shapes resolve to the **same monomorphic accessor** (report §2.6 "Payload access
via the same monomorphic accessor path"; type-system §7.3 `PairAccessor`). `getPair(item, R,
target)` returns a `PairAccessor` whose `read()`/`write()` close over either:

- the **subject archetype columns** at the subject's row (`exclusive-column`), or
- the **overflow columns** at `overflowRowFor(R, sIdx, tIdx, /*create=*/true)` (`overflow-table`).

The accessor obeys the same view-invalidation contract as component accessors
(memory-buffers.md §7.1: length-tracking views; fallback registry). For the overflow case the
accessor's `__idx` is the overflow row, re-resolved per access (the overflow row can change on
re-add; the accessor re-derives it from `overflowRowFor` at bind). Writing through `write()`
pushes `(subjectEid, pairComponentId)` to the `writeLog` for `.changed` reactivity exactly like
a component setter (type-system I-ACC-4; report §2.7).

```ts
// Public surface (type contract in type-system §7.3):
function getPair<R extends RelationDef<Schema>>(
  subject: EntityHandle, relation: R, target: EntityHandle,
): PairAccessor<R>;   // throws (dev) / returns inert (prod) if the pair is not present
```

---

## 5. Structural operations

All of `addPair` / `removePair` are **main-thread / serial** (entity-model.md §3.2 single-writer
rule; Must-Fix #1). Workers stage `OP_ADD_PAIR` / `OP_REMOVE_PAIR` to command buffers (§5.5).

### 5.1 Public API

```ts
interface RelationsApi {
  addPair<R extends RelationDef<Schema | void>>(
    subject: EntityHandle, relation: R, target: EntityHandle,
    payload?: R extends RelationDef<infer P> ? (P extends Schema ? Partial<WriteValues<P>> : never) : never,
  ): void;

  removePair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): void;

  hasPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): boolean;
  hasRelation(subject: EntityHandle, relation: RelationDef<Schema | void>): boolean;   // Pair(R, Wildcard)

  getPair<R extends RelationDef<Schema>>(
    subject: EntityHandle, relation: R, target: EntityHandle): PairAccessor<R>;

  /** Back-ref query: all subjects s such that (s, R, target) holds. Main-thread. O(1) to the Set. */
  subjectsOf(relation: RelationDef<Schema | void>, target: EntityHandle): Iterable<EntityHandle>;

  /** All targets t such that (subject, R, t) holds. */
  targetsOf(subject: EntityHandle, relation: RelationDef<Schema | void>): Iterable<EntityHandle>;
}
```

### 5.2 `addPair` (non-exclusive, the general case)

```
addPair(subject, R, target, payload?):
  assertMainThreadSerialPhase()
  if not isAlive(subject): return            // drop-if-dead (consistency with command apply, §5.5)
  if not isAlive(target):  { devWarn('addPair to dead target'); return }
  sIdx := handleIndex(subject); tIdx := handleIndex(target)
  rt   := relationRuntime(R)

  cid  := mintPair(rt.relationId, tIdx)      // §2.2 — O(1), eager, no scan
  if subjectSignatureHas(subject, cid): {    // idempotent re-add
       if payload !== undefined: writePayload(rt, sIdx, tIdx, payload)
       return
  }

  # --- compute the combined signature delta (pair ID, and presence iff first R-pair) ---
  addIds := [cid]
  firstOfRelation := (relationPairCount[sIdx]?.get(rt.relationId) ?? 0) === 0
  if firstOfRelation: addIds.push(rt.presenceId)

  # --- one migration adds all delta IDs at once (edge-graph cached after first time) ---
  storage.migrateAddingMany(subject, addIds)      # storage module; O(K) shared-column copy

  # --- bookkeeping (all main-thread) ---
  incr relationPairCount[sIdx][rt.relationId]
  incr pairRefCount[cid]
  backrefAdd(rt, tIdx, subject)                    # §6
  if rt.storageKind === 'overflow-table' and payload !== undefined:
       row := overflowRowFor(rt.relationId, sIdx, tIdx, /*create=*/true)
       writeOverflowPayload(rt.overflow, row, payload)
  if rt.depth: rt.depth.markDirty(sIdx)           # §9
  # presence/pair adds already emitted shape-log entries via the migration (report §2.7)
```

- **Complexity:** O(1) amortized + O(K) shared-column copy of the migration (K = shared column
  count, typically small — report T1). The migration's *second* occurrence on a given archetype
  is an O(1) edge-graph lookup (report §2.1 edge graph).
- `migrateAddingMany` is the storage primitive that adds several `ComponentId`s in **one**
  archetype move (so adding the pair ID and the presence bit together is one migration, not
  two). It is a **required** storage-module primitive (archetype-storage.md §5.6a), not an
  optional optimization: Invariant P1 atomicity (presence iff a pair, §5.3) depends on the pair
  ID and presence ID landing in the same target archetype in a single migration. `migrateRemovingMany`
  is the symmetric required primitive used by `removePair` (§5.5).

### 5.3 Signature-delta ordering

Within `migrateAddingMany`, the order of the added IDs does not matter (the archetype signature
is a *set*, canonicalized by sort — type-system / storage). What matters is **atomicity**: the
pair ID and the presence ID land in the **same** target archetype so that Invariant P1
(presence iff a pair) never observes an intermediate archetype carrying the pair but not the
presence. A single migration guarantees this; two sequential migrations would transiently
violate P1 but, because all of this is serial/main-thread and no query runs between them, the
violation is unobservable. The single-migration form is preferred for fewer transient
archetypes (less fragmentation churn).

### 5.4 `addPair` — exclusive re-target (the T1 valve)

For `rt.exclusive`, a subject holds **at most one** target. `addPair(subject, R, newTarget)`
when the subject already holds `(R, oldTarget)`:

```
addPairExclusive(subject, R, newTarget, payload?):
  rt := relationRuntime(R); sIdx := handleIndex(subject)
  oldTarget := decodeEid(subjectTargetColumn(rt, subject))     // -1 if none
  if oldTarget === newTarget:
       if payload: writeExclusivePayload(rt, subject, payload)
       return
  # 1. fix back-ref index: remove old subject->target link, add new
  if oldTarget !== null: backrefRemove(rt, handleIndex(oldTarget), subject)
  backrefAdd(rt, handleIndex(newTarget), subject)
  # 2. THE VALVE: rewrite the eid target column in place — NO MIGRATION
  subjectTargetColumn(rt, subject)[/* subject row */] := encodeEid(newTarget)
  if payload: writeExclusivePayload(rt, subject, payload)
  # 3. presence bit: already present iff oldTarget !== null; if this is the first ever target,
  #    a migration added R-exclusive presence column the first time only:
  if oldTarget === null:
       storage.migrateAddingMany(subject, [rt.presenceId /* = the R-exclusive column-bearing id */])
       incr relationPairCount[sIdx][rt.relationId]   // goes 0 -> 1
  # 4. reactivity: re-target is a write, not a structural change -> writeLog push (not shapeLog)
  writeLog.push(subject, rt.presenceId)
  if rt.depth: rt.depth.markDirty(sIdx)
```

- **The only structural change for an exclusive relation is the *first* attach** (which adds the
  presence/target/payload columns) and the *last* detach (which removes them). Every re-target
  in between is an **in-place `eid` field write** — **no archetype move** (report §6.4 #1, T1).
  This is what makes a scene graph with constant re-parenting cheap and non-fragmenting.
- Exclusive enforcement is therefore *implicit* in the single-target column (you cannot store
  two targets), which is stronger than bitECS's add-time prior-target removal
  (`Component.ts:270-275`): there is no prior pair to remove because there was never a distinct
  pair component per target. We **adapt** bitECS's exclusivity intent into the column model.

### 5.5 `removePair`

```
removePair(subject, R, target):
  assertMainThreadSerialPhase()
  if not isAlive(subject): return
  rt := relationRuntime(R); sIdx := handleIndex(subject); tIdx := handleIndex(target)

  if rt.storageKind === 'exclusive-column':
       if decodeEid(subjectTargetColumn(rt, subject)) !== target: return   // not the current target
       backrefRemove(rt, tIdx, subject)
       subjectTargetColumn(rt, subject)[row] := encodeEid(NULL)            // clear in place
       # last target removed -> drop the presence/target/payload columns (one migration)
       storage.migrateRemovingMany(subject, [rt.presenceId])
       decr relationPairCount[sIdx][rt.relationId]  // 1 -> 0, delete inner entry
       return

  # tag or overflow-table:
  cid := lookupPairId(rt.relationId, tIdx)           // pairIdByKey.get(...); undefined => not present
  if cid === undefined or not subjectSignatureHas(subject, cid): return
  backrefRemove(rt, tIdx, subject)
  decr pairRefCount[cid]
  if rt.storageKind === 'overflow-table':
       row := overflowRowFor(rt.relationId, sIdx, tIdx, /*create=*/false)
       if row !== -1: releaseOverflowRow(rt.overflow, row)
  # remove the pair ID, and the presence bit iff this was the subject's last R-pair (one migration)
  removeIds := [cid]
  if (relationPairCount[sIdx].get(rt.relationId) ?? 0) === 1: removeIds.push(rt.presenceId)
  storage.migrateRemovingMany(subject, removeIds)
  decr relationPairCount[sIdx][rt.relationId]
  if rt.depth: rt.depth.markDirty(sIdx)
```

- **Complexity:** O(1) bookkeeping + O(K) migration. The "last R-pair?" check is O(1) via the
  counter (§3.3). Combining the pair-ID removal and presence-bit removal into one
  `migrateRemovingMany` keeps Invariant P1 atomic (§5.3).

### 5.6 Worker path & command-apply (validate-then-apply)

Workers never call `addPair`/`removePair`. A worker emits `OP_ADD_PAIR eid relationId targetEid
[payload words…]` or `OP_REMOVE_PAIR eid relationId targetEid` to its command buffer (report
§6.1). The main thread, applying the buffer between waves in deterministic worker-index order,
calls the functions above. The command-buffer **drop-if-dead** rule (report §6.1) is honored
here:

- `OP_ADD_PAIR`/`OP_REMOVE_PAIR` whose `subject` is dead at apply time → dropped (the `addPair`
  guard `if not isAlive(subject): return` enforces it).
- `OP_ADD_PAIR` whose `targetEid` is dead at apply time → dropped ("a relation to a destroyed
  target is meaningless" — report §6.1). The `addPair` target guard enforces it.
- Apply-time minting: if the pair ID for `(relationId, targetIndex)` was never minted (the
  worker only had the raw target), `addPair` mints it on the main thread (`mintPair`, §2.2) at
  apply time — workers never mint.

This is the entirety of the worker-side relation safety story: it reduces to the generic
command-buffer validate-then-apply invariant, with the one relation-specific addition that the
**target** (not just the subject) is liveness-checked.

---

## 6. Main-thread sparse back-ref index

### 6.1 Layout & purpose

Per relation `R`: `backref: Map<targetIndex(number), Set<EntityHandle>>` (the `RelationRuntime.
backref` field, §3.2). It answers `subjectsOf(R, target)` — "who points at `target` via `R`?" —
in O(1) to the `Set`, which cascade (§7) and specific-target queries (§8.2) need.

- **Main-thread only**, consulted **only during (always-serial) structural changes** (report
  §2.6 "Consulted only during … structural changes"). It is a plain JS `Map`/`Set`, **not** SAB
  — it never crosses a worker boundary, consistent with Must-Fix #1. Workers that need
  "subjects of T" do not exist mid-wave; back-ref queries run on the main thread.
- We store **full `EntityHandle`s** in the subject `Set` (not indices) so that `subjectsOf`
  yields directly-usable handles and a stale subject is caught by `isAlive` at iteration. The
  target is keyed by **index** (the stable lifetime key, §2.1).
- This **rejects** bitECS's Wildcard *ghost-component* back-reference mechanism
  (`Component.ts:250-267`) — that pollutes the archetype space. It **borrows** the *intent* of
  becsy's typed `backrefs` (a maintained reverse view, `refindexer.ts:239-278`) but as an
  explicit main-thread index rather than a `Type.ref`-field-driven one.

### 6.2 Maintenance

```
backrefAdd(rt, tIdx, subjectHandle):
  set := rt.backref.get(tIdx); if !set: { set = new Set(); rt.backref.set(tIdx, set) }
  set.add(subjectHandle)

backrefRemove(rt, tIdx, subjectHandle):
  set := rt.backref.get(tIdx); if !set: return
  set.delete(subjectHandle)
  if set.size === 0: rt.backref.delete(tIdx)     // reclaim empty buckets (no leak — rejects Map leak, §2.3 of report on miniplex)
```

- Called from every `addPair`/`removePair`/exclusive-re-target (§5) and from cascade (§7). O(1)
  each (Set add/delete + Map get).
- `subjectsOf(R, target)` = `rt.backref.get(handleIndex(target)) ?? EMPTY_SET`, lazily filtered
  by `isAlive` at iteration (a subject can be staged-dead within a flush; iteration skips dead
  handles). `targetsOf(subject, R)` for the **exclusive** case is the single `eid` column value;
  for non-exclusive it requires a forward index (§6.3).

### 6.3 Forward index for `targetsOf` (non-exclusive)

`subjectsOf` is the back-ref index (target → subjects). `targetsOf(subject, R)` (subject →
targets) for **non-exclusive** relations needs the *forward* direction. Rather than a second
full map, we derive it from the subject's signature: every pair `ComponentId` the subject holds
of relation `R` decodes (via `pairKeyById`, §2.2) to a `targetIndex`. To avoid scanning the
whole signature, maintain a per-subject forward set only when `targetsOf` is actually used
(opt-in, lazily allocated):

```ts
// relationId -> (subjectIndex -> Set<targetIndex>); allocated lazily on first targetsOf(R, _) call.
forwardIndex: Map<RelationId, Map<number, Set<number>>>;
```

- If a relation's `forwardIndex` is active, `addPair`/`removePair` also maintain it (O(1)).
- If never used, it is never allocated (zero cost) — the common case (`ChildOf` needs only
  `subjectsOf` for cascade and the single-`eid` `targetsOf`). This keeps the back-ref machinery
  pay-for-what-you-use.

---

## 7. Cascade-on-delete & re-parent churn

### 7.1 The `preDespawn` hook

This module registers a `preDespawn` lifecycle hook with the entity module (entity-model.md
§6.3: hook fires **before** `freeEntity`, so the dying entity is still alive/resolvable). The
hook handles the entity being deleted as a **target**, as a **subject**, and the cascade.

```
onPreDespawn(dying):                               # runs main-thread, serial, before freeEntity
  dIdx := handleIndex(dying)
  for each relation rt in allRelations:

    # ---- (A) `dying` is a TARGET: every subject pointing at it must lose that pair ----
    subjects := rt.backref.get(dIdx)
    if subjects:
       for s in Array.from(subjects):             # snapshot: removePair mutates the Set
          switch rt.cascade:
            'none':           removePair(s, rt.def, dying)          # just drop the dangling pair
            'removeRelation': removePair(s, rt.def, dying)          # same as 'none' for target-side
            'deleteSubject':  cascadeQueue.push(s); removePair(s, rt.def, dying)
       rt.backref.delete(dIdx)

    # ---- (B) `dying` is a SUBJECT: drop its outgoing pairs (clean its back-ref contributions) ----
    if rt.storageKind === 'exclusive-column':
       t := decodeEid(subjectTargetColumn(rt, dying))
       if t !== null: backrefRemove(rt, handleIndex(t), dying)
       # the columns vanish with the row removal in despawn step 2 (entity-model §6.3); no migration needed
    else:
       for tIdx in targetsOfIndices(dying, rt):    # via forwardIndex or signature decode (§6.3)
          cid := lookupPairId(rt.relationId, tIdx)
          if cid: decr pairRefCount[cid]
          backrefRemove-on-target-not-needed       # `dying` is the subject here; its outgoing links:
          # `dying` appears in rt.backref under each target tIdx -> remove it there:
          backrefRemove(rt, tIdx, dying)
          if rt.storageKind === 'overflow-table':
             row := overflowRowFor(rt.relationId, dIdx, tIdx, false)
             if row !== -1: releaseOverflowRow(rt.overflow, row)
    relationPairCount.delete(dIdx)
    if rt.depth: rt.depth.markDirty(dIdx)

  # ---- (C) drain the cascade queue iteratively (NO recursion) ----
  while cascadeQueue not empty:
     victim := cascadeQueue.shift()
     if isAlive(victim): despawn(victim)           # re-enters entity despawn -> re-enters this hook
```

### 7.2 Cascade is iterative BFS (no stack blowup)

The cascade work-queue (`cascadeQueue`) is a plain array drained in a `while` loop — **borrowed
directly** from bitECS's iterative BFS (`bitECS/src/core/Entity.ts:75-138`, report §2.6 "Cascade
… iterative BFS (no recursion blowup)"). A deep hierarchy (e.g. a 100k-deep chain) deletes
without recursion. Re-entrancy is safe because `despawn` is main-thread/serial and idempotent
(entity-model.md §6.3, I8); a victim already dead when shifted is skipped.

> **Cycle safety.** Relations may form cycles (A `ChildOf` B `ChildOf` A is malformed but
> possible via direct `addPair`). The BFS must not loop forever. Guard: a victim is pushed only
> if `isAlive` and only the **first** time (a `visited` set keyed by `targetIndex` for the
> current cascade, cleared when the queue empties). Since `despawn` bumps generation,
> re-encountering an already-despawned entity fails `isAlive` and is skipped, but the explicit
> `visited` set avoids re-pushing within one cascade before the despawn commits. O(affected
> entities), each processed once.

### 7.3 Cascade modes (per relation `cascade` flag)

| `cascade` | On delete of **target** T | On delete of **subject** S |
|---|---|---|
| `'none'` (default) | subjects keep existing; their dangling pair to T is **removed** (no archetype carries a pair to a dead target — required so the pair ID's `targetIndex` never aliases a recycled slot, §2.1) | S's outgoing pairs are removed as its row is torn down |
| `'removeRelation'` | same as `'none'` for the target side (the *relation instance* is removed; the subject survives) | same |
| `'deleteSubject'` | each subject S is **also despawned** (pushed to the cascade BFS) — e.g. delete a parent ⇒ delete its children (`ChildOf` with `deleteSubject`) | n/a (S is the one being deleted) |

This matches the trait-flag set in report §2.6 (`{exclusive, cascade: 'none' |
'deleteSubject' | 'removeRelation'}`) and the type contract (type-system §7.1 `cascade`).

### 7.4 Ordering w.r.t. the entity despawn protocol

The entity module's `despawn` (entity-model.md §6.3) calls hooks in this order: `preDespawn`
(this module) → `removeRow` (storage) → `despawn` reactivity → `freeEntity` (identity
invalidated LAST). Consequences this module relies on:

- During `onPreDespawn`, `dying` is still **alive and resolvable** (`isAlive(dying) === true`,
  `resolveLocation(dying)` valid), so reading its exclusive `eid` target column and its row is
  safe.
- All back-ref/pair removals this hook performs happen **before** the row is shuffle-popped, so
  reading the subject's columns (to clear them / read targets) is valid.
- Cascaded `despawn(victim)` calls re-enter the *full* protocol for each victim, in the same
  serial phase — no deferral, deterministic.

### 7.5 Re-parent churn (T1) summary

The T1 pressure on relations is **archetype churn from re-parenting**. This module's three
valves, in order of effectiveness:

1. **Exclusive relations re-target by field write** (§5.4) — zero migrations for re-parent. This
   is the dominant mitigation; `ChildOf` is exclusive, so scene-graph re-parenting is free of
   archetype churn (report T1 resolution, §6.4 #1).
2. **Combined-delta migrations** (`migrateAddingMany`/`migrateRemovingMany`, §5.2/§5.5) — a
   pair add/remove that also toggles the presence bit is **one** migration, not two.
3. **Command-buffer batching** (report §6.1, owned by scheduler) — a remove-then-add of pairs
   within a wave coalesces at the serial flush, avoiding mid-iteration table mutation.

Residual fragmentation that only non-exclusive relations can cause is bounded by the
cold-archetype fallback (§10, report §6.4 #3).

---

## 8. Relation query terms

The query module owns matching; this section specifies the **contract** a `PairDef` term hands
it (type-system §7.2/§7.3). Three term shapes, three matching strategies.

### 8.1 `Pair(R, Wildcard)` — O(1) per archetype

Resolves to the **presence component** `presenceId(R)` (§3). The query adds `presenceId(R)` to
its `withWords` signature mask. Matching is one bitwise-AND per archetype signature word
(O(archetypes), the standard archetype filter — report §2.6, §6.4 #2). Iteration yields every
entity holding any `R`-pair. This is the resolution of Q-QR2 (report §2.6 boxed): **not** an
O(T) scan over targets.

### 8.2 `Pair(R, specificTarget)` — by storage kind

- **`tag` / `overflow-table` (non-exclusive presence):** the specific pair `ComponentId` is a
  real signature bit. `Pair(R, T)` resolves to `lookupPairId(rt.relationId, handleIndex(T))`;
  the query adds that `ComponentId` to `withWords`. Pure archetype filter, O(archetypes). If the
  pair ID was never minted (no entity ever held `(R, T)`), the query matches nothing (and does
  **not** mint — querying must not mutate the component space; minting is an `addPair`-only side
  effect).
- **`exclusive-column`:** the target is a *column value*, not a signature bit. `Pair(R, T)` can
  either (a) match the `R`-exclusive presence archetypes then filter rows by
  `targetColumn[row] === T`, or (b) — preferred when the caller wants exactly the subjects of T
  — use the back-ref index: `subjectsOf(R, T)` (§6.2), O(1) to the subject set, then resolve
  each subject's row. The `PairDef` carries `storageKind` so the query planner picks (b) for
  exclusive specific-target queries and (a) only when combined with other component terms that
  must intersect by archetype first.

### 8.3 Canonical hash contribution

A `Pair(R, target)` term contributes its resolved `ComponentId` (the pair ID for
non-exclusive/tag; the presence ID for wildcard; the presence ID for exclusive specific-target,
with the target carried as a row-filter predicate) to the query's canonical hash. Because pair
IDs are dense integers in the same space as component IDs, they hash naturally (report §2.4
"Hash must encode relation-pair targets"; type-system §5 canonical hash). The hash for an
exclusive specific-target query additionally folds in `target`'s index so two queries differing
only by parent are distinct cache entries.

### 8.4 Query semantics over cold archetypes

If a matching archetype is **cold** (overflow store, report §6.4 #3), the query iterates the
cold entities filtered by the same signature, transparently — the relation query API is
unchanged; only throughput differs (report §6.4 "Query semantics for cold entities"). Cold
entities still carry the presence/pair bits in the per-entity bitmask, so `hasRelation` and
incremental maintenance work identically.

---

## 9. Hierarchy depth cache

For relations used as hierarchies (e.g. `ChildOf`), systems often need depth-ordered iteration
(parents before children). This module provides an optional, lazily-allocated depth cache per
relation.

### 9.1 Layout — keyed by stable slot index

```ts
interface HierarchyDepthCache {
  /** depth[index] = hierarchy depth of the entity at that slot. Int32Array, length = capacity. */
  depth: Int32Array;                 // -1 = unknown/dirty
  dirty: Set<number>;                // subjectIndex set needing recompute (lazy)
}
```

- **Keyed by the stable slot `index`** (low bits of the handle), **never** by a volatile dense
  position — this is the explicit **rejection** of bitECS's entity-ID-keyed unbounded depth
  array (`bitECS/src/core/Hierarchy.ts:23-33`, report §2.6 "what to avoid"). The index space is
  bounded by `capacity` (entity-model.md §3.1), so the depth array is a fixed `Int32Array`
  sized like the entity record, allocated through the buffers module **only on first depth
  query** for that relation (zero cost if hierarchy ordering is never requested).

### 9.2 Lazy compute + dirty set

```
depthOf(rt, subject):
  idx := handleIndex(subject)
  if rt.depth.depth[idx] !== -1 and idx not in rt.depth.dirty: return rt.depth.depth[idx]
  # walk to root via the exclusive eid target column (parent chain), memoizing:
  d := 0; cur := subject; visited := []
  while true:
     parent := decodeEid(subjectTargetColumn(rt, cur))     # exclusive: O(1) parent lookup
     if parent === null: break
     pIdx := handleIndex(parent)
     if rt.depth.depth[pIdx] !== -1 and pIdx not in rt.depth.dirty:
        d := d + 1 + rt.depth.depth[pIdx]; break            # memoized hit
     visited.push(idx-of(cur)); d := d + 1; cur := parent
     if d > capacity: throw 'hierarchy cycle'               # safety bound
  # write back along the walked path:
  assign depths to visited slots; clear them from dirty
  rt.depth.depth[idx] := finalDepth; rt.depth.dirty.delete(idx)
  return finalDepth
```

- `addPair`/`removePair`/re-target on the relation calls `rt.depth.markDirty(subjectIndex)` so
  the cache invalidates lazily (report §2.6 "lazy depth compute + dirty `SparseSet`"). Borrowed
  from bitECS's lazy depth cache (`Hierarchy.ts:131-146, 368-403`) but **keyed by slot index**,
  not entity ID.
- In-place **depth sort** for hierarchy-ordered iteration: the query result for a hierarchy
  query is sorted by `depth[index]` ascending (parents first). v1 sorts on demand; an
  incremental sorted structure is a v2 refinement.
- Hierarchy depth is **only** defined for **exclusive** relations (single parent → a tree/forest).
  Requesting `depthOf` on a non-exclusive relation is a dev-mode throw (a DAG/multigraph has no
  single depth). This is why §9 reads the parent via the exclusive `eid` column.

---

## 10. Fragmentation & the cold-archetype interaction (report §7.4)

This module's storage decisions are the primary lever on relation-induced archetype
fragmentation (report §7.4, T1, T4). Restated as this module's commitments:

1. **Exclusive relations do not fragment by target.** Storing the target as an `eid` column
   (§4.2) means all subjects of an exclusive relation with the same component set share **one**
   archetype regardless of how many distinct targets exist. The scene-graph blow-up
   (`N` entities × `P` parents ⇒ up to `P` archetypes) is **eliminated** for exclusive
   relations (report §6.4 #1). `defineRelation` should default scene-graph-style relations to
   `exclusive: true`; the type contract already exposes the flag (type-system §7.1).
2. **Non-exclusive relations can fragment**, because each distinct `(R, target)` is a distinct
   pair `ComponentId` and thus a distinct signature bit. The **presence bit** (§3) keeps
   *wildcard* matching O(1) even under fragmentation, and the **overflow payload table** (§4.3)
   keeps payload storage out of the per-target archetype columns, but the **archetype count**
   itself still grows with distinct targets. This residual is the documented cost of
   first-class non-exclusive pair-as-member relations (report §6.4).
3. **Cold-archetype fallback** (storage module, report §6.4 #3) caps hot archetypes at
   `maxHotArchetypes`; relation-minted archetypes beyond the cap become cold (hash-backed
   overflow store). This module's only obligation: relation queries iterate cold archetypes
   transparently (§8.4), and the presence/pair bits are maintained for cold entities identically
   (the bitmask is index-addressed, not archetype-addressed). Promotion via `world.warm(sig)` is
   storage-owned; v1 ships explicit warm only (report §6.4, Q-A1-followup deferred).

---

## 11. Concurrency & memory-ordering summary

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `mintPair` / `defineRelation` presence mint | Main only | Serial | None (single-writer); may grow bitmask pair region in place. |
| `addPair` / `removePair` / exclusive re-target | Main only | Serial | None; drives `migrate*`, plain stores. |
| back-ref index / overflow maps / relationPairCount | Main only | Serial | Plain JS Map/Set; never SAB; never read by workers. |
| Overflow **payload columns** | SAB-backed (via buffers) | written serial, read main-thread | Standard column view contract (memory-buffers §7). Workers do not read overflow columns mid-wave (relation payload access is main-thread or via the subject column on the worker's archetype). |
| `subjectsOf` / `targetsOf` / `depthOf` | Main only | Serial / read | Plain loads. |
| Worker `OP_ADD_PAIR`/`OP_REMOVE_PAIR` | Worker emit; Main apply | emit mid-wave; apply serial | Buffer is worker-local plain array; apply is serial validate-then-apply (§5.6, report §6.1). |

Load-bearing rule (inherited from Must-Fix #1): **all relation structural state — pair IDs,
presence bits, back-ref index, overflow maps, depth cache, counters — is main-thread / serial.**
Only the overflow *payload column bytes* are SAB-backed, and they follow the same view
contract as ordinary component columns. No relation structure is on a worker's mid-wave hot
path, so no atomics are needed in v1.

---

## 12. Invariants (testable assertions)

- **P1.** An entity's signature contains `presenceId(R)` **iff** it holds ≥1 pair of `R`
  (maintained atomically per migration, §3.2/§5.3). Test: add/remove pairs and assert presence
  bit tracks the pair count crossing 0↔1.
- **P2.** A pair is keyed by `(relationId, targetIndex)`; `mintPair` is idempotent — the same
  `(R, tIdx)` always returns the same `ComponentId` for the slot's lifetime (§2.2). Test:
  `mintPair(R, t) === mintPair(R, t)`.
- **P3.** Exclusive re-target performs **zero migrations** (only an `eid` column write) when the
  subject already holds an `R`-pair (§5.4, T1). Test: spy on `migrate*`; re-target N times; assert
  call count is 0 after the first attach.
- **P4.** No live pair ever references a dead target: on `despawn(T)`, every `(s, R, T)` is
  removed before `freeEntity(T)` bumps T's generation (§7.1 ordering, entity-model §6.3). Test:
  despawn a target; assert no surviving subject's signature contains the `(R, targetIndex)` pair
  ID.
- **P5.** Cascade is iterative (no recursion) and processes each entity once (§7.2 `visited`
  set). Test: a 100k-deep `ChildOf(deleteSubject)` chain despawns without stack overflow.
- **P6.** `Pair(R, Wildcard)` matching is O(archetypes) — one signature check via `presenceId`,
  never O(distinct targets) (§8.1). Test: 10k distinct targets, wildcard query touches the
  signature once per archetype, not 10k times.
- **P7.** Non-exclusive payload lives in the overflow table; the subject archetype carries the
  pair ID + presence bit but **no payload column** (§4.3). Test: assert the subject archetype's
  column set excludes the relation payload fields; assert the payload is readable via `getPair`.
- **P8.** Back-ref index buckets are reclaimed when empty (§6.2) — no `Map` leak (rejects
  miniplex leak, report §2.3). Test: add then remove all subjects of T; assert
  `rt.backref.has(tIdx) === false`.
- **P9.** Hierarchy depth is keyed by slot index, bounded by `capacity`, lazily allocated, and
  only valid for exclusive relations (§9). Test: `depthOf` on non-exclusive throws (dev); depth
  cache not allocated until first `depthOf`.
- **P10.** Workers never mint pair IDs or mutate any relation structure; all such mutation flows
  through the serial command-apply path (§5.6, §11). Test (dev guard): a `mintPair`/`addPair`
  call off the main thread throws.

---

## 13. Complexity summary

| API | Time | Space |
|---|---|---|
| `mintPair` | O(1) amortized (map + rare bitmask stride grow) | O(1) per distinct pair |
| `addPair` (non-exclusive) | O(1) bookkeeping + O(K) migration column copy | O(1) |
| `addPair` exclusive re-target | **O(1)** (one `eid` column write, no migration) | 0 |
| `removePair` | O(1) + O(K) migration | reclaims overflow row / backref bucket |
| `hasPair` / `hasRelation` | O(1) (signature/presence bit) | 0 |
| `subjectsOf(R, T)` | O(1) to the Set + O(live subjects) to iterate | back-ref index O(live pairs) |
| `getPair(...).read/write` | O(1) (column or overflow-row access) | 0 (pooled accessor) |
| `Pair(R, Wildcard)` match | O(archetypes), one signature check each (§8.1) | presence bit: 1 per archetype |
| `Pair(R, specificTarget)` (non-excl) | O(archetypes) signature filter | pair bit: 1 per archetype/target |
| `Pair(R, specificTarget)` (excl) | O(1) via back-ref, or O(rows) row-filter (§8.2) | 0 extra |
| `onPreDespawn` cascade | O(affected pairs + cascaded subjects), each processed once | reused BFS queue |
| `depthOf` | O(depth) amortized to O(1) with memoization | `Int32Array[capacity]` per hierarchy relation |
| overflow table | O(1) row alloc/free (free-list) | one SoA ColumnSet per non-exclusive payload relation |

---

## 14. Open questions deferred (non-blocking, from report §8)

- **Q-R1** (pair-ID lifecycle): v1 retains a pair `ComponentId` when its ref-count hits 0;
  reclamation only via explicit `world.compactRelations()` (§2.3). Auto-reclamation + archetype
  demotion-to-cold on pair-ID free is deferred. The empty archetype is independently reclaimable
  by the storage module.
- **Q-A1-followup** (automatic cold→hot promotion of relation-heavy archetypes): v1 ships
  explicit `world.warm(sig)` only (§10, report §6.4).
- **Forward-index default** (§6.3): `targetsOf` for non-exclusive relations lazily allocates a
  forward index; whether to make it eager for relations declared "frequently iterated forward"
  is a tuning knob, not a blocker.
- **Depth-sort incrementality** (§9.2): v1 sorts hierarchy query results on demand by
  `depth[index]`; an incrementally-maintained sorted result container is a v2 refinement.
- **`migrateAddingMany` availability** (§5.2): **RESOLVED — required (CANON, world.md §9.7).**
  `storage.migrateAddingMany(handle, componentIds[])` / `storage.migrateRemovingMany(handle, componentIds[])`
  are required core storage primitives (archetype-storage.md §5.6a; world.md §9.7), each computing **one**
  target signature and performing a **single** combined migration; Invariant P1 atomicity depends on them,
  so they are NOT optional. (No longer open; behavior validated at M8.)
