# ecsia Implementation Spec — Module: Archetype Tables, Bitmask Index & Migration

> Module owner: `@ecsia/core` (`src/storage/`, `src/bitmask/`).
> Status: implementable. This module is the **storage kernel**: it owns archetype identity, the
> SoA column tables, the lazy edge-graph migration cache, swap-pop row removal, the per-entity
> bitmask membership index (main-thread/serial-only), and the archetype-fragmentation /
> cold-archetype fallback. It sits directly on top of three foundation specs and honors their
> contracts verbatim:
> - `entity-model.md` — `EntityHandle`, the two-word entity record, `commitRecord(index, archId,
>   row)`, lifecycle hooks, `EMPTY_ARCHETYPE_ID`, `ARCHETYPE_NONE`, `reserveEntityBlock`.
> - `memory-buffers.md` — `Column`, `ColumnLayout`, `Buffers.column/grow/region`, length-tracking
>   views (V-1), serial-growth (V-2), the `bitmask.words` region, `ColumnKey`.
> - `type-system.md` — `FieldDescriptor`, `AccessorFactory<S>`, `ComponentId`, `ArchetypeId`,
>   `ComponentDef`, synthetic pair `ComponentId`s.
>
> Every `file:line` citation refers to the three reference libraries surveyed in
> `docs/research/DESIGN-RESEARCH.md` ("the report"). Section pointers like "§7.4" refer to the
> report unless prefixed "this spec".

---

## 0. Scope & Non-Goals

**In scope (this module owns):**

1. `ArchetypeId`, the **canonical sorted signature** (`Uint32Array` of component IDs), and
   signature hashing/equality.
2. The **archetype table**: its `ColumnSet` (one `Column` per `(component, field)` via the
   `Buffers` registry), its dense **entity-row list**, its `count`, and row alloc/free.
3. **`allocRow(handle)` / `removeRow(row, fixSibling)`** — the swap-pop primitive the entity
   module's `spawn`/`despawn`/`migrate` call (entity-model.md §4.2, §6.3).
4. The lazy **edge graph**: `add`/`remove` transition cache (`Map<ComponentId, {add, remove}>`)
   that turns the *second* and later `add(C)`/`remove(C)` on an archetype into O(1).
5. **`migrate(handle, fromArch, toArch)`** plus the multi-ID **`migrateAddingMany` /
   `migrateRemovingMany`** and single-ID `migrateAdding` / `migrateRemoving` specializations
   (§5.6a): shared-column copy, added-column init, removed reactivity enqueue, source shuffle-pop,
   and the two-word commit via `commitRecord`.
