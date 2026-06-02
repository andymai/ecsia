# ecsia Implementation Spec — Module: Entity Model, Handles & Records

> Foundation module. Every other spec (storage, query, scheduler, relations, reactivity,
> serialization) depends on the types and invariants defined here. This module owns the
> definition of an *entity identity*, its *generational handle*, the *liveness model*, the
> *two-word entity record* that is the structural-change commit point, and the lifecycle
> APIs (`spawn` / `despawn` / `isAlive`) plus handle ↔ id encode/decode.
>
> Locked-decision provenance and reference-library borrows/rejections are cited inline as
> `DESIGN-RESEARCH.md §x.y` (the report) and as `lib/path:line` (original source the report
> read). This module **borrows** bitECS's generational-handle bit-packing and dense/sparse
> swap-and-move free-list, **adapts** becsy's `Atomics.sub` lock-free ID take and the
> two-flat-array entity-record idea, and **rejects** miniplex's `Map<entity,number>`
> generation-less identity.

---

## 0. Scope & Non-Goals

**In scope (this module owns these):**

- The `EntityHandle` branded type, its bit layout, and the encode/decode/validate functions.
- The `EntityIndex`: dense/sparse arrays + free-list governing index allocation, recycling,
  and generation bumping.
- The two-word **entity record** (`recordArchetypeId`, `recordArchetypeRow`) and the precise
  semantics of writing those two words as the structural commit point.
- `world.spawn()`, `world.despawn(handle)`, `world.isAlive(handle)`, and the handle codec
  surface.
- Capacity/growth of the entity-identity flat structures (NOT archetype columns).
- The pre-reserved entity-ID block protocol that the command buffer (§7.1 of the report)
  depends on.

**Out of scope (owned by other modules; this spec only declares the contracts they consume):**

- Archetype tables, SoA columns, the edge graph, migration column-copy mechanics — owned by
  the *storage* module. This spec defines *what* the two record words mean and *when* they are
  committed; storage defines *how* a migration produces the new `(archetypeId, row)`.
- The per-entity membership **bitmask** — the "bitmask module" is **not a separate spec file**;
  its content is owned by **archetype-storage.md §6** (the `bitmask.words` region is allocated by
  memory-buffers.md §5.4 and operated by archetype-storage §6). This spec defines the liveness
  check (which does NOT consult the bitmask) and the lifecycle hooks that bitmask logic in
  archetype-storage §6.3/§6.5 subscribes to.
- Command-buffer encoding/merge — owned by *scheduler/commands*. This spec defines the
  ID-reservation handshake (`reserveEntityBlock`, `commitReservedCreate`, `returnReservedIds`)
  that the command buffer calls.
- Accessor classes / `EntityRef` getter installation — owned by *component* module. This spec
  defines the pooled `EntityRef` *identity resolution* (`handle → (archetypeId, row)`) only.

---

## 1. Design Constraints This Module Satisfies (Locked Decisions)

