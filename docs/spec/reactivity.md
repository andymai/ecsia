# ecsia Implementation Spec — Module: Change Detection & Observers (Reactivity)

> Reactivity module. Owns the three coherent reactivity layers that ride on **one** log
> infrastructure: (1) the **ring-log + per-system read pointers** that drive the `Changed`
> *query filter* with **no atomic write per field mutation**; (2) the **per-row version
> stamps** consumed ONLY by the public `.changed` predicate and the delta serializer; and
> (3) **deferred observers** (`onAdd`/`onRemove`/`onChange`) dispatched at a serial scheduler
> slot, never synchronously mid-system. It also owns **Added/Removed** structural tracking and
> the **recoverable log-overflow spill** protocol (no hard throw).
>
> Locked-decision provenance and reference-library borrows/rejections are cited inline as
> `DESIGN-RESEARCH.md §x.y` (the report) and as `lib/path:line` (the original source the report
> read). This module **borrows** becsy's SAB ring `shapeLog`/`writeLog` + per-system
> `LogPointer` model (`becsy/src/datatypes/log.ts:29-162`; `becsy/src/system.ts:339,366`) and
> its `QueryFlavor` lazy-allocation (`becsy/src/query.ts:11-14`), **adapts** becsy's `corral`
> single-writer staging (`becsy/src/datatypes/log.ts:65-97`) into a per-worker staging arena
> merged serially, and **rejects** bitECS's synchronous mid-frame observer dispatch
> (`bitECS/src/core/Query.ts:436-494`; `Component.ts:244-249`), becsy's hard-throw-on-overflow
> (`becsy/src/datatypes/log.ts:67`), and bitECS's per-call `Array.from(set).reduce()` notify
> hot path (`bitECS/src/core/utils/Observer.ts:19-23`).

---

## 0. Scope & Non-Goals

**In scope (this module owns these):**

- The **write log** (field-mutation journal) and **shape log** (structural-change journal):
  their SAB ring layout, entry packing, header words, generation-counter wraparound, and the
  per-worker **corral** staging arenas merged serially between waves.
- The **`LogPointer`** type and per-system/per-consumer read-pointer protocol that lets each
  consumer scan only entries appended since its last read.
- The `Changed` / `Added` / `Removed` **query filter** maintenance driven off the two logs
  (the transient per-query delta lists; integration contract with the query module).
- The **per-row `changeVersion` column** (allocation, stamping rule, reset semantics) and the
  two public consumers it exists for: the `.changed`-since-tick **predicate** and the
  **delta serializer**.
- **Deferred observers**: `world.observe(...)`, the `(kind, componentId)` handler dispatch
  table, the `ObserverSystem` serial drain slot, re-entrancy safety, and the rule that
  observer mutations stage to command buffers.
- The **recoverable overflow spill**: double-buffered ring + main-thread spill `Array`,
  drain-and-merge at the serial flush, next-frame ring resize to `2× peak`, dev-mode warning.
- The **worker-safety model** of all of the above: how setters on worker threads stage into
  per-worker corrals with no cross-thread atomic on the hot path, and the single
  `Atomics.load` of the generation counter that synchronizes a consumer per frame.

**Out of scope (owned by other modules; this spec only declares the contracts it consumes or
provides):**

- The accessor classes themselves (the closure-bound getter/setter bodies) — owned by the
  *component* module. This spec defines the **`trackWrite(index, componentId, fieldIndex?)`**
  call those setters MUST emit (the `I-ACC-4` contract from `type-system.md`; canonical signature
  in world.md §9.1) and what it does. The first argument is the **entity index** (`handleIndex(__eid)`,
  the low handle bits), **never** the full generational handle, and field-granular setters
  **forward `fieldIndex`** to drive field-granular `changeVersion` stamping (§6.2).
- Archetype tables, migration column-copy, shuffle-pop — owned by *storage*. This spec defines
  the **`trackShape(eid, componentId, kind)`** hook storage MUST call at the structural commit
  point, and consumes the `(archetypeId, row)` from `resolveLocation` (entity module) to stamp
  `changeVersion`.
- The per-entity membership **bitmask** — owned by *bitmask*. This spec never reads or writes
  the bitmask; `Added`/`Removed` are driven by the shape log, not by diffing bitmasks.
- Command-buffer encode/merge/apply — owned by *scheduler/commands*. This spec defines that
  **applying** a command record on the main thread is what emits the corresponding shape/write
  log entries (so reactivity sees a worker-staged change exactly once, in merge order), and
  the **serial flush point** that is this module's quiescence/drain boundary.
- `LiveQuery` storage (the `current` sparse set), per-archetype matching, hashing — owned by
  *query*. This spec provides the delta lists and the maintenance hooks; query owns the
  result containers.
- Snapshot/delta wire format and ID remapping — owned by *serialization*. This spec provides
  the `changedSince(tick)` iterator and the `changeVersion` column it reads; serialization owns
  the bytes.

---

## 1. Design Constraints This Module Satisfies (Locked Decisions)

