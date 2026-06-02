# ecsia Implementation Spec — Module: Query Matching, Caching & Filters

> Module owner: `@ecsia/core` (`src/query/`).
> Status: implementable. This module owns the **query subsystem**: query signature compilation
> (with/without/optional + relation/wildcard pair terms), **per-archetype** matching (O(A), one
> AND per signature word — NOT per-entity), the cached **matching-archetype lists** with
> incremental maintenance on archetype creation and single-entity migration, the canonical query
> **dedup cache**, the per-query result container, the **Added/Changed/Removed** filters wired to
> reactivity's log-pointers, and the **iteration API** that surfaces the accessor cursor.
>
> It sits on six already-written specs and honors their contracts **verbatim** — matching their
> type names, layouts, sentinels, and signatures. It introduces **no** new field encoding, **no**
> new buffer-growth decision, **no** new bitmask layout, **no** new accessor class, and **no** new
> reactivity ring. Those are owned upstream and consumed here.
> - `type-system.md` — `QueryTerm`, `ReadTerm`/`WriteTerm`/`WithTerm`/`WithoutTerm`/`OptionalTerm`,
>   `Pair`/`Wildcard`/`PairDef`, `TermElement`, `QueryElement`, `Query`, `WorldQuery`,
>   `LooseQueryElement`, `MAX_QUERY_ARITY`, `ComponentDef`, `ComponentId`, `ArchetypeId`,
>   `EntityHandle`, branded IDs, `Has`/`HasWrite`.
> - `archetype-storage.md` — `Archetype`, `Signature`, `sigWords`, `sigHas`, `signatureMatches`,
>   the `archetypeCreated` emit hook, `matchingArchetypes`, `entityShapeWords`, `ColdStore`,
>   `EMPTY_ARCHETYPE_ID`, `world.phase`/`world.tick`, the bitmask stride.
> - `entity-model.md` — `EntityHandle`, `handleIndex`, `isAlive`, `resolveLocation`, the entity
>   record, lifecycle hooks.
> - `accessors.md` — `ArchetypeCursor`, `bindCursor`, the pooled element, `each`, the worker cursor.
> - `reactivity.md` — `LogPointer`, `CONSUME`, `OVERFLOW_SENTINEL`, `QueryDeltaLists`,
>   `attachFlavors`, `drainChanged`, `MAINTAIN_STRUCTURAL`, `queriesReferencing`,
>   the shape/write logs, `world.trackWrite`/`world.trackShape`.
> - `relations.md` — `Pair(R, target)`/`Pair(R, Wildcard)` matching by `storageKind`,
>   `presenceId(R)`, `lookupPairId`, `subjectsOf`, the canonical hash contribution.
> - `memory-buffers.md` — `Buffers.region` (the sparse-set result container is a `u32` region),
>   length-tracking views (V-1), serial-growth (V-2).
>
> `file:line` citations reference the three reference libraries surveyed in
> `docs/research/DESIGN-RESEARCH.md` ("the report"). Section pointers like "§2.4" refer to the
> report unless prefixed with a spec filename. This module **borrows** bitECS's string-hash query
> dedup (`bitECS/src/core/Query.ts:217-227`), its component-indexed reverse lookup
> (`bitECS/src/core/Component.ts:34-41`), its `SparseSet` SAB-backed result container
> (`bitECS/src/core/utils/SparseSet.ts:11-117`), and its deferred-removal coalescing
> (`bitECS/src/core/Query.ts:436-494`); **borrows** becsy's `QueryFlavor` lazy flavor allocation
> (`becsy/src/query.ts:11-14, 97-109`) and per-component reverse query index
> (`becsy/src/query.ts:148-181`); and **rejects** bitECS's `number[][]` entity masks
> (`bitECS/src/core/World.ts:13`), its `ComponentRef = any` result typing
> (`bitECS/src/core/Component.ts:21-22`), its naive string-sort hash that collides on non-unique
> IDs (`bitECS/src/core/Query.ts:217-227`), and the per-entity-bitmask-AND iteration path
> (report §1, §2.4 correction — iteration is per-archetype, never per-entity).

---

## 0. Scope & Non-Goals

**In scope (this module owns):**

1. **Query compilation**: turning a `readonly QueryTerm[]` into a `CompiledQuery` with packed
   `withWords` / `notWords` / `optionalWords` signature masks plus the residual term lists for
   IDs beyond the fixed bitmask stride (large pair IDs) and for row-filter predicates (exclusive
   specific-target pairs). (§3)
2. The **canonical query hash + dedup cache** (`Map<string|number, LiveQuery>`), keyed so that
   relation-pair targets and Not/Optional roles are encoded into the key. (§4)
3. The **per-archetype matching algorithm** (O(A), one bitwise AND per signature word) and the
   **cached `matchingArchetypes` list** maintained incrementally on `archetypeCreated`. (§5)
4. **Incremental single-entity maintenance** of each `LiveQuery`'s `current` set on migration,
   driven by the reverse `queriesReferencing(componentId)` index and the single-entity matcher
   `entityShapeWords` + `matchEntity` (archetype-storage §6.6, report §2.4). (§6)
5. The **result container**: a SAB-capable `Uint32Array` sparse set for `current`, plus the
   transient per-flavor `added`/`removed`/`changed` lists owned by reactivity but driven here. (§7)
6. **Added / Changed / Removed filters**: how a query declares flavors, how `Changed` integrates
   with reactivity's write-log pointer, how `Added`/`Removed` integrate with the shape-log drain,
   and the per-frame dedup + remove-then-add coalescing semantics. (§8)
7. The **iteration API** (`query.each`, `[Symbol.iterator]`, the flavor list iterators) surfacing
   the accessor cursor (accessors §9) and the typed pooled element. (§9)
8. **Relation / wildcard query terms** resolution (`Pair(R, Wildcard)` → presence bit O(1);
   `Pair(R, T)` → pair bit or back-ref index by `storageKind`), per relations §8. (§10)
9. The **hybrid declaration model**: lazy `world.query(...)` anywhere (cached, no scheduler
   metadata) AND system-scoped pre-declaration carrying `{ read, write }` access sets for the
   planner (report §2.4 "Hybrid mode"). (§11)
10. **Cold-archetype query semantics** (transparent; same entity set, lower throughput). (§12)

**Out of scope (consumed from / handed to other modules):**

- The `QueryTerm`/`QueryElement` **types**, the arity-cap overload family, `MAX_QUERY_ARITY`,
  branded IDs — `type-system.md §5`/§6. This module supplies the *runtime* that satisfies those
  types; it does not author the generic machinery.
- `signatureMatches`, `sigWords`, `sigHas`, `buildSigWords`, the `archetypeCreated` emit, the
  `Archetype` structure, `entityShapeWords`, the `ColdStore` — `archetype-storage.md`. This module
  *calls* the signature primitives and *subscribes* to the archetype-created event.
- The accessor singletons, `ArchetypeCursor`, `bindCursor`, the pooled element, `__idx`/`__eid`
  poking, `world.trackWrite` body — `accessors.md`. This module drives the cursor; it does not own
  the accessor closures.
- The shape/write **log rings**, `LogPointer`, `CONSUME`, `OVERFLOW_SENTINEL`, the per-flavor
  `QueryDeltaLists` storage, version stamps, observers — `reactivity.md`. This module declares the
  flavors and consumes the drain hooks; reactivity owns the logs.
- Pair-ID minting, `presenceId(R)`, the exclusivity split, `subjectsOf`/back-ref index, cascade —
  `relations.md`. This module reads `PairDef.storageKind` and calls `lookupPairId`/`subjectsOf`.
- The conflict DAG, waves, worker dispatch, command buffers — `scheduler/*`. This module exposes
  the `{ read, write }` access sets a system query declares; the scheduler builds the graph.

---

## 1. How this module satisfies the locked decisions

