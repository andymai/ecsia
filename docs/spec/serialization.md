# ecsia Implementation Spec — Module: Serialization & Cross-Worker Transfer

> Module owner: `@ecsia/serialization` (`packages/serialization/src/`) for the copy-based
> snapshot/delta layer, plus a small **worker-bootstrap** surface (`@ecsia/scheduler/workers`
> consumes it) for intra-process zero-copy handoff. Status: implementable. Consumes
> `@ecsia/core` (entity, storage, buffers, reactivity), `@ecsia/relations`, and
> `@ecsia/schema`.
>
> This module owns the **strict separation of two transports**:
>
> 1. **Zero-copy SAB sharing** (intra-process world → worker handoff): the buffer *set* + the
>    schema/ID registry are shared/replicated **once at startup**; component *values* are
>    **never serialized**. This is a manifest + re-wrap protocol, not a codec.
> 2. **Copy-based snapshot + delta** (network/persistence/cross-isolate): a detached
>    `ArrayBuffer` wire format. The **delta is driven by the per-row `changeVersion` version
>    stamps** (reactivity.md §6), **not** a shadow map / epsilon-diff. Stable serialization of
>    **entity handles** (an ID-remap table on deserialize) and **relation pairs**
>    (`[subjectEid][relationId][targetEid][...payload]`, both eids remapped) across the
>    boundary.
>
> Locked-decision provenance and reference-library borrows/rejections are cited inline as
> `DESIGN-RESEARCH.md §x.y` (the report) and as `lib/path:line` (the original source the report
> read). This module **borrows** bitECS's two-phase snapshot + entity-ID remap table
> (`bitECS/src/serialization/SnapshotSerializer.ts:148-216, 238-246`), bitECS's structural-delta
> stream with enum op types (`bitECS/src/serialization/ObserverSerializer.ts:18-25, 159-243`),
> and becsy's transparent SAB/AB handoff (`becsy/src/buffers.ts:96-144`); **adapts** bitECS's
> per-field change-mask diff (`SoASerializer.ts:373-405`) to be driven by ecsia version stamps
> instead of a shadow map (`SoASerializer.ts:284-328`); and **rejects** the bitECS 100 MB static
> backing + per-call `buffer.slice` (`SoASerializer.ts:547, 562`), the double-copy snapshot
> round-trip (`SnapshotSerializer.ts:203-206`), bitECS observer packets that omit values on add
> (`ObserverSerializer.ts:166-168, 202-208`), and the per-event object-tuple observer queue
> (`ObserverSerializer.ts:163`).

---

## 0. Scope & Non-Goals

**In scope (this module owns these contracts):**

1. **Worker bootstrap (zero-copy)**: the `WorldBootstrap` manifest (buffer set + schema/ID
   registry) posted to a worker once at startup; the worker-side `attachWorld` re-wrap; the
   lazily-created-archetype broadcast; and the postMessage-fallback transport variant. (§3)
2. **Snapshot format (copy)**: the exact byte layout (header, registry section, per-archetype
   structure section, per-component SoA section, relations section), the serialize/deserialize
   algorithms, and the **entity-ID remap table**. (§4, §5)
3. **Delta format (copy, version-stamp driven)**: `createDeltaSerializer(sinceTick)`, the
   per-archetype changed-row scan over `changeVersion` (reactivity.md §6.3), the wire records,
   and apply-on-receiver semantics including ID remap and re-targeting of `eid`/pair fields. (§6)
4. **Structural delta stream (copy / observer log)**: the `[tick][op][eid][componentId][...]`
   op-enum record stream that carries structure **with initial values on add** (rejecting the
   bitECS value-less add), used as the postMessage-fallback structural transport and as a
   late-joiner reconstruction source. (§7)
5. **Handle & pair stability across the boundary**: how a `EntityHandle` (and the
   `NO_ENTITY`/`-1` sentinel) and a `(relationId, targetEid)` pair are written, read, and
   remapped so they remain valid on the receiver. (§8)
6. The **buffer discipline** (no static megabuffer; size by entity count; reuse the output
   buffer across ticks; `slice` only at the process boundary). (§9)

**Out of scope (consumed, not owned):**

- The SAB-vs-AB backing decision, `Column`/`Region`/`Backing` types, `exportSharedHandles()`,
  `snapshotInto()`, `sharedBacking()`, length-tracking-view growth — **memory-buffers.md**
  (§3, §6, §7). This module *calls* `exportSharedHandles()` for the bootstrap manifest and
  `snapshotInto()` for the copy layer; it does not allocate backings.
- The `changeVersion` column (allocation, stamping rule, the `changedSince`/`changedRows`
  predicate) — **reactivity.md** (§6). This module *reads* `world.changedRows(archetypeId,
  since)` and `world.changedSince(handle, since)`; it never stamps.
- Entity identity, the two-word record, `isAlive`, handle codec, `NO_ENTITY`, the
  `reserveEntityBlock` worker-ID handshake — **entity-model.md** (§2, §3, §4, §5). This module
  consumes the codec and the sentinel; it does not own them.
- Archetype tables, signatures, column iteration, `archetypeCreated` hook — **archetype-storage.md**.
  This module reads an archetype's signature + columns to serialize; it asks storage to recreate
  archetypes on deserialize.
- Relation pair-ID minting, presence bits, exclusivity split, overflow table —
  **relations.md** (§2-§4). This module reads/writes pair payloads through the relations API
  (`getPair`, `addPair`) and serializes the *logical* `(subject, relationId, target, payload)`,
  never the synthetic pair `ComponentId` (which is receiver-specific and must be re-minted).
- Command-buffer encode/merge/apply, the Atomics wave-sync tiers, `transferList` wave dispatch
  — **scheduler/commands** + **scheduler/workers** (report §6.1/§6.3). This module supplies the
  structural-delta record format those use as the postMessage-fallback transport (§7), and the
  bootstrap manifest the worker dispatch sends once (§3); it does not own the dispatch loop.

---

## 1. How this module satisfies the locked decisions