| Locked decision (report) | How this module honors it |
|---|---|
| Reactivity: **ring-log + per-system read pointers for the `Changed` FILTER (no atomic write per field)** (§2.7 Layer 1, §3 #8, T3) | `writeLog` is a plain SAB `Uint32Array` ring; setters push `(eid, componentId)` to a **per-worker corral** (no atomic), merged serially. Consumers hold a `LogPointer`; one `Atomics.load` of the generation counter per consumer per frame is the only atomic on the read side. §3, §4, §9. |
| **Per-row version stamps ONLY for the public `.changed` predicate + delta serializer** (§2.7 reconciliation, §3 #8, T3) | `changeVersion: Uint32Array` per archetype column-set, stamped at component granularity. It is **not** consulted by the `Changed` *filter* (that is the log). Read only by `changedSince(tick)` and the delta serializer. §6. |
| **Added/Removed tracking** (§2.4 QueryFlavor, §2.7) | Driven off the **shape log**: structural commit emits `OP_KIND_ADD`/`OP_KIND_REMOVE` entries; the per-query transient `added`/`removed` lists are filled during incremental maintenance, deduped per frame. §5. |
| **Observers DEFERRED to a serial scheduler slot** (no synchronous mid-frame dispatch) (§2.7 Layer 2, §3 #8) | `world.observe(...)` registers a handler in a `(kind, componentId)` table. A single `ObserverSystem` drains the logs from a saved pointer at a scheduler-defined serial slot and dispatches main-thread JS. No setter or migration fires an observer synchronously. §7. |
| **Log overflow recoverable (spill list), not a hard throw** (§2.7 capacity/overflow, §3 #8) | When the ring fills mid-wave, further entries spill into a main-thread `Array`; drained+merged at the serial flush; ring resized next-frame to `2× peak`. Dev-mode warning, production silent. **No throw.** §8. |
| **Write-tracking API = `entity.write(Component)`** (Must-Fix #2) | The `.changed` filter is driven by `trackWrite(index, componentId, fieldIndex?)` (canonical signature, world.md §9.1), called from the mutable accessor setter installed by the component module with `index = handleIndex(__eid)` (low handle bits, never the full handle) and `fieldIndex` forwarded for field-granular setters; the `Readonly` shorthand path never calls `trackWrite`. Scheduler write-intent is the separate `{read,write}` declaration and is **not** this module's concern. §3.2, §3.3, §6.2, §10. |
| **Bitmask is main-thread/serial-only; workers never read it mid-wave** (Must-Fix #1, T2) | This module never touches the bitmask. `Added`/`Removed` come from the shape log, not bitmask diffs. Worker setters write only their own corral (no shared mutation). §9. |
| ESM-only, strict TS, runtimes: all + workers via SAB w/ postMessage fallback (§3 #9, §7.3) | All rings are allocated through `Buffers.region(...)` (memory-buffers module) → SAB when `threaded && crossOriginIsolated`, else `ArrayBuffer`. In postMessage-fallback mode worker corrals travel as Transferables and merge identically. §9.4. |
| Command-buffer applied changes seen by reactivity **exactly once, in deterministic merge order** (§6.1 reactivity interaction) | The shape/write log entries for a worker-staged change are emitted **at apply time on the main thread**, in fixed worker-index merge order — not when the worker staged the command. §9.3. |

---

## 2. Data-Layout Overview (all sizes for the default world)

Default world constants (owned by *world.md* §6 / *entity-model.md* / *memory-buffers.md*,
restated for sizing): `maxEntities = 1 << 20 = 1_048_576` (CANON default, world.md §6.1),
`ENTITY_INDEX_BITS = 22` (handle index field width — `indexBits = 32 - generationBits`, default
`generationBits = 10`), `numComponentTypes` initially registered = `C`. The two reactivity rings
are sized from `maxEntities`.

```
Region (key)            element  initial length        growable  backing            owner-thread
----------------------  -------  --------------------  --------  -----------------  ------------
log.write               u32      maxWritesPerFrame     yes(ring) SAB|AB             main writes;
                                 (default maxEntities*4)          (per-buffers)      workers via corral
log.shape               u32      maxShapeChangesPerFrame yes     SAB|AB             main only
                                 (default maxEntities*2)
log.write.header        i32      4 words (Atomics)     no        SAB|AB             shared
log.shape.header        i32      4 words (Atomics)     no        SAB|AB             main only
changeVersion[A]        u32      per-archetype: count  yes(col)  SAB|AB             main writes
                                 (one slot per row, lazy)        (per-column, §6)   workers may write*
corral.write[w]         u32      maxCorralPerWave      grows(JS) ArrayBuffer        worker w only
                                 (default 4096 entries)
spill.write             u32[]    grows on demand       JS Array  (heap)             main only
spill.shape             u32[]    grows on demand       JS Array  (heap)             main only
```

`*` `changeVersion` is written by a worker only for rows the worker is permitted to write
(scheduler disjoint-write guarantee); it is a plain store of the current frame tick, never an
atomic increment, so two workers never contend a slot (T3). Stamping is OPTIONAL on the worker
hot path — see §6.4.

**Memory @ default capacity.** `log.write` = `maxEntities*4` u32 = `4_194_304 * 4 B = 16 MiB`;
`log.shape` = `maxEntities*2` u32 = `8 MiB` (at the CANON default `maxEntities = 1 << 20`). These
are the documented defaults; both are **configurable** via the `reactivity:{}` sub-object of
`createWorld` (world.md §2.2 nesting — `reactivity.maxWritesPerFrame` /
`reactivity.maxShapeChangesPerFrame`, never flat top-level keys) and the spill protocol (§8) makes
them soft ceilings, not hard ones. (Report §2.7 capacity/overflow.)

---

## 3. The Write Log (field-mutation journal)

### 3.1 Entry encoding (one u32 per write event)

A write entry packs `(entityIndex, componentId)` into a single u32 — the same scheme becsy uses
(`becsy/src/datatypes/log.ts:29-44`, entries pack `entityId | typeId<<bits`) but using the
**entity index** (handle low bits, not the full generational handle) because the consumer only
needs the index to look up the current location and the generation is irrelevant for a
within-frame change record (a stale write to a since-recycled slot is filtered at consume time
by `isAlive` if needed — §3.4).

```
write entry u32 layout (default ENTITY_INDEX_BITS = 22):
  bits [21..0]   entityIndex   (22 bits, up to 4_194_303)
  bits [31..22]  componentId    (10 bits, up to 1023 component types)
```

```ts
const ENTITY_INDEX_BITS = world.handleLayout.indexBits;          // default 22
const ENTITY_INDEX_MASK = (1 << ENTITY_INDEX_BITS) - 1;          // 0x003FFFFF
const COMPONENT_ID_BITS = 32 - ENTITY_INDEX_BITS;                // default 10

function packWrite(index: EntityIndex, componentId: ComponentId): number {
  return ((componentId << ENTITY_INDEX_BITS) | (index & ENTITY_INDEX_MASK)) >>> 0;
}
function unpackWrite(w: number): { index: EntityIndex; componentId: ComponentId } {
  return {
    index: (w & ENTITY_INDEX_MASK) as EntityIndex,
    componentId: (w >>> ENTITY_INDEX_BITS) as ComponentId,
  };
}
```

> **Width interlock (and the unbounded-pair-ID rule).** `ENTITY_INDEX_BITS + COMPONENT_ID_BITS ===
> 32` MUST hold; with the default 22-bit index this caps the **one-word** entry's componentId field
> at `< 2**COMPONENT_ID_BITS` (1023 at the default split). User component types plus relation
> presence/overflow ids are all known at world creation, so that bound is checkable up front. **Pair
> IDs are different**: relations.md §2.2 mints a fresh dense `ComponentId` for every distinct
> `(relationId, targetIndex)` pair, *eagerly and unboundedly, at runtime*, drawn from the same
> `nextComponentId` space (component-schema.md §7.6). A pair-heavy world can therefore push
> `nextComponentId` past `COMPONENT_ID_BITS` long after creation — when a `.changed`-tracked write or
> a structural op on such a pair would overflow word A's componentId field. The fail-fast-at-creation
> guard cannot catch this. The resolved rule (CANON, world.md §9.6, resolves punch-list C2) is
> therefore **two-word by default for any world with relations**: the creation-time fail-fast guard
> is **replaced** by this selection.
>
> - **If `world.relations` is non-empty (any relation registered at `createWorld`), `logEntryWords`
>   defaults to `2`** (§3.5) — the one-word fast path is dropped because pair-ID growth is unbounded.
>   This is decided once at world creation from the *presence* of relations, not from a count, so it
>   is never invalidated by later `mintPair` calls.
> - **If no relations are registered**, the componentId space is fixed at creation
>   (`registry.nextComponentId` after registration, world.md §5.3); the **one-word fast path** is
>   used iff that count fits in `COMPONENT_ID_BITS`, else two-word is selected — validated
>   fail-fast. The one-word path is used **ONLY** in relation-free worlds (world.md §9.6).
> - The explicit `createWorld({ reactivity: { logEntryWords } })` knob still overrides the default in
>   both directions (e.g. force one-word in a relation-using world the author knows stays under the
>   bound — at their own risk, dev-mode asserts `nextComponentId < 2**COMPONENT_ID_BITS` on every
>   `mintPair`). relations.md §2.2 and component-schema.md §7.6 cross-reference this rule.

### 3.2 The header (control words, Atomics-capable)

```
log.write.header : Int32Array length 4 (one cache line is 16 words; we use 4)
  [0] writeHead     : next ring slot to write (main-thread monotonic, wraps via modulo length)
  [1] generation    : increments each time writeHead wraps past length (ring-rollover counter)
  [2] spillCount    : number of entries currently in spill.write (main-thread only)
  [3] peakThisFrame : high-water mark of entries appended this frame (for §8 resize)
```

`generation` is the **only** word a consumer reads atomically: one `Atomics.load(header,1)` per
consumer per frame tells it whether the ring wrapped since its last read (and therefore whether
its saved `LogPointer` is stale and the consumer must treat *everything* as changed — the
conservative overflow response, §3.6). All other header words are touched only on the main
thread / serial phase, so they are plain reads there. (becsy `log.ts:99-140` header model; the
single-atomic-per-frame discipline is T3's resolution.)

### 3.3 Push path (the hot path — NO per-field atomic)

The mutable accessor setter installed by the component module calls `world.trackWrite(index,
componentId, fieldIndex?)` exactly once per setter invocation (`type-system.md` I-ACC-4;
canonical signature world.md §9.1). The setter passes `index = handleIndex(this.__eid)` (the
low handle bits, **never** the full generational handle — passing the raw handle would corrupt
the packed log index) and forwards `fieldIndex` only for field-granular setters (§6.2). On the
**main thread**, `trackWrite` appends directly to the ring; on a **worker thread**, it appends to
the worker's **corral** (a plain `ArrayBuffer`-backed `Uint32Array`, no atomics — §9.1).

```ts
// MAIN THREAD push (serial phase or single-threaded executor).
// `fieldIndex` is the optional field-granular tracking arg (§6.2): it does NOT enter the write
// LOG entry (the log is component-granular by design, §13 edge case 6) — it is forwarded only to
// the changeVersion stamp when field-granular stamping is enabled. The push path ignores it.
function trackWriteMain(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void {
  const h = writeHeader;            // Int32Array
  let head = h[0];                  // writeHead, plain read (single writer)
  if (head >= ring.length) {        // ring full this frame → spill (§8)
    spillWrite.push(packWrite(index, componentId));
    h[2]++;                         // spillCount
    if (++framePushCount > h[3]) h[3] = framePushCount;
    return;
  }
  ring[head] = packWrite(index, componentId);
  h[0] = head + 1;                  // monotonic within frame; reset to 0 at frame start (§3.7)
  if (++framePushCount > h[3]) h[3] = framePushCount;
}
```

Complexity: **O(1)**, one array store + one counter bump. No `Atomics`, no allocation. This is
the load-bearing property that makes "no atomic write per field" true (report §3 #8, T3).

> **Why index not full handle.** Packing the index (not the generational handle) keeps the
> entry to one u32 and lets `componentId` share the word. The generation is recoverable at
> consume time from `world.generationOf(index)` if a consumer needs staleness filtering; most
> consumers do not (a write recorded this frame is to a live entity by construction, because a
> despawn in the same frame emits a shape-log `REMOVE` that the consumer also sees — §5.3).

### 3.4 Consume path (per-system / per-consumer)

Each consumer (a system's `Changed` filter, or the `ObserverSystem`, or the delta serializer)
holds a `LogPointer`:

```ts
interface LogPointer {
  readonly log: 'write' | 'shape';
  cursor: number;        // last ring slot this consumer has read up to (exclusive)
  generation: number;    // ring generation observed at last read
}
```

Consume algorithm (called once per consumer per frame, at the consumer's scheduled slot):

```
CONSUME(ptr, visit):
  1. curGen  = Atomics.load(header, 1)            // the ONE atomic read per consumer/frame
  2. curHead = header[0]                          // plain read (serial phase: main thread)
  3. if curGen !== ptr.generation:                // ring wrapped since last read
        // conservative overflow: we lost entries; consumer must assume worst case
        visit(OVERFLOW_SENTINEL)                  // §3.6 — caller treats all-as-changed
        ptr.cursor = curHead; ptr.generation = curGen; return
  4. for slot in [ptr.cursor, curHead):           // linear scan of new entries only
        visit(ring[slot])
  5. // drain spill entries appended after the ring filled (main thread only)
     for e in spill[ptr.spillCursor .. spillCount):
        visit(e)
        ptr.spillCursor++
  6. ptr.cursor = curHead
```

Complexity: **O(entries-since-last-read)** for this consumer, plus O(spill tail). A consumer
that subscribes to nothing relevant still pays only the scan; to skip even that, the consumer
first checks `hasUpdatesSince(ptr)` (`curHead !== ptr.cursor || curGen !== ptr.generation`),
the becsy `hasUpdatesSince` fast-out (`becsy/src/system.ts:475-493`).

### 3.5 Two-word entry fallback (wide-ID worlds)

The world switches the write log (and the shape log's word A, §4.1) to a **two-word entry** when
either (a) **any relation is registered** (the default, because pair-ID minting is unbounded —
§3.1 Width interlock; world.md §9.6 CANON), or (b) the fixed component count
(`registry.nextComponentId` after registration, world.md §5.3) exceeds `COMPONENT_ID_BITS`, or
(c) `createWorld({ reactivity: { logEntryWords: 2 } })` forces it.
In the two-word form: word A = `entityIndex` (full 32 bits available), word B = `componentId` (full
32 bits — so pair IDs can grow without bound). The ring length is then interpreted in 2-word
records; `packWrite` writes two slots, `unpackWrite` reads two. The shape log's two-word event
becomes a three-word record (word A index, word B componentId, word C `kind|auxTarget`) so its
componentId is likewise unbounded. The selection is made **once at world creation** from the
*presence* of relations (not a runtime count), so it is never invalidated by later `mintPair`
(relations.md §2.2); it is invisible to consumers (they call `unpackWrite`). The corral and spill
formats follow the same word count.

### 3.6 Overflow response on the consume side (lost-entry safety)

The ring is finite; the §8 spill recovers entries **the main thread appended**, but a consumer
that runs *after* the ring wrapped a full generation (its `cursor` was overtaken) has provably
lost precise information. The contract is **fail-safe, not fail-silent**:

- On `curGen !== ptr.generation`, the consumer for a `Changed` filter MUST treat **every entity
  in its matching archetypes as changed this frame** (a conservative superset — never misses a
  real change, may report spurious ones). This is correct-but-imprecise, matching becsy's
  generation-rollover semantics (`becsy/src/datatypes/log.ts:144-162`) and is strictly safer
  than dropping changes.
- The spill (§8) exists precisely so this conservative path is **rare**: spilling lets the main
  thread keep precise entries past the ring capacity within a single frame; generation-wrap only
  happens if a single consumer is starved across many frames, which the per-frame ring reset
  (§3.7) prevents in the normal case.

### 3.7 Frame-boundary reset

At the **start of each frame** (serial phase, before any system runs), the main thread:

```
FRAME_RESET(log):
  world.advanceTick()             // WORLD owns world.tick (world.md §8); reactivity triggers the advance, does NOT hold the counter
  header[3] (peakThisFrame) → recorded into resize controller (§8), then header[3] = 0
  framePushCount = 0
  // ring is NOT zeroed (no memset); writeHead carries forward only if consumers lag.
  // If all consumers have caught up (min(ptr.cursor over all consumers) === writeHead):
  if minConsumerCursor === header[0]:
      header[0] = 0                  // recycle ring from slot 0
      header[1]++ ... NO: generation only bumps on wrap, not reset
      reset every ptr.cursor of caught-up consumers to 0
  // else: leave entries in place; lagging consumer reads them before reset can recycle
```

> **Design note.** The ring is a **per-frame** journal in the common case: most consumers run
> within the frame, so at frame start every pointer equals `writeHead` and the ring resets to
> slot 0 with no wrap and no generation bump. Cross-frame retention only occurs when a consumer
> (e.g. a low-frequency observer or a serializer reading "since tick T") lags — those consumers
> use the **`changeVersion` predicate path** (§6), not the ring, precisely so the ring stays a
> single-frame structure and never needs cross-frame generation gymnastics.

---

## 4. The Shape Log (structural-change journal)

Structurally identical to the write log but records **structural** events (component add/remove,
pair add/remove, entity create/destroy) and is **main-thread only** (all structural mutation is
serial — Must-Fix #1, T2). No corral is needed for the shape log because workers never mutate
structure; they stage commands, and **applying** a command on the main thread is what emits the
shape-log entry (§9.3).

### 4.1 Entry encoding (two u32 words per structural event)

Structural events carry a `kind` that does not fit alongside `index|componentId` in one word, so
the shape log uses **two-word entries**:

```
shape entry (2 × u32):
  word A: bits [21..0] entityIndex, bits [31..22] componentId  (same as write entry)
  word B: bits [2..0]  kind, bits [31..3] reserved/auxTarget
            kind enum — SHARED structural-op ordinals (world.md §9.4; numeric values MUST be
            identical across command-buffer Op, serialization DeltaOp, and reactivity ShapeKind):
              0 OP_KIND_CREATE       entity created (componentId field = NO_COMPONENT = 0)
              1 OP_KIND_DESTROY      entity destroyed (componentId field = NO_COMPONENT = 0)
              2 OP_KIND_ADD          component added to entity
              3 OP_KIND_REMOVE       component removed from entity
              4 OP_KIND_ADD_PAIR     componentId is the synthetic pair id; auxTarget = target index
              5 OP_KIND_REMOVE_PAIR  ditto
              6 OP_KIND_SET_PAYLOAD  pair payload write (componentId = pair id; auxTarget = target index)
```

For pair kinds, word B bits `[31..3]` carry the **target entity index** (29 bits, sufficient for
a 22-bit index space) so observers and serializers can recover `(relationId, subject, target)`
without a side lookup (mirrors the report's structural delta record
`[tick][eid][op][componentId][...]`, §2.9 Layer 2, compacted to two words for the in-process
log).

> **Wide-ID worlds → three-word shape entry.** Word A packs `componentId` into the same
> `COMPONENT_ID_BITS` field as the write log, so it has the **same unbounded-pair-ID exposure**
> (§3.1). When the world is in two-word mode (any relation registered, or count over the bound —
> §3.5), the shape log adds a **third word** holding the full 32-bit `componentId`, and word A's
> componentId field is ignored; word C carries `kind | (auxTarget << 3)`. `packShape`/`unpackShape`
> follow `logEntryWords` exactly as `packWrite`/`unpackWrite` do, so observers and the delta
> serializer never see the difference. For `CREATE`/`DESTROY` the componentId is the
> `NO_COMPONENT = 0` sentinel (world.md §5.1; `ComponentId 0` is never a user component,
> `FIRST_USER_COMPONENT_ID = 1`) in both layouts — the `kind` field disambiguates the
> lifecycle event from a real component op.

```ts
function packShape(index: EntityIndex, componentId: ComponentId,
                   kind: ShapeKind, targetIndex = 0): [number, number] {
  const a = ((componentId << ENTITY_INDEX_BITS) | (index & ENTITY_INDEX_MASK)) >>> 0;
  const b = ((targetIndex << 3) | (kind & 0x7)) >>> 0;
  return [a, b];
}
```

### 4.2 The structural commit hook (storage → reactivity)

The storage module, at the **structural commit point** (after column copies, after the two
entity-record words are written — `entity-model.md` I6), calls exactly one of:

```ts
world.trackShape(index, componentId, ShapeKind.Add);     // entity.add(C) committed
world.trackShape(index, componentId, ShapeKind.Remove);  // entity.remove(C) committed
world.trackShape(index, 0,           ShapeKind.Create);  // spawn committed
world.trackShape(index, 0,           ShapeKind.Destroy); // despawn: emitted BEFORE removeRow AND before identity invalidation (entity-model.md §6.3 steps 1→2)
world.trackShapePair(index, pairId, target, ShapeKind.AddPair);
world.trackShapePair(index, pairId, target, ShapeKind.RemovePair);
```

`trackShape` appends two words to `log.shape` (same push path as §3.3, minus the corral branch —
main thread only). It is **O(1)**.

> **Ordering invariant (matches entity-model despawn ordering, §6.3).** For `Destroy`,
> `trackShape` (and the per-component `enqueueRemoveLog`) MUST be called **before `removeRow`**
> AND before the entity module invalidates the identity (bumps generation). The full fixed
> sequence is: (1) `trackShape(Destroy)` + remove-logs, (2) `removeRow`, (3) bitmask clear,
> (4) `freeEntity` (entity-model.md §6.3). Emitting the log entries before `removeRow` (and
> deferring the row's actual column overwrite when remove-observers exist — §7.4) is what lets
> the shape-log entry, the back-ref cascade, and any deferred observer still resolve the dying
> entity's last location and read its final component values via `resolveLocation`.

### 4.3 A single migration emits the minimal entry set

`entity.add(C)` that migrates A→B emits exactly **one** `OP_KIND_ADD(index, C)` entry — not one
per copied column. The shuffle-popped sibling entity that moved into the vacated row emits **no
shape entry** (its component *set* did not change; only its row did — a row change is invisible
to reactivity, which keys on `(entity, component)` membership, not row). This keeps shape-log
volume proportional to **structural deltas**, not to migration column count (report §2.1
migration protocol; the "fire onRemove via the log, deferred" line).

---

## 5. Added / Removed / Changed Query-Filter Maintenance

The query module owns `LiveQuery` and its `current` sparse set. This module owns the **transient
per-query delta lists** and the maintenance that fills them, driven off the two logs. (Report
§2.4 "change flavors", §2.7 Layer 1; becsy `QueryFlavor` lazy lists `becsy/src/query.ts:11-25`.)

### 5.1 Per-query delta storage (allocated lazily per declared flavor)

```ts
interface QueryDeltaLists {
  // allocated only if the query declares the corresponding flavor (QueryFlavor bitmask)
  added?:   Uint32Array;  addedCount: number;     // entity indices added to the match this frame
  removed?: Uint32Array;  removedCount: number;   // entity indices removed from the match this frame
  changed?: { ptr: LogPointer; dedup: Uint8Array }; // write-log pointer + per-frame dedup bitset
}
```

A query that declares no `added/removed/changed` flavor allocates none of these — **zero cost
for unused flavors** (becsy `query.ts:97-109`). The `changed` flavor holds its own `LogPointer`
into `log.write` and a `dedup` bitset (one bit per entity index in the query's matching set,
sized lazily) so an entity written N times in a frame appears in the `changed` list once
(becsy's `processedEntities` / `changedEntities` dedup, `query.ts:148-150`).

### 5.2 Added/Removed maintenance (off the shape log)

`Added`/`Removed` are computed during **incremental query maintenance**, which runs at the
serial phase after structural changes are applied. The query module already re-tests a single
migrated entity against the queries referencing the changed component (entity-model/query
contract). This module supplies the trigger by draining the shape log:

```
MAINTAIN_STRUCTURAL(frame):                  // serial phase, after command flush (§9.3)
  for each (a, b) in log.shape since maintenancePointer:
     { index, componentId, kind, target } = unpackShape(a, b)
     for q in queriesReferencing(componentId):          // reverse index, query module
        wasMatch = q.current.has(index)
        isMatch  = q.matchesEntityNow(index)             // single-entity matcher, query module
        if  isMatch && !wasMatch:
            q.current.add(index)
            if q.delta.added:   q.delta.added[q.delta.addedCount++] = index
        elif !isMatch && wasMatch:
            q.current.remove(index)
            if q.delta.removed: q.delta.removed[q.delta.removedCount++] = index
  maintenancePointer.cursor = shapeHeader[0]
```

- **Coalescing remove-then-add within a frame.** Because the shape log is drained once at the
  serial flush, an entity that was removed then re-added the same frame ends with
  `isMatch === wasMatch` and produces **no** `added`/`removed` delta — the same net-effect
  coalescing bitECS gets from `toRemove` + `commitRemovals` (`bitECS/src/core/Query.ts:436-494`),
  achieved here by deferring maintenance to one drain rather than a per-event toggle.
- **Complexity.** O(shape-entries × queries-referencing-each-component). The reverse index
  (`queriesReferencing`) bounds the inner loop to subscribed queries only (becsy
  `shapeQueriesByComponent`, `query.ts:148-181`).

### 5.3 Changed maintenance (off the write log)

`Changed` is computed when a `changed`-flavor query is **read** (lazy), draining its own
`LogPointer` into `log.write`:

```
DRAIN_CHANGED(q):
  q.delta.changedCount = 0
  q.delta.dedup.fill(0)              // O(matchingSetSize) — or use a versioned dedup (§5.4)
  CONSUME(q.delta.changed.ptr, (entry) => {
     if entry === OVERFLOW_SENTINEL:        // §3.6 conservative path
        for index in q.current:  emit index   // treat all current matches as changed
        return
     { index, componentId } = unpackWrite(entry)
     if !q.referencesComponent(componentId): return     // not a component this query filters on
     if !q.current.has(index):              return     // entity left the match; ignore
     if q.delta.dedup[index]: return                    // already emitted this frame
     q.delta.dedup[index] = 1
     q.delta.changed[q.delta.changedCount++] = index
  })
```

- A `changed` filter does **not** consult `changeVersion` (§6) — that column exists for the
  *public predicate* and the *serializer*, not the per-system filter (T3). The filter is the
  log.
- **Complexity.** O(write-entries-since-last-read) for this query, with O(1) dedup test.

### 5.4 Dedup without per-frame `fill` (optimization, optional)

`dedup.fill(0)` is O(matchingSetSize) per drain. The optional optimization (becsy-style) stores a
`Uint32Array dedupStamp` and compares against a per-frame `frameTick`: an entry is "already
emitted" iff `dedupStamp[index] === frameTick`; emitting sets `dedupStamp[index] = frameTick`.
This removes the `fill` (no reset needed) at the cost of a u32 per entity. v1 ships the `Uint8Array
+ fill` form (simpler); the stamp form is a measured M5 opt-in.

---

## 6. Per-Row Version Stamps (`changeVersion`)

Exists for exactly **two consumers**: the public `.changed`-since-tick **predicate**
(`world.changedSince(component, tick)` and `entity.read(C).changedAt`) and the **delta
serializer** (`serialization` reads it to emit only changed rows). It is **not** the `Changed`
filter mechanism (that is the log — T3, report §2.7 reconciliation). Keeping it separate is the
whole point of the reconciliation: the hot per-system filter pays no per-field stamp.

### 6.1 Layout

One `changeVersion` column **per archetype** (parallel to that archetype's component columns),
addressed by **row** (not entity index):

```
changeVersion[archetypeId] : Uint32Array, length = archetype.capacity (grows with the archetype)
  changeVersion[archetypeId][row] = the world frame tick at which ANY component of the
                                    entity in `row` was last written (component granularity)
```

- **Granularity: component-level by default** (one stamp per row covers "some component of this
  entity changed"), per the T3 resolution and becsy `registry.ts:425`. Field-granularity (a
  stamp per `(row, fieldIndex)`) is an opt-in (`defineComponent(schema, { changeTracking:
  'field' })`) that allocates a `Uint32Array[count × fieldCount]` instead — Q-CD1, deferred
  tuning, not v1 default.
- It is allocated through `Buffers.column(...)` exactly like a component column, so it inherits
  the **length-tracking resizable-SAB** view contract (memory-buffers V-1): the stamp view
  widens automatically on archetype growth. (Must-Fix #5 path applies unchanged.)
- **Opt-in per archetype.** `changeVersion` is allocated for an archetype only if **at least one
  registered query uses the `.changed` predicate OR a delta serializer is attached**. Worlds with
  no public-`.changed` consumer pay **zero** stamp memory and zero stamp stores (Q-A4 lean:
  per-row column allocated lazily, only when a consumer exists).

### 6.2 Stamping rule

`trackWrite` (§3.3), in addition to pushing the log entry, conditionally stamps:

```ts
function trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void {
  pushWriteEntry(index, componentId);                 // §3.3 — always (component-granular; fieldIndex NOT logged)
  if (stampingEnabled) {                              // only if a .changed predicate/serializer exists
    const { archetypeId, row } = resolveLocation(index);  // entity-model two-word record read
    if (fieldIndex === undefined) {                  // component-granular stamp (default)
      changeVersion[archetypeId][row] = currentFrameTick;
    } else {                                          // field-granular stamp (opt-in, §6.2)
      changeVersion[archetypeId][row * fieldCountOf(componentId) + fieldIndex] = currentFrameTick;
    }
  }
}
```

`fieldIndex` is the same optional argument the public §10 signature
(`world.trackWrite(index, componentId, fieldIndex?)`) exports: default-granular setters omit it;
field-granular setters (the component module's field-granular `entity.write(C).x = …`) pass it.
It affects only the `changeVersion` stamp, never the write-log entry.

- The stamp is a **plain store of `currentFrameTick`**, never an atomic increment, so two workers
  writing disjoint rows never contend (T3). `currentFrameTick` **is `world.tick`** — the single
  frame counter **owned by the world** (world.md §8). Reactivity does **not** own a private
  counter; `frameReset()` (§3.7) advances the tick by calling into the world
  (`world.advanceTick()`), and every reader (stamps, queries, the delta serializer, observers)
  reads `world.tick`.
- Stamping is at **component granularity by default**, so we stamp `changeVersion[archetypeId]
  [row]` (the whole-entity slot) regardless of which `componentId` changed. Field granularity
  uses `changeVersion[archetypeId][row * fieldCount + fieldIndex]` and `trackWrite` must receive
  the `fieldIndex` (the component module's field-granular setter passes it; default-granular
  setters pass none).

### 6.3 Public predicate

```ts
// "did component C on this entity change since tick T?"  (component granularity)
world.changedSince(handle: EntityHandle, since: Tick): boolean {
  const { archetypeId, row } = resolveLocation(handleIndex(handle));
  return changeVersion[archetypeId][row] > since;     // strict > : changes AT `since` are already seen
}
```

`> since` (not `>=`) means a caller that ran at tick `T` and asks `changedSince(T)` gets changes
strictly after `T` (its own writes at `T` are not re-reported). The delta serializer calls the
same predicate per row over an archetype's `count` rows, emitting only `row` where
`changeVersion[archetypeId][row] > sinceTick` — the version-stamp-driven delta (report §2.8
Layer 3 "driven by ecsia's version stamps, not a shadow map").

### 6.4 Worker stamping is optional on the hot path

A worker setter MAY stamp `changeVersion` directly (it has disjoint write access to the row by
the scheduler's guarantee), OR defer stamping to the serial phase by relying on the write log:
at the serial flush, after merging corrals (§9.2), the main thread can replay the merged write
entries and stamp `changeVersion` for each `(index)` with the frame tick. v1 default: **workers
stamp directly** (one extra store, no contention, simplest); the replay-stamp path is the
fallback when `changeVersion` lives in a non-shared `ArrayBuffer` (postMessage mode, §9.4) and the
worker cannot reach it.

---

## 7. Deferred Observers

Observers do **NOT** fire synchronously from a setter or a migration (the rejected bitECS path,
`bitECS/src/core/Query.ts:436-494`; `Component.ts:244-249`). They fire from a dedicated
**`ObserverSystem`** that runs at a scheduler-defined **serial slot** (`'frame-end'` by default,
or at every wave's serial slot if `observerCadence: 'per-system'` — world.md §9.5 CANON; the
scheduler maps `'per-system'` to its per-wave serial-slot dispatch internally). Report §2.7
Layer 2.

### 7.1 Registration API

```ts
type ObserverKind = 'add' | 'remove' | 'change';
interface ObserverHandle { readonly id: number; dispose(): void; }

// term factories (typed, mirror the query DSL)
function onAdd<C extends ComponentDef>(...components: C[]): ObserverTerm;
function onRemove<C extends ComponentDef>(...components: C[]): ObserverTerm;
function onChange<C extends ComponentDef>(...components: C[]): ObserverTerm;

interface World {
  observe(term: ObserverTerm, handler: (e: EntityRef, ctx: ObserverContext) => void): ObserverHandle;
}

interface ObserverContext {
  readonly kind: ObserverKind;
  readonly component: ComponentId;     // which component triggered (for multi-component terms)
  readonly tick: Tick;                 // frame tick of the event
  // for add/change: the entity is alive and its current values are readable via e.read(C).
  // for remove/destroy: e resolves the entity's LAST location (valid until end of this drain),
  //   and the removed component's values are still readable from the pre-removal snapshot (§7.4).
}
```

Multi-component `onAdd(Position, Velocity)` fires when an entity comes to hold **all** listed
components (transitions from not-all to all), matching becsy's add-when-query-entered semantics —
implemented by reusing the query maintenance: the observer subscribes to an internal `LiveQuery`
over the term's components and fires on that query's `added`/`removed` deltas.

### 7.2 Dispatch table

```
observerTable : Map<(kind, componentId), Observer[]>     // keyed pair; one array per (kind, comp)
  Observer = { id, term, handler, internalQuery?: LiveQuery }
```

Registration inserts the observer into the bucket for each `(kind, componentId)` in its term.
Dispatch (the `ObserverSystem`) walks the shape/write logs once and, per entry, looks up the
bucket — **O(events × observers-on-that-(kind,comp))**, no `Array.from`/`reduce` per event (the
rejected bitECS allocation hot path, `Observer.ts:19-23`).

### 7.3 The `ObserverSystem` drain (serial slot)

```
OBSERVER_DRAIN(frame):                          // runs at the serial observer slot
  // structural observers (add/remove) — drain shape log from the observer's saved pointer
  CONSUME(observerShapePointer, (a, b) => {
     { index, componentId, kind, target } = unpackShape(a, b)
     okind = kind∈{ADD,ADD_PAIR} ? 'add' : kind∈{REMOVE,REMOVE_PAIR,DESTROY} ? 'remove' : null
     if okind === null: return                  // CREATE has no per-component observer
     for obs in observerTable.get(okind, componentId) ?? []:
        // multi-component terms: only fire if the entity satisfies the whole term (add)
        //   or just left it (remove) — checked via obs.internalQuery deltas, not re-tested here
        if obs.satisfiesNow(index, okind):
           ref = world.entity(makeHandle(index, generationOf(index)))
           obs.handler(ref, { kind: okind, component: componentId, tick: frame.tick })
  })
  // change observers — drain write log from a separate saved pointer
  CONSUME(observerWritePointer, (entry) => {
     if entry === OVERFLOW_SENTINEL: { fireAllChangeObserversConservatively(); return }
     { index, componentId } = unpackWrite(entry)
     for obs in observerTable.get('change', componentId) ?? []:
        if obs.dedup(index): continue           // dedup repeated writes per frame
        ref = world.entity(makeHandle(index, generationOf(index)))
        obs.handler(ref, { kind: 'change', component: componentId, tick: frame.tick })
  })
```

### 7.4 Re-entrancy safety (mutations inside observers stage to command buffers)

An observer handler MAY call `world.spawn()`, `world.despawn()`, `entity.add/remove`, etc. Because
the `ObserverSystem` runs at a **serial slot** (not mid-wave, not mid-iteration), these mutations
are **staged to the main-thread command buffer** and applied at the **next** serial flush — never
applied synchronously inside the drain loop. This makes the drain loop iterate a **frozen** log
snapshot (`[observerPointer, head)` captured at drain start) so an observer that spawns entities
does not extend the loop it is in. (Report §2.7: "Safe to create/destroy entities inside observers
(mutations staged to command buffers, §7.1)".) Consequence: an entity spawned inside an `onChange`
handler is observed by `onAdd` observers **next frame**, deterministically — never re-entrantly
this frame.

- **Remove/destroy value access.** For `remove`/`destroy`, the observer needs the *pre-removal*
  values. The drain runs **before** the row is physically reclaimed: structural application
  (§9.3) performs the entity-record/identity changes but the *despawn* path defers the row's
  column overwrite until after the observer slot when any observer subscribes to that component's
  removal (a one-frame "stale row" window, the becsy `staleShapes`/`removedShapes` reactivity
  window idea, `becsy/src/registry.ts:83-86, 320-356`, but realized as **deferred row reclaim**
  guarded by "are there remove-observers on this component", not three parallel shape arrays).
  If no observer subscribes to a component's removal, the row is reclaimed immediately (no window
  cost).

### 7.5 Observer pointers and frame boundary

`observerShapePointer` and `observerWritePointer` are advanced to the current head at the end of
`OBSERVER_DRAIN`. If `observerCadence === 'per-system'` (world.md §9.5; the scheduler maps it to
per-wave serial-slot dispatch internally), the drain runs in each wave's serial slot and advances
incrementally; if `'frame-end'` (default) it runs once after the last wave.
Either way, every log entry is observed **exactly once** because the pointer is monotonic and the
generation check (§3.6) catches any wrap.

---

## 8. Recoverable Log Overflow (spill list — NO hard throw)

becsy hard-throws when its fixed log fills (`becsy/src/datatypes/log.ts:67`;
`dispatcher.ts:127`). ecsia **rejects** that (report §2.7 capacity/overflow, §3 #8): a single
frame can legitimately burst (scene load, many merged worker spawns). The ring is a **soft**
ceiling.

### 8.1 Double-buffered ring + main-thread spill

Each log (`write`, `shape`) has:
- the SAB ring (capacity `R`), and
- a main-thread-owned growable JS `Array` **spill** (`spill.write`, `spill.shape`).

When `trackWriteMain`/`trackShape` finds `head >= R` (§3.3), it appends to the spill instead of
throwing and bumps `header[2] = spillCount`. Workers cannot spill (their corral is plain JS and
already growable, §9.1) — a worker corral simply grows its backing `Uint32Array` (allocate-copy)
on its own thread, never touching the shared ring mid-wave; the **merge** at the serial flush is
where overflow against the shared ring is detected and routed to the spill.

### 8.2 Drain-and-merge at the serial flush

At the serial flush (FRAME_RESET or the command-flush point), the main thread, in order:

```
FLUSH_LOGS():
  1. record peak  = max(header[3], header[0] + spillCount)     // entries seen this frame
  2. resizeController.observe(peak)                            // §8.3
  3. (consumers have already drained ring then spill in CONSUME §3.4 — pointers carry spillCursor)
  4. spill.length = 0; header[2] = 0; header[3] = 0            // clear spill, reset peak
  5. header[0] = 0 (if all consumers caught up, §3.7)
```

The spill is drained by every consumer **after** the ring (the `CONSUME` step 5 spill loop,
§3.4), so spill entries are seen in append order **after** ring entries — preserving global event
order (ring slots `[0..R)` then spill `[0..spillCount)` is the true chronological order, because
the spill only began once the ring filled). This ordering is essential for observers and the
serializer (events must be replayed in commit order).

### 8.3 Next-frame ring resize to `2× peak`

```
resizeController.observe(peak):
  if peak > R:                          // we spilled this frame
     pendingResize = nextPow2(peak * 2) // grow to 2× the observed peak
  elif peak < R / 4 and R > minRing:    // chronically under-using
     pendingResize = max(minRing, nextPow2(R / 2))   // shrink (rare; opt-in via config)
```

The actual `Buffers.grow(ring, pendingResize)` happens at the **next FRAME_RESET** (a serial,
quiescent point — V-2 of memory-buffers; no consumer is mid-scan), so views (length-tracking,
§6.1) widen automatically and no consumer holds a stale ring view across the grow. The ring grow
is a `.grow()` on the resizable SAB (primary path) or allocate-copy+rebroadcast (fallback path) —
identical to the column-growth protocol, reused from memory-buffers §7.

### 8.4 Dev-mode diagnostic

```ts
if (DEV && spilledThisFrame) {
  console.warn(`[ecsia] ${log} log overflowed ring (R=${R}); ${spillCount} entries spilled. ` +
    `Peak=${peak}. Ring will grow to ${pendingResize} next frame. ` +
    `Set createWorld({ reactivity: { ${log === 'write' ? 'maxWritesPerFrame' : 'maxShapeChangesPerFrame'}: ${pendingResize} } }) to pre-size.`);
}
```

Production: silent and correct (spill + resize handle it). The config knobs
`maxWritesPerFrame` / `maxShapeChangesPerFrame` live **under the `reactivity:{}` sub-object** of
`createWorld` (world.md §2.2 CANON nesting — surfaced, not buried, but never as flat top-level
keys; report §2.7).

### 8.5 Invariant: overflow never loses a main-thread-appended event

As long as the spill `Array` can grow (heap-bounded, not ring-bounded), **no event appended on the
main thread is lost** — the only lossy path is a *consumer* falling a full generation behind
(§3.6), which the per-frame reset and the spill jointly prevent in normal operation. This is the
"recoverable, not hard throw" guarantee.

---

## 9. Worker-Safety Model

The entire reactivity model is built so the **only** atomic on the hot path is one
`Atomics.load(generation)` per consumer per frame (§3.2). No per-field atomic write, no
per-event lock. This rests on Must-Fix #1 (all structural mutation serial; workers never read the
bitmask) and the command-buffer model (Must-Fix #3).

### 9.1 Per-worker corral (write log staging)

A worker thread cannot append to the shared `log.write` ring concurrently with other workers
without an atomic per push (the thing we are avoiding). So each worker writes to its **own**
corral — a plain `ArrayBuffer`-backed `Uint32Array` owned solely by that worker (becsy `corral`
single-writer staging, `becsy/src/datatypes/log.ts:65-97`, **adapted** from one-corral-per-system
to one-corral-per-worker; report §2.7 reconciliation, "per-worker staging merged serially"):

> **Naming.** "corral" and "per-worker staging arena" are the **same** structure (used
> interchangeably here). The reactivity write-corral (`corral.write[w]`, §2) is the per-worker
> buffer for *write-log* entries; it is a distinct, parallel structure to the scheduler/commands
> spec's per-worker **command buffer** (Must-Fix #3 / commands spec) that stages *structural*
> ops. Both are merged at the serial flush in the same fixed worker-index order (§9.2); the
> commands spec should name its per-worker structural buffer "command buffer", reserving
> "corral" for this write-log staging arena, to avoid two names for one structure across specs.

```
corral.write[w] : Uint32Array (ArrayBuffer, NOT SAB)
  worker w's setter pushes packWrite(index, componentId) here — plain store, O(1), no atomic.
  grows by allocate-copy on its own thread if it fills (never throws, never touches shared ring).
```

Workers do **not** stage `shape` entries — they never mutate structure (they stage structural
*commands*, §9.3). The corral holds only `write` entries (field mutations on rows the worker has
disjoint write access to).

### 9.2 Serial merge of corrals (deterministic order)

Between waves, at the serial flush, the main thread merges corrals into the shared ring in
**fixed worker-index order** (worker 0's corral fully appended, then worker 1's, …) — the same
deterministic merge order as the command buffers (Must-Fix #3, report §6.1):

```
MERGE_CORRALS():
  for w in 0 .. numWorkers-1:                 // fixed order ⇒ deterministic
     c = corral.write[w]
     for i in 0 .. c.count:
        appendToRing(c.data[i])               // routes to ring or spill (§8) as needed
        if stampingEnabled && changeVersionShared:   // optional replay-stamp (§6.4)
           { index } = unpackWrite(c.data[i]); stamp(index, currentFrameTick)
     c.count = 0                              // reset corral for next wave
```

This makes the post-wave write-log content **deterministic regardless of worker completion
order** — essential for replay/test determinism (report §6.1 merge-order rationale). Complexity:
O(total corral entries). No atomics (single-threaded merge).

### 9.3 Command application emits log entries (exactly once, in merge order)

Applying a worker's command buffer (OP_CREATE/OP_DESTROY/OP_ADD/OP_REMOVE/OP_ADD_PAIR/
OP_REMOVE_PAIR — scheduler/commands) is what emits the **shape-log** entries, on the main thread,
at apply time, in fixed worker-index merge order. A worker that staged "add Position to E" does
**not** emit a shape entry on its thread; the main thread emits it when it applies the command and
performs the actual migration (calling `trackShape`, §4.2). Therefore:

- Reactivity sees each structural change **exactly once**, **after** the wave, in deterministic
  order (report §6.1 "reactivity interaction").
- A command dropped by the validate-then-apply drop-if-dead rule (Must-Fix #3) emits **no** log
  entry (the change never happened), so observers never fire for a dropped op.

### 9.4 postMessage-fallback mode

When SAB is unavailable (no cross-origin isolation, §7.3 of the report):
- The shared rings are plain `ArrayBuffer`s (single-process anyway; the main thread owns them).
- Worker corrals travel back to the main thread as **Transferables** (zero-copy `postMessage`
  transfer of the corral's `ArrayBuffer`), and merge identically (§9.2). The worker allocates a
  fresh corral for the next wave (its old one was transferred out).
- `changeVersion` columns are non-shared `ArrayBuffer`s the worker cannot reach, so stamping uses
  the **replay-stamp** path (§6.4 / §9.2 step) on the main thread.
- Observers and the `Changed`/`Added`/`Removed` filters are unchanged — they run on the main
  thread off the (now main-thread-owned) rings. The model is **identical** apart from the corral
  transport. (Report §7.3: postMessage fallback keeps the public API identical.)

### 9.5 What this module never does on a worker

- Never reads or writes the per-entity **bitmask** (Must-Fix #1).
- Never appends to the shared **ring** directly (only to its own corral).
- Never appends to the **shape log** (no worker structural mutation).
- Never fires an **observer** (observers are main-thread, serial-slot only).
- Never calls **`Atomics.add`/`Atomics.or`** on a reactivity structure on the hot path (the only
  reactivity atomic is the consumer's once-per-frame `Atomics.load` of the generation word).

---

## 10. Provided API (surface this module exports)

```ts
// ---- Hot-path hooks (called by component/storage modules) ----
world.trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void;
world.trackShape(index: EntityIndex, componentId: ComponentId, kind: ShapeKind): void;
world.trackShapePair(index: EntityIndex, pairId: ComponentId, targetIndex: EntityIndex,
                     kind: ShapeKind.AddPair | ShapeKind.RemovePair): void;

// ---- Public predicate + delta (serialization/user) ----
world.changedSince(handle: EntityHandle, since: Tick): boolean;
world.changedRows(archetypeId: ArchetypeId, since: Tick): Iterable<number>;   // for delta serializer
world.currentTick(): Tick;

// ---- Observers ----
world.observe(term: ObserverTerm, handler: (e: EntityRef, ctx: ObserverContext) => void): ObserverHandle;
function onAdd(...c: ComponentDef[]): ObserverTerm;
function onRemove(...c: ComponentDef[]): ObserverTerm;
function onChange(...c: ComponentDef[]): ObserverTerm;

// ---- Query-filter integration (called by query module) ----
interface ReactivityQueryHooks {
  attachFlavors(q: LiveQuery, flavors: { added?: boolean; removed?: boolean; changed?: boolean }): QueryDeltaLists;
  drainChanged(q: LiveQuery): Uint32Array;   // returns this frame's changed indices (deduped)
  // added/removed lists are filled by MAINTAIN_STRUCTURAL during serial maintenance
}

// ---- Lifecycle (called by world frame loop / scheduler) ----
interface Reactivity {
  frameReset(): void;            // §3.7 — start of frame; advances world.tick via world.advanceTick() (world.md §8)
  mergeCorrals(): void;          // §9.2 — after a wave (no-op single-threaded)
  maintainStructural(): void;    // §5.2 — after command flush
  observerDrain(): void;         // §7.3 — at the serial observer slot
  flushLogs(): void;             // §8.2 — drain/merge spill, schedule resize
}

// ---- Config (the shape of createWorld({ reactivity: {...} }), public-api.md §2.2) ----
// NORMATIVE NESTING: these are NOT top-level createWorld keys; they are the `reactivity` sub-object
// of WorldOptions (public-api.md §2.2 is the authoritative WorldOptions surface). This interface IS
// `WorldOptions['reactivity']`.
interface ReactivityOptions {
  maxWritesPerFrame?: number;        // default maxEntities*4 ; ring R for log.write
  maxShapeChangesPerFrame?: number;  // default maxEntities*2 ; ring R for log.shape
  observerCadence?: 'frame-end' | 'per-system';      // CANON literal set (world.md §9.5); default 'frame-end'. Scheduler maps 'per-system' to per-wave serial-slot dispatch internally.
  changeTrackingDefault?: 'component' | 'field';      // default 'component' (Q-CD1)
  shrinkRings?: boolean;             // default false ; enable §8.3 shrink branch
  logEntryWords?: 1 | 2;             // default: 2 if any relation registered (unbounded pair IDs, §3.5), else 1
}

// SHARED structural-op ordinals — numeric values are IDENTICAL across command-buffer Op,
// serialization DeltaOp, and reactivity ShapeKind (world.md §9.4). Names differ per spec;
// the ordinals do not. This enables the shared apply-path numbering.
enum ShapeKind { Create = 0, Destroy = 1, Add = 2, Remove = 3, AddPair = 4, RemovePair = 5, SetPayload = 6 }
```

### 10.1 Frame-loop call order (the contract with the scheduler/world)

```
each frame:
  reactivity.frameReset()                 // §3.7 advance world.tick (world.md §8), reset ring heads, snapshot peak
  for each wave:
     run systems (workers stage writes→corral, structural→command buffer)
     reactivity.mergeCorrals()            // §9.2 merge write corrals → ring (deterministic)
     scheduler.applyCommandBuffers()      // emits trackShape entries on apply (§9.3)
     reactivity.maintainStructural()      // §5.2 fill added/removed deltas from shape log
  reactivity.observerDrain()              // §7.3 fire deferred observers (serial slot)
  reactivity.flushLogs()                  // §8.2 drain spill, schedule next-frame resize
```

`changed`-flavor queries are drained **lazily** when the owning system reads the filter
(`DRAIN_CHANGED`, §5.3), not in this loop — so a system that never reads its `changed` filter pays
nothing.

---

## 11. Invariants (enforced; testable at M5)

- **R-1 (no per-field atomic).** The write-log push path (`trackWriteMain`, corral push) performs
  zero `Atomics.*` calls. The only reactivity atomic is `Atomics.load(generation)` once per
  consumer per frame. (T3; M5 test asserts no atomic in the setter→trackWrite→push chain.)
- **R-2 (filter ≠ predicate mechanism).** The `Changed` *query filter* is driven by `log.write`
  only; the public `.changed`-since-tick *predicate* and the delta serializer are driven by
  `changeVersion` only. Neither reads the other's mechanism. (T3, report §2.7.)
- **R-3 (observers never synchronous).** No `trackWrite`/`trackShape` call invokes an observer
  handler. Observers fire only from `observerDrain` at the serial slot. (Report §2.7 Layer 2; M9
  re-entrancy test.)
- **R-4 (exactly-once, deterministic merge order).** Each structural change produces exactly one
  shape-log entry, emitted at command-apply time on the main thread in fixed worker-index order;
  each field write produces exactly one write-log entry, emitted at main-thread push or at corral
  merge in fixed worker-index order. (Report §6.1; M7 determinism/fuzz test.)
- **R-5 (no hard throw on overflow).** A full ring spills to the main-thread `Array`; no code path
  throws on log overflow. No main-thread-appended event is lost (spill is heap-bounded). (Report
  §2.7; M5 overflow-spill-recovery test.)
- **R-6 (worker isolation).** A worker touches only its own corral and its own command buffer on
  the reactivity hot path; it never reads the bitmask, never appends to a shared ring, never fires
  an observer. (Must-Fix #1; M7 test asserts no worker write to shared ring/bitmask.)
- **R-7 (length-tracking views).** `changeVersion` columns and the SAB rings use length-tracking
  views (no explicit length argument) over resizable backings, so growth (§8.3) auto-widens all
  views with no regeneration. (memory-buffers V-1, Must-Fix #5; M2/M5 post-grow validity test.)
- **R-8 (destroy ordering).** `trackShape(Destroy)` is emitted before identity invalidation, so a
  remove/destroy observer can resolve the dying entity's last location. (entity-model despawn
  ordering; M9 test reads a destroyed entity's last component value in an `onRemove` handler.)
- **R-9 (coalescing).** An add-then-remove (or remove-then-add) of the same component on the same
  entity within one frame produces no net `added`/`removed` delta (maintenance is one drain).
  (bitECS toRemove coalescing, achieved by deferral; M5 coalescing test.)

---

## 12. Complexity Summary

| Operation | Cost |
|---|---|
| `trackWrite` push (main or corral) | O(1), no alloc, no atomic |
| `trackShape` push | O(1) (two stores) |
| `changeVersion` stamp | O(1) plain store (when stamping enabled) |
| `changedSince(handle, tick)` predicate | O(1) (one record read + one column read) |
| `CONSUME(ptr)` per consumer | O(entries since last read) + O(spill tail) |
| `DRAIN_CHANGED(q)` | O(write-entries this frame), O(1) dedup |
| `MAINTAIN_STRUCTURAL` | O(shape-entries × queries-per-changed-component) |
| `OBSERVER_DRAIN` | O(events × observers-per-(kind,comp)) |
| `MERGE_CORRALS` | O(total corral entries), single-threaded |
| Overflow spill push | O(1) amortized (JS Array push) |
| Ring resize | O(R) copy, once per `O(log capacity)` grows, at a quiescent serial point |

---

## 13. Edge Cases

1. **Write to an entity despawned earlier the same frame.** The write entry was pushed before the
   despawn's shape entry (commit order). At consume, the `Changed` filter checks
   `q.current.has(index)` (§5.3) — the despawn removed it from `current` during
   `MAINTAIN_STRUCTURAL`, so the stale write is ignored. No `isAlive` call needed in the filter
   hot path; staleness is absorbed by the `current` membership test.
2. **Entity index recycled within the same frame** (despawn then spawn lands on the same slot).
   The write log stores the **index**, not the generation. A consumer that must distinguish the
   two occupants calls `generationOf(index)` and compares; the `Changed` filter does not need to
   (it keys on current membership). The shape log's `CREATE` then `DESTROY` (or vice-versa)
   entries carry the events in order; observers see both, in order, with the correct generation
   recovered at dispatch (§7.3 `makeHandle(index, generationOf(index))`).
3. **Consumer never runs (system disabled).** Its `LogPointer` lags. The ring is not recycled past
   a lagging pointer (§3.7), so entries are retained; if the consumer lags a full generation, it
   gets the conservative `OVERFLOW_SENTINEL` (§3.6) and treats all as changed — correct, imprecise.
   Long-lived "since tick T" consumers (serializers) MUST use the `changeVersion` path (§6), not a
   ring pointer, precisely to avoid pinning the ring.
4. **`changeVersion` tick wraparound** (u32 frame tick wraps after ~4.29e9 frames). At ~60 fps that
   is ~2.27 years of continuous running. On wrap, `changedSince(handle, since)` with a pre-wrap
   `since` could false-negative. Mitigation: at wrap (detected at FRAME_RESET when
   `currentFrameTick === 0xFFFFFFFF`), the world resets all `changeVersion` columns to 0 and tick
   to 0 at a serial flush (O(total rows), once per ~2.27 years; world.md §8 wrap handling) —
   acceptable. Documented; not a v1 hot-path concern.
4b. **Pair-id event with target index > 2^29.** Word B of a pair shape entry carries the target in
   29 bits (§4.1). If the world's index space exceeds 2^29 (only possible with `indexBits > 29`,
   well above the 22 default), pair shape entries switch to a **three-word** form (target gets its
   own word). Selected with `logEntryWords` interlock at world creation (§3.5). Fail-fast.
5. **Observer registered after the frame started.** Registration inserts into `observerTable`
   immediately but the new observer's pointer starts at the **current head**, so it observes only
   events from its registration point forward — it does not retroactively fire for earlier-frame
   events. Documented semantics (matches becsy late-subscriber behavior).
6. **Field-granular tracking on a vec field.** Writing `entity.write(Position).x = 5` stamps
   `changeVersion[arch][row*fieldCount + xFieldIndex]` and pushes one write entry with the
   component id (the field index does not enter the **log** — the log is component-granular even
   when stamps are field-granular, because a `Changed` *filter* is component-granular by design;
   only the *predicate* can be field-granular). The two granularities are independent knobs.
7. **Spill grows unbounded under a pathological frame** (e.g. a system writing every component of
   every entity in a tight loop). The spill is heap-bounded, not ring-bounded, so it does not
   throw — but it will allocate. The dev warning (§8.4) surfaces the peak so the user can either
   raise the ring or fix the system. There is no correctness failure, only memory pressure, which
   is the explicit "recoverable, not throw" trade (R-5).
8. **No reactive consumers at all.** If a world registers no `changed`/`added`/`removed` query
   flavor, no observer, and no serializer, then: `changeVersion` is never allocated (§6.1),
   `stampingEnabled` is false (no stamp store in `trackWrite`), and the logs may even be sized to
   minimum (the rings still allocate for potential `entity.has`-style debugging but at `minRing`).
   The hot path degrades to **just** the `trackWrite` log push, and a future micro-opt MAY elide
   even that when zero consumers exist (deferred; correctness-neutral).

---

## 14. Reference-Library Borrow/Reject Ledger (with citations)

| Technique | Source (file:line) | ecsia decision |
|---|---|---|
| SAB ring `shapeLog`/`writeLog` + `[writeIndex, generation]` header | becsy `datatypes/log.ts:29-162` | **Borrow** — §3, §4 (entry packs `index|componentId`; generation header word). |
| Per-system `LogPointer`, scan only since pointer, `hasUpdatesSince` fast-out | becsy `system.ts:339,366,475-493` | **Borrow** — §3.4 `LogPointer` + `CONSUME`. |
| `corral` single-writer staging before ring commit | becsy `datatypes/log.ts:65-97` | **Adapt** — per-**worker** corral (not per-system), merged serially in worker-index order. §9.1-9.2. |
| `QueryFlavor` bitmask, lists allocated only when declared | becsy `query.ts:11-14,97-109` | **Borrow** — §5.1 lazy `QueryDeltaLists`. |
| `processedEntities`/`changedEntities` Bitset dedup | becsy `query.ts:148-150` | **Borrow** — §5.3 per-query `dedup` bitset. |
| Component-indexed reverse dispatch (`shapeQueriesByComponent`) | becsy `query.ts:148-181` | **Borrow** — §5.2 `queriesReferencing`. |
| `staleShapes`/`removedShapes` reactivity window (3 parallel arrays) | becsy `registry.ts:83-86,320-356` | **Adapt** — realized as guarded **deferred row reclaim** for remove-observers (§7.4), not three arrays. |
| Hard-throw on log overflow | becsy `datatypes/log.ts:67`; `dispatcher.ts:127` | **Reject** — recoverable spill + next-frame resize (§8). |
| Synchronous mid-frame observer dispatch | bitECS `core/Query.ts:436-494`; `Component.ts:244-249` | **Reject** — deferred `ObserverSystem` at serial slot (§7). |
| `Array.from(set).reduce()` notify hot path | bitECS `core/utils/Observer.ts:19-23` | **Reject** — `(kind, componentId)` table walk, no per-event alloc (§7.2). |
| `toRemove` + `commitRemovals` remove-then-add coalescing | bitECS `core/Query.ts:436-494` | **Adapt** — achieved by single deferred maintenance drain (§5.2, R-9), not a toggle list. |
| Per-field change-mask diff driven by version stamps | bitECS `serialization/SoASerializer.ts:373-405` | **Borrow (for serializer only)** — delta driven by `changeVersion`, no shadow map (§6.3). |
| Shadow-map float epsilon comparison for diff | bitECS `SoASerializer.ts:284-328` | **Reject** — version stamps replace shadow memory (T3, §6). |
| Per-row tick stamp on every write as the `changed` filter | (implied "version stamps" reading of decision #8) | **Refine** — stamps used ONLY for predicate+serializer; the filter is the log (T3, §2.7 reconciliation). |

---

## 15. Dependencies & Provided Contracts (summary)

**Depends on:**
- *entity-model* — `EntityHandle`/`EntityIndex`, `handleIndex`, `makeHandle`, `generationOf`,
  `resolveLocation(index) → {archetypeId,row}`, despawn ordering (identity invalidated last),
  `EntityRef`/`world.entity(handle)`.
- *memory-buffers* — `Buffers.region`/`Buffers.column` for the SAB rings and `changeVersion`
  columns; the length-tracking resizable-SAB grow path (V-1, §7); `Atomics`-capable header
  regions; postMessage-fallback Transferable transport.
- *storage* — calls `trackShape`/`trackShapePair` at the structural commit point; provides
  per-archetype `count`/`capacity` for `changeVersion` sizing and `changedRows`.
- *component/type-system* — the mutable accessor setter calls `trackWrite` (I-ACC-4); supplies
  `fieldIndex` for field-granular tracking; `ComponentDef.id`.
- *query* — owns `LiveQuery.current`, `matchesEntityNow`, `queriesReferencing`,
  `referencesComponent`; consumes `QueryDeltaLists`, `drainChanged`.
- *scheduler/commands* — defines the wave/serial-flush boundaries; `applyCommandBuffers` calls
  `trackShape` per applied op; corral merge order matches command merge order (Must-Fix #3).
- *bitmask* — **none** (deliberately; this module never touches the bitmask, Must-Fix #1).

**Provides:**
- Hot-path hooks `trackWrite`/`trackShape`/`trackShapePair`.
- Public `changedSince`/`changedRows`/`currentTick` for serialization + user `.changed`.
- `world.observe` + `onAdd`/`onRemove`/`onChange` deferred observers.
- `ReactivityQueryHooks` (`attachFlavors`/`drainChanged`) for the query module's filter flavors.
- Frame-loop lifecycle (`frameReset`/`mergeCorrals`/`maintainStructural`/`observerDrain`/
  `flushLogs`).

---

## 16. Open Questions (non-blocking; tuning during M5/M7/M9)

- **Q-CD1** (`onChange` granularity component vs field): default component (§6.2); field-granular
  is an opt-in. Decide default per benchmarked log-volume cost.
- **Q-CD3** (exact "all entities where C changed since T" API): provided as `changedRows`
  (archetype-scan over `changeVersion`); a cross-archetype convenience iterator is a thin wrapper
  to confirm at M10.
- **Q-S2** (observer cadence `'frame-end'` vs `'per-system'`): CANON literal set is
  `'frame-end' | 'per-system'` (world.md §9.5), default `'frame-end'`; `'per-system'` enables
  between-wave observation at higher drain cost (the scheduler maps it to per-wave serial-slot
  dispatch internally). Tune at M9.
- **Q-A4** (`changeVersion` per-row vs per-archetype): spec chooses **per-row, lazily allocated
  only when a public-`.changed` consumer exists** (zero cost otherwise); per-archetype (coarser,
  false positives) not pursued in v1.
- **Dedup form** (Uint8 `fill` vs versioned stamp, §5.4): ship `fill`; benchmark the stamp variant
  at M5.
- **Spill shrink policy** (§8.3 shrink branch): off by default; confirm whether chronic
  over-provisioning warrants auto-shrink at M5.