| Locked decision (report) | Where satisfied in this spec |
|---|---|
| Query iteration matches **per archetype** (O(A), one AND per signature word), **NOT per entity** | §5: matching tests `arch.sigWords` against the query masks at `archetypeCreated`; iteration walks cached `matchingArchetypes` then `0..count`. The per-entity AND loop (`matchEntity`) is used **only** for single-entity incremental maintenance (§6), never for iteration. |
| Cached **matched-archetype lists** + incremental maintenance via the bitmask index | §5.3 (`matchingArchetypes` appended at archetype creation, O(A·words) amortized), §6 (single migrated entity re-tested via `entityShapeWords` against the reverse `queriesReferencing` index — archetype-storage §6.6, becsy `query.ts:148-181`). |
| **Added/Changed/Removed** filters integrating with reactivity log-pointers | §8: `Changed` drains a per-query `LogPointer` into `log.write` (reactivity §5.3); `Added`/`Removed` are filled by `MAINTAIN_STRUCTURAL` off `log.shape` (reactivity §5.2). No per-field stamp on the filter path (T3). |
| **Iteration API surfacing accessors** | §9: `query.each(fn)` / `[Symbol.iterator]` drive the `ArchetypeCursor` (accessors §9) and yield the typed pooled element; zero allocation per row. |
| **Relation / wildcard** query terms | §10: `Pair(R, Wildcard)` → `presenceId(R)` signature bit (O(1) per archetype — relations §8.1); `Pair(R, T)` → pair bit (tag/overflow) or back-ref index (exclusive) per `storageKind` (relations §8.2). |
| Bitmask is **main-thread/serial-only**; workers never read it mid-wave (Must-Fix #1, T2) | §5 (matching reads immutable `sigWords`, not the bitmask), §6 (`entityShapeWords` is serial-only — archetype-storage §6.6), §9.4 (worker iteration establishes membership purely from the archetype it iterates). |
| Hybrid: lazy `query()` anywhere + system-scoped pre-declaration with access masks (report §2.4) | §11: both surfaces compile to the same `LiveQuery` keyed by the same canonical hash; system-scoped queries additionally register `{ read, write }` access sets for the scheduler. |
| Branded nominal IDs, full TS inference, arity cap + escape hatch (decision #6) | §3.1/§9.3 realize the runtime under the type-system overload family; element typing is the type-system's, never `any` (rejecting bitECS `Component.ts:21-22`). |
| ESM-only, strict TS, SAB + postMessage fallback | §7 result container allocates through `Buffers.region` (SAB when threaded); no SAB/AB branch here. Query *iteration* is read-only over columns (accessors §9.4) and over immutable `sigWords` — worker-safe without atomics. |

---

## 2. Terminology & Units

- **Term** = one `QueryTerm` (type-system §5.1): `read(C)` / `write(C)` / bare `ComponentDef` (==
  read) / `With(C)` / `Without(C)` / `optional(C)` / `Pair(R, target)` / `Pair(R, Wildcard)`.
- **Value term** = a term that contributes an accessor to the iteration element: `read`, `write`,
  `optional`, bare def, and a payload `Pair`. `With`/`Without` are **membership-only** (no value).
- **Word** = one `u32` of a packed bit-vector. `{ wordIndex, mask }` is a `Word` (archetype-storage
  §8). `wordIndex = componentId >>> 5`, `mask = 1 << (componentId & 31)`.
- **Fixed stride** = `bmStride = ceil(N/32)`, `N` = registered component-type count (the bitmask /
  signature word count fixed at world creation; archetype-storage §2, memory-buffers §5.4).
- **Residual term** = a term whose `ComponentId` is a **pair ID beyond the fixed stride** (large
  pair IDs go in the sparse pair-bit region, not `sigWords`), tested against the sorted `signature`
  array by `sigHas` (binary search) instead of a `sigWords` AND (archetype-storage §3.8).
- **Row-filter term** = an exclusive-relation specific-target `Pair(R, T)`: the target is a column
  value, not a signature bit, so it matches archetypes by `presenceId(R)` then filters rows by
  `targetColumn[row] === T` (relations §8.2(a)) or resolves via the back-ref index (§8.2(b)).
- **LiveQuery** = the cached runtime object: compiled masks + `current` sparse set + cursors +
  optional flavor delta lists + (for system-scoped queries) access sets.
- **Flavor** = one of `current` (always), `added`, `removed`, `changed` (lazily allocated; becsy
  `QueryFlavor`, `query.ts:11-14`).
- **Phase** = `world.phase`: `'serial'` (matching, maintenance, structural changes legal) or
  `'wave'` (workers iterate columns; no matching/maintenance).

---

## 3. Query compilation

### 3.1 The `CompiledQuery` structure

```ts
import type {
  ComponentId, ArchetypeId, EntityHandle, ComponentDef, RelationDef, PairDef,
} from '../type-system';
import type { Archetype } from '../storage';
import type { LogPointer } from '../reactivity';

/** One packed membership-bit reference within the fixed-stride signature words. */
export interface Word {
  readonly wordIndex: number;   // componentId >>> 5  (index into sigWords / shape words)
  readonly mask: number;        // 1 << (componentId & 31)
}

/** A residual (large pair-ID) term tested by sigHas binary search, not a sigWords AND. */
export interface ResidualTerm {
  readonly componentId: ComponentId;  // pair ID beyond the fixed bitmask stride
  readonly negate: boolean;           // true for a Without residual (rare)
}

/** An exclusive specific-target pair: match by presence bit, then filter rows by target. */
export interface RowFilterTerm {
  readonly presenceId: ComponentId;   // presenceId(R): the archetype membership bit
  readonly relationId: number;        // RelationId
  readonly targetIndex: number;       // handleIndex(target) the row must equal
  readonly subjectTargetFieldIndex: number; // which eid field on the subject column holds the target
}

export interface CompiledQuery {
  /** ALL of these bits MUST be set in an archetype signature (with / read / write / bare). */
  readonly withWords: readonly Word[];
  /** NONE of these bits may be set (without). */
  readonly notWords: readonly Word[];
  /** Optional terms contribute NO matching constraint; recorded for the value element only. */
  readonly optionalIds: readonly ComponentId[];
  /** Residual large-pair-ID terms (beyond fixed stride): tested by sigHas. */
  readonly residualWith: readonly ResidualTerm[];
  /** Exclusive specific-target pair terms: presence-match then row-filter. */
  readonly rowFilters: readonly RowFilterTerm[];

  /** Value terms in declaration order (drives the pooled element + cursor binding). */
  readonly valueTerms: readonly CompiledValueTerm[];

  /** Components/pairs this query references, for the reverse maintenance index (§6). */
  readonly referencedIds: readonly ComponentId[];

  /** Canonical hash (§4) — identical term sets share one LiveQuery. */
  readonly hash: string;
}

export interface CompiledValueTerm {
  readonly componentId: ComponentId;   // the component or pair ID whose accessor to bind
  readonly role: 'read' | 'write' | 'optional' | 'pairRead' | 'pairWrite';
  readonly key: string;                // element property name (CompKey; type-system §3)
}
```

> **Why `optionalIds` impose no constraint.** An `optional(C)` term must not exclude entities that
> lack `C`; it only adds a possibly-`undefined` accessor to the element (type-system §5.2
> `OptionalTerm`). It therefore contributes **nothing** to `withWords`/`notWords` — it is a pure
> value term whose accessor binding may resolve to `MISSING_SENTINEL` (accessors §9.2). This
> mirrors miniplex's optional-narrowing semantics without an entity-type pre-declaration
> (`miniplex/.../core.ts:199-205`).

### 3.2 `OrTerm` is not in v1 (and why the report's `orWords` are absent here)

The report's single-entity matcher pseudocode (§2.4) and archetype-storage `signatureMatches`
(§8) carry an `orWords` slot for an "any-of" constraint. **v1 exposes no `Or` term in the public
DSL** (type-system §5.1 has no `OrTerm`), so a compiled query produces an **empty** `orWords` list
and `signatureMatches`'s `orW` loop is a no-op. The slot is retained in the shared signature-match
primitive (archetype-storage §8) for forward-compatibility; this module passes `[]` for it. An
`Or([...])` term (matching entities holding *any* of a set) is **Q-Q1**, deferred — it would
compile to a non-empty `orWords` and reuse the exact same primitive with zero new matching code.

### 3.3 Compilation algorithm

```
compileQuery(terms: QueryTerm[]) -> CompiledQuery:   // serial-phase, at first world.query(...) for a hash
  withWords := []; notWords := []; optionalIds := []
  residualWith := []; rowFilters := []; valueTerms := []; referenced := new Set()

  for term in terms:
    (kind, def_or_pair, role) := classifyTerm(term)        // §3.4
    switch kind:
      'component':                                           // read/write/with/bare
        cid := def_or_pair.id                                // ComponentId assigned at registration
        referenced.add(cid)
        addWithBit(withWords, residualWith, cid)             // §3.5 — fixed-stride bit OR residual
        if role in {read, write, bare}:                      // 'bare' == read (type-system §5.1)
          valueTerms.push({ componentId: cid, role: role=='bare'?'read':role, key: keyOf(def_or_pair) })
      'without':
        cid := def_or_pair.id; referenced.add(cid)
        addNotBit(notWords, residualWith, cid)               // §3.5 (negate=true for residual)
      'optional':
        cid := def_or_pair.id; referenced.add(cid)
        optionalIds.push(cid)                                 // NO matching constraint
        valueTerms.push({ componentId: cid, role: 'optional', key: keyOf(def_or_pair) })
      'pairWildcard':                                         // Pair(R, Wildcard)  → §10.1
        pid := presenceId(R); referenced.add(pid)
        addWithBit(withWords, residualWith, pid)              // presence bit, O(1) match
        // payload (if any) is read via getPair, not the element — no value term for wildcard
      'pairSpecific':                                         // Pair(R, T)          → §10.2
        compilePairSpecific(term, withWords, residualWith, rowFilters, valueTerms, referenced)
  hash := canonicalHash(terms)                                // §4
  return frozen CompiledQuery { withWords, notWords, optionalIds, residualWith,
                                rowFilters, valueTerms, referencedIds: [...referenced], hash }
```

- Complexity: **O(arity)** — one pass over the term list, each term O(1). No buffer allocation, no
  entity scan. Runs once per distinct query hash (cache miss, §4).
- `classifyTerm` reads the `__term` discriminant on the typed wrappers (type-system §5.1) and the
  `PairDef` shape (type-system §7.2); a bare `ComponentDef` is treated as `read`.
- `keyOf(def)` is the element property name (`def.name` / `CompKey<C>`, type-system §3).

### 3.4 `classifyTerm`

```ts
function classifyTerm(t: QueryTerm):
    { kind: 'component'|'without'|'optional'|'pairWildcard'|'pairSpecific',
      target: ComponentDef | PairDef, role: 'read'|'write'|'bare'|'none' } {
  if (isPairDef(t)) return t.target === Wildcard
    ? { kind: 'pairWildcard', target: t, role: 'none' }
    : { kind: 'pairSpecific', target: t, role: 'none' };
  switch (t.__term) {
    case 'read':     return { kind: 'component', target: t.c, role: 'read' };
    case 'write':    return { kind: 'component', target: t.c, role: 'write' };
    case 'with':     return { kind: 'component', target: t.c, role: 'none' };  // membership only
    case 'without':  return { kind: 'without',   target: t.c, role: 'none' };
    case 'optional': return { kind: 'optional',  target: t.c, role: 'read' };
    default:         return { kind: 'component', target: t,   role: 'bare' };  // bare def == read
  }
}
```

### 3.5 Bit placement: fixed-stride bit vs residual

A `ComponentId` `c` that fits the fixed bitmask stride (`c < bmFixedBitCount = bmStride * 32`)
becomes a `Word`; a larger pair ID becomes a `ResidualTerm` (archetype-storage §3.3/§3.8).

```ts
function addWithBit(withWords: Word[], residual: ResidualTerm[], c: ComponentId): void {
  if (c < world.bmFixedBitCount) withWords.push({ wordIndex: c >>> 5, mask: (1 << (c & 31)) >>> 0 });
  else residual.push({ componentId: c, negate: false });   // tested by sigHas (binary search)
}
function addNotBit(notWords: Word[], residual: ResidualTerm[], c: ComponentId): void {
  if (c < world.bmFixedBitCount) notWords.push({ wordIndex: c >>> 5, mask: (1 << (c & 31)) >>> 0 });
  else residual.push({ componentId: c, negate: true });
}
```

- Ordinary components and per-relation presence IDs are bounded by the registered count and always
  fit the fixed stride (relations §3.4: presence IDs counted in the fixed region). Only large
  runtime-minted pair IDs (specific-target non-exclusive pairs) can land in the residual path.
- The `withWords`/`notWords` packed form is the hot O(1)-per-word matching path; residuals are the
  rare O(log|sig|) fallback for unbounded pair-ID space. This is the report's "stride for ordinary
  components is fixed at world creation … growing only when new component *types*, not new pairs"
  (§2.1) realized at the query level.

---

## 4. Canonical hash & dedup cache

Identical term sets must share **one** `LiveQuery` (its `current` set, cursors, and maintenance
are computed once). bitECS dedups by a string-sorted hash (`Query.ts:217-227`); the report flags
that a *naive* string-sort hash "may collide if component IDs aren't globally unique integers"
(§2.4 "What to avoid") — relevant once pair IDs share the component space. ecsia's IDs **are**
globally-unique dense integers (component IDs and pair IDs both drawn from one dense space,
relations §2.2), so the hash is over those integers, with **role tags** to keep `read`/`with`,
`without`, and `optional` of the same component distinct.

### 4.1 Hash construction

```
canonicalHash(terms) -> string:
  parts := []
  for term in terms:
    (kind, target, role) := classifyTerm(term)
    cid := (kind in {pairWildcard,pairSpecific}) ? pairHashId(target) : target.id   // §4.2
    roleTag := kind=='without' ? 'N'
             : kind=='optional' ? 'O'
             : kind=='component' && role=='none' ? 'M'        // With (membership) distinct from read
             : 'P'                                            // read/write/bare/pair value-present
    parts.push(roleTag + ':' + cid)
  parts.sort()                                                // order-independent (term order irrelevant)
  return parts.join('|')
```

- **Role tags collapse `read`/`write`/`bare` into one `P` tag** because they impose the *same
  matching constraint* (presence of the component) and the *same* `current` set — they differ only
  in element *mutability*, which is a type-level concern (type-system §5), not a matching concern.
  Two queries `[read(A)]` and `[write(A)]` therefore **share one `LiveQuery`** (same `current`,
  same maintenance) but yield differently-typed elements via their respective compiled
  `valueTerms`. The `LiveQuery` caches the *matching*; the per-call `valueTerms`/element typing is
  derived from the actual terms.
  > **Subtlety (value-term divergence on a shared LiveQuery).** Because `[read(A)]` and `[write(A)]`
  > share a `LiveQuery` by hash but need different `valueTerms`/cursors, the `LiveQuery` stores a
  > small `Map<string /*valueSignature*/, { valueTerms, cursors, pooledElements }>` keyed by the
  > **value-role signature** (the `P`-tagged subset with read-vs-write distinguished). The matching
  > state (`current`, `matchingArchetypes`, maintenance) is shared; only the cursor/element binding
  > is per-value-signature. This keeps matching deduped while honoring the read/write element split
  > (§9.3). Most worlds have one value-signature per match-signature, so the inner map is size 1.
- `With(A)` (membership-only, tag `M`) is kept **distinct** from `read(A)` (tag `P`) in the hash so
  that a query that only checks membership does not collide with one that also reads — they have the
  same `current` set but different `valueTerms`, and keeping them distinct avoids surprising a
  membership-only query with an unexpected value binding. (Both still produce the same matching;
  the distinction is purely about the cached value binding.)
- The sort makes the hash **order-independent** (`[read(A), read(B)]` === `[read(B), read(A)]`).

### 4.2 `pairHashId`

```
pairHashId(pairDef) -> string:
  R := pairDef.relation
  if pairDef.target === Wildcard:  return 'W' + R.relationId          // wildcard → presence id space
  if R.storageKind === 'exclusive-column':
     return 'X' + R.relationId + '.' + handleIndex(pairDef.target)    // presence + target row-filter
  return 'p' + R.relationId + '.' + handleIndex(pairDef.target)       // tag/overflow specific pair id
```

This folds the **target index** into the key for specific-target pairs so `Pair(ChildOf, p1)` and
`Pair(ChildOf, p2)` are distinct cache entries (relations §8.3 "two queries differing only by
parent are distinct cache entries"). Keying by `handleIndex(target)` (not the full handle) matches
relations' index-keyed pair identity (relations §2.1) — a target's generation bump tears the pair
down via cascade, so the index is the stable lifetime key.

### 4.3 The cache

```ts
interface QueryCache {
  byHash: Map<string, LiveQuery>;          // canonical hash → the single LiveQuery
}

function getOrCreateLiveQuery(cache: QueryCache, terms: QueryTerm[]): LiveQuery {
  const compiled = compileQuery(terms);    // §3.3 (cheap; could be skipped if hash precomputed)
  const existing = cache.byHash.get(compiled.hash);
  if (existing) {
    existing.ensureValueSignature(compiled);  // §4.1 subtlety: add the value-signature binding if new
    return existing;
  }
  const lq = createLiveQuery(compiled);    // §5.2 — allocate current set, test all existing archetypes
  cache.byHash.set(compiled.hash, lq);
  return lq;
}
```

- Cache lookup is O(1) (string hash map). On a hit, no archetype re-test, no `current` rebuild — the
  whole point of dedup (bitECS `Query.ts:329-336`).
- **Complexity:** a cache *miss* costs O(arity) compile + O(A · words) to seed `matchingArchetypes`
  against all existing archetypes (§5.2). A *hit* costs O(arity) compile (or O(1) if the caller
  passes a precomputed hash) + O(1) lookup.

---

## 5. Per-archetype matching (the iteration path, O(A))

> **The load-bearing correction (report §1, §2.4).** Query *iteration* never ANDs per entity. Each
> `LiveQuery` caches the set of matching **archetypes**; iteration walks those archetypes and their
> contiguous rows. Matching a *new* archetype against a query is one bitwise AND per signature word
> (O(A) archetypes total, amortized at archetype creation). The per-entity AND (`matchEntity`,
> archetype-storage §6.6) is used **only** for re-testing a *single migrated* entity (§6).

### 5.1 The `LiveQuery` structure

```ts
export interface LiveQuery {
  readonly compiled: CompiledQuery;

  /** Cached pointers to every archetype whose signature matches (the iteration set). */
  readonly matchingArchetypes: Archetype[];

  /** O(1) membership: entity index → in the match? (the result container, §7). */
  readonly current: SparseSetU32;

  /** Per-(value-signature) cursor + pooled element bindings (§4.1 subtlety, §9). */
  readonly bindings: Map<string, { cursors: Map<ArchetypeId, ArchetypeCursor>;
                                   elements: Map<ArchetypeId, PooledElement>;
                                   valueTerms: readonly CompiledValueTerm[] }>;

  /** Lazily-allocated flavor delta lists (reactivity-owned storage; §8). */
  delta?: QueryDeltaLists;

  /** Last tick this query's matching set was reconciled (debug / staleness). */
  lastMatchTick: number;

  /** For system-scoped queries: the scheduler access sets (§11). undefined for lazy queries. */
  access?: { read: ComponentId[]; write: ComponentId[] };
}
```

### 5.2 `createLiveQuery` — seed the matching set

```
createLiveQuery(compiled) -> LiveQuery:                 // serial-phase
  lq := { compiled, matchingArchetypes: [], current: newSparseSet(maxEntities),
          bindings: new Map(), lastMatchTick: world.tick }
  // test EVERY existing archetype once (one-time O(A·words) seed):
  for arch in store.byId:
    if archetypeMatches(arch, compiled):                // §5.4
      lq.matchingArchetypes.push(arch)
      seedCurrentFromArchetype(lq, arch)                // §5.5
  // register in the reverse maintenance index for incremental upkeep (§6):
  for cid in compiled.referencedIds:
    queriesReferencing(cid).add(lq)                     // reactivity/storage reverse index
  return lq
```

- The one-time seed walks all existing archetypes (`store.byId`, archetype-storage §5.1). For a
  query created at world setup (before many archetypes exist) this is cheap; for a query created
  late it is O(A · words) once. Subsequent archetypes are added incrementally (§5.3).
- `seedCurrentFromArchetype` adds every live row's entity index to `current` (§5.5).

### 5.3 Incremental maintenance on archetype creation (`archetypeCreated` hook)

Archetype-storage emits `archetypeCreated` when a new signature first occurs (archetype-storage
§5.3). This module subscribes once and tests the new archetype against **every** registered query:

```
onArchetypeCreated(arch):                               // serial-phase; storage emits this
  for lq in queryCache.byHash.values():
    if archetypeMatches(arch, lq.compiled):             // §5.4 — one AND per word
      lq.matchingArchetypes.push(arch)
      // a brand-new archetype starts with count 0 (entities migrate IN afterward), so there is
      // nothing to seed into `current` here — entities are added by the per-entity migration path
      // (§6) as they actually enter the archetype. (A non-empty new archetype only arises via
      // `world.warm` promotion of a cold archetype, which re-seeds via §5.5.)
      for binding in lq.bindings.values():
        binding.cursors.set(arch.id, bindCursor(lq, arch, binding))   // accessors §9.2, cached
        binding.elements.set(arch.id, makePooledElement(lq, arch, binding))
```

- **Complexity: O(#queries · words) per new archetype.** This is the report's "When an archetype
  is created … test its signature once and, if it matches, append a pointer to the query's
  `matchingArchetypes`" (§2.4), and becsy's per-component reverse-query idea generalized to the
  whole query set at creation time. It is **not** per entity.
- Iterating all queries per new archetype is acceptable because archetype creation is rare (lazy,
  amortized — report T4) and queries are few relative to entities. A finer reverse index
  (`queriesReferencing(cid)` ∩ over the new signature's IDs) is the optimization **Q-Q2** — test
  only queries that reference at least one of the new archetype's components. v1 ships the simple
  all-queries scan; Q-Q2 narrows it to the union of `queriesReferencing(c)` for `c in arch.sig`.

### 5.4 `archetypeMatches` (the per-archetype predicate)

```
archetypeMatches(arch, q) -> boolean:
  // 1. fixed-stride words via the shared storage primitive (archetype-storage §8):
  if not signatureMatches(arch.sigWords, q.withWords, q.notWords, /*orW=*/[]):  return false
  // 2. residual large-pair-ID terms (beyond fixed stride) via sigHas binary search:
  for r in q.residualWith:
    present := sigHas(arch.signature, r.componentId)     // archetype-storage §3.8, O(log|sig|)
    if r.negate ? present : !present:  return false
  // 3. row-filter terms (exclusive specific-target pairs): match by presence bit ONLY here;
  //    the per-row targetColumn==T filter is applied during iteration (§10.2(a)) or replaced by
  //    the back-ref path (§10.2(b)). The archetype matches iff it carries presenceId(R):
  for rf in q.rowFilters:
    if not sigHasFixedOrResidual(arch, rf.presenceId):  return false
  return true
```

- `signatureMatches` is the shared primitive (archetype-storage §8): `notWords` then `withWords`
  (then the empty `orWords`). Each is one `(sigWords[wordIndex] & mask)` test — **O(words)**.
- Residual and row-filter handling are O(residual · log|sig|) and O(rowFilters), both tiny.
- **Total: O(words + residual·log|sig| + rowFilters)** per archetype; with no large pair IDs and
  no exclusive specific-target term (the common case) it is purely O(words).

### 5.5 `seedCurrentFromArchetype`

```
seedCurrentFromArchetype(lq, arch):                     // serial-phase
  for row in 0 .. arch.count-1:
    h := arch.rows[row]                                  // full handle (archetype-storage §3.5)
    index := handleIndex(h)
    if lq.compiled.rowFilters.length === 0 or passesRowFilters(lq, arch, row):  // §10.2(a)
      lq.current.add(index)
```

- Used only on `createLiveQuery` (existing archetypes) and on `world.warm` re-seed (a cold
  archetype promoted with live rows). New archetypes from ordinary migration start empty and are
  populated by the per-entity path (§6).
- Complexity: O(arch.count) (+ O(1) row-filter per row when present).

---

## 6. Incremental single-entity maintenance (on migration)

When **one** entity migrates (component add/remove, pair add/remove, `spawnWith`), only the
queries that reference a *changed* component need re-testing — **for that one entity** (report
§2.4 "incremental maintenance only"; becsy `query.ts:148-181`). This is the **only** place a
per-entity AND runs, and it runs serial-phase on the single migrated entity, never over all
entities and never for iteration.

### 6.1 The trigger: `MAINTAIN_STRUCTURAL` drain (reactivity-driven)

Reactivity's `MAINTAIN_STRUCTURAL` (reactivity §5.2) drains `log.shape` once at the serial flush,
after command application, and for each `(index, componentId, kind)` entry calls into this module
per query that references `componentId`:

```
maintainEntity(index, componentId):                     // called by reactivity §5.2 per shape entry
  for lq in queriesReferencing(componentId):            // reverse index seeded in §5.2/§5.3
    wasMatch := lq.current.has(index)
    isMatch  := matchesEntityNow(lq, index)             // §6.2 single-entity matcher
    if isMatch and not wasMatch:
      lq.current.add(index)
      if lq.delta?.added:   lq.delta.added[lq.delta.addedCount++] = index
    elif not isMatch and wasMatch:
      lq.current.remove(index)
      if lq.delta?.removed: lq.delta.removed[lq.delta.removedCount++] = index
```

- This is reactivity's `MAINTAIN_STRUCTURAL` inner body (reactivity §5.2), whose `matchesEntityNow`
  / `queriesReferencing` are **owned here**. The reactivity spec calls these; this module supplies
  them.
- **Remove-then-add coalescing**: because the shape log is drained once per flush, an entity removed
  then re-added the same frame ends with `isMatch === wasMatch` and produces **no** `added`/`removed`
  delta — the net-effect coalescing bitECS gets from `toRemove` + `commitRemovals`
  (`Query.ts:436-494`), achieved here by deferring maintenance to one drain (reactivity §5.2).
- **Complexity:** O(shape-entries · queries-referencing-each-component). The reverse index bounds
  the inner loop to subscribed queries only (becsy `shapeQueriesByComponent`, `query.ts:148-181`).

### 6.2 `matchesEntityNow` (the single-entity matcher)

```
matchesEntityNow(lq, index) -> boolean:                 // serial-phase ONLY (bitmask read, BM-1)
  shape := entityShapeWords(index)                       // archetype-storage §6.6 — zero-copy fixed-stride view
  // fixed-stride with/not via the report's matchEntity loop (report §2.4):
  for t in lq.compiled.notWords:  if (shape[t.wordIndex] & t.mask) !== 0      return false
  for t in lq.compiled.withWords: if (shape[t.wordIndex] & t.mask) !== t.mask return false
  // residual large-pair-ID terms: test against the entity's CURRENT signature (not shape words):
  sig := currentSignature(index)                         // resolveLocation → archetype.signature
  for r in lq.compiled.residualWith:
    present := sigHas(sig, r.componentId)
    if r.negate ? present : !present:  return false
  // row-filters: presence bit (shape/sig) AND per-row target value
  for rf in lq.compiled.rowFilters:
    if not entityHas(index, rf.presenceId):  return false
    if not rowFilterPassesForEntity(index, rf):  return false   // §10.2(a)
  return true
```

- `entityShapeWords(index)` returns the entity's **fixed-stride** membership words (archetype-storage
  §6.6) — the substrate of the per-entity AND. This is the report's `matchEntity` pseudocode (§2.4),
  realized over `entityShapeWords` for fixed-stride terms and `sigHas` for residual pair terms.
- **Main-thread/serial-only** (Must-Fix #1, BM-1): `entityShapeWords` asserts `world.phase ===
  'serial'`. This path never runs on a worker — maintenance happens between waves. (Worker
  iteration establishes membership from the archetype it iterates, §9.4 — never from this.)
- **Complexity: O(words + residual·log|sig| + rowFilters)** per migrated entity, exactly the
  single-entity matcher cost the report names (§2.4), independent of total entity count.

### 6.3 Lifecycle integration (spawn / despawn)

- **spawn**: a freshly spawned entity lands in `EMPTY_ARCHETYPE_ID` (entity-model §6.2). The
  empty-signature archetype matches only a query with no `withWords`/`residualWith`/`rowFilters`
  and no violated `notWords` (rare). `spawn` emits a `Create` shape entry (reactivity §4.2); the
  `Create` kind triggers no per-component `maintainEntity` (the entity holds no components yet), so
  most queries see the entity only after its first `add`/`spawnWith` migration (which emits `Add`
  entries that drive §6.1). This is correct: an entity with no components matches no
  component-constrained query.
- **spawnWith**: the single migration (archetype-storage §5.6) emits one `Add` entry per added
  component; `MAINTAIN_STRUCTURAL` then runs `maintainEntity(index, c)` for each, adding the entity
  to every newly-matching query exactly once (the `dedup`/idempotent `current.add` makes repeated
  adds within one drain harmless).
- **despawn**: the `Destroy`/per-component `Remove` entries (reactivity §4.2, emitted before
  `removeRow` and identity invalidation — entity-model §6.3) drive `maintainEntity` to remove the
  index from every query that held it. Because removal entries are emitted **before** `freeEntity`,
  `resolveLocation`/`currentSignature` still resolve the dying entity during maintenance. After the
  flush, `current.has(index)` is false for all queries (the entity is gone).

---

## 7. Result container & flavor lists

### 7.1 `current` — SAB-capable u32 sparse set

`current` is a **`SparseSetU32`** — the bitECS sparse-set result container
(`bitECS/src/core/utils/SparseSet.ts:11-117`): O(1) add/remove/has, dense iteration, SAB-shareable.
It stores **entity indices** (not full handles — the index is the stable maintenance key, matching
the bitmask and entity record addressing).

```ts
export interface SparseSetU32 {
  dense: Uint32Array;     // [0..size) = entity indices currently in the match (dense, iterable)
  sparse: Uint32Array;    // sparse[index] = position in dense, valid iff dense[pos]===index & pos<size
  size: number;
  has(index: number): boolean;        // sparse[index] < size && dense[sparse[index]] === index
  add(index: number): void;           // O(1); idempotent (has-guarded)
  remove(index: number): void;        // O(1) swap-and-pop within dense
  [Symbol.iterator](): Iterator<number>;   // iterate dense[0..size)
}
```

- `dense`/`sparse` are `u32` regions allocated through `Buffers.region('query.<hash>.dense'/...,
  'u32', maxEntities)` (memory-buffers §5.1) — SAB when threaded, length-tracking (V-1). `current`
  is read-only to workers (workers do not maintain `current`; they iterate `matchingArchetypes`
  rows, §9.4), so no atomics on the iteration path.
- **Why a sparse set and not a `number[][]` mask.** The report rejects bitECS's `number[][]` entity
  masks (`World.ts:13`) as poor-locality and non-SAB-shareable (§2.4 "What to avoid"). The sparse
  set is dense-iterable, O(1)-mutable, and SAB-backed — the report's chosen result container (§2.4
  "Result storage").
- **Memory:** two `u32` arrays × `maxEntities` per query = 32 MiB per query at the default
  `maxEntities = 2^22`. **This is sized lazily by `dense` high-water, not eagerly** — see §7.3.

### 7.2 Iteration of `current` vs iteration of `matchingArchetypes`

There are **two** ways to enumerate a query's entities, used in different places:

1. **`matchingArchetypes` walk (the hot iteration path, §9):** for system iteration, walk each
   matching archetype's contiguous rows. This is cache-coherent SoA iteration and is what
   `query.each` uses. It does **not** consult `current`.
2. **`current` sparse set (the membership/filter path):** `current.has(index)` answers "is this
   entity in the match?" in O(1), and the `Added`/`Changed`/`Removed` filters intersect against it
   (§8). It is also the substrate for incremental maintenance (§6).

> **Why both exist.** Iteration wants dense per-archetype columns (locality); filters and
> single-entity maintenance want O(1) membership. Keeping both coherent is cheap: `current` is
> updated only by the per-entity maintenance path (§6) and the seed (§5.5), both serial. The
> `matchingArchetypes` walk yields exactly the entities in `current` (invariant Q-I1, §13) because
> every live row in a matching archetype is in `current` and vice versa.

### 7.3 Lazy `current` sizing

A query's `current` sparse set is sized to the world's **current entity high-water mark**, not
eagerly to `maxEntities`, and grows via the standard region-growth protocol (memory-buffers §7.6,
serial-only V-2). A query that matches few entities pays little. The `sparse` array must be
addressable by any entity index, so it is sized to the entity index high-water (the entity layer's
`denseLen`, entity-model §3.1), growing in lockstep when the entity space grows. This avoids the
naive 32 MiB-per-query worst case for small worlds while preserving O(1) addressing.

### 7.4 Flavor delta lists (reactivity-owned storage, query-driven)

`added` / `removed` / `changed` lists are **allocated lazily** by reactivity's `attachFlavors`
(reactivity §5.1) only if the query **declares** the flavor — zero cost for unused flavors (becsy
`QueryFlavor`, `query.ts:97-109`). This module calls `attachFlavors` at `LiveQuery` creation when
the query was built with a flavor declaration (§8.1) and stores the returned `QueryDeltaLists` on
`lq.delta`.

```ts
// reactivity §5.1 (consumed here):
interface QueryDeltaLists {
  added?:   Uint32Array;  addedCount: number;
  removed?: Uint32Array;  removedCount: number;
  changed?: { ptr: LogPointer; dedup: Uint8Array };
}
```

---

## 8. Added / Changed / Removed filters

The two logs (`log.shape`, `log.write`) are reactivity's; this module declares which flavors a
query wants and consumes the drain results. **No per-field version stamp touches the filter path**
(T3 — the public `.changed` predicate uses `changeVersion`, the *filter* uses the log).

### 8.1 Declaring flavors

```ts
// Flavor declaration is part of the query builder surface (system-scoped, §11) or a chained call:
world.query([read(Position), write(Velocity)])
  .added()      // entities that ENTERED the match this frame
  .removed()    // entities that LEFT the match this frame
  .changed(Velocity);   // entities in the match whose Velocity was written this frame
```

- `.added()`/`.removed()` allocate `added`/`removed` via `attachFlavors`. `.changed(...C)` allocates
  a `changed` `LogPointer` + dedup bitset and records the set of components whose writes count
  (default: all `read`/`write` components of the query if none listed).
- Declaring a flavor sets a `QueryFlavor` bit on the `LiveQuery`; undeclared flavors allocate
  nothing (becsy `query.ts:97-109`).
- **Flavor declaration does not change the hash** (§4) — two queries with the same terms but
  different flavors share the same `LiveQuery` matching state; flavors are additive per-`LiveQuery`
  state, so declaring `.added()` on a previously-non-added query attaches the list on first use.

### 8.2 `Added` / `Removed` (off the shape log)

`added`/`removed` are filled by the §6.1 maintenance loop during `MAINTAIN_STRUCTURAL` (reactivity
§5.2): when an entity's match transitions `false→true` it is appended to `added`; `true→false` to
`removed`. The lists are **transient — cleared each frame** at `FRAME_RESET` (the system reads them
during its execution slot, between maintenance and reset).

```
// per frame, the system reads:
for index in lq.delta.added[0 .. addedCount):    /* newly matched this frame */
for index in lq.delta.removed[0 .. removedCount): /* left the match this frame */
// reset (FRAME_RESET, reactivity §3.7):
lq.delta.addedCount = 0; lq.delta.removedCount = 0
```

- **Coalescing** (§6.1): remove-then-add within a frame nets to no delta. **Add-then-remove**
  within a frame likewise nets to no delta (the entity is not in `current` at flush and never
  appears in either list). This is the becsy `processedEntities` per-frame net-effect (`query.ts:
  148-150`) achieved by the single-drain maintenance.
- A `Removed` entity is reported by its **index**; the system can resolve its (now possibly dead)
  handle via the index, but should treat it as a tombstone (the entity may have despawned). For
  `onRemove`-style value access use a deferred observer (reactivity §7), not the `Removed` filter.

### 8.3 `Changed` (off the write log)

`Changed` is computed **lazily when the query is read**, draining the query's own `LogPointer` into
`log.write` (reactivity §5.3, `drainChanged`):

```
changedIndices(lq) -> Uint32Array:                      // O(write-entries-since-last-read)
  return reactivity.drainChanged(lq)                     // reactivity §5.3 DRAIN_CHANGED
  // DRAIN_CHANGED filters write entries to: componentId referenced by lq, index in lq.current,
  // deduped per frame (one bit per index). Returns this frame's changed indices.
```

- The `changed` filter consults **the write log, not `changeVersion`** (T3, reactivity §5.3). An
  entity written N times in a frame appears once (per-frame dedup bitset, reactivity §5.1).
- **Overflow path:** if the write log wrapped (consumer fell a full generation behind), `CONSUME`
  yields `OVERFLOW_SENTINEL` and the conservative response is **treat every entity in `current` as
  changed** (reactivity §3.6) — a correct superset, never a missed change.
- **Worker writes** are merged into `log.write` from per-worker corrals at the serial flush
  (reactivity §9.2) before any `changed` consumer runs, so a write on a worker is seen by the
  `changed` filter exactly once, deterministically, after the wave.

### 8.4 Filter intersection semantics

`Added`/`Changed`/`Removed` are always **relative to the query's match**:

- `added` ⊆ entities now in `current` (entered this frame).
- `changed` ⊆ `current` (only entities currently matching whose referenced component changed).
- `removed` ⊆ entities no longer in `current` (left this frame).

A system iterating `query.changed()` iterates only the changed-and-still-matching entities — the
common "react to moved transforms" pattern. The iteration still goes through the cursor (§9) for
the matching archetypes, filtered by `current.has(index)` for the changed set, OR (more directly)
iterates the `changed` index list and binds the cursor per index (§9.5).

---

## 9. Iteration API (surfacing accessors)

Iteration is the hot path. It walks `matchingArchetypes`, drives the `ArchetypeCursor` (accessors
§9), and yields a typed pooled element. **Zero allocation per row.**

### 9.1 The `Query` surface (runtime side of type-system §5.3)

```ts
export interface Query<Terms extends readonly QueryTerm[]> {
  readonly terms: Terms;

  /** Iterate every matching entity; `e` is the pooled element (do NOT store it). */
  each(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void;

  /** Lazy iterator form (same pooled element; single active iteration). */
  [Symbol.iterator](): Iterator<QueryElement<Terms> & { handle: EntityHandle }>;

  /** Flavor declarations (chainable; §8.1). Return `this` for fluent use. */
  added(): this;
  removed(): this;
  changed(...components: ComponentDef<any>[]): this;

  /** Flavor result iterators (entities entered/left/changed this frame). */
  eachAdded(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void;
  eachRemoved(fn: (index: number, handle: EntityHandle) => void): void;   // tombstone: index + maybe-dead handle
  eachChanged(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void;

  /** Count of currently-matching entities (current.size). O(1). */
  readonly count: number;
}
```

### 9.2 `each` — the hot loop (delegates to the accessor cursor)

```
each(lq, valueSignature, fn):                            // serial OR wave (read-only over columns)
  binding := lq.bindings.get(valueSignature)             // §4.1 subtlety; one per value-signature
  for arch in lq.matchingArchetypes:
    if arch.cold:  { eachCold(lq, arch, binding, fn); continue }   // §12
    cur := binding.cursors.get(arch.id)                  // accessors §9.2, cached at match time
    el  := binding.elements.get(arch.id)                 // pooled, one per (query, value-sig, archetype)
    cur.reset()
    if lq.compiled.rowFilters.length === 0:
      while cur.next():                                  // accessors §9.1: pokes __idx/__eid, O(touched comps)
        el.handle := arch.rows[cur.row]
        fn(el)
    else:                                                // exclusive specific-target row-filter (§10.2a)
      while cur.next():
        if passesRowFilters(lq, arch, cur.row):
          el.handle := arch.rows[cur.row]
          fn(el)
```

- The cursor (accessors §9.1) advances `row`, pokes every bound accessor's `__idx`/`__eid`, and is
  O(touched components) per row — not O(all components). The pooled element's props **are** the
  bound accessor singletons (accessors §9.3): `el.position.x` is one `__idx` poke (done by `next()`)
  + one typed-array load; `el.velocity.x = 1` fires the singleton setter → slot store + `trackWrite`
  (accessors §6.4). **Read terms type the prop `Readonly`; write terms type it mutable** (Must-Fix
  #2; the per-term realization of the read/write split, accessors §9.3).
- **Zero allocation per row:** `row`/`__idx`/`__eid`/`el.handle` mutate in place; the cursor and
  element are pooled per `(query, value-signature, archetype)`, cached at match time (§5.3). No
  `new` in the loop (report §2.4 result/iteration; bitECS dense iteration).
- **Complexity:** O(Σ over matching archetypes of their `count`) + O(touched components) per row.
  No per-entity matching (matching was amortized at archetype creation, §5.3).

### 9.3 The pooled element & the read/write split

`makePooledElement(lq, arch, binding)` builds one small object per `(query, value-signature,
archetype)` whose properties are the archetype's accessor singletons for the query's value terms,
typed per the term role:

```
makePooledElement(lq, arch, binding):
  el := { handle: NO_ENTITY }
  for vt in binding.valueTerms:                          // CompiledValueTerm (§3.1)
    cs := arch.columnSets.get(vt.componentId)
    if cs:
      defineProp(el, vt.key, () => cs.accessor)          // returns the singleton (cursor poked __idx)
    elif vt.role === 'optional':
      defineProp(el, vt.key, () => undefined)            // optional absent → undefined (type-system §5.2)
    // With/Without contribute no value term, hence no prop
  return el
```

- The element is built **once** at match time (cached on `binding.elements`), not per row. Its
  getters return the (already-`__idx`-poked) accessor singleton; the read/write typing comes from
  the `valueTerms` roles and the static `QueryElement<Terms>` type (type-system §5.3). A `read`/bare
  term's prop is typed `ReadOf<C>` (assignment a compile error); a `write` term's is `WriteOf<C>`.
- This is the runtime realization of `QueryElement<Terms>` (type-system §5.3) — the intersection of
  per-term contributions — as a concrete pooled object (accessors §9.3).

### 9.4 Worker iteration (Must-Fix #1)

A worker running a system over its assigned batch drives the **same** cursor over the same
archetype columns (SAB-shared on the primary path; transferred per wave in postMessage mode —
accessors §10). Crucially:

- The cursor establishes membership **purely from the archetype it iterates** (`arch.rows`/
  `arch.columnSets`), never from the per-entity bitmask (Must-Fix #1, T2). Every entity in
  `arch.rows[0..count)` is alive (rows hold only live handles, archetype-storage §3.5) and carries
  exactly the signature's components — so a worker needs no `current`-set read and no bitmask read
  to iterate correctly.
- The worker reads/writes **column values only** — plain typed-array access over the SAB
  (widening-safe, memory-buffers §7.2). Write setters call `world.trackWrite`, which on a worker
  routes to the per-worker corral (reactivity §9.1), merged serially — no atomics on the hot path.
- The worker never runs §5 matching or §6 maintenance (both serial). It receives the already-
  computed `matchingArchetypes` (or the subset assigned to its batch) from the scheduler at wave
  dispatch. `Added`/`Changed`/`Removed` filters are computed on the main thread (off the merged
  logs) — a worker system that needs `changed` reads it from the main-thread-computed list at the
  serial slot, not mid-wave.

### 9.5 Flavor iteration

```
eachChanged(lq, valueSignature, fn):                    // serial slot (after MERGE_CORRALS)
  changed := changedIndices(lq)                          // §8.3, deduped
  binding := lq.bindings.get(valueSignature)
  for index in changed:
    h := makeHandleFromIndex(index)                      // generation from entity layer
    { archetypeId, row } := resolveLocation(index)       // entity-model §4.3
    arch := store.byId[archetypeId]
    cur := binding.cursors.get(arch.id); cur.row := row  // bind the singletons to this row
    for acc in cur.boundAccessors: acc.__idx := row; acc.__eid := h
    el := binding.elements.get(arch.id); el.handle := h
    fn(el)

eachAdded(lq, valueSignature, fn):  // identical but iterates lq.delta.added[0..addedCount)
eachRemoved(lq, fn):                 // iterates lq.delta.removed; yields (index, handle) tombstones
```

- `eachChanged`/`eachAdded` bind the cursor per index (not a contiguous archetype walk) because the
  changed/added set is scattered across archetypes. This is O(changed) with one `resolveLocation` +
  cursor poke per entity — acceptable because the changed set is typically small relative to the
  full match (the whole point of the `changed` filter).
- `eachRemoved` yields tombstones (the entity may be dead); it does not bind an element (no live
  row to read). Value access for removed entities is an observer concern (reactivity §7).

---

## 10. Relation / wildcard query terms

The query module owns matching; relations §8 fixes the contract a `PairDef` term hands it. Three
term shapes → three strategies, all resolved at compile time (§3.3 `compilePairSpecific` /
`pairWildcard`).

### 10.1 `Pair(R, Wildcard)` — O(1) per archetype

Compiles to the relation's **presence component** `presenceId(R)` (relations §3). The query adds
`presenceId(R)` to `withWords` (fixed-stride — presence IDs are bounded by relation count, relations
§3.4). Matching is one bitwise-AND per archetype signature word (O(archetypes) — relations §8.1).
Iteration yields every entity holding **any** `R`-pair. This is Q-QR2's resolution (report §2.6
boxed): **not** an O(distinct-targets) scan.

- No value term is added for a wildcard pair (the *which* target is unknown at compile time); to read
  a specific pair's payload during iteration, the system calls `world.getPair(e.handle, R, target)`
  (relations §4.4) inside the callback, or uses `targetsOf(e.handle, R)` (relations §6.3) to
  enumerate targets.

### 10.2 `Pair(R, specificTarget)` — by `storageKind`

`compilePairSpecific` reads `R.storageKind` (relations §3.2) and branches:

**(tag / overflow-table — non-exclusive presence):** the specific pair `ComponentId` is a real
signature bit. Resolve `cid := lookupPairId(R.relationId, handleIndex(target))` (relations §2.2). If
`cid` exists, add it via `addWithBit` (fixed-stride bit or residual for large pair IDs, §3.5). Pure
archetype filter, O(archetypes). **If the pair ID was never minted** (no entity ever held `(R, T)`),
the query matches **nothing** and does **not** mint — querying must not mutate the component space
(relations §8.2; minting is an `addPair`-only side effect). This is represented by a sentinel
"matches-nothing" compiled flag (`compiled.unsatisfiable = true`), short-circuiting §5.4 to `false`.

**(exclusive-column):** the target is a **column value**, not a signature bit (relations §4.2). Two
strategies, the planner picks per relations §8.2:

- **(a) presence + row-filter:** add `presenceId(R)` to `withWords` (matches archetypes carrying the
  exclusive `R`), and add a `RowFilterTerm { presenceId, relationId, targetIndex, subjectTargetFieldIndex }`.
  Matching includes the archetype iff it carries `presenceId(R)` (§5.4 step 3); **iteration filters
  rows** by `targetColumn[row] === target` (§9.2 row-filter branch, `passesRowFilters`). Cost:
  O(rows-in-matching-archetypes). Chosen when the pair term is combined with other component terms
  that must intersect by archetype first.
- **(b) back-ref index:** when the query is **exactly** "subjects of `target` via `R`" (a lone
  exclusive specific-target term, optionally with other `With` terms), resolve directly via
  `subjectsOf(R, target)` (relations §6.2) — O(1) to the subject set — and bind each subject's row.
  This bypasses the archetype walk entirely. The compiled query records `useBackref = true` and
  `each` iterates `subjectsOf(...)` (filtered by `isAlive` and any other `With` terms via
  `entityHas`) instead of `matchingArchetypes`.

```
passesRowFilters(lq, arch, row) -> boolean:             // §9.2 iteration filter
  for rf in lq.compiled.rowFilters:
    cs := arch.columnSets.get(rf.presenceId)             // exclusive presence == column-bearing id (relations §4.2)
    targetCol := cs.columns[rf.subjectTargetFieldIndex]  // the eid target column
    if decodeEid(targetCol.view[row]) is null: return false
    if handleIndex(decodeEid(targetCol.view[row])) !== rf.targetIndex: return false
  return true
```

### 10.3 Canonical hash contribution

A `Pair(R, target)` term contributes its resolved ID to the hash via `pairHashId` (§4.2): the pair
ID for tag/overflow, the presence ID for wildcard, the presence ID + folded `targetIndex` for
exclusive specific-target (so `Pair(R, p1)` and `Pair(R, p2)` are distinct cache entries). Because
pair IDs and component IDs share one dense integer space (relations §2.2), they hash naturally
(report §2.4 "Hash must encode relation-pair targets"; relations §8.3).

### 10.4 Maintenance for pair terms

`addPair`/`removePair` emit `OP_KIND_ADD_PAIR`/`OP_KIND_REMOVE_PAIR` shape entries via the migration
(relations §5; reactivity §4.2). `MAINTAIN_STRUCTURAL` drains them and calls `maintainEntity(index,
pairId)` and `maintainEntity(index, presenceId)` for the queries referencing those IDs — so a
wildcard query (referencing `presenceId(R)`) and a specific-pair query (referencing the pair ID) are
both maintained incrementally by the same §6 path. For **exclusive re-target** (a field write, not a
migration — relations §5.4), no shape entry is emitted; instead the `eid` write pushes a *write-log*
entry. A row-filtered query (§10.2(a)) does **not** auto-re-evaluate on re-target (the archetype
membership did not change); to react to re-parenting, declare `.changed(R-presence)` so the write-log
entry surfaces the affected subject (Q-QR3: making row-filtered exclusive queries auto-maintain on
re-target is deferred — the `.changed` filter covers it).

---

## 11. Hybrid declaration model

ecsia supports **both** lazy ad-hoc queries and system-scoped pre-declared queries; both compile to
the **same** `LiveQuery` (one per canonical hash), so an ad-hoc and a declared query with identical
terms share matching state (report §2.4 "Hybrid mode": "One global live set per hash + per-system
transient lists").

### 11.1 Lazy `world.query(...)`

```ts
world.query([read(Position), write(Velocity)]).each(e => { e.position.x; e.velocity.x = 1; });
```

- Callable anywhere (a system body, a one-off main-thread script). It is **cached** by hash (§4), so
  repeated `world.query([...])` with the same terms returns the same `LiveQuery` (no re-seed) —
  bitECS's anywhere-`query()` (`Query.ts`), but archetype-cached.
- A lazy query carries **no** scheduler access metadata (`lq.access` is `undefined`). It does not
  participate in the conflict DAG. A lazy `write`-term query *does* still drive the `.changed`
  reactivity filter (via `trackWrite` on its element setters) — reactivity is independent of the
  scheduler (Must-Fix #2).

### 11.2 System-scoped pre-declaration (carries access sets)

```ts
defineSystem({
  query: [read(Position), write(Velocity), With(Alive)],
  // OR explicit access override:  read: [Position], write: [Velocity],
  run(q) { q.each(e => { e.velocity.x += e.position.x; }); },
});
```

- A system-scoped query compiles to the same `LiveQuery` as the equivalent lazy query, **plus**
  records `lq.access = { read, write }` derived from the term roles (`read`/bare → read set;
  `write` → write set; `With`/`Without`/`optional` → read set for relations that affect matching but
  not value, conservatively). Pair terms contribute the pair ID / presence ID to the appropriate set
  (relations: pair IDs are ordinary component IDs to the scheduler — report §2.5).
- The scheduler reads `lq.access` at **world setup** (not per-execute, unlike becsy's per-execute
  path — report §2.4) to build the conflict DAG. **Write-intent is the declaration, not inferred
  from runtime setters** (Must-Fix #2, report §2.8). `entity.write(C).x = 5` participates only in
  the `.changed` reactivity filter, never in scheduler write-tracking.
- Multiple systems declaring the same terms share one `LiveQuery` (matching computed once) but each
  has its **own** transient flavor lists and its own access entry (report §2.4 "One global live set
  per hash + per-system transient lists"). The per-system flavor lists live on the system, not the
  shared `LiveQuery`; the `LiveQuery.delta` is the union view, and `MAINTAIN_STRUCTURAL` fills each
  subscribing system's `added`/`removed` (or, simpler in v1, one shared delta read by all systems
  that declared the flavor — Q-Q3: per-system vs shared flavor lists; v1 ships shared, since the
  delta is read within the same frame by all subscribers).

### 11.3 Access-set derivation

```
deriveAccess(compiled) -> { read: ComponentId[], write: ComponentId[] }:
  read := []; write := []
  for vt in compiled.valueTerms:
    if vt.role in {write, pairWrite}: write.push(vt.componentId)
    else:                             read.push(vt.componentId)
  // With/Without/Optional and residual/rowFilter presence ids affect MATCHING only → read intent
  for w in compiled.withWords:  read.push(idOfWord(w))   // conservative: matching reads membership
  for cid in compiled.optionalIds: read.push(cid)
  return { read: dedup(read), write: dedup(write) }
```

- This is conservative (membership/`With` terms count as reads). Finer column-level conflict
  detection is a v2 refinement (report T5 "type-level conflict v1 / column-level v2"); v1's
  derivation is component-type-level, matching the scheduler's v1 granularity.

---

## 12. Cold-archetype query semantics

A matching archetype may be **cold** (in the `ColdStore` overflow, archetype-storage §10.3). Cold
archetypes are matched **identically** (their `sigWords` are built the same way, archetype-storage
§5.3) and appear in `matchingArchetypes`; only iteration differs.

```
eachCold(lq, arch, binding, fn):                         // §9.2 cold branch
  cur := binding.coldCursors.get(arch.id)                // cold cursor (accessors §11.1)
  cur.reset()
  while cur.coldNext():                                   // resolves __idx via ColdStore.rowOf per row
    if lq.compiled.rowFilters.length === 0 or passesRowFilters(lq, arch, cur.coldRow):
      el := binding.coldElements.get(arch.id)
      el.handle := cur.currentColdHandle
      fn(el)
```

- The cold cursor resolves each entity's per-component cold-block row through `ColdStore.rowOf`
  (one map lookup per row — the documented cold throughput penalty, accessors §11.1, archetype-
  storage §10.3). The **query API is unchanged**; the same entity set is yielded as if the
  archetype were hot (report §6.4 "Query semantics for cold entities").
- **Matching, `current`, `has`, and incremental maintenance work identically** for cold entities:
  they carry the same signature bits in the per-entity bitmask (index-addressed, not archetype-
  addressed — archetype-storage §10.3, §6), so §5/§6 are oblivious to hot/cold.
- `world.warm(sig)` promotion (archetype-storage §10.4) re-seeds `current` for the promoted
  archetype via §5.5 (it now has live rows in contiguous form) and swaps its cold cursors for hot
  ones; the `LiveQuery` keeps the same `matchingArchetypes` entry (same `ArchetypeId`).

---

## 13. Invariants (testable assertions)

- **Q-H1 (hash dedup).** `world.query(T)` and `world.query(T')` return the **same** `LiveQuery`
  object iff `canonicalHash(T) === canonicalHash(T')`. `[read(A)]` and `[write(A)]` share matching
  state (same `current`); `[read(A)]` and `[With(A)]` share matching but have distinct value
  bindings. (§4)
- **Q-M1 (per-archetype matching).** Adding an archetype runs `archetypeMatches` **once** per query
  (O(words)); a test stubs `entityShapeWords` and asserts it is **never** called during archetype
  matching or `each` iteration (iteration is per-archetype, not per-entity — report §2.4). (§5, §9)
- **Q-M2 (incremental maintenance scope).** A single entity migration re-tests it against **only**
  the queries in `queriesReferencing(changedComponentId)`, via `matchesEntityNow` on **that one
  entity**; a test with K queries, only J of which reference the changed component, asserts exactly
  J `matchesEntityNow` calls. (§6)
- **Q-I1 (current ⟺ matchingArchetypes coherence).** After any serial flush, for every alive entity
  `i`: `current.has(i)` (for query `q`) ⟺ `i` occupies a live row of some `arch ∈
  q.matchingArchetypes` that passes `q`'s row-filters. A test enumerates both and asserts set
  equality. (§7.2)
- **Q-F1 (added/removed coalescing).** Within one frame, remove-then-add and add-then-remove of an
  entity to a query's match produce **no** `added`/`removed` delta entry. (§8.2; bitECS
  `Query.ts:436-494`)
- **Q-F2 (changed off the log, not changeVersion).** The `.changed()` filter reads only
  `log.write`; a test stubs `changeVersion` and asserts zero reads during `eachChanged`. (§8.3, T3)
- **Q-F3 (changed dedup).** An entity whose component is written N times in a frame appears in
  `eachChanged` exactly **once**. (§8.3; becsy `query.ts:148-150`)
- **Q-F4 (changed overflow superset).** When the write log wraps, `eachChanged` yields a **superset**
  of the true changed set (every entity in `current`), never a subset. (§8.3, reactivity §3.6)
- **Q-R1 (wildcard O(1) match).** `Pair(R, Wildcard)` over a world with T distinct targets touches
  each archetype's signature **once** (via `presenceId(R)`), not T times. (§10.1; relations §8.1)
- **Q-R2 (specific-pair no-mint on query).** `query([Pair(R, T)])` for a `(R, T)` never `addPair`'d
  matches nothing and does **not** mint a pair ID (no component-space mutation from a query). (§10.2)
- **Q-W1 (worker iteration no bitmask).** A worker `each` over an archetype reads no per-entity
  bitmask and no `current` set; membership comes solely from `arch.rows`/`arch.columnSets`. A dev
  guard asserts `entityShapeWords`/bitmask APIs are absent from the worker iteration path. (§9.4)
- **Q-A1 (zero-alloc iteration).** `query.each` over N rows performs **0** heap allocations after
  the first call (cursor + element pooled per `(query, value-sig, archetype)`). A test counts
  allocations across two iterations. (§9.2)
- **Q-C1 (cold transparency).** A query over a signature yields the **same** entity set whether that
  archetype is hot or cold (only throughput differs). (§12; archetype-storage FRAG-1)

---

## 14. Concurrency, memory-ordering & worker policy

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `compileQuery` / `getOrCreateLiveQuery` | Main only | Serial | None (single-writer over the cache). |
| `createLiveQuery` seed / `archetypeMatches` | Main only | Serial | Plain loads over immutable `sigWords`. |
| `onArchetypeCreated` maintenance | Main only | Serial | None; archetype set mutated serially. |
| `matchesEntityNow` / `maintainEntity` | Main only | Serial | `entityShapeWords` asserts serial (BM-1). |
| `current.add/remove/has` | Main only | Serial | Plain stores; never mutated mid-wave. |
| `each` iteration (column **value** read) | Main or worker | Serial / Wave | Plain TypedArray loads over SAB; widening-safe (memory-buffers §7.2). |
| `each` iteration (column **value** write via element setter) | Worker (disjoint) or main | Wave (disjoint) / Serial | Plain store; disjointness from `lq.access` declarations (report T5); `trackWrite` → per-worker corral (reactivity §9.1), no atomics. |
| `drainChanged` / `eachChanged`/`eachAdded`/`eachRemoved` | Main only | Serial slot | One `Atomics.load(generation)` per consumer/frame (reactivity §3.2); rest plain. |

Load-bearing rule (inherited from Must-Fix #1): **all matching, maintenance, `current` mutation,
and filter computation are main-thread / serial.** Workers only *iterate* (read columns, write
disjoint columns) over the pre-computed `matchingArchetypes`; they never match, maintain, read the
bitmask, or touch `current`. The scheduler's wave fence is the synchronization — no atomics on the
query iteration hot path (report §4 T2/T3).

---

## 15. Complexity summary

| Operation | Time | Space |
|---|---|---|
| `compileQuery` | O(arity) | O(arity) words/terms |
| `canonicalHash` | O(arity log arity) (sort) | O(arity) |
| `getOrCreateLiveQuery` (hit) | O(arity) + O(1) lookup | 0 |
| `createLiveQuery` (miss) | O(A · words) seed | O(matching A) + sparse set |
| `onArchetypeCreated` (per new archetype) | O(#queries · words) | O(1) per matching query |
| `archetypeMatches` | O(words + residual·log\|sig\| + rowFilters) | 0 |
| `matchesEntityNow` (per migrated entity) | O(words + residual·log\|sig\| + rowFilters) | 0 |
| `maintainEntity` (per shape entry) | O(queries-referencing-component · matcher cost) | 0 |
| `current.add/remove/has` | O(1) | sparse set: 2·u32·(entity high-water) |
| `each` iteration | O(Σ matching-archetype counts + touched-comps/row) | 0 alloc (pooled cursor+element) |
| `eachChanged`/`eachAdded` | O(changed/added) + O(1) resolveLocation per | 0 alloc |
| `Pair(R, Wildcard)` match | O(archetypes), one signature check each | presence bit: 1/archetype |
| `Pair(R, T)` exclusive via back-ref | O(\|subjects of T\|) | 0 extra |
| Per-query `current` memory | 2 · 4 · (entity high-water) bytes (lazy) | grows with entity space |

---

## 16. Open questions deferred (non-blocking, from report §8)

- **Q-Q1** (`Or([...])` "any-of" term): not in v1; the `orWords` slot in the shared
  `signatureMatches` primitive (archetype-storage §8) is reserved for it (§3.2). Compiles to a
  non-empty `orWords`, zero new matching code.
- **Q-Q2** (narrow `onArchetypeCreated` to the union of `queriesReferencing(c)` over the new
  signature, instead of scanning all queries): v1 scans all queries per new archetype (rare event);
  the reverse-index narrowing is a measured optimization. (§5.3)
- **Q-Q3** (per-system vs shared flavor delta lists for queries shared across systems): v1 ships
  **shared** delta lists on the `LiveQuery` (read within-frame by all subscribers); per-system lists
  are a refinement if cross-system flavor isolation is needed. (§11.2)
- **Q-QR3** (auto-maintain row-filtered exclusive specific-target queries on re-target): v1 covers
  re-target reactivity via the `.changed(R-presence)` filter (the re-target is an `eid` write that
  pushes a write-log entry); auto re-evaluation of the row-filter set on re-target is deferred. (§10.4)
- **Value-signature inner map** (§4.1): a `LiveQuery` keys its cursor/element bindings by
  value-role signature so `[read(A)]`/`[write(A)]` share matching but not bindings; whether to
  collapse identical value-signatures further is an implementation detail, not a blocker.
```