6. The **per-entity bitmask membership index** (`bitmask.words` region): set/clear on
   add/remove, `has(handle, componentId)` point test, single-entity query re-test support.
   **Main-thread / serial-phase only** (Must-Fix #1).
7. **Archetype fragmentation** handling: `maxHotArchetypes` cap, the **cold-archetype overflow
   store**, transparent query semantics for cold entities, and `world.warm(sig)` promotion
   (report §6.4).

**Out of scope (consumed from / handed to other modules):**

- The physical column representation per field type, the `Buffers` registry growth protocol,
  SAB-vs-AB selection, length-tracking views — `memory-buffers.md`. This module *requests*
  columns and rows; it never decides backing or view lifetime.
- The generational handle codec, `isAlive`, `resolveLocation`, `commitRecord` bodies, the
  free-list, `spawn`/`despawn`/`reserveEntityBlock` — `entity-model.md`. This module is *called
  by* `spawn`/`despawn`/`migrate` and *calls* `commitRecord` and the lifecycle hooks.
- The accessor factory-closure class bodies, `__idx` poking, `read`/`write` views —
  `accessors`/`component` spec. This module holds the `AccessorFactory<S>` reference and the
  per-`(archetype, component)` singleton, and registers it as a `ViewHolder` for the fallback
  grow path; it does not author the closure bodies.
- Query compilation, `LiveQuery`, the per-archetype `matchingArchetypes` lists, the change-log
  rings — `query`/`reactivity` specs. This module **emits archetype-created / migration / row
  events** the query module subscribes to, and exposes the signature-AND primitive queries use.
- Relation pair-ID minting, exclusivity decision, back-ref index, cascade BFS, the non-exclusive
  overflow payload table — `relations` spec. This module treats a pair ID as an ordinary
  `ComponentId` in a signature (report §2.6) and stores exclusive-relation `eid` payloads as
  ordinary columns; it has **no** relation-specific code beyond that.

---

## 1. How this module satisfies the locked decisions

| Locked decision (report) | Where satisfied in this spec |
|---|---|
| Storage = TWO representations: (a) per-entity bitmask membership index, (b) archetype SoA tables, kept coherent | §3 (tables), §6 (bitmask). Coherence is one-way and serial: §6.1 / §7. |
| Bitmask read ONLY on main-thread/serial; NEVER by workers mid-wave (Must-Fix #1 / T2) | §6.2: every bitmask read/write asserts `world.phase === 'serial'`; workers use the archetype signature they iterate (§9.4). |
| Archetype TABLES = SoA columns; per-archetype query matching O(A), NOT per-entity | §3.4 (`ColumnSet`), §8 (signature-AND matching is per-archetype; the per-entity matcher is incremental-only). |
| Lazy edge-graph migration cache, O(1) after first | §5: `Map<ComponentId,{add,remove}>` per archetype node; first transition computes+caches, rest are O(1). becsy lacks this (`registry.ts:399-423`). |
| Swap-pop row removal, cost O(shared columns) | §4.3 `removeRow`; migration copy cost is O(K) shared columns (§5.4), shuffle-pop is O(columns of source). |
| Relations as integer pair IDs = archetype members; payload split by exclusivity (Must-Fix #4) | §3.2 (pair IDs are ordinary signature members), §3.6 (exclusive `eid` payload = ordinary column; non-exclusive overflow owned by `relations`). |
| Generational handle, two-word record is the structural commit point | §4.2/§5.6 commit via `commitRecord` (entity-model.md §4.2); rows store full handles (§3.5). |
| Accessors = monomorphic factory-closure, one hidden class per (archetype,component); NOT Proxy/codegen | §3.7: `AccessorFactory<S>` invoked once per `(archetype, component)`; registered as `ViewHolder` (§3.7, memory-buffers.md §7.5). |
| Archetype fragmentation under relations + cold-archetype handling (report §6.4) | §10 in full: cap, cold overflow store, transparent query semantics, `world.warm`. |
| ESM-only, strict TS, SAB + postMessage fallback | All allocation via `Buffers` (memory-buffers.md §5); no SAB/AB branch in this module (B-1). |

---

## 2. Terminology & Units

- **Signature** = the canonical sorted `Uint32Array` of `ComponentId`s defining an archetype's
  exact component set. Pair IDs and per-relation presence IDs are ordinary members.
- **Archetype** = a table: one `ColumnSet` per component in the signature + a dense entity-row
  list. Identified by an `ArchetypeId` (dense `0..A-1`).
- **Row** = an entity's slot within one archetype, `0 <= row < archetype.count`.
- **Hot archetype** = column-backed (SoA). **Cold archetype** = stored in the shared overflow
  store (§10), no dedicated columns.
- **`K`** = number of components **shared** between two archetypes across an edge (the copy width
  of a migration).
- **Signature word** = one `u32` of a packed membership bit-vector; `stride = ceil(N/32)` where
  `N` = registered component-type count (the bitmask stride, memory-buffers.md §5.4).
- **Phase** = `'serial'` (main thread, between waves; structural mutation legal) or `'wave'`
  (workers executing; structural mutation illegal, staged to command buffers). `world.phase`.

---

## 3. The Archetype Table

### 3.1 Identity types

```ts
import type { EntityHandle } from '../entity';
import type { ComponentId, ArchetypeId, AccessorFactory } from '../type-system';
import type { Column, ColumnLayout, ColumnKey, Buffers } from '../memory-buffers';

/** Canonical, sorted, de-duplicated component IDs. Owned (never aliased) per archetype. */
export type Signature = Uint32Array & { readonly __ecsiaSignature: unique symbol };

/** Dense archetype index, 0..archetypeCount-1. Branded per type-system.md. */
// (ArchetypeId imported from type-system)

// OWNED HERE (this module is the normative definer of both constants; entity-model.md references them).
export const EMPTY_ARCHETYPE_ID = 0 as ArchetypeId;          // the empty-signature archetype: a REAL archetype, dense id 0
export const ARCHETYPE_NONE     = 0xffffffff as ArchetypeId; // record sentinel: "no archetype yet" (distinct from EMPTY_ARCHETYPE_ID)
```

### 3.2 Signature: canonical form, equality, hash

The signature is the **sorted ascending** array of component IDs (the report's "sorted
`Uint32Array` of component IDs (canonical signature) for fast equality/hash", §2.1). Sorting
makes two archetypes with the same set structurally identical regardless of add order, and makes
equality a linear word compare. Pair IDs (`relations` mints them as synthetic `ComponentId`s,
report §2.6) and per-relation presence IDs are ordinary members — **no special casing**, so
`query([Pair(ChildOf, parent)])` hashes naturally (report §2.4 "Hash must encode relation-pair
targets").

```ts
/** O(n) equality of two sorted signatures. */
function sigEquals(a: Signature, b: Signature): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** FNV-1a over the sorted IDs → 32-bit hash for the archetype lookup map. */
function sigHash(a: Signature): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
```

- **De-dup invariant SIG-1:** a signature contains each `ComponentId` at most once and is sorted
  ascending. Constructed only by `canonicalize(ids)` (§5.2), which sorts + de-dups.
- **Equality vs hash:** the archetype index is `Map<number, Archetype[]>` keyed by `sigHash`;
  hash collisions are resolved by `sigEquals` over the small bucket (§5.1). This avoids stringly
  hashing (rejecting bitECS's string-sort hash that "may collide if component IDs aren't globally
  unique", report §2.4 "What to avoid").

### 3.3 Membership bit-vector (per-archetype signature words)

For O(A) query matching (§8) each archetype caches its signature as packed words alongside the
sorted ID array. `sigWords` is `Uint32Array[stride]`, `stride = ceil(N/32)` where
`N = registry.registeredComponentCount` — the **single canonical fixed-component-id count**
(component-schema.md §7.4: `nextComponentId` after createWorld, including user components, reserved
ids, and one relation presence id each). The scheduler's `accessStrideWords` (scheduler.md §3.3) and
the bitmask `bmStride` (§6.1) derive from the **same** `N`, so all three layouts align. Bit for
`ComponentId c` is `sigWords[c >>> 5] & (1 << (c & 31))`.

```ts
/** Packed membership words for fast bitwise-AND query matching (report §2.4 archetype matching). */
function buildSigWords(sig: Signature, stride: number): Uint32Array {
  const w = new Uint32Array(stride);
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i];
    w[c >>> 5] |= 1 << (c & 31);
  }
  return w;
}
```

> Pair IDs occupy ordinary bit positions in `sigWords` only while they fit the fixed component
> stride. The **unbounded pair-ID space** does **not** widen this fixed stride; per-relation
> presence (one bit per relation *type*, report §2.6 / §6.4 mitigation 2) is what makes wildcard
> matching O(1) without enumerating pair IDs. Pair-ID-specific membership for *exact* pair
> queries is tested against the sorted `sig` array directly (binary search, §3.8), not the fixed
> `sigWords`. This is the report's "stride for ordinary components is fixed at world creation …
> growing only when new component types, not new pairs, are minted" (report §2.1).

### 3.4 The `Archetype` structure

```ts
export interface ColumnSet {
  /** Columns for ONE (archetype, component), one Column per schema field, field-index order. */
  readonly columns: readonly Column[];           // [] for tag components & cold archetypes
  /** The monomorphic accessor singleton for this (archetype, component) pair (§3.7). */
  readonly accessor: AccessorInstance;
  /** The component this set stores (a real ComponentId or a synthetic pair ComponentId). */
  readonly componentId: ComponentId;
}

export interface Archetype {
  readonly id: ArchetypeId;
  readonly signature: Signature;                 // sorted, owned
  readonly sigWords: Uint32Array;                // packed, length = stride
  readonly hash: number;                         // sigHash(signature), cached

  /** componentId -> its ColumnSet. Dense small Map; hot archetypes only. */
  readonly columnSets: Map<ComponentId, ColumnSet>;

  /** Dense entity-row list: rows[r] = the FULL EntityHandle occupying row r. */
  rows: Uint32Array;                             // length-tracking view over a 'rowlist' column
  count: number;                                 // live rows = [0, count)

  /** Lazy edge cache (§5). */
  readonly edges: Map<ComponentId, { add?: Archetype; remove?: Archetype }>;

  /** Per-archetype state for fragmentation policy (§10). */
  cold: boolean;                                 // true => entities live in the overflow store
  lastAccessTick: number;                        // for warm/cold heuristics (v2)
}
```

- `columnSets` holds one `ColumnSet` per component in the signature that has fields. Tag
  components and per-relation presence components contribute **no** `ColumnSet` (zero-field —
  presence is pure signature membership; report §2.2 "Tag components"; tag components have no
  column at all — memory-buffers.md §3.3). The empty archetype (`EMPTY_ARCHETYPE_ID`) has an empty
  `columnSets`.
- `rows` is itself a `u32` column (one per archetype, `ColumnKey = `${id}:__rowlist.0``) allocated
  through `Buffers.column` so it grows with the same length-tracking protocol as data columns
  (memory-buffers.md §7) — no separate growth code path.

### 3.5 The entity-row list stores FULL handles

`rows[r]` stores the **full `EntityHandle`** (index ⊕ generation), not a bare index, mirroring
the entity module's choice for `dense` (entity-model.md §3.1 adaptation note). Storing the full
handle lets `removeRow`'s shuffle-pop (§4.3) recover the moved sibling's `index` via
`handleIndex(movedHandle)` to fix its record word, with **no** dense/sparse lookup.

> **Borrow vs reject.** The dense entity-row list is the standard archetype-table component (the
> report's "iterate `0..archetype.count` with direct column access", §2.1). It is **not** becsy's
> pointer-chasing `entitylist.ts:55-119` (rejected, report §2.1 "What to avoid: no archetype
> grouping") — `rows` is a contiguous `Uint32Array`, and the data columns are parallel
> contiguous SoA, so iteration is cache-coherent.

### 3.6 Relation payload columns (exclusivity split — Must-Fix #4)

This module sees only `ComponentId`s; the exclusivity decision is made one level up (`relations`
spec). Concretely:

- **Exclusive relation payload** (`ChildOf` etc.): stored as an **ordinary `ColumnSet`** on the
  subject archetype — typically an `eid` target column plus any payload fields. Re-targeting is a
  field write (`accessor.write` of the `eid` column), **no migration**, no new archetype per
  parent (report §2.6 exclusive path, §6.4 mitigation 1, T1). This module does nothing special:
  the relation's `presenceId(R)` is an ordinary `ComponentId` in the signature, and — for an
  `exclusive-column` relation — it is **column-bearing** (the relations module mints it as a
  synthetic `ComponentDef` whose fields are the `eid` target + payload schema; relations.md §4.2),
  so `buildColumnSet` (§3.7) allocates its target/payload columns through the exact same path as
  any component. There is no separate "exclusive-column" ID — `presenceId(R)` carries the columns.
- **Non-exclusive relation payload**: the per-relation *presence* component ID is in the
  archetype signature (so queries stay archetype-driven), but the **payload rows are NOT entity
  rows of this archetype** — they live in a pair-keyed overflow `ColumnSet` owned by the
  `relations` module (memory-buffers.md §3.7). This module allocates that overflow `ColumnSet`
  through the ordinary `Buffers.column` path when asked, keyed by a synthetic overflow
  `ComponentId`, and never assumes its rows index live entities.

### 3.7 The per-`(archetype, component)` accessor singleton

Exactly **one** accessor instance per `(archetype, component)` pair (the locked "one hidden class
per (archetype, component)", report §2.3, decision #4). It is produced **once at archetype
creation** by invoking the component's `AccessorFactory<S>` (type-system.md) with this
archetype's column views:

```ts
type AccessorInstance = { __idx: number } & Record<string, unknown>;  // shape per type-system.md

function buildColumnSet(
  arch: Archetype, def: ComponentDef<any>, buffers: Buffers, initialCapacity: number,
): ColumnSet {
  const columns: Column[] = def.fields.map((f, fieldIndex) =>
    buffers.column(columnKey(arch.id, def.id, fieldIndex), f.layout, initialCapacity));
  // factory closes over per-field ColumnBindings: the length-tracking VIEW (survives .grow() — V-1)
  // PLUS byteOffset+element so the accessor's __rebind can reconstruct views on a FALLBACK grow
  // (type-system.md §9, I-ACC-2b / Must-Fix #5).
  const bindings = columns.map(c => ({
    view: c.view, byteOffset: c.view.byteOffset, element: c.layout.element,
  }));
  const accessor = def.accessorFactory(bindings) as AccessorInstance;
  // register for the FALLBACK grow path only (no-op on the primary resizable path):
  for (const c of columns) buffers.registerAccessor(c.key, accessorViewHolder(accessor, c));
  return { columns, accessor, componentId: def.id };
}
```

- The factory receives `columns.map(c => c.view)` — **length-tracking views** (memory-buffers.md
  V-1), so the closure survives `.grow()` with no regeneration on the primary path (Must-Fix #5).
- `registerAccessor` wires the singleton into the `Buffers` fallback registry so that on a
  non-resizable-backing grow, `__rebind` re-points the captured views (memory-buffers.md §7.5).
  On the primary path this set is **never walked** (memory-buffers.md R-1).
- The singleton is reused across all rows of the archetype: the entity layer's `EntityRef.write`
  pokes `accessor.__idx = row` and returns it (entity-model.md §6.4; type-system.md I-ACC-1).
  Zero allocation per access (report §2.3 "Shared-per-type accessor singleton").

### 3.8 Exact-pair membership test

For an exact pair query (`Pair(ChildOf, parent)` with a concrete target), the pair's synthetic
`ComponentId` may exceed the fixed `sigWords` stride. Membership is then tested by **binary search
of the sorted `signature` array** (O(log |sig|)):

```ts
function sigHas(sig: Signature, c: ComponentId): boolean {
  let lo = 0, hi = sig.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, v = sig[mid];
    if (v === c) return true;
    if (v < c) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}
```

For ordinary components (within stride), `sigWords` is preferred (O(1)); the query module picks
the test per term (§8).

---

## 4. Row allocation & removal (the swap-pop primitive)

The entity module calls these during `spawn`/`despawn`/`migrate` (entity-model.md §6.2, §6.3,
§4.2). All run **serial / main-thread** (`assert(world.phase === 'serial')`).

### 4.1 Row list capacity

`rows` and every data column share `archetype.count` as their live length and grow together
(report §2.1 "all columns grow together"). `capacityRows(arch)` = `min` of `rows.capacity()` and
every column's `capacity()`; in practice all are grown to the same target by `ensureRowCapacity`.

```
ensureRowCapacity(arch, need):                  // serial-phase only
  if need <= capacityRows(arch): return
  target := need rounded up by doubling          // memory-buffers.md §7.7 nextCapacity
  buffers.grow(arch.rowsColumn, target)          // rows list
  for cs in arch.columnSets.values():
    for col in cs.columns: buffers.grow(col, target)
  // ALSO grows reactivity's hidden changeVersion column when present (registered under this
  // archetype's keys via buildColumnSet — §5.3.1; world.md §9.8 W-9: grown in lockstep, NOT either/or):
  if reactivity.changeVersion[arch.id] present: buffers.grow(reactivity.changeVersionColumn[arch.id], target)
  // primary path: views auto-widen, accessor closures unaffected (memory-buffers.md §7.2)
```

Growth is O(columns) `grow` calls, each O(1) on the primary resizable-SAB path (a JS-visible copy
only on the fallback path). Doubling ⇒ O(log capacity) total grows over a lifetime.

### 4.2 `allocRow`

```
allocRow(arch, handle) -> row:                   // serial-phase only
  ensureRowCapacity(arch, arch.count + 1)
  row := arch.count
  arch.rows[row] := handle                        // store FULL handle (§3.5)
  arch.count := arch.count + 1
  arch.lastAccessTick := world.tick
  return row
  // NOTE: column field VALUES are written by the caller (spawn -> component init, or migrate
  //       -> column copy). allocRow only reserves the slot and records the occupant.
```

- Complexity: O(1) amortized (amortized over the doubling grow).
- `allocRow` does **not** touch the entity record; the caller (`spawn`/`migrate`) commits the
  record via `commitRecord` after column data is in place (entity-model.md §4.2 INVARIANT C1).

### 4.3 `removeRow` (swap-pop)

Removes `row` by moving the last live row into its place (dense compaction), then fixes the moved
entity's record `row` word via the caller's callback. This is the report's "shuffle-pop the
vacated source row (updating the moved entity's `archetypeRow`)" (§2.1) and miniplex's
"shuffle-pop removal keeps arrays dense" technique (`Bucket.ts:125-148`) **applied to SoA columns**
(miniplex's own bucket model is JS-object and rejected for storage; only the swap-pop idea is
borrowed).

```
removeRow(arch, row, fixSibling: (movedIndex, newRow) => void) -> void:   // serial-phase only
  last := arch.count - 1
  if row !== last:
    # 1. move the last row's column values down into `row`, per column (O(shared columns)):
    for cs in arch.columnSets.values():
      for col in cs.columns:
        copyRowWithinColumn(col, /*from*/ last, /*to*/ row)     # §4.4
    # 2. move the last row's handle down and fix its record:
    movedHandle := arch.rows[last]
    arch.rows[row] := movedHandle
    movedIndex := handleIndex(movedHandle)
    fixSibling(movedIndex, row)                  # caller writes recordArchetypeRow[movedIndex] = row
  arch.count := last
  # row `last` is now logically free; its stale column bytes are overwritten on the next allocRow.
```

- **Cost: O(number of columns) element copies** — i.e. O(shared columns), the locked
  "swap-pop row removal (cost O(shared columns))". Independent of `arch.count`. No reactivity
  here; removal reactivity is enqueued by the caller (`despawn`/`migrate`) before invoking
  `removeRow` so the dying values are still readable (entity-model.md §6.3 ordering).
- **`fixSibling` is the only record write `removeRow` causes** (the at-most-one moved sibling).
  When `row === last` (removing the tail) there is no moved sibling and `fixSibling` is not
  called — satisfies entity-model.md INVARIANT I6 ("at-most-one shuffle-popped sibling").
- **Edge case — `count === 0`**: `removeRow` is never called on an empty archetype (caller holds
  a valid row). Dev assertion guards it.

### 4.4 `copyRowWithinColumn` and `copyRowAcrossColumns`

```ts
/** Copy one row's `stride` elements from srcRow to dstRow within the SAME column. */
function copyRowWithinColumn(col: Column, srcRow: number, dstRow: number): void {
  const s = col.layout.stride;
  const v = col.view;
  v.copyWithin(dstRow * s, srcRow * s, srcRow * s + s);   // O(stride), no alloc
}

/** Copy one row from a source column to a (same-layout) destination column (cross-archetype). */
function copyRowAcrossColumns(src: Column, srcRow: number, dst: Column, dstRow: number): void {
  const s = src.layout.stride;                            // layouts are identical for shared comps
  dst.view.set(src.view.subarray(srcRow * s, srcRow * s + s), dstRow * s);  // O(stride)
}
```

`copyWithin`/`set` are the engine's bulk-copy intrinsics; both are O(stride) and allocation-free.
Shared components between two archetypes have **identical `ColumnLayout`** (same component ⇒ same
field schema), so `copyRowAcrossColumns` is a straight `set` with no conversion.

---

## 5. The edge graph & migration

### 5.1 Archetype index (lookup-or-create)

```ts
interface ArchetypeStore {
  byId: Archetype[];                              // dense, index = ArchetypeId
  byHash: Map<number, Archetype[]>;               // sigHash -> collision bucket
  hotCount: number;                               // number of hot (column-backed) archetypes
  readonly maxHotArchetypes: number;              // createWorld option (§10)
  readonly cold: ColdStore;                       // §10
}

function getOrCreateArchetype(store: ArchetypeStore, sig: Signature): Archetype {
  const h = sigHash(sig);
  const bucket = store.byHash.get(h);
  if (bucket) for (const a of bucket) if (sigEquals(a.signature, sig)) return a;  // existing
  return createArchetype(store, sig, h);          // §5.3
}
```

- Lookup is O(bucket size) `sigEquals`, effectively O(1) (hash collisions are rare with FNV-1a
  over u32 IDs). Existing archetypes are **never** recreated (signatures are interned).

### 5.2 Canonicalization

```ts
function canonicalize(ids: Iterable<ComponentId>): Signature {
  const arr = Uint32Array.from(new Set(ids));     // de-dup
  arr.sort();                                      // ascending; Uint32Array.sort is numeric
  return arr as Signature;                         // SIG-1 holds
}

/** Derive a target signature for add/remove without rebuilding from scratch. */
function sigWithAdded(sig: Signature, c: ComponentId): Signature;     // insert c in sorted order
function sigWithRemoved(sig: Signature, c: ComponentId): Signature;   // delete c, keep sorted
```

`sigWithAdded`/`sigWithRemoved` produce the neighbor signature in O(|sig|) by copy-with-splice
(binary-search the insertion/deletion point). They are used only on an **edge miss** (§5.3).

### 5.3 Archetype creation & cap

```
createArchetype(store, sig, hash) -> Archetype:  // serial-phase only
  id := store.byId.length as ArchetypeId
  isCold := store.hotCount >= store.maxHotArchetypes        // §10 fragmentation cap
  arch := {
    id, signature: sig, hash,
    sigWords: buildSigWords(sig, store.stride),
    columnSets: new Map(), edges: new Map(),
    rows: <empty>, count: 0, cold: isCold, lastAccessTick: world.tick,
  }
  if isCold:
    store.cold.attach(arch)                                 # entities go to overflow store (§10)
  else:
    arch.rowsColumn := buffers.column(rowsKey(id), U32_LAYOUT, INITIAL_ROWS)
    arch.rows := arch.rowsColumn.view
    for each componentId c in sig WITH fields:
      arch.columnSets.set(c, buildColumnSet(arch, defOf(c), buffers, INITIAL_ROWS))  # §3.7
    store.hotCount += 1
  store.byId.push(arch)
  bucketPush(store.byHash, hash, arch)
  emit('archetypeCreated', arch)                            # query module tests it against all queries (§8);
                                                            # reactivity module attaches its changeVersion
                                                            # column here if stamping is enabled (§5.3.1)
  return arch
```

#### 5.3.1 Reactivity `changeVersion` column registration hook (resolves Q-A4)

`changeVersion` is **per-row, per-archetype, lazily allocated** (reactivity.md §6.1, Q-A4
resolved to *per-row*). The storage module does not own it, but it owns the **hook** through which
reactivity attaches it. On `archetypeCreated`, the reactivity module — if `stampingEnabled` (i.e.
at least one `.changed` predicate or a delta serializer is registered) — registers one extra `u32`
column on the new (hot) archetype through the **same `Buffers.column` path** `buildColumnSet` uses:

```
onArchetypeCreated_reactivity(arch):                       # reactivity module's archetypeCreated listener
  if not world.reactivity.stampingEnabled: return          # zero cost when no .changed consumer (§6.1 lean)
  if arch.cold: return                                     # cold rows stamped via cold-store path
  key := columnKey(arch.id, CHANGEVERSION_COMPONENT_ID, 0) # synthetic reserved component id for changeVersion
  col := buffers.column(key, U32_LAYOUT, capacityRows(arch))
  world.reactivity.changeVersion[arch.id] := col.view       # length-tracking view; widens on grow (V-1)
```

- The column is allocated through `Buffers.column` so it inherits length-tracking growth (V-1)
  and grows in lockstep with the archetype's data columns. **`ensureRowCapacity` (§4.1) grows ALL
  columns registered for the archetype, INCLUDING the `changeVersion` column** — this is the
  canonical path, **not** an either/or (world.md §9.8, W-9): reactivity registers `changeVersion`
  via `buildColumnSet` (keyed on `CHANGEVERSION_COMPONENT_ID`) as a hidden, non-query-matching
  column on each hot archetype at creation, so it lives in the archetype's column set and the
  `ensureRowCapacity` growth loop reaches it in lockstep with the data columns. A row written past
  its `changeVersion` capacity is a bug; this path prevents it. Serial-phase, same `Buffers.grow`
  protocol as every other column.
- The column is **not** part of any component's signature and is invisible to query matching; it
  is addressed by row exactly like a data column.

- `emit('archetypeCreated', arch)` is the query module's hook: it AND-tests the new archetype's
  `sigWords` against each registered query once and appends to matching `matchingArchetypes`
  (§8, report §2.4 "When an archetype is created … test its signature once").
- Lazy: only signatures that actually occur get an archetype (report T4 "Allocate archetype
  column SABs lazily on first archetype creation").

### 5.4 The edge graph (lazy transition cache)

Each archetype caches, per `ComponentId`, the neighbor reached by adding or removing that
component. This is the locked "lazy edge-graph migration cache (add/remove component → target
archetype, O(1) after first)" and the becsy gap (`registry.ts:399-423` "just flips bits", no
neighbor cache).

```
edgeAdd(arch, c) -> Archetype:                   // serial-phase only
  e := arch.edges.get(c)
  if e && e.add: return e.add                     # O(1) cache hit (the common case)
  # miss: compute neighbor signature, intern archetype, cache BOTH directions:
  targetSig := sigWithAdded(arch.signature, c)    # §5.2, O(|sig|)
  target    := getOrCreateArchetype(store, targetSig)
  setEdge(arch,   c, 'add',    target)
  setEdge(target, c, 'remove', arch)              # reverse edge primed for free
  return target

edgeRemove(arch, c) -> Archetype:                # symmetric, sigWithRemoved
```

- **Complexity: O(1) on a cache hit** (a `Map.get`), O(|sig| + archetype-create) on the first
  miss for a given `(arch, c)`. Both directions are cached on a miss, so the reverse transition is
  also primed (re-adding then removing a component is O(1) each after the first round-trip).
- `arch.edges` is a small `Map<ComponentId, {add?, remove?}>` — one entry per distinct component
  ever added/removed at this archetype. Memory is bounded by actual transition diversity, not by
  the global component count.
- **Idempotent add/remove:** `edgeAdd(arch, c)` where `sigHas(arch.signature, c)` already holds
  returns `arch` itself (the entity already has `c`; the entity module treats this as a no-op and
  skips migration). Symmetric for remove of an absent component.

### 5.5 Migration algorithm

`migrate` moves one entity from `fromArch` to `toArch`. It is invoked by the entity module's
component add/remove path and by `spawnWith` (entity-model.md §6.1). The two-word commit is the
entity module's `commitRecord`; this module performs the column work and the source shuffle-pop.

```
migrate(handle, fromArch, toArch) -> newRow:     // serial-phase only; entity-model.md §4.2
  index   := handleIndex(handle)
  oldRow  := recordArchetypeRow[index]            # current row in fromArch (read via record)
  # ---- 1. reserve destination slot (non-observable until commit) ----
  newRow  := allocRow(toArch, handle)             # §4.2
  # ---- 2. copy shared columns fromArch[oldRow] -> toArch[newRow] (O(K)) ----
  for (c, dstCS) in toArch.columnSets:
    srcCS := fromArch.columnSets.get(c)
    if srcCS:                                      # shared component -> copy
      for fieldIdx in 0..dstCS.columns.length-1:
        copyRowAcrossColumns(srcCS.columns[fieldIdx], oldRow,
                             dstCS.columns[fieldIdx], newRow)     # §4.4
    else:                                          # added component -> initialize
      initColumnRow(dstCS, newRow, defOf(c))       # §5.7 (defaults / spawnWith values)
  # ---- 3. enqueue removal reactivity for components in fromArch \ toArch (DEFERRED) ----
  for (c, srcCS) in fromArch.columnSets:
    if not toArch.columnSets.has(c):
      enqueueRemoveLog(handle, c)                  # writeLog/shapeLog; observers fire at serial slot (report §2.7)
  # ---- 4. shuffle-pop the vacated source row, fixing the moved sibling's record ----
  removeRow(fromArch, oldRow, (movedIndex, newSrcRow) => {
    commitRecordRow(movedIndex, newSrcRow)         # writes recordArchetypeRow[movedIndex] (entity-model.md)
  })
  # ---- 5. THE COMMIT (entity-model.md §4.2: row word then id word) ----
  commitRecord(index, toArch.id, newRow)           # two stores: recordArchetypeRow then recordArchetypeId
  # ---- 6. bitmask membership update (serial, main-thread; §6) ----
  bitmaskApplyDelta(index, fromArch.signature, toArch.signature)   # set added bits, clear removed bits
  return newRow
```

- **Copy cost: O(K)** shared-column field copies (`K` = shared component count, each O(stride)),
  plus O(added components) inits, plus the source `removeRow` which is O(columns of `fromArch`).
  This is the locked "migration cost proportional to shared column count K" (report T1).
- **Ordering is load-bearing:** removal reactivity is enqueued (step 3) **before** the source row
  is overwritten (step 4) so the dying component values are still readable by `onRemove` observers
  (report §2.7 "recently-deleted data visible"); the record commit (step 5) is the **only**
  observable transition (entity-model.md INVARIANT C1); the bitmask delta (step 6) is last and is
  main-thread-only (§6). Workers never run this (Must-Fix #1).
- **Reuse of edges:** the caller obtained `toArch` via `edgeAdd`/`edgeRemove` (§5.4), so the
  second-and-later add/remove of a given component on a given archetype skips signature
  recomputation and archetype lookup entirely (O(1) to find `toArch`).

### 5.6 `spawnWith` single-migration fast path

`world.spawnWith(...defs)` (entity-model.md §6.1) must produce **one** migration, not N.
**Ownership boundary:** entity-model.md §6.1 owns the *public* `world.spawnWith` signature and
mints the handle (via `spawn` into `EMPTY_ARCHETYPE_ID`); it then delegates to this module's
`storage.spawnWith(handle, defs)`, which owns the *implementation* (target-signature computation
+ single `migrate`). The two specs describe two halves of one call, not two competing owners.
This module computes the target signature up front and migrates once:

```
spawnWith(handle, defs):                          # called by entity-model spawnWith
  targetSig := canonicalize([ ...defs.map(d => d.id) ])
  toArch    := getOrCreateArchetype(store, targetSig)
  # entity is currently in EMPTY_ARCHETYPE_ID (allocated by spawn); single migrate:
  migrate(handle, store.byId[EMPTY_ARCHETYPE_ID], toArch)
  # initColumnRow for each def applies the caller-provided initial values (§5.7)
```

This addresses report T1 churn ("spawning into empty then migrating once per added component
would cause N migrations").

### 5.6a `migrateAddingMany` / `migrateRemovingMany` (multi-ID atomic migration — REQUIRED)

The relations module calls `storage.migrateAddingMany(subject, addIds)` and
`storage.migrateRemovingMany(subject, removeIds)` (relations.md §5.2/§5.5) to add or remove a
**pair ID and a per-relation presence ID together in one migration**. Storage **MUST** provide
both (world.md §9.7, W-1; relations atomicity P1). These are **required core
primitives**, not optional optimizations: relations' Invariant P1 (presence bit present *iff* a
pair is held) depends on the pair ID and the presence ID landing in the **same** target archetype
atomically — two sequential single-ID migrations would pass through an intermediate archetype that
carries the pair but not the presence (or vice-versa), violating P1 (relations.md §5.3). Although
the violation is unobservable while serial, the combined primitive also avoids a transient
archetype (less fragmentation churn), so it is specified as the canonical path.

```
migrateAddingMany(handle, addIds[]) -> newRow:    // serial-phase only
  fromArch  := store.byId[recordArchetypeId[handleIndex(handle)]]
  # de-dup against the current signature (idempotent adds are skipped):
  effective := addIds.filter(c => not sigHas(fromArch.signature, c))
  if effective.length === 0: return recordArchetypeRow[handleIndex(handle)]   // no-op
  # ONE target signature computed by applying ALL additions at once:
  targetSig := canonicalize([ ...fromArch.signature, ...effective ])           // §5.2
  toArch    := getOrCreateArchetype(store, targetSig)                          // §5.1, one lookup/create
  return migrate(handle, fromArch, toArch)                                     // §5.5, a single migration

migrateRemovingMany(handle, removeIds[]) -> newRow:   // symmetric
  fromArch  := store.byId[recordArchetypeId[handleIndex(handle)]]
  effective := removeIds.filter(c => sigHas(fromArch.signature, c))
  if effective.length === 0: return recordArchetypeRow[handleIndex(handle)]
  targetSig := canonicalize(fromArch.signature without effective)              // multi-remove at once
  toArch    := getOrCreateArchetype(store, targetSig)
  return migrate(handle, fromArch, toArch)
```

- **Edge-graph interaction:** the multi-ID transition is keyed in the edge cache by the *sorted
  set of added/removed IDs*, not a single component, so the second-and-later
  `migrateAddingMany(subject, [pairId, presenceId])` over the same `(fromArch, idSet)` is an O(1)
  cache hit. The single-ID `edgeAdd`/`edgeRemove` (§5.4) remains the fast path for ordinary
  one-component add/remove; `migrateAddingMany` uses `getOrCreateArchetype` directly (one
  `canonicalize` + one lookup) and MAY additionally cache the multi-ID edge under a composite key
  (v1 may skip the multi-ID edge cache — the `canonicalize`+lookup miss cost is O(|sig|), bounded).
- **Atomicity:** exactly **one** `migrate` (hence one `commitRecord`, one `bitmaskApplyDelta`, one
  shape-log delta set) — satisfying relations P1 and INVARIANT C1 with no intermediate archetype.
- **Single-ID forms** `migrateAdding(handle, c)` / `migrateRemoving(handle, c)` are the
  one-element specializations (used by `entity.add(C)`/`entity.remove(C)`) and route through
  `edgeAdd`/`edgeRemove` (§5.4) for the cached O(1) transition.

### 5.7 Column row initialization

```
initColumnRow(cs, row, def):
  for fieldIdx, field in def.fields:
    col := cs.columns[fieldIdx]
    writeDefault(col, row, field)                 # field.encode(default) or eid -> -1 (memory-buffers.md C-2)
```

`eid` fields default to `-1` (null sentinel, memory-buffers.md §3.4 C-2); numeric fields default
to `0` (already zero from the column's zero-init) unless the schema declares a non-zero default;
`staticString` defaults to choice index 0; `spawnWith` overrides with caller values.

---

## 6. The per-entity bitmask membership index (main-thread / serial-only)

### 6.1 Role & layout

The bitmask is the **single-entity membership index** — the report's becsy `ShapeArray`
(`shapearray.ts:21-108`) used **only** for (a) `entity.has(C)` O(1) point checks and (b) re-testing
a *single* migrated entity against the queries that reference the changed component (incremental
query maintenance). It is **NOT** the query-iteration path (that is per-archetype, §8). This is
the locked refinement (report §1, §2.4 "Correction — what the bitmask is for").

Layout (memory-buffers.md §5.4 `bitmask.words` region):

```
bitmask.words : Uint32Array, length = capacity * stride
  stride = ceil(N / 32)              # N = registered component-type count, fixed at world creation
  bit for (entity index i, componentId c):
      word   = bitmask.words[i * stride + (c >>> 5)]
      mask   = 1 << (c & 31)
      member = (word & mask) !== 0
```

- Addressed by **entity index** (low bits of the handle), like the entity record — not by dense
  position. Stable across swap-pop.
- `stride` is fixed from the registered component-type count and grows only when new component
  **types** are minted (rare, serial) — **not** when new relation pairs are minted. Pair-ID
  membership beyond the fixed stride uses a **separate lazily-grown sparse pair-bit vector** owned
  by this module's bitmask submodule (report §2.1, §6.4): a `Map<index, Uint32Array>` or a
  sparse region grown via `region(..., {fixed:false})`. Wildcard relation queries do **not**
  consult it — they use the per-relation presence bit (§3.3, report §6.4 mitigation 2).

### 6.2 Main-thread-only enforcement (Must-Fix #1 / T2)

> **Invariant BM-1 (main-thread/serial-only).** Every read and write of `bitmask.words` (and the
> sparse pair-bit vector) asserts `world.phase === 'serial'`. No worker, during a wave, reads or
> writes the bitmask. Liveness and worker membership facts come from the archetype signature
> (§9.4), never the bitmask.

```ts
function bitmaskHas(index: number, c: ComponentId): boolean {
  assert(world.phase === 'serial', 'bitmask is main-thread/serial-only (Must-Fix #1)');
  if (c >= bmFixedBitCount) return sparsePairBitHas(index, c);   // pair beyond fixed stride
  return (bmWords[index * bmStride + (c >>> 5)] & (1 << (c & 31))) !== 0;
}
```

- Because all structural mutation is serial (command buffers applied between waves, report §6.1)
  and the bitmask is only mutated by `bitmaskApplyDelta` during a serial migration (§5.5 step 6),
  the bitmask **never needs atomics** (plain `|=` / `&= ~`). This is the load-bearing T2 decision:
  *the bitmask is a main-thread index over a structure only the main thread mutates*. No
  `Atomics.or/and` (rejecting becsy's `AtomicSharedShapeArray`, `shapearray.ts:112-204`, as
  unnecessary under serial mutation).

### 6.3 `bitmaskApplyDelta` (coherence with the table)

Called by `migrate` (§5.5 step 6), by `spawn` (sets nothing — empty signature), and by `despawn`
(clears all bits — §6.5).

```
bitmaskApplyDelta(index, fromSig, toSig):        # serial-phase only
  base := index * bmStride
  # set bits present in toSig (added components):
  for c in toSig: if c < bmFixedBitCount: bmWords[base + (c>>>5)] |=  (1 << (c & 31))
                  else: sparsePairBitSet(index, c)
  # clear bits present in fromSig but absent in toSig (removed components):
  for c in fromSig: if not sigHas(toSig, c):
                      if c < bmFixedBitCount: bmWords[base + (c>>>5)] &= ~(1 << (c & 31))
                      else: sparsePairBitClear(index, c)
```

- For the common single-add / single-remove migration the loops touch one bit each; a full
  `spawnWith` sets |toSig| bits. Complexity O(|fromSig| + |toSig|).
- Coherence is **one-way**: the bitmask is derived from the signatures the migration already
  committed; it is never the source of truth for location (the record is) or liveness (the
  dense/sparse generation check is, entity-model.md §3.3). A test asserts `bitmaskHas(i, c) ===
  sigHas(currentSignature(i), c)` after every structural op (§11 BM coherence test).

### 6.4 `has` point check (public, main-thread)

```ts
// world.entity(h).has(Component) -> boolean ; or world.has(h, Component)
function has(h: EntityHandle, def: ComponentDef<any>): boolean {
  assert(world.phase === 'serial');
  if (!isAlive(h)) return false;                  // entity-model.md §3.3 (no bitmask read)
  return bitmaskHas(handleIndex(h), def.id);
}
```

- O(1): one liveness check (≤2 loads + compare) + one word load + mask. Matches the report's
  "O(1) `entity.has(C)` (one word load + mask)" (§1).
- **Alternative without the bitmask:** `has` could equivalently test `sigHas(currentSignature(i),
  def.id)` (binary search, O(log |sig|)) — the bitmask is the O(1) constant-time path and the
  substrate the single-entity incremental matcher (§6.6) needs.

### 6.5 `despawn` bitmask clear

On `despawn`, after row removal and removal reactivity, before identity invalidation
(entity-model.md §6.3 ordering), this module clears the entity's bitmask:

```
bitmaskClear(index):                             # serial-phase only
  base := index * bmStride
  for w in 0..bmStride-1: bmWords[base + w] := 0
  sparsePairBitClearAll(index)                   # if the entity held any out-of-stride pair bits
```

O(stride) — small and fixed.

### 6.6 Single-entity incremental query matcher (the bitmask's second job)

After a single entity migrates, only the queries that *reference a changed component* need
re-testing **for that one entity** (report §2.4 "incremental maintenance only"). This module
exposes the entity's shape words to the query module's `matchEntity` (report §2.4 pseudocode):

```ts
/** Read the fixed-stride shape words for one entity (for the query module's single-entity matcher). */
function entityShapeWords(index: number): Uint32Array {
  assert(world.phase === 'serial');
  return bmWords.subarray(index * bmStride, index * bmStride + bmStride);  // zero-copy view
}
```

The query module's `matchEntity(shape, q)` (report §2.4) ANDs these words against the query's
`withWords`/`notWords`/`orWords`. This is the **only** per-entity AND loop in ecsia, and it runs
**only** on the single migrated entity, serial-phase — not over all entities, not for iteration.
Pair-bit terms beyond the fixed stride are tested against the migrated entity's signature
directly (the query module has the signature; §8).

---

## 7. Coherence model (one-way, serial)

The two representations (bitmask + table) stay coherent by a **one-way, serial** discipline,
resolving report T2:

1. **The record is the location truth** (entity-model.md INVARIANT C1). Both representations are
   derived from the committed record + signature.
2. **The signature is the membership truth.** The bitmask is a *derived index* refreshed by
   `bitmaskApplyDelta` immediately after each serial migration commit. It is never read to *find*
   an entity's location or to drive iteration.
3. **All mutation is serial.** `migrate`, `allocRow`, `removeRow`, `bitmaskApplyDelta`,
   `bitmaskClear` assert `world.phase === 'serial'`. Workers stage structural intents to command
   buffers (report §6.1); the main thread applies them between waves, running this exact serial
   path once per intent in deterministic merge order.
4. **No atomics on the storage hot path.** Column reads/writes during a wave are plain TypedArray
   accesses over SABs (disjoint per the scheduler's read/write declarations); the record commit is
   plain stores (entity-model.md §4.2); the bitmask is plain `|=`/`&=`. The scheduler's wave fence
   is the synchronization (report §4 T2/T3).

> **Invariant CO-1 (no mid-wave structural mutation).** During `world.phase === 'wave'`, no
> archetype `count`, `rows`, column view content's *structure* (only disjoint value writes per
> scheduler), entity record, or bitmask word is mutated by storage. Enforced by the phase
> assertions above + the command-buffer model (report §6.1). This is what lets workers read
> columns and the record without atomics.

---

## 8. Query matching surface (what queries consume from this module)

This module does not own queries, but it owns the primitives query matching runs on. The
**iteration path is per-archetype** (O(A)), per the locked decision and report correction (§2.4):

- On `archetypeCreated` (§5.3), the query module tests `arch.sigWords` against each query's
  `withWords`/`notWords`/`orWords` (one bitwise AND per signature word) and, on match, appends
  `arch` to that query's `matchingArchetypes`. Cost: O(A · words) total, amortized at archetype
  creation, **not per entity**.
- Iteration walks `query.matchingArchetypes`, then `0..arch.count` per archetype, reading columns
  directly through the per-`(archetype, component)` accessor (§3.7). No pointer chasing
  (rejecting becsy `entitylist.ts:55-119`, report §2.1).
- **Exact-pair terms** (pair ID beyond the fixed stride) are matched with `sigHas` binary search
  (§3.8); **wildcard relation terms** use the per-relation presence bit within `sigWords` (O(1),
  report §6.4 mitigation 2).
- **Cold archetypes** are matched identically (their `sigWords` are built the same way, §5.3) and
  iterated through the overflow store (§10.3) — transparently to the query API (report §6.4).

Signature-AND helper (the query module calls this, exposed for testing):

```ts
function signatureMatches(sigWords: Uint32Array, withW: Word[], notW: Word[], orW: Word[]): boolean {
  for (const t of notW)  if ((sigWords[t.wordIndex] & t.mask) !== 0)      return false;
  for (const t of withW) if ((sigWords[t.wordIndex] & t.mask) !== t.mask) return false;
  for (const c of orW)   if ((sigWords[c.wordIndex] & c.mask) === 0)      return false;
  return true;
}
```

---

## 9. Concurrency, memory ordering & worker policy

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `allocRow` / `removeRow` / `ensureRowCapacity` | Main only | Serial | None (single-writer). |
| `migrate` / `bitmaskApplyDelta` / `bitmaskClear` | Main only | Serial | Plain stores; ordered per §5.5. |
| `getOrCreateArchetype` / `createArchetype` / edge ops | Main only | Serial | None; archetype set mutated serially. |
| Column **value** read | Main or worker | Any | Plain TypedArray load over SAB; widening-safe (memory-buffers.md §7.2). |
| Column **value** write | Worker (disjoint per scheduler) or main | Wave (disjoint) / Serial | Plain store; disjointness from scheduler declarations (report T5). |
| `bitmaskHas` / `has` / `entityShapeWords` | Main only | Serial | Plain loads; **BM-1**. |
| `signatureMatches` (query match) | Main only | Serial (at archetypeCreated / query run) | Plain loads over immutable `sigWords`. |

### 9.4 Worker membership policy (Must-Fix #1)

A worker mid-wave never reads the bitmask. It establishes membership facts from the **archetype
signature it is already iterating** (report §4 T2): every entity in `arch.rows[0..count)` is alive
(rows hold only live handles, §3.5) and carries exactly the signature's components. A worker that
needs `has(C)` for an entity *outside* its current archetype defers — it cannot answer mid-wave;
such logic must run in a serial system or be expressed as a query term. This is enforced
structurally: the bitmask read API is not present in the worker-side storage surface.

---

## 10. Archetype fragmentation & the cold-archetype fallback (report §6.4)

### 10.1 The blow-up

Pairs as archetype members make an entity's signature include every distinct pair it holds. A
scene graph of `N` entities each `ChildOf` one of `P` distinct parents produces **up to `P`
archetypes** (one per parent), each tiny — column overhead dominates, iteration loses
cache-coherence, and edge-graph/query-matching costs grow with `A` (report §6.4 quantified
blow-up).

### 10.2 Mitigations in order

1. **Exclusive relations store the target as an `eid` payload** (§3.6, report §6.4 mitigation 1):
   `ChildOf` is exclusive, so all children share **one** archetype carrying the `ChildOf`-presence
   component + an `eid` target column; re-parenting is a field write, **no new archetype per
   parent**. This eliminates the scene-graph blow-up for the common (exclusive) case. The blow-up
   survives only for genuinely non-exclusive multi-target relations.
2. **Per-relation presence bit for wildcard queries** (§3.3): keeps `Pair(R, Wildcard)` O(1) per
   archetype regardless of pair-ID diversity, so fragmentation does not also degrade wildcard
   matching.
3. **Cold-archetype overflow store** (below) for residual non-exclusive blow-up.

### 10.3 The cold-archetype overflow store

`createArchetype` (§5.3) marks an archetype **cold** when `hotCount >= maxHotArchetypes`
(`createWorld` option, default sized from `maxEntities`). Cold archetypes have **no dedicated
columns**; their entities live in a single shared SoA block keyed by `(entityIndex, componentId) →
value`, in spirit becsy's `compact` singleton storage (`component.ts:423-485`, report §6.4):

```ts
interface ColdStore {
  /** componentId -> a packed SoA block (one ColumnSet per component type, NOT per archetype). */
  blocks: Map<ComponentId, ColumnSet>;            // allocated lazily via Buffers.column
  /** (entityIndex, componentId) -> row in that component's block. */
  rowOf: Map<number, number>;                     // key = (entityIndex * N + componentId)
  /** entityIndex -> its cold archetype id (so resolveLocation still yields an ArchetypeId). */
  archOf: Map<number, ArchetypeId>;
}
```

- **Membership** of cold entities still uses the per-entity bitmask (§6) and the entity's signature
  — so `has`, the single-entity matcher, and query *matching* work identically (report §6.4 "Cold
  entities still carry the per-entity bitmask").
- **Query iteration** for a cold archetype: the query matched the cold archetype's `sigWords` (§8);
  iteration over it reads from `cold.blocks` filtered by the cold archetype's signature, yielding
  the same `EntityRef` sequence as a hot archetype — **the query API is unchanged**, only
  throughput differs (report §6.4 "Query semantics for cold entities").
- **Record:** a cold entity's two record words store its cold `ArchetypeId` and a row that indexes
  the cold store's per-component blocks via `cold.rowOf` (not a contiguous archetype row). The
  accessor for a cold archetype resolves the value through `cold.rowOf`, not a direct column index.

### 10.4 Promotion / demotion

- v1 ships **explicit promotion only**: `world.warm(signature)` promotes a cold archetype to hot
  at a serial flush point — allocate its columns, migrate its entities out of the overflow store
  into contiguous rows, flip `cold = false`, `hotCount += 1` (report §6.4 "v1 ships promotion only
  on explicit `world.warm(sig)`").
- Automatic frequency-driven promotion (using `lastAccessTick`) and cap-pressure demotion are a v2
  heuristic (report §6.4, Q-A1 follow-up). The fields (`lastAccessTick`, `cold`) are present in v1
  so v2 needs no layout change.

### 10.5 Resolution of Q-A1

The cap is `maxHotArchetypes` (default from `maxEntities`); cold overflow goes to the shared
hash-backed `ColdStore` with transparent query semantics (§10.3). This is the report's §6.4
resolution, not the earlier "consider a hash-based fallback" non-answer.

---

## 11. Invariants (testable)

- **SIG-1.** Every `Signature` is sorted ascending and de-duplicated (constructed only via
  `canonicalize`). Test: random ID multisets → `canonicalize` → assert sorted + unique.
- **AR-1.** `getOrCreateArchetype(sig)` returns the **same** `Archetype` object for two
  structurally-equal signatures regardless of construction order. (signature interning)
- **EDGE-1.** `edgeAdd(arch, c)` is O(1) (a `Map.get`) on the second and later call for the same
  `(arch, c)`; the first call caches both `add` (on `arch`) and the reverse `remove` (on target).
- **ROW-1.** After `removeRow(arch, row, fix)`, `arch.count` decremented by 1, the row list and
  every column remain dense over `[0, count)`, and `fix` was called **exactly once** iff
  `row !== count-1` (the moved sibling). (swap-pop correctness — entity-model.md I6)
- **MIG-1.** `migrate` writes exactly two record words for the migrating entity (via
  `commitRecord`) and at most one (`recordArchetypeRow`) for the shuffle-popped sibling.
  (entity-model.md I6)
- **MIG-2.** Migration copy cost is O(K) shared-column field copies + O(added) inits + O(columns of
  `fromArch`) shuffle-pop; independent of `arch.count`. (complexity)
- **BM-1.** Every bitmask read/write asserts `world.phase === 'serial'`; a test stubs a worker
  phase and asserts `bitmaskHas`/`has` throw. (Must-Fix #1)
- **BM-2 (coherence).** After any sequence of `spawn`/`add`/`remove`/`despawn`, for every alive
  entity `i` and component `c`: `bitmaskHas(i, c) === sigHas(currentSignature(i), c)`. (one-way
  coherence, §6.3)
- **BM-3.** `bitmaskHas`/`has`/`entityShapeWords` never read the entity record's location words and
  never drive iteration. (the bitmask is membership-only, §6.1)
- **CO-1.** No archetype `count`/`rows`/record/bitmask word is mutated while `world.phase ===
  'wave'`. (serial-mutation invariant, §7)
- **FRAG-1.** With `maxHotArchetypes = M`, after creating `M + k` distinct signatures, exactly `M`
  are hot and `k` are cold; queries over a cold signature yield the same entity set as if it were
  hot. (cold-store transparency, §10.3)
- **ACC-1.** The accessor for `(archetype, component)` is a single instance, created once at
  archetype creation, reused for all rows (poke `__idx`), and survives a primary-path `.grow()`
  with no regeneration. (one hidden class per pair — report §2.3; Must-Fix #5)

---

## 12. Complexity summary

| Operation | Time | Space |
|---|---|---|
| `sigEquals` / `sigHash` / `buildSigWords` | O(\|sig\|) | O(\|sig\|) words |
| `getOrCreateArchetype` (hit) | O(bucket) ≈ O(1) | — |
| `createArchetype` | O(\|sig\| + columns) | O(columns) column allocs |
| `edgeAdd` / `edgeRemove` (hit) | O(1) | O(1) Map entry per distinct transition |
| `edgeAdd` / `edgeRemove` (miss) | O(\|sig\| + create) | — |
| `allocRow` | O(1) amortized | 0 alloc (amortized over doubling) |
| `removeRow` (swap-pop) | O(columns) = O(shared) | 0 alloc |
| `migrate` | O(K + added + columns of from) | 0 alloc |
| `migrateAddingMany` / `migrateRemovingMany` | O(\|sig\| canonicalize + one `migrate`) | 0 alloc |
| `bitmaskApplyDelta` | O(\|fromSig\| + \|toSig\|) | 0 alloc |
| `bitmaskHas` / `has` | O(1) (+O(1) isAlive) | 0 alloc |
| `bitmaskClear` | O(stride) | 0 alloc |
| Query archetype match (per new archetype) | O(words · #queries) | — |
| Query iteration | O(matching archetypes · their counts) | 0 alloc (pooled EntityRef) |
| Bitmask region memory | `maxEntities · stride · 4` bytes | pre-allocated (memory-buffers.md §5.4) |
| Per-archetype column memory | `Σ rowBytes · capacity` | lazy, doubling growth |

---

## 13. Open questions deferred (non-blocking, from report §8)

- **Q-A2** (one large SAB slab + custom allocator vs per-archetype column SABs): this spec assumes
  **per-archetype column SABs** (memory-buffers.md Q-A2). A slab allocator changes only how
  `buildColumnSet` obtains columns; §4/§5/§6 invariants are unaffected.
- **Q-A3** (synchronous main-thread migration vs always command-buffer-deferred): main-thread
  migration is synchronous here (§5.5, serial phase); workers always defer (report §6.1).
- **Q-A4** (`changeVersion` per-row vs per-archetype): **RESOLVED — per-row**, lazily allocated
  only when a public-`.changed` consumer exists (reactivity.md §6.1, Q-A4). The reactivity module
  registers one extra `u32` column per hot archetype through the `archetypeCreated` hook (§5.3.1),
  using the same `Buffers.column` path; layout-neutral here. (No longer open.)
- **Q-R1** (pair-ID lifecycle — free a pair ID when no entity holds it; demote its archetypes to
  cold): owned by `relations`; this module supports cold demotion via §10 but v1 does not auto-free
  pair IDs.
- **Q-A1-followup** (automatic cold→hot promotion heuristic): v2; v1 is explicit `world.warm`
  (§10.4).

---

## Appendix A — Reference-library techniques: borrowed vs rejected

| Technique | Source `file:line` | ecsia decision |
|---|---|---|
| Sorted-`Uint32Array` canonical archetype signature | report §2.1 (Flecs-style) | **Borrowed** (§3.2). |
| Lazy edge-graph add/remove transition cache | absent in becsy (`registry.ts:399-423` flips bits) | **Borrowed/originated** (§5.4) — fills the becsy gap. |
| Flat per-entity bitmask `ShapeArray` (membership index) | becsy `shapearray.ts:21-108` | **Borrowed** for `has` + incremental match ONLY (§6); **NOT** for iteration (report §2.4 correction). |
| `AtomicSharedShapeArray` (`Atomics.or/and` membership) | becsy `shapearray.ts:112-204` | **Rejected** — bitmask is serial/main-thread-only, no atomics needed (Must-Fix #1, §6.2). |
| Per-component reverse query index (re-test only relevant queries) | becsy `query.ts:148-181` | **Borrowed** (consumed by query module; §6.6, §8). |
| Swap-pop dense removal | miniplex `Bucket.ts:125-148` | **Borrowed** the swap-pop idea, applied to SoA columns (§4.3); miniplex's JS-object bucket storage **rejected** (report §2.1). |
| Pointer-chasing entity-handle lists | becsy `entitylist.ts:55-119` | **Rejected** — contiguous `rows: Uint32Array` + parallel SoA (§3.5). |
| Pairs as synthetic component IDs in the signature | bitECS `Relation.ts:69-93` | **Borrowed** (§3.2, §3.6); JS-object pair identity **rejected** → integer IDs (report §2.6). |
| Eager Wildcard bookkeeping ghost components | bitECS `Component.ts:250-267` | **Rejected** — per-relation presence bit instead (§3.3, report §6.4). |
| Exclusive-relation `eid` payload (re-target = field write) | report §2.6 / §6.4 mitigation 1 | **Borrowed** (§3.6) — the T1 pressure-release valve. |
| `compact` singleton storage (shared keyed block) | becsy `component.ts:423-485` | **Borrowed in spirit** for the cold-archetype overflow store (§10.3). |
| Monolithic pre-allocated `maxEntities × numBits` matrix | becsy `registry.ts:106-113` | **Rejected** — fixed stride for component types + sparse pair-bit vector (§6.1, report §2.1). |
| Two flat entity-record arrays as the structural commit point | report §2.1 / entity-model.md §4 | **Consumed** via `commitRecord` (§5.5). |
| Central `Buffers` registry, length-tracking growth | becsy `buffers.ts:96-125` + memory-buffers.md §7 | **Consumed** — all columns/rows/bitmask via `Buffers` (§4.1, §3.7). |