| Locked decision (report / Must-Fix) | Where satisfied |
|---|---|
| **Separate zero-copy SAB sharing (intra-process) from copy-based snapshot/delta (network/persistence)** (decision #9, §2.9 Layers 1+3) | The two transports are *different code paths with no shared codec*: §3 (zero-copy = manifest + re-wrap, no value bytes) vs §4-§7 (copy = byte format). The single seam is `world.snapshot()` (copy) vs `world.bootstrapForWorker()` (zero-copy). |
| **Delta driven by version stamps, NOT shadow maps** (§2.9 Layer 3, §3 #9, T3) | §6: the delta serializer scans `changeVersion[archetypeId][row] > sinceTick` (reactivity.md §6.3) per archetype — no shadow buffer, no float-epsilon diff. Rejects `SoASerializer.ts:284-328`. |
| **Zero-copy intra-process needs NO value serialization** (§2.9 Layer 1) | §3: the bootstrap manifest carries `{ key, backing(SAB), layout }` from `exportSharedHandles()` (memory-buffers.md §6.3). Workers re-wrap the *same* SAB; component values are read directly. No bytes copied. |
| **SAB requires cross-origin isolation; postMessage fallback REQUIRED** (§3 #9, §7.3) | §3.4 (zero-copy unavailable → bootstrap degrades to a copy snapshot + the structural-delta stream as the per-wave transport, report §7.3); the manifest's `shared` flag tells the worker which path. |
| **Stable serialization of entity handles across the boundary** (§2.9 Layer 3 "entity-ID remap table"; pair eids remapped) | §5.4 + §8: a deserialize-time `Map<oldHandle, newHandle>`; every `eid` field and every pair `(subject,target)` is translated through it in a deterministic two-pass order. Borrows bitECS `SnapshotSerializer.ts:238-246`. |
| **Relations serialized as `[subjectEid][relationId][targetEid][...fields]`, both eids remapped** (§2.9 Layer 3 API) | §4.6 (snapshot relations section), §6.5 (delta pair records), §8.3 (remap of both eids). The synthetic pair `ComponentId` is **never** on the wire — only the stable `(relationId, targetEid)` logical pair, re-minted on the receiver via `addPair` (relations.md §2.2/§5.6). |
| **Bundle initial values on ComponentAdd** (§2.9 "Unlike bitECS, include initial field values on ComponentAdd") | §7.2: `OP_ADD` carries the component's field words; a late joiner reconstructs full state from the stream. Rejects `ObserverSerializer.ts:166-168`. |
| **No 100 MB static backing; reuse output buffer; `slice` only at boundary** (§2.9 buffer discipline) | §9: `SnapshotSerializer` owns a reusable, doubling output `ArrayBuffer`; `snapshotInto` writes per-column via one `set()` (memory-buffers.md §6.4); `slice` only when handing bytes to `postMessage`/disk. Rejects `SoASerializer.ts:547, 562`. |
| **eid storage = full u32 handle bit-pattern, `-1` sentinel, no stale flag** (memory-buffers.md §3.4) | §8.1: `eid` columns serialize as the stored `i32` words verbatim, then remap the unsigned handle; `-1` (`NO_ENTITY`) passes through unremapped. |
| ESM-only, strict TS, all runtimes | §10 public API is `export`ed, no `any` except the wire `DataView` byte cursor; works in browser/Node/worker (the copy path needs no SAB). |

---

## 2. Terminology, units & the two-transport split

- **Word** = 4 bytes = one `Uint32`/`Int32`/`Float32` slot (matching memory-buffers.md §2).
  All wire offsets in this spec are in **bytes** (the wire is byte-addressed via `DataView`),
  but SoA payload sections are word-aligned (every section starts on a 4-byte boundary).
- **Zero-copy transport (Layer 1, §3)**: intra-process, same OS process, SAB-backed. The
  payload is a **manifest of buffer handles** + a **registry** (schema + ID assignment). No
  component value is ever encoded; the worker reads the live SAB columns. Transport =
  `postMessage(manifest)` **once** (SABs are not `Transferable` but are sharable by reference).
- **Copy transport (Layers 2+3, §4-§7)**: cross-process, persistence, network, or non-isolated
  fallback. The payload is **detached `ArrayBuffer` bytes**. Three flavors:
  - **Snapshot** (§4-§5): full world state at a tick (header + registry + structure + SoA + relations).
  - **Delta** (§6): only rows whose `changeVersion > sinceTick`, plus structural ops since the
    tick, as a compact byte stream.
  - **Structural delta stream / observer log** (§7): a record stream of structural ops *with
    initial values*, used as the per-wave postMessage transport and for late-joiner replay.

> **The split is structural, not a flag.** `world.bootstrapForWorker()` returns a
> `WorldBootstrap` (handles, never bytes). `world.snapshot()` / `serializer.delta()` return
> `Uint8Array` bytes (never handles). A caller cannot accidentally serialize values when it
> wanted zero-copy, or share a SAB across a process boundary that cannot accept one — the type
> of the return value enforces the boundary. (Decision #9, report §2.9 Layers 1 vs 3.)

---

## 3. Zero-copy worker bootstrap (Layer 1 — buffer set + schema registry)

The intra-process world handoff to a worker. **No value serialization.** The worker gets (a)
the *same* SAB-backed buffer set by reference, and (b) a replicated *registry* so it can map
`ComponentDef → ComponentId → ColumnKey` identically to the main thread.

### 3.1 The bootstrap manifest

```ts
/** Posted to a worker ONCE at startup. Carries handles + registry, never component values. */
export interface WorldBootstrap {
  /** True iff buffers are SAB-backed and sharable by reference (memory-buffers.md §6.2). */
  readonly shared: boolean;
  /** Handle layout so the worker decodes EntityHandles identically (entity-model.md §2.2). */
  readonly handleLayout: HandleLayout;
  /** Frozen runtime capabilities so the worker takes the same code paths (memory-buffers.md §4.1). */
  readonly capabilities: RuntimeCapabilities;
  /** Buffer set: every column + region SAB, keyed identically on both sides (memory-buffers.md §6.3). */
  readonly buffers: SharedHandleManifest;   // from world.buffers.exportSharedHandles()
  /** Registry: schema + dense ID assignment so worker resolves the same ComponentIds. §3.2. */
  readonly registry: SerializedRegistry;
  /** The world tick at bootstrap time (worker starts reading from here). */
  readonly tick: Tick;
  /** Per-worker pre-reserved entity-ID block seed (entity-model.md §5.1), if dispatching now. */
  readonly reservation?: EntityReservation;
}
```

`SharedHandleManifest` is produced verbatim by `world.buffers.exportSharedHandles()`
(memory-buffers.md §5.1, §6.3) — `{ columns: [{key, backing, layout}], regions: [{key,
backing, element}] }`. On the **SAB path** `backing` is a `SharedArrayBuffer` (sharable by
reference; **not** placed in a `transferList` — that would detach it). On the **postMessage
fallback** there is no zero-copy manifest at all — see §3.4.

### 3.2 The serialized registry (schema + ID assignment)

The registry is the **schema/ID contract**: it lets the worker (and a copy-deserialize
receiver, §5.2) reconstruct the exact `ComponentId`/`RelationId`/field-layout numbering the
producer used. Component **definitions are code on both sides** (the same `defineComponent`
calls run in the worker module), so the registry does **not** ship field *types* — it ships the
**dense ID assignment and the order**, which is the only producer-specific datum.

```ts
export interface SerializedRegistry {
  /** schemaHash: a stable hash of (componentName, fieldName, fieldToken)* in registration order.
   *  The receiver recomputes it from ITS defineComponent set and MUST match (§3.3). */
  readonly schemaHash: number;          // u32, FNV-1a over the canonical schema string
  /** Dense component-id assignment, by registration order = createWorld({components}) order. */
  readonly components: ReadonlyArray<{ readonly name: string; readonly id: ComponentId;
                                       readonly fieldCount: number; readonly storage: StorageStrategy }>;
  /** Dense relation-id assignment + traits (relations.md §2.1). */
  readonly relations: ReadonlyArray<{ readonly name: string; readonly id: RelationId;
                                      readonly exclusive: boolean; readonly hasPayload: boolean;
                                      readonly presenceId: ComponentId }>;
  /** staticString choices tables, replicated (immutable, tiny — memory-buffers.md §6.2). */
  readonly staticStrings: ReadonlyArray<{ readonly componentId: ComponentId;
                                          readonly fieldIndex: number; readonly choices: readonly string[] }>;
  /** Number of fixed-region component-id bits reserved (bitmask stride basis), for sanity check. */
  readonly numComponentTypes: number;
}
```

> **Why pair `ComponentId`s are NOT in the registry.** Pair IDs are minted at runtime per
> `(relationId, targetIndex)` (relations.md §2.2) and are **producer-local** — a receiver mints
> its own when `addPair` runs. The registry carries only the **stable** `relationId` + the
> per-relation `presenceId` (minted eagerly at `defineRelation`, relations.md §3.2). The wire
> never contains a synthetic pair `ComponentId`; it contains the logical `(relationId,
> targetEid)` which the receiver re-mints. (relations.md §5.6 apply-time minting.)

### 3.3 `attachWorld` — worker-side re-wrap (the zero-copy receive)

```
attachWorld(bootstrap: WorldBootstrap) -> WorkerWorldView:
  1. assert bootstrap.shared === true          // else this is the fallback path (§3.4)
  2. recompute localSchemaHash from the worker's own defineComponent set (same module code)
     assert localSchemaHash === bootstrap.registry.schemaHash   // fail-fast; mismatched code
  3. for each component in registry.components:
        bind the worker's local ComponentDef.id := component.id   // align dense IDs
  4. for each region in bootstrap.buffers.regions:
        view := makeView(region.element, region.backing)          // LENGTH-TRACKING, no length arg (memory-buffers V-1)
        workerRegions.set(region.key, { view, backing: region.backing })
  5. for each column in bootstrap.buffers.columns:
        view := makeView(column.layout.element, column.backing)   // LENGTH-TRACKING
        workerColumns.set(column.key, { layout, view, backing })
  6. install handleLayout + capabilities (frozen, identical to main)
  7. workerTick := bootstrap.tick
  8. return WorkerWorldView { columns: workerColumns, regions: workerRegions, ... }
```

- **No value copy.** Step 4/5 wrap the *same* SAB by reference. A read of `Position.x` on the
  worker is a direct indexed load of the shared `Float32Array` — identical to the main thread.
  This is "read-only cross-worker access needs *no serialization*" (report §2.9 Layer 1).
- **Schema-hash gate (step 2).** The worker module and the main module run the *same*
  `defineComponent` source, so IDs would align anyway; the hash gate is a **fail-fast guard**
  against a worker built from stale code (mismatched component set → wrong column keys → silent
  corruption). It is one u32 compare, computed once at attach. Mirrors bitECS's snapshot
  structure-hash discipline (`SnapshotSerializer.ts:148-216`).
- Complexity: O(#columns + #regions) view constructions, once. Zero bytes copied.
  (memory-buffers.md §9: "worker startup transfer — O(#columns + #regions) SAB posts, once".)

### 3.4 Lazily-created archetypes (post-bootstrap columns)

Archetypes are created lazily (memory-buffers.md §6.3; report §4 T4), so columns appear after
bootstrap. When storage creates a new archetype at a **serial flush point**, this module emits a
`ColumnsAdded` notice to workers (a tiny `{ keys, backings, layouts }` postMessage, **not** a
new bootstrap), and each worker re-wraps the new SABs before the next wave (memory-buffers.md
§6.3 "posted to workers when the archetype is first created … the worker re-wraps before the
next wave"). On the **primary resizable path** a *grown* column never triggers this (the SAB
identity is stable — memory-buffers.md §7.2 / B-2); on the **fallback grow** path the
`growFallback` broadcast (memory-buffers.md §7.5) re-broadcasts the new backing, which this
module's worker handler treats identically to a `ColumnsAdded` re-wrap.

> **G-7 notice-applied-before-dispatch guarantee (CANON, world.md §9.9 — stated normatively
> here).** `ColumnsAdded` notices are **drained AND applied** by each worker (via
> `applyColumnsAdded`, §10) **during the inter-wave barrier, BEFORE the next wave dispatches**.
> `scheduler.prepareWave` **guarantees** this ordering: no worker's first system in a wave touches
> a lazily-created column before that worker has re-wrapped its backing. The notice is therefore
> never merely *delivered* — it is applied at the quiescent serial flush point that precedes
> dispatch, so a system that matches a freshly-minted archetype always has a live, correctly-sized
> view of every new column. The same guarantee holds for the fallback `growFallback` re-broadcast.
> (Stated as a partner to scheduler.md §prepareWave; resolves punch-list G-7.)

```ts
export interface ColumnsAdded {
  readonly kind: 'columns-added';
  readonly columns: ReadonlyArray<{ key: ColumnKey; backing: SharedArrayBuffer; layout: ColumnLayout }>;
  readonly registryDelta?: SerializedRegistry['components'];  // if new pair/synthetic IDs were minted
}
```

### 3.5 postMessage-fallback bootstrap (no zero-copy)

When `bootstrap.shared === false` (no cross-origin isolation, memory-buffers.md §4.3; report
§7.3): there is **no shared buffer set**. The worker is instead bootstrapped from a **copy
snapshot** (§4) and kept current by the **structural delta stream** (§7) plus per-wave column
**transfers** (zero-copy `Transferable`, scheduler/workers owns the transfer; this module
supplies the snapshot for the initial state):

```
bootstrapFallback(world, worker):
  1. snap := world.snapshot()                  // §4 — full copy of current state
  2. worker.postMessage({ kind:'bootstrap-copy', registry, handleLayout, snap.buffer },
                        [snap.buffer])          // transfer the snapshot bytes (detached)
  3. worker deserializes snap into a LOCAL world (§5) — a private copy, NOT shared
  4. thereafter: structural changes flow as structural-delta records (§7) over postMessage;
     per-wave the scheduler transfers the columns a batch needs and back (report §7.3).
```

In this mode the worker holds a **private copy** of world state; coherence is maintained by the
delta stream, not by shared memory. This is strictly slower (report §7.3) but the public API and
all wire formats below are **identical** to the network/persistence path — a single copy codec
serves both. (Decision #9; report §7.3 "keeps the public API identical".)

---

## 4. Snapshot format (Layer 3 — copy, full state)

A snapshot is a self-describing, byte-addressed image of the whole world at one tick. Layout is
**five contiguous sections** (header, registry, structure, SoA, relations), each word-aligned.
Borrows bitECS's two-phase (structure-then-data) ordering (`SnapshotSerializer.ts:148-216`) but
writes SoA columns with single `set()` slices from contiguous archetype columns (no per-entity
gather; report §2.9 "single `set()` calls from contiguous archetype column slices").

### 4.1 Byte layout (offsets in bytes from start of buffer)

```
+================================================================+
| SECTION 0 — HEADER (fixed 32 bytes)                            |
+----------------------------------------------------------------+
  off  0  u32  MAGIC            = 0x45435349 ('ECSI')
  off  4  u16  FORMAT_VERSION   = 1
  off  6  u8   ENDIAN           = 1 (little; reader asserts platform LE — §9.4)
  off  7  u8   flags            bit0 = isDelta (0 here), bit1 = hasRelations
  off  8  u32  schemaHash       (must match receiver's registry, §3.3)
  off 12  u32  tick             (world tick at snapshot)
  off 16  u32  aliveEntityCount E
  off 20  u32  archetypeCount   A (archetypes with >=1 row)
  off 24  u32  sectionRegistryOffset
  off 28  u32  sectionStructureOffset
+================================================================+
| SECTION 1 — REGISTRY (variable)                                |
|   sectionSoAOffset, sectionRelationsOffset live at its tail    |
+----------------------------------------------------------------+
  u32 numComponents
    repeat numComponents:  u32 id; u16 nameLen; nameLen bytes (utf8); u16 fieldCount; u8 storage
  u32 numRelations
    repeat numRelations:   u16 id; u16 nameLen; name bytes; u8 traits(bit0 exclusive,bit1 hasPayload); u32 presenceId
  u32 numStaticStringTables
    repeat: u32 componentId; u16 fieldIndex; u16 choiceCount; (u16 len + bytes) per choice
  u32 sectionSoAOffset
  u32 sectionRelationsOffset
+================================================================+
| SECTION 2 — STRUCTURE (per-entity identity + membership)       |
+----------------------------------------------------------------+
  // One record per alive entity, in a DETERMINISTIC order (archetype id asc, then row asc).
  // This order is the canonical "serialization order" the SoA section mirrors (§4.4).
  repeat E:
     u32 handle            // FULL EntityHandle (index <<-packed generation), entity-model §2.2
     u32 archetypeId       // producer-local archetype id (receiver re-derives from signature)
  // Then, per archetype, its signature so the receiver can recreate the archetype:
  repeat A:
     u32 archetypeId
     u32 rowCount
     u16 signatureLen      // number of ComponentIds in the sorted signature
     repeat signatureLen: u32 componentId   // sorted (archetype-storage canonical signature)
+================================================================+
| SECTION 3 — SoA DATA (per-archetype, per-column contiguous)    |
+----------------------------------------------------------------+
  repeat A:                                  // same archetype order as structure
     u32 archetypeId
     u16 columnCount                         // = number of column-bearing components (tags skipped)
     repeat columnCount:
        u32 componentId
        u16 fieldCount
        repeat fieldCount:
           u8  element                       // ElementKind ordinal (memory-buffers §3.1)
           u8  stride
           u32 byteLength                    // = rowCount * stride * elementBytes
           <byteLength bytes>                // ONE set()/copy from view.subarray(0,rowCount*stride)
           (pad to 4-byte boundary)
+================================================================+
| SECTION 4 — RELATIONS (only if flags bit1)                     |
+----------------------------------------------------------------+
  u32 pairCount                              // total live pairs across all relations
  repeat pairCount:
     u32 subjectHandle                       // FULL handle (remapped on deser, §8.3)
     u16 relationId
     u32 targetHandle                        // FULL handle (remapped on deser); NO_ENTITY if cleared
     u16 payloadWords                        // 0 for tag relations
     repeat payloadWords: u32 word           // payload field words (subject-column or overflow, §4.6)
+================================================================+
```

> **Why store both `handle` and `archetypeId` in structure, but re-derive the archetype.** The
> producer's `archetypeId` is producer-local (dense, assignment-order dependent) and is **not**
> portable. The receiver ignores the numeric `archetypeId` for *placement* — it recreates an
> archetype from the **signature** (Section 2's signature list) and gets its *own* dense id. The
> stored `archetypeId` is retained only to *group* entities and SoA columns in the same order on
> both sides (it is the join key between Section 2 entities, Section 2 signatures, and Section 3
> columns). Handles are remapped (§8.2). This is the bitECS structure-then-data + remap model
> (`SnapshotSerializer.ts:148-216, 238-246`), adapted to archetype tables.

### 4.2 `SnapshotSerializer` interface

```ts
export interface SnapshotSerializer {
  /** Serialize the whole world at the current tick into a detached ArrayBuffer (reused, §9). */
  snapshot(): Uint8Array;                 // a view onto the reusable buffer, valid until next call
  /** As above but slice into a fresh buffer safe to transfer/persist (§9.3). */
  snapshotCopy(): Uint8Array;
}
export function createSnapshotSerializer(world: World, opts?: SnapshotOptions): SnapshotSerializer;
export interface SnapshotOptions {
  readonly includeRelations?: boolean;    // default true
  readonly initialOutputBytes?: number;   // default sized from aliveEntityCount * avgRowBytes (§9.1)
}
```

### 4.3 Serialize algorithm

```
SNAPSHOT(world):
  assertMainThreadSerialPhase()                 // structure must be quiescent (memory-buffers V-2)
  cur := outputCursor(reusableBuffer)           // §9: a DataView byte cursor over the reused AB
  // --- header (back-patch offsets after sizing) ---
  writeHeaderPlaceholder(cur)
  // --- registry ---
  cur.mark('registry')
  writeRegistry(cur, world.registry)            // §4.1 Section 1 (from in-memory registry)
  // --- structure: iterate archetypes in id-ascending order for determinism ---
  archs := world.archetypes.filter(a => a.count > 0).sortBy(a => a.id)
  cur.mark('structure')
  for a in archs:
     for row in 0 .. a.count:
        cur.u32(a.handleAt(row))                 // the entity occupying this row
        cur.u32(a.id)
  for a in archs:
     cur.u32(a.id); cur.u32(a.count); cur.u16(a.signature.length)
     for cid in a.signature: cur.u32(cid)        // sorted signature
  // --- SoA data: one set() per column ---
  cur.markAlign4('soa')
  for a in archs:
     cur.u32(a.id); cur.u16(a.columnBearingComponents.length)
     for comp in a.columnBearingComponents:      // tags skipped (no column, memory-buffers §3.3)
        cur.u32(comp.id); cur.u16(comp.fieldCount)
        for field in comp.fields:
           col := a.column(comp.id, field.index)
           n := a.count * field.stride
           cur.u8(elementOrdinal(field.element)); cur.u8(field.stride); cur.u32(n * field.bytesPerElem)
           cur.copyTyped(col.view.subarray(0, n))   // ONE set(); reactivity NOT consulted
           cur.alignTo(4)
  // --- relations ---
  if includeRelations:
     cur.markAlign4('relations')
     pairs := world.relations.allLivePairs()     // iterate back-ref / overflow maps (relations §6)
     cur.u32(pairs.length)
     for p in pairs:                              // p = { subject, relationId, target, payload? }
        cur.u32(p.subject); cur.u16(p.relationId); cur.u32(p.target ?? NO_ENTITY)
        words := payloadWordsFor(p)               // §4.6
        cur.u16(words.length); for w in words: cur.u32(w)
  // --- back-patch header offsets + counts ---
  patchHeader(cur, { E, A: archs.length, schemaHash, tick: world.currentTick(),
                     registryOff, structureOff, soaOff, relationsOff, flags })
  return cur.bytesView()                          // §9: subarray of reusable buffer
```

- **Complexity**: O(E) for structure + O(total column elements) for SoA (one `set()` per
  column = O(rowCount·stride), summed = O(total live field slots)) + O(pairCount) for relations.
  No per-entity gather, no shadow buffer. This is the report's "single `set()` calls from
  contiguous archetype column slices" (§2.9).
- **Quiescence**: serialize runs only at a serial flush point (no worker mid-wave; structure
  immutable), so columns are stable and `view.subarray(0, count)` is exact (memory-buffers
  C-1/V-2). Asserted by `assertMainThreadSerialPhase()`.
- **`eid` columns are copied verbatim** here (the stored `i32` words); remap happens on
  *deserialize* (§5.4), so serialize is a pure memcpy with no per-field translation (fast path).

### 4.4 Determinism

Entity order = (archetypeId asc, row asc). SoA column order = (archetypeId asc, signature order,
field declaration order). Relation order = relations.md iteration order (relationId asc, then
back-ref/overflow insertion order, then sorted by `(subject, target)` to remove map-iteration
nondeterminism). This makes two snapshots of the same logical state **byte-identical** — required
for content-hash dedup, replay tests, and golden-file CI (report §2.9; bitECS lacks this).

### 4.5 Tag components & object fields

- **Tag components** (zero fields, no column — memory-buffers.md §3.3) appear in Section 2
  signatures (membership) but contribute **nothing** to Section 3 (`columnCount` excludes them).
  The receiver re-adds them as pure membership when recreating the archetype from the signature.
- **`object<T>` fields** (`shareable === false`, memory-buffers.md §3.8) are **not serializable**
  by the copy path (no byte representation). A component containing an object field is
  **skipped** in Section 3 with a dev-mode warning, and a `SnapshotOptions.onUnserializable`
  callback (default: warn) lets the app supply a custom encoder. Object fields are also never in
  the zero-copy manifest (they are `restrictedToMainThread`). This is the documented limit of the
  non-shareable escape hatch (report §2.2; type-system.md §1.4 `object` row).

### 4.6 Relation payload extraction

For each live pair `(subject, relationId, target)`:
- **tag** (`storageKind === 'tag'`): `payloadWords = []`.
- **exclusive-column**: read the payload columns on the subject archetype at the subject's row
  (relations.md §4.2) via `getPair(subject, R, target).read()`, encode each field to its word(s).
- **overflow-table**: read the overflow row via `getPair` (relations.md §4.4), encode likewise.

The serializer does **not** know or care which storage shape was used — it calls `getPair(...)
.read()` and walks the relation's payload schema fields, encoding each through the field
descriptor's `encode` (type-system.md §1.4). The wire is storage-shape-agnostic, exactly as the
type system promises (type-system.md §7.3 "storage location … invisible").

---

## 5. Deserialize (snapshot → world) + entity-ID remap

### 5.1 Interface

```ts
export interface SnapshotDeserializer {
  /** Apply a snapshot into `world`. `world` MUST be empty for a clean load, or mode='merge'. */
  load(bytes: Uint8Array, mode?: 'replace' | 'merge'): DeserializeResult;
}
export interface DeserializeResult {
  /** Old-handle → new-handle map (the entity-ID remap table). Exposed for app-level fixups. */
  readonly remap: ReadonlyMap<EntityHandle, EntityHandle>;
  readonly entitiesCreated: number;
  readonly tick: Tick;                    // the snapshot's tick (caller may adopt it)
}
export function createSnapshotDeserializer(world: World): SnapshotDeserializer;
```

### 5.2 Header & registry validation (fail-fast)

```
1. assert MAGIC, FORMAT_VERSION supported, ENDIAN === platform LE (§9.4)
2. recompute localSchemaHash from world.registry; assert === header.schemaHash
   // mismatched component set → refuse rather than silently corrupt (mirrors §3.3)
3. read registry section; build producerId → localDef maps by NAME:
     for each producer component { name, id, fieldCount }:
        local := world.componentByName(name); assert local exists && local.fieldCount === fieldCount
        producerCidToLocal[id] := local.id          // PRODUCER ids → LOCAL ids (they may differ)
     same for relations (by name → local RelationId, presenceId)
   // This is why the wire carries names in the registry: ids are remapped by name, not assumed equal.
```

> **ID portability.** Component/relation **ids are producer-local**; the receiver maps them
> **by name** (registry Section 1) to its own ids. Field *layout* is code on both sides (same
> `defineComponent`), validated by `fieldCount` + `schemaHash`. This is bitECS's snapshot
> name/id reconciliation (`SnapshotSerializer.ts:148-216`) made explicit. Pair `ComponentId`s
> never appear (re-minted via `addPair`, §5.5).

### 5.3 Two-pass entity creation (build the remap table first)

The remap table must be complete **before** any `eid` field or pair is translated, because an
`eid` may forward-reference an entity defined later in the structure section. Two passes:

```
PASS 1 — create entities, build remap (NO field data yet):
  remap := new Map<EntityHandle, EntityHandle>()
  for each (oldHandle, oldArchId) in Section 2 entity list:    // in serialization order
     newHandle := world.spawn()                                // entity-model §6.2; fresh handle
     remap.set(oldHandle, newHandle)
  remap.set(NO_ENTITY, NO_ENTITY)                              // sentinel maps to itself (§8.1)

PASS 1b — recreate archetypes from signatures, place entities, BULK-load columns:
  for each archetype record (oldArchId, rowCount, signature) in Section 2:
     localSig := signature.map(producerCidToLocal)             // remap component ids by name
     // recreate archetype + migrate each of its entities into it in ONE batched move:
     for each entity row r of this oldArchId (Section 2 entity list, in order):
        newHandle := remap.get(oldHandleAt(oldArchId, r))
        world.storage.spawnInto(newHandle, localSig)           // single migration to the full signature
     // bulk-copy SoA: Section 3 columns are contiguous & row-aligned with the placement order
     for each column (componentId, field) in Section 3 for oldArchId:
        localCid := producerCidToLocal[componentId]
        destCol  := archetypeForSig(localSig).column(localCid, field.index)
        destCol.view.set( readTypedSlice(bytes, field) , 0 )   // ONE set() per column
```

> **Why bulk column `set()` works.** The structure section lists entities in (archetype, row)
> order, and PASS 1b places them into the recreated archetype in that **same order**, so row `r`
> in the snapshot maps to row `r` in the new archetype. Therefore the SoA section's contiguous
> column slice can be written with a single `destCol.view.set(slice, 0)` — no per-entity scatter.
> This is the receiver-side mirror of the producer's single-`set()` write (§4.3) and is the
> reason the format pays the cost of a deterministic placement order. (Rejects bitECS's
> double-copy round-trip, `SnapshotSerializer.ts:203-206`.)

### 5.4 Pass 2 — translate `eid` fields through the remap

After columns are bulk-loaded, every `eid` field column holds **producer** handles. Walk each
`eid` column once and remap in place:

```
PASS 2 — remap eid fields:
  for each archetype, for each component with an eid field, for each row:
     stored := eidCol.view[row]                  // i32 word (memory-buffers §3.4)
     if stored === -1: continue                  // NO_ENTITY sentinel (§8.1) — leave as -1
     newHandle := remap.get((stored >>> 0) as EntityHandle)
     if newHandle === undefined:                 // referenced a non-snapshotted entity
        eidCol.view[row] := -1                   // dangling ref → null it (dev-mode warn)
     else:
        eidCol.view[row] := encodeEid(newHandle) // memory-buffers §3.4 encodeEid
```

- Complexity: O(total eid field slots). One pass, in place, no allocation beyond the remap map.
- A producer handle absent from `remap` means it pointed at an entity not in the snapshot
  (filtered out, or a cross-snapshot reference) → nulled to `NO_ENTITY` with a dev warning
  (never a dangling live-looking handle).

### 5.5 Pass 3 — recreate relations (re-mint pairs via `addPair`)

```
PASS 3 — relations:
  for each pair record (subjectH, relationId, targetH, payloadWords) in Section 4:
     subject := remap.get(subjectH);  target := remap.get(targetH)
     if subject === undefined: continue                       // subject not in snapshot → skip
     localRel := producerRelToLocal[relationId]
     if targetH === NO_ENTITY or target === undefined:
        // exclusive relation with a cleared/absent target → re-add with null target if meaningful, else skip
        if localRel.exclusive: world.relations.addPair(subject, localRel.def, NO_ENTITY)  // edge case §8.3
        continue
     payload := decodePayload(localRel, payloadWords)
     world.relations.addPair(subject, localRel.def, target, payload)   // re-mints pair id locally (relations §2.2/§5.6)
```

- `addPair` re-mints the producer-local synthetic pair `ComponentId` on the receiver
  (relations.md §2.2) and recreates the presence bit + back-ref + (overflow/column) payload —
  the whole relation runtime is reconstructed from the *logical* `(subject, relationId, target,
  payload)`, never from the producer's pair id. This is the relations-as-`[subjectEid][relationId]
  [targetEid][...fields]` design (report §2.9 API), with both eids remapped (§8.3).
- Relations are recreated **after** all entities exist (PASS 1) so both subject and target
  resolve; cascade/exclusivity invariants are maintained by `addPair` itself.

### 5.6 `merge` mode

`mode === 'merge'` skips the "world must be empty" precondition: PASS 1 still `spawn()`s fresh
entities (so loaded entities never collide with existing ones — every loaded handle is new), the
remap table is built identically, and existing entities are untouched. This is how a saved
sub-scene is loaded into a running world. `mode === 'replace'` (default) asserts the world has no
alive entities first (caller calls `world.clear()`); it is the load-a-save path.

---

## 6. Delta serialization (Layer 3 — copy, version-stamp driven)

The delta carries only what changed since `sinceTick`: **changed rows** (driven by
`changeVersion`, reactivity.md §6) and **structural ops** (driven by the shape log / a kept
structural record, §7). **No shadow map, no float-epsilon diff** (rejects
`SoASerializer.ts:284-328`).

### 6.1 Interface

```ts
export interface DeltaSerializer {
  /** Emit a delta covering [sinceTick, currentTick]. Advances the serializer's internal cursor. */
  delta(): Uint8Array;                    // view onto reusable buffer (§9)
  deltaCopy(): Uint8Array;
  /** The tick this delta is relative to (its baseline). */
  readonly sinceTick: Tick;
}
export function createDeltaSerializer(world: World, sinceTick: Tick, opts?: DeltaOptions): DeltaSerializer;
export interface DeltaOptions {
  readonly includeStructural?: boolean;   // default true (else value-only delta)
  readonly granularity?: 'component' | 'field';   // matches changeVersion granularity (reactivity §6.2)
}
```

> **Dependency on reactivity.** `createDeltaSerializer` REQUIRES `changeVersion` stamping to be
> enabled for the relevant archetypes. Per reactivity.md §6.1, `changeVersion` is allocated for
> an archetype only if "a delta serializer is attached" — so constructing a `DeltaSerializer`
> **registers a stamping consumer** with reactivity (`world.reactivity.requireChangeVersion()`),
> which turns on `stampingEnabled` and lazily allocates the per-archetype stamp columns. Without
> a delta serializer (or a `.changed` predicate user), zero stamp memory is paid (reactivity.md
> §6.1 opt-in).

### 6.2 Wire layout

```
HEADER (28 bytes): MAGIC, FORMAT_VERSION, ENDIAN, flags(bit0 isDelta=1), schemaHash,
                   baselineTick (= sinceTick), targetTick (= currentTick),
                   structuralSectionOffset, valueSectionOffset
SECTION S — STRUCTURAL OPS (if includeStructural): the structural-delta record stream (§7.2),
            covering ops with tick in (sinceTick, targetTick].
SECTION V — CHANGED VALUES:
   u32 changedArchetypeCount
   repeat:
     u32 archetypeId
     u32 changedRowCount
     u32[] changedRows            // row indices where changeVersion[row] > sinceTick (reactivity §6.3)
     u16 columnCount
     repeat columnCount:
        u32 componentId; u16 fieldCount
        repeat fieldCount:
           u8 element; u8 stride
           // per CHANGED row only (NOT the whole column): gather row slices
           repeat changedRowCount: <stride elements>   // value words for this field at each changed row
```

### 6.3 Delta serialize algorithm (the version-stamp scan)

```
DELTA(world, sinceTick):
  assertMainThreadSerialPhase()
  writeHeader(...)
  if includeStructural: writeStructuralOps(cur, sinceTick, currentTick)   // §7.2 record stream
  // value section, driven PURELY by changeVersion:
  cur.u32(0 /* changedArchetypeCount, back-patched */)
  for a in world.archetypes where a.count > 0:
     rows := [...world.changedRows(a.id, sinceTick)]   // reactivity §6.3: changeVersion[row] > sinceTick
     if rows.length === 0: continue
     changedArchetypeCount++
     cur.u32(a.id); cur.u32(rows.length); for r in rows: cur.u32(r)
     cur.u16(a.columnBearingComponents.length)
     for comp in a.columnBearingComponents:
        cur.u32(comp.id); cur.u16(comp.fieldCount)
        for field in comp.fields:
           col := a.column(comp.id, field.index)
           cur.u8(elementOrdinal(field.element)); cur.u8(field.stride)
           for r in rows:                              // GATHER only changed rows
              cur.copyTyped(col.view.subarray(r*field.stride, (r+1)*field.stride))
  patch(changedArchetypeCount); patch(targetTick)
  this.sinceTick := currentTick                        // advance baseline for next delta()
  return cur.bytesView()
```

- **No shadow buffer.** The "what changed" question is answered by `changeVersion[row] >
  sinceTick` (reactivity.md §6.3), a per-row u32 compare. The serializer keeps **no** copy of
  prior values. This is the report's "Delta = bitECS diff mode **driven by ecsia's version
  stamps**, not a shadow map — no extra shadow memory" (§2.9 Layer 3). The diff *shape* (only
  changed slots on the wire) is borrowed from bitECS `SoASerializer.ts:373-405`; the *trigger*
  (version stamp vs shadow compare) is the ecsia substitution.
- **Granularity.** Default `component`: a changed row emits **all** its fields (the stamp is
  per-row). `field` granularity (reactivity.md §6.2 opt-in) lets the value section emit only the
  changed `(row, fieldIndex)` cells by reading `changeVersion[row*fieldCount+fieldIndex] >
  sinceTick` — a smaller wire at the cost of a field-granular stamp column. v1 default is
  `component`.
- **Complexity.** O(changed rows × fields-per-archetype) for the value section + the structural
  stream cost (§7). It scans every archetype's stamp column to find changed rows: O(total rows)
  worst case; an optional per-archetype "max stamp" early-out (`if archetypeMaxStamp <= sinceTick
  skip`) makes unchanged archetypes O(1) — a documented M10 optimization.

### 6.4 Delta apply (receiver)

```
APPLY_DELTA(world, bytes, remap):       // remap from the bootstrap snapshot's PASS 1
  assert header.baselineTick === world.lastAppliedTick   // ordering guard: deltas apply in sequence
  if structuralSection: applyStructuralOps(world, structuralSection, remap)   // §7.3 — creates/destroys/adds
  for each changed archetype:
     for each changed row r (mapped to the receiver's row for that entity):
        for each column/field: write the value words into the receiver's column at the row
  world.lastAppliedTick := header.targetTick
```

- **Row identity across the boundary.** The receiver does **not** trust the producer's *row*
  index (rows are local). The structural section (§7) carries the **entity handle** for each
  add/create; the value section's rows are joined to entities through the same (archetype,row)
  order the structural section established this delta, OR — for value-only deltas on a stable
  topology — the receiver maintains its own `producerHandle → (localArchetype, localRow)` map
  built from the bootstrap snapshot + prior deltas. The delta value section therefore carries
  rows that the receiver re-resolves to its local row via that map. (Implementation: the value
  section's `changedRows` are producer rows; the receiver maps producer-row→entity-handle via the
  snapshot/structural stream, then handle→local-row via its record.)
- **Ordering.** Deltas MUST apply in tick order (the `baselineTick === lastAppliedTick` guard).
  A gap (lost delta) forces a **resync** via a fresh snapshot (§4) — there is no partial-apply.

### 6.5 Relation deltas

Relation changes (add/remove pair, exclusive re-target, payload change) flow in the **structural
op stream** (§7) for adds/removes, and in the **value section** for exclusive-column payload
*writes* (which are ordinary `writeLog`/`changeVersion` events — relations.md §4.4 "Writing
through `write()` pushes … to the `writeLog` … exactly like a component setter"). Non-exclusive
overflow payload changes are emitted as explicit `OP_PAIR_PAYLOAD` records (§7.2) because they
do not live in an archetype column the changed-row scan covers. Both eids are remapped (§8.3).

---

## 7. Structural delta stream (Layer 2 — op records, values-on-add)

A compact record stream of structural events, op-enum tagged. Used as (a) the postMessage
structural transport in fallback mode (§3.5; report §7.3), (b) the structural section of a delta
(§6.2), and (c) a late-joiner reconstruction source (replay from baseline). Borrows bitECS's
`ObserverSerializer` op enum (`ObserverSerializer.ts:18-25, 159-243`) but **includes initial
field values on add** (rejecting `ObserverSerializer.ts:166-168`) and is **byte-packed, not an
object queue** (rejecting `ObserverSerializer.ts:163`).

### 7.1 Op enum

```ts
// SHARED structural-op ordinals — numeric values are IDENTICAL across command-buffer Op,
// serialization DeltaOp, and reactivity ShapeKind (world.md §9.4). Names differ per spec;
// the ordinals do not.
export const enum DeltaOp {
  EntityCreate    = 0,  // CREATE      — args: handle
  EntityDestroy   = 1,  // DESTROY     — args: handle
  ComponentAdd    = 2,  // ADD         — args: handle, componentId, fieldWords...   (VALUES INCLUDED)
  ComponentRemove = 3,  // REMOVE      — args: handle, componentId
  PairAdd         = 4,  // ADD_PAIR    — args: subjectHandle, relationId, targetHandle, payloadWords...
  PairRemove      = 5,  // REMOVE_PAIR — args: subjectHandle, relationId, targetHandle
  PairPayload     = 6,  // SET_PAYLOAD — args: subjectHandle, relationId, targetHandle, payloadWords...  (overflow/exclusive payload change)
}
```

This is the same op **family** the in-process command buffer uses (command-buffer.md §4:
`Op.CREATE/DESTROY/ADD/REMOVE/ADD_PAIR/REMOVE_PAIR/SET_PAYLOAD`), **plus** the values on
`ComponentAdd`/`PairAdd`. The command buffer (worker→main, intra-process) and this stream
(producer→receiver, cross-boundary) are **distinct structures** — the command buffer is
worker-local plain `ArrayBuffer` applied serially (command-buffer.md, scheduler owns it); this
stream is a portable byte format.

> **Shared structural-op numbering (CANON, world.md §9.4).** The structural-op ordinals are
> **shared across command-buffer `Op`, serialization `DeltaOp`, and reactivity `ShapeKind`** — the
> **numeric values MUST be identical** even though the member names differ per spec:
> `CREATE = 0, DESTROY = 1, ADD = 2, REMOVE = 3, ADD_PAIR = 4, REMOVE_PAIR = 5, SET_PAYLOAD = 6`.
> Thus `DeltaOp.EntityCreate === Op.CREATE === ShapeKind.Create === 0`, and so on through
> `PairPayload === Op.SET_PAYLOAD === ShapeKind.SetPayload === 6`. This spec **states it shares this
> numbering** (world.md §9.4); the shared ordinals enable a single apply-path numbering across the
> three structures. An apply routine consuming records from any of the three sources dispatches on
> the **same ordinal → logical op** with no per-source remapping. (Resolves the punch-list "Op enum
> ordinal drift" item; the earlier "ordinals intentionally do not match / are NOT cross-compared"
> note is retracted.)

### 7.2 Record layout (byte-packed)

```
repeat until section end:
  u8  op
  switch op:
    EntityCreate/EntityDestroy:   u32 handle
    ComponentAdd:                 u32 handle; u32 componentId; u16 fieldWordCount; u32[fieldWordCount]
    ComponentRemove:              u32 handle; u32 componentId
    PairAdd/PairPayload:          u32 subject; u16 relationId; u32 target; u16 payloadWordCount; u32[...]
    PairRemove:                   u32 subject; u16 relationId; u32 target
```

`ComponentAdd` carries the field words read at emit time (the component's current values),
so a receiver with no prior state reconstructs full state from the stream alone — the late-joiner
fix the report mandates (§2.9 "include initial field values on ComponentAdd so late joiners
reconstruct from the stream").

### 7.3 Stream source & apply

- **Source (producer).** The stream is produced by draining the **shape log** (reactivity.md §4)
  over `(sinceTick, targetTick]`: each shape-log entry `(index, componentId, kind, target)` maps
  to an op; for `ComponentAdd`/`PairAdd` the producer additionally reads the entity's current
  field words to attach values. Because the shape log is main-thread/serial (reactivity.md §4),
  this read is quiescent. The producer maps `entityIndex → full handle` via
  `world.generationOf(index)` (reactivity.md §3.3 note) so the wire carries portable full handles.
- **Apply (receiver).** Replays each op against the receiver world through the **same
  validate-then-apply, drop-if-dead** discipline as the command buffer (report §6.1): an op
  referencing an entity dead on the receiver is dropped (dev-warn); `EntityCreate` uses `spawn()`
  and records the producer→local handle in `remap`; `ComponentAdd` migrates + writes the carried
  values; `PairAdd` calls `addPair` (re-minting locally, §5.5). Apply is deterministic (record
  order is the producer's commit order, reactivity.md §9.3).

### 7.4 `createObserverLog` (SAB ring variant, intra-process subscribers)

For intra-process subscribers that want the structural stream **without copying bytes**, this
module exposes a thin wrapper over the reactivity shape log:

```ts
export interface ObserverLog {
  /** A reader cursor; drain returns newly-committed ops since last drain (zero-copy view). */
  drain(): Iterable<DeltaRecord>;     // decoded from the SAB shape-log ring (reactivity §4)
}
export function createObserverLog(world: World): ObserverLog;
```

This is **not** a second log — it is a *view* over reactivity's `log.shape` ring (reactivity.md
§4), decoding entries into `DeltaRecord`s on demand. It exists so the serialization API surface
(`createObserverLog`, report §2.9 API) is honored without duplicating the ring. Cross-process
subscribers use the byte stream (§7.2) instead.

---

## 8. Handle & pair stability across the boundary

### 8.1 EntityHandle on the wire

- An `EntityHandle` is written as its **full u32** (index ⊕ generation, entity-model.md §2.2) —
  never split. The receiver does **not** reuse producer handles; it remaps every one through the
  remap table (§5.3 / §7.3).
- The **`NO_ENTITY` / `-1` sentinel** (entity-model.md §2.5; type-system.md §8) is the single
  null entity in two spellings. On the wire it is written as the **full u32 `0xffffffff`** in
  `handle` slots (Section 2/4 use u32) and as **`-1`** in `eid` *column* words (Section 3, an
  `Int32Array` copy). The remap table seeds `remap.set(NO_ENTITY, NO_ENTITY)` (§5.3) and the
  `eid` remap pass leaves `-1` untouched (§5.4) — so the sentinel survives the round-trip in
  both spellings, consistent with memory-buffers.md §3.4 C-2 and entity-model.md §2.5.
- **Generation is preserved through serialize but discarded on deserialize**: the producer's
  generation is written (it is part of the full handle) but the receiver's `spawn()` assigns a
  *fresh* generation; the remap table is the only correct way to follow a reference. Storing the
  producer generation lets a debugger correlate, and lets a `merge` into the *same* world detect
  a self-reference, but it is never assumed valid on the receiver.

### 8.2 The remap table

`Map<EntityHandle, EntityHandle>` (producer → receiver), built in PASS 1 (§5.3) before any
reference is translated. Every `eid` field (§5.4) and every pair `(subject, target)` (§5.5/§7.3)
is translated through it. A producer handle absent from the map → the reference is nulled
(`NO_ENTITY`) with a dev warning (dangling/cross-snapshot ref). This is bitECS's entity-ID remap
table (`SnapshotSerializer.ts:238-246`) generalized to eid fields + relation pairs.

### 8.3 Relation pairs on the wire

A pair is serialized **logically** as `[subjectHandle][relationId][targetHandle][payload...]`
(Section 4, §4.1; op records, §7.2) — the report's `[sourceEid][relationId][targetEid][...fields]`
(§2.9 API). On deserialize:
1. `relationId` is mapped producer→local **by name** (§5.2).
2. `subjectHandle` and `targetHandle` are mapped through the remap table (§8.2).
3. `addPair(subject, localRelation, target, payload)` re-mints the **receiver-local** synthetic
   pair `ComponentId` (relations.md §2.2) — the producer's pair id is **never** transmitted or
   assumed. Presence bit, back-ref index, exclusivity, and payload storage are all rebuilt by
   `addPair` on the receiver (relations.md §5.2/§5.4/§5.6).
4. Edge cases: a target that maps to `NO_ENTITY`/absent → for an exclusive relation, re-add with
   a null target if the schema permits, else skip with a dev warning (a non-exclusive pair to a
   missing target is meaningless and dropped — matching the command-buffer drop-if-target-dead
   rule, relations.md §5.6).

This is exactly why the wire carries the **stable** `(relationId, targetEid)` and not the
synthetic pair id: pair ids are producer-local (relations.md §2 "producer-local"), so the only
portable, receiver-reconstructable representation is the logical triple. (Decision #7 + §2.9 API.)

---

## 9. Buffer discipline (rejecting the bitECS megabuffer)

### 9.1 Sizing

The snapshot/delta output buffer is sized from `aliveEntityCount * avgRowBytes` (estimated from
registered component sizes), **not** a fixed 100 MB (rejects `SoASerializer.ts:547`). Default
`initialOutputBytes = max(64 KiB, estimatedSnapshotBytes)`; it **doubles on overflow** (report
§2.9 "size by entity count, double on growth"; memory-buffers.md §2.9 doubling).

### 9.2 Reuse across ticks

`SnapshotSerializer`/`DeltaSerializer` each own **one reusable** growable `ArrayBuffer` and a
`DataView` cursor. `snapshot()`/`delta()` return a `Uint8Array` **subarray view** onto that
reused buffer — valid only until the next call (zero per-tick allocation on the hot path; report
§2.9 "reuse the output buffer across ticks"). A caller that needs to retain or transfer the bytes
calls `snapshotCopy()`/`deltaCopy()` (§9.3).

### 9.3 `slice` only at the process boundary

`buffer.slice(0, used)` (the detaching copy) is performed **only** in `*Copy()` and only when the
bytes leave the process (persist to disk, `postMessage` to a non-shared worker as a Transferable,
network send). Intra-process consumers read the reused view directly. This is "`slice` only at the
process boundary" (report §2.9), rejecting bitECS's per-call slice (`SoASerializer.ts:562`).

### 9.4 Endianness

All multi-byte words are written **little-endian** via `DataView` with explicit `littleEndian =
true`, and the header records `ENDIAN = 1`. The deserializer asserts the platform is LE (it
always is on the runtimes ecsia targets) and rejects a big-endian image with a clear error,
rather than silently misreading. SoA payload bytes are copied as raw TypedArray bytes (already in
platform LE), so the LE assertion makes the raw copy correct without per-element byteswap.

---

## 10. Public API (surface this module owns)

```ts
// @ecsia/serialization

// ---- Zero-copy worker bootstrap (Layer 1) ----
export function bootstrapForWorker(world: World, opts?: { reservation?: EntityReservation }): WorldBootstrap;
export function attachWorld(bootstrap: WorldBootstrap): WorkerWorldView;          // worker side
export function applyColumnsAdded(view: WorkerWorldView, notice: ColumnsAdded): void;

// ---- Copy snapshot (Layer 3) ----
export function createSnapshotSerializer(world: World, opts?: SnapshotOptions): SnapshotSerializer;
export function createSnapshotDeserializer(world: World): SnapshotDeserializer;

// ---- Copy delta (Layer 3, version-stamp driven) ----
export function createDeltaSerializer(world: World, sinceTick: Tick, opts?: DeltaOptions): DeltaSerializer;
export function applyDelta(world: World, bytes: Uint8Array, remap: ReadonlyMap<EntityHandle, EntityHandle>): Tick;

// ---- Structural delta stream / observer log (Layer 2) ----
export function createObserverLog(world: World): ObserverLog;
export function encodeStructuralOps(world: World, sinceTick: Tick, targetTick: Tick): Uint8Array;
export function applyStructuralOps(world: World, bytes: Uint8Array, remap: Map<EntityHandle, EntityHandle>): void;

// ---- Types ----
export type {
  WorldBootstrap, SerializedRegistry, WorkerWorldView, ColumnsAdded,
  SnapshotSerializer, SnapshotDeserializer, SnapshotOptions, DeserializeResult,
  DeltaSerializer, DeltaOptions, ObserverLog, DeltaRecord,
};
export { DeltaOp };
export const SERIALIZATION_FORMAT_VERSION = 1;
export const SNAPSHOT_MAGIC = 0x45435349; // 'ECSI'
```

### 10.1 World-level convenience (re-exported on `World`)

```ts
interface World {
  bootstrapForWorker(opts?): WorldBootstrap;     // §3
  snapshot(opts?): Uint8Array;                   // createSnapshotSerializer(this).snapshotCopy()
  loadSnapshot(bytes, mode?): DeserializeResult; // createSnapshotDeserializer(this).load(...)
  clear(): void;                                 // despawn all entities (for mode:'replace')
}
```

---

## 11. Invariants (testable assertions)

- **S-1 (transport separation).** `bootstrapForWorker` returns no byte arrays; `snapshot`/`delta`
  return no SAB handles. Test: assert return types; assert `snapshot()` output is a detached-
  capable `Uint8Array` and contains no `SharedArrayBuffer` reference. (Decision #9.)
- **S-2 (zero-copy = no value copy).** After `attachWorld`, a worker read of a column reads the
  **same** SAB as the main thread. Test: write `Position.x` on main, read on worker via the
  attached view, assert equality with no intervening copy (spy: `set`/`slice` not called on
  bootstrap path). (Report §2.9 Layer 1.)
- **S-3 (delta is version-stamp driven).** The delta value section contains row `r` **iff**
  `changeVersion[archetypeId][r] > sinceTick`. Test: stamp specific rows, assert exactly those
  appear; assert no shadow buffer is allocated by the serializer. (§6.3; rejects shadow map.)
- **S-4 (snapshot round-trip).** `load(snapshot(world))` into an empty world reproduces every
  entity's component values, membership, and relations (modulo remapped handles). Test: golden
  round-trip on a mixed world (scalars, vecs, eid refs, exclusive + non-exclusive relations).
- **S-5 (handle remap correctness).** Every `eid` field and every pair `(subject,target)` on the
  receiver resolves to the **remapped** entity, never a producer handle. Test: snapshot a world
  with cross-references; assert receiver `eid` columns hold receiver handles; assert `NO_ENTITY`/
  `-1` survives. (§8.)
- **S-6 (pair id never on the wire).** No synthetic pair `ComponentId` appears in any byte
  output; relations are `(subject, relationId, target, payload)`. Test: scan snapshot/delta bytes;
  assert only `relationId`s (< numRelations) in relation records; assert receiver re-mints pair
  ids via `addPair`. (§8.3; relations.md §2.)
- **S-7 (values on add).** A `ComponentAdd` structural record carries the component's field words;
  a late joiner replaying from baseline reconstructs full state with no separate value fetch.
  Test: replay structural stream into empty world; assert values present. (§7.2; rejects bitECS.)
- **S-8 (determinism).** Two `snapshot()`s of the same logical state are byte-identical. Test:
  snapshot, mutate-and-revert, snapshot again, assert `Buffer.equals`. (§4.4.)
- **S-9 (buffer reuse, slice only at boundary).** Repeated `snapshot()` allocates no new output
  buffer until overflow; `snapshotCopy()` is the only path that `slice`s. Test: spy on
  `ArrayBuffer` construction and `slice` over 100 snapshots; assert O(log size) growths, slices
  only on `*Copy`. (§9; rejects `SoASerializer.ts:547,562`.)
- **S-10 (schema-hash gate).** `attachWorld`/`load` with a mismatched schema hash throws fail-fast
  rather than corrupting. Test: tamper a registry component name; assert throw. (§3.3, §5.2.)
- **S-11 (quiescence).** Serialize/deserialize run only at a serial flush point; a mid-wave call
  fails a dev assertion. Test: call `snapshot()` with `world.phase !== 'serial'`; assert throw.
  (§4.3; memory-buffers V-2.)
- **S-12 (fallback parity).** The postMessage-fallback bootstrap (§3.5) produces a worker whose
  world state equals the main world's after applying the bootstrap snapshot + a structural delta.
  Test: in a COOP/COEP-less rig (report M0), bootstrap a fallback worker, mutate main, ship a
  delta, assert state parity. (§3.5; report §7.3.)
- **S-13 (G-7 columns-added-before-dispatch).** A `ColumnsAdded` notice is **applied** by every
  worker before any system in the next wave runs; no worker touches a lazily-created column with a
  stale/absent view. Test: mint a new archetype at a flush, dispatch a wave whose system matches
  it, assert each worker re-wrapped the new column before its first read; assert `prepareWave`
  blocks dispatch until all pending `ColumnsAdded` notices are applied. (§3.4; world.md §9.9; G-7.)

---

## 12. Concurrency & memory-ordering summary

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `bootstrapForWorker` (export manifest) | Main only | Serial (startup) | None; `exportSharedHandles` reads stable handles (memory-buffers §6.3). |
| `attachWorld` (worker re-wrap) | Worker | Startup | None; wraps shared SABs by reference; length-tracking views (V-1). |
| `applyColumnsAdded` / fallback grow re-wrap | Worker | Inter-wave barrier (before next dispatch) | None; re-wrap at quiescent point. **G-7 (world.md §9.9):** drained AND applied BEFORE the next wave dispatches; `scheduler.prepareWave` guarantees notice-applied-before-dispatch (memory-buffers §6.3/§7.5). |
| `snapshot` / `delta` (serialize) | Main only | Serial flush | Plain reads of quiescent columns + `changeVersion` (V-2). |
| `load` / `applyDelta` / `applyStructuralOps` | Main only | Serial flush | `spawn`/`addPair`/migrate are main-thread serial (entity-model §3.2, relations §5). |
| `createObserverLog.drain` | Main (or worker reading its shared ring view) | Serial slot | One `Atomics.load` of the shape-log generation per drain (reactivity §3.4). |

**Load-bearing rule (inherited from Must-Fix #1 / T2):** all copy serialization and all
deserialization run on the **main thread at a serial flush point** — never mid-wave — so columns,
records, `changeVersion`, and the relation runtime are all quiescent and read with plain loads.
The only worker-side serialization activity is the **zero-copy attach** (re-wrapping shared SABs,
no value copy) and re-wrapping newly-broadcast columns at serial boundaries. No serialization
path needs an atomic beyond the observer log's once-per-drain generation load.

---

## 13. Open questions deferred (non-blocking, from report §8)

- **Q-SER1 (compression).** v1 ships uncompressed LE byte images. A pluggable
  `SnapshotOptions.codec` (gzip/zstd at the `*Copy` boundary) is a v2 add; the format is already
  block-structured (sections) to compress well.
- **Q-SER2 (partial / filtered snapshots).** v1 snapshots the whole world (or a `merge` sub-load).
  A query-filtered snapshot (only entities matching a query) reuses the same format with a
  filtered entity list in Section 2 — deferred; the format does not need to change.
- **Q-SER3 (delta archetype early-out).** The per-archetype "max stamp <= sinceTick" skip (§6.3)
  needs a per-archetype max-stamp counter; whether reactivity maintains it eagerly or the
  serializer derives it is an M10 tuning choice (reactivity.md §6 owns `changeVersion`).
- **Q-SER4 (cross-version migration).** `FORMAT_VERSION` is in the header; a v1→v2 reader-upgrade
  path (field added/removed between schema versions) is deferred. v1 requires `schemaHash` match;
  evolving schemas across persisted saves is a future migration-tooling concern.
- **Q-CD3 (changed-since-T API shape).** Resolved upstream: `world.changedRows(archetypeId, since)`
  + `world.changedSince(handle, since)` (reactivity.md §6.3) are the canonical predicates this
  module consumes; no new API is introduced here. (Report §8 Q-CD3.)
```