| Locked decision (report) | How this module honors it |
|---|---|
| Generational handle, **configurable split, default 22 index / 10 version** (§2.3, §3 #3, §7 must-fix list) | `EntityHandle` is a `u32`; split is a `createWorld({ generationBits })` option; default `indexBits = 22`, `generationBits = 10`. Decode/encode are pure bit ops. §2 below. |
| Entity record = **two words** `(archetypeId, archetypeRow)`, the **structural commit point** (§2.1, §3 #3) | Two parallel flat arrays `recordArchetypeId[]`, `recordArchetypeRow[]`; a migration commits by writing exactly these two words *after* column copies. §4 below. |
| Handles stay valid across migrations (§1, §2.3) | The handle encodes *identity* (index+generation), never a row. Row is resolved through the record on every access. A migration mutates the record, not the handle. §4.4 below. |
| Bitmask is **main-thread / serial-phase only**; liveness must not depend on it (Must-Fix #1, T2) | `isAlive` uses only the dense/sparse generation check (`dense[sparse[index]] === handle`), never the bitmask. Borrowed from bitECS `EntityIndex.ts:128-165`. §3.3 below. |
| Workers never mutate identity mid-wave; structural intents staged to command buffers (§6.1/§7.1) | `despawn` and free-list mutation are **single-writer / main-thread / serial-phase**. Workers obtain IDs only from a **pre-reserved block** via `Atomics.sub` (becsy `intpool.ts:98-105`); they never touch the free-list. §5 below. |
| `entity.position` is `Readonly` shorthand; tracked writes via `entity.write(C)` (Must-Fix #2) | This module exposes only identity + record resolution; the *component* module installs accessors. The `EntityRef` returned here is the carrier, and its `read`/`write` surface is declared (§6) but implemented downstream. |
| ESM-only, strict TS, runtimes: all + workers via SAB w/ postMessage fallback (§3 #9, §7.3) | All flat structures are allocated through a `BackingStore` abstraction that yields `SharedArrayBuffer` when `threaded && crossOriginIsolated`, else `ArrayBuffer`. No code path assumes SAB. §7 below. |

---

## 2. The Generational Handle

### 2.1 Type

```ts
/** A packed u32: [generation : generationBits][index : indexBits], generation in the HIGH bits. */
export type EntityHandle = number & { readonly __ecsiaEntityHandle: unique symbol };

/** The low-bits index portion, i.e. the slot in the dense/sparse arrays. */
export type EntityIndex = number & { readonly __ecsiaEntityIndex: unique symbol };

/** The generation (version) counter for a slot. */
export type EntityGeneration = number & { readonly __ecsiaEntityGeneration: unique symbol };
```

Branding follows becsy's nominal-ID convention (`becsy/src/entity.ts:8`) so that a raw
`number` cannot be passed where a handle is required, and `EntityHandle`, `EntityIndex`,
`ComponentId` etc. are mutually non-assignable. The brand is erased at runtime (it is a plain
`number`); zero heap allocation per entity — borrowed from bitECS (`EntityIndex.ts:31-52`),
explicitly rejecting miniplex's JS-object entities (`miniplex/.../core.ts:128-162`) and its
generation-less `Map<entity,number>` (`miniplex/.../core.ts:263-297`).

### 2.2 Bit layout (default 22 / 10)

`EntityHandle` is a single unsigned 32-bit integer. Generation occupies the **high** bits,
index the **low** bits. Placing the index low makes `handle & INDEX_MASK` the array subscript
directly (the common hot operation), matching bitECS (`EntityIndex.ts:31-52`).

```
 bit  31                    10 9                     0     (default split)
      +----------------------+-+----------------------+
      |   generation (10b)     |     index (22b)       |
      +----------------------+-+----------------------+
       MSB                                          LSB

  indexBits      = 22   (default)   → index range      [0, 2^22 - 1] = [0, 4_194_303]
  generationBits = 10   (default)   → generation range [0, 2^10 - 1] = [0, 1_023]
  Constraint:  indexBits + generationBits === 32   (the handle is exactly one u32)
```

The split is configurable via `createWorld({ generationBits })`; `indexBits = 32 -
generationBits`. This mirrors bitECS's `withVersioning(versionBits)` (`EntityIndex.ts:76-96`)
and is the locked "configurable split, default 22/10" decision (§2.3, §3 #3). The report
**withdrew** the earlier "bitECS 24/8 wraps after 256, too fast" claim as uncited (§2.3 boxed
note); this module therefore does NOT bake in a magic split — it derives everything from
`generationBits`.

**Derived constants** (computed once at world creation; all are `>>> 0` to stay u32):

```ts
interface HandleLayout {
  readonly indexBits: number;        // 32 - generationBits
  readonly generationBits: number;   // option, default 10
  readonly indexMask: number;        // (1 << indexBits) - 1, as u32  → low-bits mask
  readonly generationMask: number;   // (1 << generationBits) - 1     → unshifted gen mask
  readonly generationShift: number;  // === indexBits
  readonly maxIndex: number;         // indexMask  (largest valid index)
  readonly maxGeneration: number;    // generationMask (gen value just before wrap to 0)
  readonly capacity: number;         // maxIndex + 1  (number of addressable slots)
}
```

> **Edge case — `indexBits === 32`** (`generationBits === 0`): `1 << 32` is `1` in JS
> (shift is mod-32), so `indexMask` must be computed as `generationBits === 0 ? 0xffffffff :
> ((1 << indexBits) - 1) >>> 0`. Generation-less mode is permitted ONLY when `threaded ===
> false` (single-thread, no recycled-slot aliasing risk); under SAB it is rejected at world
> creation (the report flags disabling versioning under SAB as unsafe — bitECS
> `EntityIndex.ts:128-165`). Validation: `assert(generationBits >= 1 || !threaded)`.

### 2.3 Encode / decode (pure, branch-free)

```ts
function makeHandle(index: number, generation: number, L: HandleLayout): EntityHandle {
  // (generation << generationShift) | index, kept unsigned
  return (((generation << L.generationShift) | index) >>> 0) as EntityHandle;
}

function handleIndex(h: EntityHandle, L: HandleLayout): EntityIndex {
  return ((h & L.indexMask) >>> 0) as EntityIndex;
}

function handleGeneration(h: EntityHandle, L: HandleLayout): EntityGeneration {
  return ((h >>> L.generationShift) & L.generationMask) as EntityGeneration;
}
```

- Complexity: O(1), no branches, no allocation, no `Atomics`. Pure functions; safe to call
  from workers (they receive `HandleLayout` as a plain frozen object at startup).
- `makeHandle` assumes `index <= maxIndex` and `generation <= maxGeneration`; callers
  internal to this module guarantee that (the index allocator clamps to `maxIndex`, the
  generation bump masks with `generationMask` — §3.2). In dev mode `makeHandle` asserts both.

### 2.4 Generation wrap semantics

A generation increments each time its slot is *freed* (§3.2). When `generation` reaches
`maxGeneration` and is bumped again, it wraps to `0` (`(g + 1) & generationMask`). Wrap is
**not** an error — it is the documented aliasing window. The wrap time for a single hot slot
recycled at rate `r` is `2^generationBits / r` (report's corrected derivation, §2.3 boxed
note). This module surfaces the formula in a `world.handleStats()` debug helper and emits a
**dev-mode** warning the first time any slot wraps, so users can raise `generationBits`. No
production throw.

---

## 3. The Entity Index (allocation, recycling, liveness)

The `EntityIndex` is the authoritative registry of which `index` slots are alive and at which
generation. It is the bitECS dense/sparse swap-and-move free-list (`EntityIndex.ts:104-165`)
generalized to a configurable split and made SAB-capable.

### 3.1 Data layout

Three flat arrays plus scalar cursors. All are sized to `capacity = maxIndex + 1` (Q-C1 in the
report sets `maxEntities`; this module names it `capacity` and derives it from `indexBits`).

```ts
interface EntityIndexLayout {
  // sparse[index] = position of `index` within `dense` (its current "slot in the dense array").
  //   Word size: Uint32Array. Length: capacity.
  sparse: Uint32Array;

  // dense[pos] = a full EntityHandle (index packed WITH its current generation).
  //   The dense array is partitioned: [0, aliveCount) are alive handles; [aliveCount, denseLen)
  //   are recycled-but-free handles whose generation has ALREADY been bumped, ready to reissue.
  //   Word size: Uint32Array. Length: capacity. (Stores handles, not bare indices — this is the
  //   key adaptation of bitECS that lets us reissue the bumped generation directly.)
  dense: Uint32Array;

  // Per-slot generation, addressed by index (NOT by dense position). Kept separate so liveness
  //   and the bump are O(1) by index without a dense lookup.
  //   Word size: Uint32Array (only low generationBits used). Length: capacity.
  generation: Uint32Array;
}
```

Plus three cursors held in a small SAB control block (`Int32Array`/`Uint32Array` of length 4,
so `Atomics` works on them):

```
 word 0: aliveCount       // number of currently-alive entities (= live prefix length of dense)
 word 1: denseLen         // number of distinct indices ever minted (high-water mark)
 word 2: reservedHead     // dense position of the next ID a worker block may claim via Atomics.sub
 word 3: (reserved / padding for 8-byte alignment)
```

> **Why `dense` stores full handles, not bare indices (adaptation note).** bitECS's `dense`
> stores entity ids and recovers generation by re-reading a parallel structure
> (`EntityIndex.ts:128-149`). ecsia stores the *handle* (index ⊕ generation) directly in
> `dense` so that recycling can reissue the already-bumped handle with a single read, and so
> that the **pre-reserved-block** worker path (§5) can hand out fully-formed handles with one
> `Atomics.sub` and no second lookup. The per-index `generation[]` array is retained for O(1)
> `isAlive` and for re-deriving the handle on the rare paths that have only an index.

**Memory cost** (default split, `capacity = 2^22 = 4,194,304`): three `Uint32Array`s ×
4 bytes × 4,194,304 = **48 MiB** for the identity registry at full default capacity. This is
the bounded, pre-allocated cost the report mandates (§4 T4: "pre-allocate the flat per-entity
structures … sized by `maxEntities`"). Smaller `capacity` (most worlds) costs proportionally
less; the arrays may also be lazily grown (§7) if `maxEntities` is left default-but-unused.

### 3.2 Allocation & recycling algorithm (swap-and-move free-list)

Borrowed from bitECS `EntityIndex.ts:104-165`, generalized to the configurable split. All
mutation here is **single-writer**: it runs on the main thread during a serial phase only
(Must-Fix #1; workers use the reserved-block path §5, never this).

```
allocEntity() -> EntityHandle:
  1. if aliveCount < denseLen:                      # a recycled slot is available
       pos   := aliveCount
       h     := dense[pos]                          # already carries the bumped generation
       index := handleIndex(h)
       sparse[index] := pos                         # (already true, but reasserted for clarity)
       aliveCount := aliveCount + 1
       return h
  2. else:                                          # mint a brand-new index
       if denseLen > maxIndex:  throw CapacityExceeded   # index space exhausted (§3.4)
       index := denseLen
       generation[index] := 0
       h := makeHandle(index, 0, L)
       dense[index]  := h
       sparse[index] := index
       denseLen   := denseLen + 1
       aliveCount := aliveCount + 1
       return h

freeEntity(h) -> void:                              # despawn; precondition isAlive(h)
  1. index := handleIndex(h)
  2. pos   := sparse[index]
  3. lastAlive := aliveCount - 1
  4. # swap the freed slot's dense entry with the last alive entry (swap-and-move):
     lastHandle := dense[lastAlive]
     lastIndex  := handleIndex(lastHandle)
     dense[pos]            := lastHandle
     sparse[lastIndex]     := pos
  5. # bump generation for the freed index and park its NEW handle at the just-vacated tail:
     g := (generation[index] + 1) & generationMask
     generation[index] := g
     newHandle := makeHandle(index, g, L)
     dense[lastAlive]  := newHandle               # parked in the free region [aliveCount-1 .. )
     sparse[index]     := lastAlive               # index now lives at the tail (free region)
  6. aliveCount := aliveCount - 1
```

- Complexity: `allocEntity` and `freeEntity` are **O(1)**, no allocation, no scan. Matches
  bitECS's stated O(1) recycling (§2.3 "what works").
- After `freeEntity`, the freed index's *new* (bumped-generation) handle sits in the free
  region of `dense` and will be the next handle returned by `allocEntity` step 1 — the
  swap-and-move keeps the alive prefix dense and the free region a reusable stack.
- The generation bump in step 5 is what makes the *old* handle stale: `isAlive(oldHandle)`
  now fails the generation comparison (§3.3). This is the bitECS staleness mechanism
  (`EntityIndex.ts:128-165`), the model the report mandates over miniplex's leak-prone
  generation-less Map (§2.3 "what to avoid").

### 3.3 Liveness / staleness check

```ts
function isAlive(h: EntityHandle, idx: EntityIndexLayout, L: HandleLayout): boolean {
  const index = handleIndex(h, L);
  if (index >= idx.denseLenValue) return false;          // never minted
  const pos = idx.sparse[index];
  if (pos >= idx.aliveCountValue) return false;          // index is in the free region → dead
  return idx.dense[pos] === (h as number);               // generation must match exactly
}
```

- The final equality is the single load + compare the report calls out (bitECS
  `dense[sparse[id]] === id`, §2.3 "what works", `EntityIndex.ts:128-149`). Because `dense`
  stores the *full handle* (index ⊕ generation), one comparison validates **both** that the
  slot is alive **and** that the generation matches — a stale handle (old generation) fails
  even if its index has been recycled and is alive at a newer generation.
- **It NEVER consults the per-entity bitmask** (Must-Fix #1 / T2: the bitmask is
  main-thread/serial-only and is not the liveness source). Liveness is purely the
  dense/sparse/generation triad, so the same logic is safe to expose as a (read-only) check —
  though by policy workers validate via the archetype signature they iterate, not via
  `isAlive` (§5.3).
- Complexity: O(1), 1–2 array loads + 1 compare. No branches beyond the two range guards.

> **Edge cases handled by the two guards:**
> - `index >= denseLen` — a handle fabricated/corrupted with an index never minted → dead.
> - `pos >= aliveCount` — index minted but currently in the free region (despawned, not yet
>   reissued) → dead, *regardless of generation* (defends against a handle whose generation
>   happens to match a parked-but-free slot).
> - matching index, alive, wrong generation — caught by the `dense[pos] === h` compare.
> - The `0` handle: index 0 / generation 0 is a *valid* entity if slot 0 is alive. There is no
>   "null handle" sentinel inside this codec; callers needing "no entity" use a separate
>   `NO_ENTITY` constant (§2.5, below) that is structurally `0xffffffff` and is rejected by the
>   `index >= denseLen` guard for any sane `denseLen < 2^22`.

```ts
/** Sentinel for "no entity" in eid fields and APIs that may return absent. NOT a live handle. */
export const NO_ENTITY = 0xffffffff as EntityHandle;
```

`NO_ENTITY` uses an all-ones u32: with the default split its index portion is `maxIndex`
(`4_194_303`) and generation `maxGeneration` (`1023`); `isAlive(NO_ENTITY)` is false unless the
world has minted the absolute maximum index AND wrapped it to the maximum generation — a
combination this module additionally forbids the allocator from producing (it skips
`index === maxIndex` as a usable slot when `threaded`, reserving it for the sentinel). For
`eid`-typed component fields, `NO_ENTITY` is the encodable "null reference," matching becsy's
`-1` ref sentinel (`becsy/src/type.ts:787-931`) but expressed as an unsigned all-ones value to
stay TypedArray-friendly.

> **Cross-reference (naming).** `NO_ENTITY` (this module, the canonical handle-space sentinel,
> `0xffffffff`) and type-system.md's `NULL_ENTITY` (`-1`) are the **same** entity — the same
> 32-bit pattern in two storage spellings. When `NO_ENTITY` is stored into an `eid` column's
> `Int32Array` it reads as `-1` (memory-buffers.md §3.4 C-2); when read back via `>>> 0` it is
> `0xffffffff` again. type-system.md re-exports `NO_ENTITY` and keeps `NULL_ENTITY` as a
> deprecated alias. Use `NO_ENTITY` in handle-space code, `-1` only at the raw `Int32Array`
> boundary.

### 3.4 Capacity exhaustion

`allocEntity` throws `CapacityExceeded` when `denseLen > maxIndex` (the index space is full of
*simultaneously alive* + ever-minted indices and no slot is free). This is a hard error (unlike
log overflow, which spills — §2.7 of the report): there is no safe degradation for running out
of identity space. The message reports `capacity`, current `aliveCount`, and suggests raising
`indexBits` (lowering `generationBits`) or `maxEntities`. The cold-archetype fallback (§7.4 of
the report) addresses *archetype* count, NOT *entity* count, so it does not apply here.

---

## 4. The Entity Record (two-word commit point)

### 4.1 Layout

Every alive entity has a **two-word record** addressed by its `index` (low bits of the handle).
Two parallel flat arrays, exactly as the report mandates ("two flat global arrays —
`archetypeId[maxEntities]` and `archetypeRow[maxEntities]`. A migration touches only these two
words per entity", §2.1; "Entity record is two words (archetypeId, archetypeRow) as the
structural commit point", report front-matter).

```ts
interface EntityRecordLayout {
  // recordArchetypeId[index] = the ArchetypeId of the archetype the entity currently lives in.
  //   Word size: Uint32Array. Length: capacity.  Sentinel ARCHETYPE_NONE for "no archetype yet".
  recordArchetypeId: Uint32Array;

  // recordArchetypeRow[index] = the row within that archetype's SoA columns.
  //   Word size: Uint32Array. Length: capacity.
  recordArchetypeRow: Uint32Array;
}
```

- **Why addressed by `index`, not by dense position:** the index is stable for the lifetime of
  a handle's generation; the dense position moves under swap-and-move (§3.2). Addressing the
  record by the *index* means a migration does not have to consult the dense/sparse arrays at
  all — it writes `recordArchetypeId[index]` and `recordArchetypeRow[index]` and is done.
- `ARCHETYPE_NONE = 0xffffffff` and `EMPTY_ARCHETYPE_ID = 0` are both **defined normatively in
  archetype-storage.md §3.1** and consumed here (this module references them; it does not redefine
  them). `ARCHETYPE_NONE` is the record sentinel for an index not yet placed into any archetype;
  `EMPTY_ARCHETYPE_ID = 0` is the **real** empty-signature archetype (dense id 0) a freshly
  spawned entity lands in — so the empty archetype is a genuine archetype, **not** the sentinel,
  and the two constants are distinct (`0` vs `0xffffffff`). A despawned index's record words are left
  as-is until reissue; they are overwritten on the next spawn into that slot, so stale record
  contents are never read (liveness is checked first by every accessor — §6.2).

**Memory cost:** two `Uint32Array`s × 4 bytes × `capacity`. At default `capacity = 2^22`:
**32 MiB**. Combined with the identity registry (§3.1, 48 MiB) the bounded pre-allocated
identity+record footprint is **80 MiB at full default capacity** — pre-allocated as SAB when
threaded (§4 T4 of the report). Typical worlds set a much smaller `maxEntities`.

### 4.2 The commit invariant (load-bearing)

> **INVARIANT C1 (structural commit point).** An entity's location is defined *solely* by its
> two record words. A migration becomes *observable* exactly when both record words have been
> written. No other reader (query iteration, accessor resolution, observer) may derive an
> entity's location from anything other than these two words.

The migration protocol (owned by the storage module; reproduced here only for the commit
ordering this module guarantees) is, per §2.1 of the report:

```
migrate(handle, fromArch, toArch):
  index := handleIndex(handle)
  # ---- all of the following are NON-observable preparation ----
  newRow := toArch.allocRow()                       # storage module
  copy shared columns fromArch[oldRow] -> toArch[newRow]
  init added columns at toArch[newRow]
  enqueue onRemove for removed components (DEFERRED via log; not synchronous)  # report §2.1
  shuffle-pop fromArch's vacated oldRow, fixing the MOVED entity's record:
      movedHandle := fromArch.handleAt(lastRow)
      movedIndex  := handleIndex(movedHandle)
      recordArchetypeRow[movedIndex] := oldRow      # the moved sibling's row word
      fromArch.count -= 1
  # ---- THE COMMIT: two stores, in this exact order ----
  recordArchetypeRow[index] := newRow               # (a)
  recordArchetypeId[index]  := toArch.id            # (b)
```

- **Single-thread / serial case (v1):** the two stores are plain (non-atomic). The report is
  explicit: "in the single-threaded case, a plain two-store write of the entity record after
  column copies" and "an atomic CAS on the record is **not** required for correctness" (§2.1).
  Because all migrations run on the main thread / serial phase (Must-Fix #1), no concurrent
  reader can observe the record between (a) and (b).
- **Ordering rationale:** write the *row* word first, the *id* word second, so that a
  hypothetical concurrent reader (there is none in v1) would, in the worst case, see the old
  `(id, oldRow)` or the new `(toArch.id, newRow)` — never `(toArch.id, oldRow)` if (b) were
  first. v1 does not rely on this (mutation is serial), but the ordering is fixed now so the
  v2 CAS contingency (next paragraph) is a drop-in.
- **v2 contingency (NOT v1):** the report writes out a CAS protocol "only as a contingency for
  a hypothetical future worker-side-mutation v2; v1 does not use it" (§4 T2). For
  forward-compat, the commit is wrapped in a single function `commitRecord(index, archId, row)`
  so a future build can swap the two plain stores for an `Atomics.store` pair (row then id,
  with an `Atomics` fence) without touching any caller. v1's `commitRecord` is two plain
  stores.

### 4.3 Reading a record

```ts
function resolveLocation(h: EntityHandle, rec: EntityRecordLayout, L: HandleLayout)
    : { archetypeId: number; row: number } {
  const index = handleIndex(h, L);
  return { archetypeId: rec.recordArchetypeId[index], row: rec.recordArchetypeRow[index] };
}
```

- Complexity: O(1), two array loads. Callers MUST have already validated `isAlive(h)` (or be
  iterating a query, which only yields alive entities). Resolution does not re-check liveness —
  that is the caller's contract, to keep the hot accessor path branch-minimal (§6.2).

### 4.4 How handles stay valid across migrations

The handle encodes only `(index, generation)`. A migration mutates *record words* (addressed
by index), never the handle and never the index→handle mapping. Therefore:

- A stored `EntityHandle` remains a correct key into the record arrays before and after any
  number of migrations of that entity or any sibling. Re-resolving via `resolveLocation`
  always yields the *current* `(archetypeId, row)`. This is the report's "handles stay valid
  across migrations" requirement and the reason the row is **never** part of the handle (§1,
  §2.3).
- A *moved sibling* (the entity that shuffle-pop relocated) has *its* row word fixed inside the
  migration (step "shuffle-pop" above). Its handle is likewise unchanged.
- Consequence for `EntityRef` row caching (Q-H2): an `EntityRef` that caches `(archetypeId,
  row)` becomes stale after *any* migration touching its archetype. This module's default is
  the safe one — `EntityRef` re-resolves through the record on every access boundary (one extra
  deref, no stale-row bug class); the cached-row variant is a documented opt-in (§6.3, Q-H2).

---

## 5. Worker ID Reservation (the command-buffer handshake)

Workers may not touch the free-list mid-wave (Must-Fix #1). To let `OP_CREATE` return a usable
handle mid-wave (report §6.1 "Entity-ID reservation"), the main thread pre-reserves a small
block of IDs per worker before each wave. This is the becsy `Atomics.sub` lock-free take
(`becsy/src/datatypes/intpool.ts:98-105`) adapted to the dense free-list.

### 5.1 Main-thread API (called between waves, serial phase)

```ts
interface EntityReservation {
  readonly handles: readonly EntityHandle[];   // pre-fully-formed handles, ready to use
  readonly workerIndex: number;
}

/** Reserve `count` entity handles for `workerIndex` to consume mid-wave. Serial-phase only. */
reserveEntityBlock(workerIndex: number, count: number): EntityReservation;

/** After the wave, reclaim any handles the worker did not consume (returns them to the pool). */
returnReservedIds(reservation: EntityReservation, consumedCount: number): void;
```

**Reservation algorithm** (main thread, serial):

```
reserveEntityBlock(workerIndex, count):
  out := []
  repeat count times:
     h := allocEntity()        # uses the normal O(1) free-list; runs serially on main thread
     out.push(h)
  return { handles: out, workerIndex }
```

The block is allocated by the *main thread* using the ordinary serial `allocEntity` (§3.2) —
the entities are fully alive the instant they are reserved, so any later command in the same
flush can reference them safely (report §6.1: "Reserved IDs from `OP_CREATE` are always alive
at apply time"). The worker receives the pre-formed handle array (copied into its command-
buffer transfer, or read from a small per-worker reservation SAB).

> **Note on becsy's `Atomics.sub` model.** becsy hands workers a shared `Uint32Pool` and lets
> each worker `Atomics.sub` to take an id (`intpool.ts:98-105`). ecsia *could* expose the
> dense free-region as a SAB and let workers `Atomics.sub` the `reservedHead` cursor (word 2,
> §3.1) directly — this is the path the `reservedHead` cursor exists for. v1 uses the simpler
> **main-thread-reserves-a-block** model (no worker free-list access at all), which is strictly
> safer (workers never mutate the dense/sparse arrays) and matches Must-Fix #1's
> "freeEntity is single-writer (main thread, between waves)" (§2.3 of the report). The
> `Atomics.sub`-on-`reservedHead` variant is documented as the v2 path for very high
> per-worker creation rates and is why `dense` stores full handles (§3.1 adaptation note).

### 5.2 Worker-side consumption (mid-wave)

A worker, executing a system, calls `world.spawn()` (worker variant). This does NOT touch the
free-list; it pops the next handle from its reservation array and emits `OP_CREATE
reservedEid` into its command buffer (report §6.1). If the reservation block is exhausted
mid-wave, the worker emits a `RESERVE_REFILL` marker and the spawn returns a *provisional*
handle drawn from a secondary per-worker fallback block; if even that is exhausted, the spawn
records the create but returns `NO_ENTITY` and a dev-mode warning fires (the system should size
its reservation via the scheduler's `expectedSpawns` hint). v1 sizes reservation blocks from a
per-system `maxSpawnsPerWave` declaration (default 64).

### 5.3 Worker liveness policy

Per Must-Fix #1 / T2, a worker mid-wave does **not** call `isAlive` against the shared
dense/sparse arrays (those are main-thread-mutated between waves; reading them mid-wave is
allowed because they are not mutated mid-wave, but the *policy* is to avoid it). Instead:

- A worker iterating a query knows every yielded entity is alive (the archetype only contains
  alive entities; report §4 T2 "systems running on workers that need membership facts use the
  archetype signature they are already iterating").
- A worker that holds a *stored* handle and needs liveness defers the decision: it emits the
  command unconditionally, and the main thread's **validate-then-apply, drop-if-dead** rule
  (report §6.1) drops commands referencing dead entities at apply time. So worker-side
  liveness is *not this module's concern mid-wave*; it is the command-buffer apply path's
  concern, and that path calls this module's `isAlive` on the main thread.

---

## 6. Public Lifecycle API

### 6.1 World-level surface

```ts
interface World {
  /** Create a new entity with the empty signature. Main-thread/serial. O(1). */
  spawn(): EntityHandle;

  /**
   * Create a new entity and immediately add the given components (one migration, not N).
   * Components/initial values resolved by the component+storage modules; this module only
   * mints the handle and hands it to the storage `migrate`. Returns the live handle.
   */
  spawnWith<T extends readonly ComponentDef<any>[]>(...defs: T): EntityHandle;

  /** Destroy an entity. Main-thread/serial. Idempotent on dead handles (no-op). O(1) + cascade. */
  despawn(h: EntityHandle): void;

  /** O(1) liveness/staleness check. Never consults the bitmask. */
  isAlive(h: EntityHandle): boolean;

  /** Resolve a pooled EntityRef for `h` (validates liveness; throws on dead unless { lenient }). */
  entity(h: EntityHandle): EntityRef;

  /** Handle codec surface (pure, also exported standalone for workers). */
  readonly handleLayout: HandleLayout;
  encodeHandle(index: number, generation: number): EntityHandle;
  decodeHandle(h: EntityHandle): { index: EntityIndex; generation: EntityGeneration };

  /** Debug/observability. */
  handleStats(): { aliveCount: number; minted: number; capacity: number; wrapTimeFormula: string };
}
```

`spawnWith` exists because spawning into the empty archetype and then migrating once per added
component would cause N migrations; the storage module computes the target archetype signature
up front and performs a single migration (this also matters for T1 churn — report §4 T1).

> **Ownership boundary (spawnWith).** This module owns the *public* `world.spawnWith` signature
> and the handle mint (it calls `spawn` to land the entity in `EMPTY_ARCHETYPE_ID`), then
> delegates the archetype work to `storage.spawnWith(handle, defs)` (archetype-storage.md §5.6),
> which owns the target-signature computation and the single `migrate`. Neither spec
> double-owns the function: entity-model = public surface + handle; storage = the migration body.

### 6.2 `spawn` algorithm

```
spawn():
  assertMainThreadSerialPhase()                 # dev-mode guard; workers use the §5 path
  h := allocEntity()                            # §3.2, O(1)
  index := handleIndex(h)
  recordArchetypeId[index]  := EMPTY_ARCHETYPE_ID    # = 0, the empty-signature archetype (archetype-storage.md §3.1)
  recordArchetypeRow[index] := emptyArchetype.allocRow(h)   # storage module
  fireLifecycleHook('spawn', h)                 # bitmask module sets membership bit; observers staged
  return h
```

- The lifecycle hook (`fireLifecycleHook`) is how downstream modules stay coherent without
  this module depending on them: the bitmask module registers a `'spawn'` listener that sets
  the entity's (initially empty) membership word; the reactivity module registers a listener
  that pushes a structural-log entry (report §2.7). Hooks fire **after** the record is
  committed (INVARIANT C1) so any listener that resolves location sees the committed state.
- Complexity: O(1) plus the empty archetype's `allocRow` (amortized O(1)).

### 6.3 `despawn` algorithm

```
despawn(h):
  assertMainThreadSerialPhase()
  if not isAlive(h): return                     # idempotent, report §6.1 "OP_DESTROY of dead = no-op"
  index := handleIndex(h)
  archId := recordArchetypeId[index]; row := recordArchetypeRow[index]

  # 1. Relations cascade / back-ref cleanup (relations module; main-thread sparse back-ref index):
  fireLifecycleHook('preDespawn', h)            # relations module enqueues cascade BFS, removes pairs

  # 2. Emit removal reactivity (DEFERRED log) BEFORE the row is reclaimed, so onRemove observers
  #    can still read the dying component values from the live (pre-overwrite) row:
  trackShape(index, 0, ShapeKind.Destroy)       # reactivity.md §4.2 — Destroy entry, emitted pre-removeRow
  for each component c in this entity's signature:
      enqueueRemoveLog(index, c)                #   one OP_KIND_REMOVE per held component (reactivity.md §5.2)

  # 3. Remove the entity's row from its archetype (shuffle-pop, fixing the moved sibling's record):
  archetypes[archId].removeRow(row, /*fixSibling=*/ (movedIndex, newRow) => {
     recordArchetypeRow[movedIndex] := newRow   # the structural commit for the moved sibling
  })
  #    (When a component has remove-observers, removeRow defers the actual column overwrite to a
  #     post-observer-slot reclaim — reactivity.md §7.4 deferred-row-reclaim — so the values logged
  #     in step 2 remain readable through the observer drain.)

  # 4. Clear the per-entity bitmask membership words (main-thread/serial; archetype-storage §6.5):
  fireLifecycleHook('despawn', h)               # bitmask clears words

  # 5. Invalidate identity LAST, so all the above could still resolve the entity's location:
  freeEntity(h)                                 # §3.2: bumps generation, parks new handle, O(1)
```

- **Ordering is load-bearing.** The sequence is fixed as: **(1)** `trackShape(Destroy)` +
  `enqueueRemoveLog` for all components, **(2)** `removeRow`, **(3)** bitmask clear, **(4)**
  `freeEntity`. Reactivity entries are emitted **before** `removeRow` (step 2 above) — matching the
  migration path, which "enqueues removal reactivity before source row overwrite"
  (archetype-storage.md §5.5 step 3) — so the deferred-row-reclaim protocol (reactivity.md §7.4)
  can keep the pre-removal values readable for `onRemove` observers (report §2.7 "recently-deleted
  data visible to observers"). Identity is invalidated (`freeEntity`) **last**, so every hook and
  the logged entries can still `resolveLocation` the dying entity. After `freeEntity`, the handle
  is stale and `isAlive` returns false.
- **Why Destroy precedes removeRow (not the reverse).** If `removeRow` ran first, the row would be
  physically reclaimed (or its sibling shuffled in) before the shape-log Destroy entry and the
  per-component remove logs were written, so a remove-observer draining at the serial slot could
  read the wrong (overwritten) row. Emitting the log entries first, and deferring the actual column
  overwrite when remove-observers exist (reactivity.md §7.4), keeps the observer's
  `e.read(C)`-of-final-state contract correct.
- **Cascade:** the relations module's `preDespawn` hook may enqueue *subject* entities for
  destruction (cascade `deleteSubject`, report §2.6). Those are processed via a BFS work-queue
  the relations module drains by calling `despawn` again — iterative, not recursive (bitECS
  `Entity.ts:75-138`), so deep hierarchies do not blow the stack. This module exposes
  `despawn` re-entrantly for that purpose; the `assertMainThreadSerialPhase` guard is satisfied
  because cascade runs in the same serial phase.
- **Worker path:** a worker never calls `despawn`; it emits `OP_DESTROY eid` to its command
  buffer (report §6.1). The main thread, applying the buffer between waves, calls this
  `despawn`, which runs the full ordered protocol once, deterministically.
- Complexity: O(1) for the identity + record + bitmask work; cascade is O(affected pairs +
  cascaded subjects), bounded by the relation back-ref index, not a full scan.

### 6.4 `EntityRef` identity resolution (this module's slice)

`EntityRef` is one pooled object **per world** (NOT per entity, NOT a Proxy — report §2.3,
rejecting miniplex JS-objects and ES Proxy). This module owns only its identity fields and
resolution; the component module installs the accessor getters/`read`/`write` on its prototype.

```ts
class EntityRef {
  /** The handle this ref currently points at. Set by world.entity(h) / query iteration. */
  __handle: EntityHandle = NO_ENTITY;
  /** Cached resolved location; valid only within one access boundary (see Q-H2). */
  __archetypeId = ARCHETYPE_NONE;
  __row = 0;

  /** Re-point this pooled ref at a (validated-alive) handle and resolve its location. */
  __bind(h: EntityHandle): this {
    this.__handle = h;
    const loc = resolveLocation(h, world.records, world.handleLayout);   // §4.3
    this.__archetypeId = loc.archetypeId;
    this.__row = loc.row;
    return this;
  }

  // Installed by the component module (declared here for the contract):
  //   read<C>(def: ComponentDef<C>): Readonly<Accessor<C>>     // entity.read(Position)
  //   write<C>(def: ComponentDef<C>): Accessor<C>              // entity.write(Velocity) — tracked
  // The bare `entity.position` getter shorthand resolves to read() and is Readonly (Must-Fix #2).
}
```

- **Default (Q-H2 = safe):** `__bind` re-resolves the location every time the ref is handed
  out (`world.entity(h)`, or query iteration re-binding the pooled ref per row). After any
  migration the next access re-resolves correctly. The opt-in cached-row mode skips re-bind
  while iterating one archetype (valid because in-iteration migrations are deferred to command
  buffers, report §7.1) and is invalidated at any structural flush.
- **Never store an `EntityRef` across system boundaries** (report §2.3): the pool reuses it.
  Store the raw `EntityHandle` and re-`world.entity(h)` after validating `isAlive`. This is the
  becsy `entity.ts:19-20` discipline.

---

## 7. Backing Storage & Growth (identity structures only)

All flat arrays in this module (`sparse`, `dense`, `generation`, the cursor control block,
`recordArchetypeId`, `recordArchetypeRow`) are allocated through a `BackingStore`:

```ts
interface BackingStore {
  /** SAB when (threaded && crossOriginIsolated && SAB-available), else ArrayBuffer. */
  allocU32(length: number, opts?: { maxLength?: number }): Uint32Array;
  allocI32Control(length: number): Int32Array;   // for Atomics cursors
  readonly shared: boolean;
}
```

- **SAB selection:** when `createWorld({ threaded: true })` and `globalThis.crossOriginIsolated
  === true`, identity arrays are SAB-backed and transferred to workers once at startup (report
  §2.5 "SABs transferred to workers once at startup, not per frame"). When not cross-origin
  isolated, the world either runs single-threaded or uses the postMessage fallback (report
  §7.3); either way these arrays are plain `ArrayBuffer`s and are never shared mid-frame.
- **Growth (length-tracking, the §7.2 invariant):** the identity arrays are normally
  pre-allocated to `capacity` (bounded, §4 T4). When `maxEntities` is left at a small default
  and the world grows past it, the arrays grow via the **resizable-SAB + length-tracking-view**
  protocol (report §7.2 / Must-Fix #5): each array is constructed **without a length argument**
  over a resizable backing buffer (`allocU32(n, { maxLength })`), so the view widens
  automatically on `.grow()` and **no view captured anywhere becomes stale**. This module holds
  no closure over these arrays besides the `EntityIndexLayout`/`EntityRecordLayout` structs,
  which the world re-reads from after a grow; on the non-resizable fallback path the world
  re-wraps and re-publishes the structs (and posts the new SAB to workers) at a serial flush
  point, never mid-wave (report §7.2 grow-and-patch fallback). Growth always doubles (report
  §2.9 "double on growth").

> **Why these arrays auto-track and accessor column views need a registry, contrasted.** The
> identity arrays have exactly one well-known consumer (this module's layout structs), so the
> length-tracking view alone suffices and no live-accessor registry is needed here — the
> registry cost (§7.2 of the report) is borne only by the *component* module's per-(archetype,
> component) accessor singletons, not by identity. This keeps the foundation module's growth
> path trivial.

---

## 8. Concurrency & Memory-Ordering Summary

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `allocEntity` / `freeEntity` | Main only | Serial (between waves) | None (single-writer). |
| `spawn` / `despawn` | Main only | Serial | None; ordered protocol §6.2/§6.3. |
| `isAlive` / `resolveLocation` | Main; (workers may read but policy: avoid) | Any (arrays not mutated mid-wave) | Plain loads; no atomics in v1. |
| `commitRecord` (two stores) | Main only | Serial | Plain stores in v1; row-then-id order; CAS reserved for v2 (§4.2). |
| `reserveEntityBlock` | Main only | Serial | Uses serial `allocEntity`. |
| Worker `spawn` (reservation pop) | Worker | Mid-wave | Reads pre-formed handle array; emits `OP_CREATE`; no shared mutation. |
| `reservedHead` cursor (v2 path only) | Worker | Mid-wave | `Atomics.sub` (becsy `intpool.ts:98-105`). Not used in v1. |

The single load-bearing rule: **all identity and record mutation is serial / main-thread**
(Must-Fix #1). v1 therefore needs **no atomics on the identity hot path** — the scheduler's
wave fence is the synchronization (report §4 T2/T3). This is why `EntityHandle` codec,
`isAlive`, and `resolveLocation` are pure non-atomic functions safe to ship to workers as
read-only helpers.

---

## 9. Invariants (testable assertions)

- **I1.** `handleIndex(makeHandle(i, g)) === i` and `handleGeneration(makeHandle(i, g)) === g`
  for all `0 ≤ i ≤ maxIndex`, `0 ≤ g ≤ maxGeneration`. (codec round-trip)
- **I2.** `indexBits + generationBits === 32`. (single-u32 handle)
- **I3.** After `h = allocEntity()`, `isAlive(h) === true`. After `freeEntity(h)`,
  `isAlive(h) === false`, and `isAlive(allocEntity())` for the reissued slot uses generation
  `(prevGen + 1) & generationMask`. (recycling + staleness)
- **I4.** A handle freed and whose index is reissued does NOT compare equal to the new handle
  (generation differs) until `2^generationBits` recycles of that exact slot. (wrap window)
- **I5.** For any sequence of migrations, a fixed `EntityHandle` `h` always satisfies
  `resolveLocation(h)` returns the entity's current `(archetypeId, row)`; the handle value is
  never rewritten by a migration. (handles valid across migrations — §4.4)
- **I6.** A migration writes exactly two record words for the migrating entity and exactly one
  (`recordArchetypeRow`) for the at-most-one shuffle-popped sibling. (two-word commit point)
- **I7.** `isAlive` and `resolveLocation` never read the per-entity bitmask. (Must-Fix #1 — a
  test stubs the bitmask module and asserts zero calls during `isAlive`.)
- **I8.** `despawn(h)` is idempotent: `despawn(h); despawn(h)` performs the protocol once.
- **I9.** All identity/record arrays are length-tracking views over resizable buffers when
  threaded; constructing any of them with an explicit length argument fails the M2 test
  (mirrors report §7.2 column-view test, applied to identity arrays).
- **I10.** Workers never call `allocEntity`/`freeEntity`/`commitRecord` (asserted by a
  dev-mode thread-id guard).

---

## 10. Complexity Summary

| API | Time | Space |
|---|---|---|
| `makeHandle` / `handleIndex` / `handleGeneration` | O(1), branch-free | 0 alloc |
| `allocEntity` / `freeEntity` | O(1) | 0 alloc |
| `isAlive` | O(1), ≤2 loads + 1 compare | 0 alloc |
| `resolveLocation` | O(1), 2 loads | 0 alloc |
| `commitRecord` | O(1), 2 stores | 0 alloc |
| `spawn` | O(1) + emptyArch.allocRow (amortized O(1)) | 0 alloc (ref pooled) |
| `despawn` | O(1) identity + O(cascade) relations | 0 alloc (BFS queue reused) |
| `reserveEntityBlock(n)` | O(n) | O(n) handle array |
| Identity+record memory | — | `5 × 4 × capacity` bytes (≈ 80 MiB @ 2^22) |

---

## 11. Open Questions Deferred to Other Modules / Milestones

- **Q-H2** (cached `EntityRef` row vs always-resolve): default = always-resolve (§6.4); cached
  mode is an opt-in benchmarked in M2/M3.
- **Q-H3 / Q-C1** (default generation/index split per workload, `maxEntities` target): this
  module exposes the knobs (`generationBits`, `maxEntities`); choosing good per-profile
  defaults is a tuning task, not a design blocker (report §8).
- **v2 `Atomics.sub`-on-`reservedHead`** worker ID take (§5.1 note): deferred; the `dense`-
  stores-full-handles layout (§3.1) is the enabling decision, shipped in v1.
- **v2 record CAS** (§4.2): deferred; `commitRecord` indirection is the enabling decision,
  shipped in v1.
