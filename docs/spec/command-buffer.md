# ecsia Implementation Spec — Module: Command Buffer & Deferred Structural Changes

> Module owner: `@ecsia/scheduler` (`packages/scheduler/src/commands/`). The encoding lives in
> `scheduler/commands`, but its data format is **shared** with `core/storage` (the apply path)
> and `observers` (which drains the same reactivity logs). The kernel runs single-threaded
> **without** `scheduler`; the command buffer is the seam that makes structural mutation
> *parallel-ready* while keeping every actual table/record/bitmask mutation **serial on the
> main thread** (report §5.1 dependency note; §4 T2).
>
> Status: implementable. This module **resolves Must-Fix #3 in full** (report §7 Must-Fix list;
> §6.1). It owns: the per-worker command-buffer layout (SAB vs plain array), the op encoding and
> exact record byte layout, the flush + deterministic merge sequence between scheduler waves, and
> the entity-reference **safety invariant** (validate-then-apply, drop-if-dead, with a tombstone +
> skip-with-diagnostic path for the in-flush deletion hazard).
>
> Citations: `DESIGN-RESEARCH.md §x.y` is the report; `lib/path:line` is the original reference
> source the report read; `entity-model.md §x`, `archetype-storage.md §x`, `relations.md §x`,
> `memory-buffers.md §x`, `type-system.md §x` are the sibling specs whose contracts this module
> honors **verbatim**.

---

## 0. Scope & Non-Goals

**In scope (this module owns these contracts):**

1. The `CommandBuffer` per-worker structure: its **plain `ArrayBuffer`-backed `Uint32Array`**
   backing (NOT a SAB, report §6.1 "Who owns the buffers under SAB"), growth, reset, and the
   write-head cursor. (§3)
2. The **op opcode set**, their argument arity, and the **exact word-by-word record byte layout**
   (offsets, word sizes, variable-length payload tails). (§4)
3. The **encode API** workers call mid-wave (`cb.create()`, `cb.destroy(h)`, `cb.add(...)`,
   `cb.remove(...)`, `cb.setRelation(...)`, `cb.setPayload(...)`) and how each appends a record. (§5)
4. The **entity-ID reservation handshake** with the entity module (`reserveEntityBlock` /
   `returnReservedIds`, entity-model.md §5) so `OP_CREATE` returns a usable handle mid-wave. (§6)
5. The **flush + deterministic merge** sequence run by the main thread between waves: fixed
   worker-index order, in-buffer append order, single-threaded apply, reactivity emission. (§7)
6. The **entity-reference safety invariant**: validate-then-apply, drop-if-dead, the **tombstone
   set** that catches an op referencing an entity *another command in the same flush* deleted, and
   the dev-mode diagnostic. (§8)
7. The **multi-id migration contract** this module *requires* storage to provide
   (`migrateAddingMany` / `migrateRemovingMany`, archetype-storage.md §5.6a) and *how* the apply
   path coalesces a worker's adds/removes per entity into those calls. (§9)

**Out of scope (consumed from / handed to other modules):**

- The free-list, `allocEntity`/`freeEntity`, `isAlive`, `reserveEntityBlock` body, lifecycle
  hooks, the two-word record commit — **entity-model.md**. This module *calls* `reserveEntityBlock`
  / `returnReservedIds` / `spawn` / `despawn` / `isAlive` and never touches the free-list directly.
- `migrate` / `migrateAddingMany` / `migrateRemovingMany` / `allocRow` / `removeRow` / the edge
  graph / the bitmask — **archetype-storage.md**. This module routes applied ops into those
  primitives; §9 specifies the contract they must satisfy.
- Pair-ID minting, the exclusivity split, the back-ref index, cascade BFS, the apply-time
  `addPair`/`removePair` bodies — **relations.md §5**. This module decodes `OP_ADD_PAIR` /
  `OP_REMOVE_PAIR` and calls `relations.addPair` / `relations.removePair`; it does **not** mint
  pair IDs (the main thread mints at apply time — relations.md §5.6).
- Column backing/growth, length-tracking views, SAB-vs-AB selection — **memory-buffers.md**. The
  command buffer's own backing is a plain `ArrayBuffer` and does NOT participate in the
  resizable-SAB column protocol (§3.1).
- The wave scheduler / DAG / Atomics wave-sync — **scheduler/workers** spec (report §6.3). This
  module is *driven by* the scheduler: the scheduler resets buffers before a wave, dispatches
  systems, waits on the wave fence, then calls `flushAll()` (§7) between waves. The Atomics
  counter for wave completion is the workers spec's concern, not this one.
- Reactivity ring layout, `LogPointer`, version stamps — **reactivity** spec. Applying a record
  *emits* `shapeLog`/`writeLog` entries through the entity/storage lifecycle hooks (which already
  push to those logs); this module guarantees emission happens **once, in merge order, on the main
  thread, after the wave** (report §6.1 "Reactivity interaction").

---

## 1. How this module satisfies the locked decisions

| Locked decision / Must-Fix (report) | Where satisfied in this spec |
|---|---|
| **Must-Fix #3** — per-worker plain (non-SAB) command buffers; opcode layout §6.1; pre-reserved ID blocks for mid-wave `OP_CREATE`; deterministic merge in fixed worker-index order; validate-then-apply, drop-if-dead | §3 (backing), §4 (opcode layout), §6 (reservation), §7 (merge), §8 (safety invariant). |
| Workers may NOT mutate tables/records/idpool/bitmask mid-wave; structural intents staged to buffers, applied between waves (Must-Fix #1 / T2) | §5 (encode-only, no mutation), §7 (main-thread serial apply), §10 (concurrency table). |
| Command buffer is the **parallel-ready seam**; correct single-threaded executor first (decision: scheduler) | §2.2 (main-thread direct-apply fast path), §7.1 (single-thread degenerate flush). |
| Storage = bitmask is main-thread/serial-only; record commit is plain store (no CAS in v1) | §7.4 (apply runs in `world.phase === 'serial'`); no atomics on apply (§10). |
| Relations: integer pair IDs; payload split by exclusivity; presence bit; cascade on delete | §4.5 (`OP_ADD_PAIR`/`OP_REMOVE_PAIR` carry `relationId` + `targetEid` + payload words), §9.3 (route to `relations.addPair`/`removePair`). |
| Reactivity: structural changes visible exactly once, deterministic, after the wave | §7.5 (emission ordering); §8.4 (dropped ops emit no reactivity). |
| Generational handle, two-word record is the structural commit point; `NO_ENTITY = 0xffffffff` | §4.1 (eids stored as full u32 handle bit-patterns); §6 (reserved handles are full handles). |
| `entity.write(C).x = 5` is the tracked-mutation handle (Must-Fix #2) | §5.6 (`setPayload` is the deferred analogue: a worker's payload words become the initial column values on apply); §4.3 (per-component field words). |
| ESM-only, strict TS, SAB + postMessage fallback (decision #9) | §3.1 (plain AB backing works identically in every runtime); §7.6 (postMessage-fallback transport note). |

---

## 2. Position in the execution model

### 2.1 The two phases

`world.phase` is `'serial'` (main thread, between waves — structural mutation legal) or `'wave'`
(workers executing — structural mutation illegal) (archetype-storage.md §2 "Phase"). The command
buffer exists to bridge a structural *intent* raised during `'wave'` to a structural *application*
performed during the following `'serial'` phase.

```
   ── serial ──┐                      ┌── serial ──┐                       ┌── serial ──
   (flush prev │   ──── wave N ────   │ flush wave │   ──── wave N+1 ───   │ flush N+1
    + reserve) │  workers encode ops  │ N (merge + │  workers encode ops  │  ...
               │  into per-worker CBs  │  apply +   │  into per-worker CBs │
               │                      │  emit logs)│                       │
   ───────────┘                      └────────────┘                       └────────────
```

- **Before a wave** (serial): the scheduler resets each participating worker's buffer (write head
  → 0, §3.4) and calls `reserveEntityBlock` (§6) to top up each worker's ID block.
- **During a wave** (`'wave'`): workers append records (§5). No shared mutation; the buffer is
  worker-local (§3.1).
- **After a wave** (serial): the scheduler calls `flushAll()` (§7). The main thread merges buffers
  in fixed worker-index order, applies each record (validate-then-apply, §8), and returns unused
  reserved IDs (§6.3).

> **Q-S2 (apply cadence).** The report leaves "apply between every wave vs only at frame end"
> open (report §8 Q-S2). This module specifies the **mechanism** (one `flushAll()` per call) and
> lets the scheduler choose the cadence: v1 default is **flush after every wave** so observers can
> fire between waves (report §6.1 "Reactivity interaction"; §2.7). A frame-end-only cadence is a
> drop-in (`flushAll()` is just called less often); the safety invariant (§8) is independent of
> cadence because tombstones are scoped to a single `flushAll()` call (§8.2).

### 2.2 Main-thread direct-apply fast path (single-threaded correctness first)

The locked decision is "CORRECT SINGLE-THREADED executor first; parallel-READY seams". So the
command buffer has a **bypass**: when a structural op is requested on the **main thread during the
serial phase** (e.g. `world.spawn()`, `entity.add(C)` called outside a worker), it is applied
**immediately and synchronously** — it does NOT go through a command buffer (report §8 Q-A3:
"Main thread: may be synchronous").

```ts
function structuralOp(op: StructuralIntent): void {
  if (world.phase === 'serial' && isMainThread()) applyDirect(op);   // synchronous fast path
  else currentWorkerBuffer().encode(op);                              // deferred (worker, mid-wave)
}
```

- `applyDirect` runs the exact same apply body as the flush path (§9), so there is one apply
  implementation, exercised by both. This is the "correct single-threaded first" guarantee: the
  whole engine works with zero command buffers if no worker is ever spawned.
- A worker mid-wave (`world.phase === 'wave'`, `!isMainThread()`) always defers. A dev-mode guard
  asserts a worker never reaches `applyDirect` (entity-model.md I10: workers never call
  `allocEntity`/`commitRecord`).

---

## 3. Per-worker command-buffer structure

### 3.1 Backing: plain `ArrayBuffer`, never SAB

Each worker owns **one** `CommandBuffer`. Its backing is a **plain, growable `ArrayBuffer`-backed
`Uint32Array`** — explicitly **NOT** a `SharedArrayBuffer` (report §6.1 "The buffers are **not**
SAB"). Rationale, verbatim from the report: the buffer is written *only* by its owning worker and
read *only* by the main thread *after* the wave, so **no cross-thread concurrent access ever
occurs** and **no atomics are needed**. This avoids the entire class of concurrent-write hazards.

```ts
export interface CommandBuffer {
  /** Worker index this buffer belongs to (0..workerCount-1). Fixes merge order (§7.2). */
  readonly workerIndex: number;

  /** u32 words. Plain ArrayBuffer backing (NOT SAB). Grows by doubling (§3.3). */
  words: Uint32Array;

  /** Write head: index of the next free u32 slot. Reset to 0 each wave (§3.4). */
  head: number;

  /** The worker's current reservation block (entity-model.md §5.1). Consumed by OP_CREATE. */
  reservation: EntityReservation;
  /** Cursor into `reservation.handles`: next unused reserved handle. */
  reservationCursor: number;

  /** Count of records appended this wave (diagnostics / merge bound). */
  recordCount: number;
}
```

- The backing is a plain `Uint32Array` over an `ArrayBuffer`; it has **no** length-tracking /
  resizable-SAB obligations (memory-buffers.md V-1 applies only to *column* views, not to this
  buffer). Growth is the simple allocate-bigger-and-copy of §3.3 — safe because the only writer is
  the owning worker and growth happens between this worker's own `encode` calls (single-threaded
  w.r.t. this buffer).
- **postMessage-fallback runtimes** (no SAB at all, report §6.3): the command buffer is *already* a
  plain `ArrayBuffer`, so it works unchanged. After the wave the worker `postMessage`s its
  `{ words, head }` (transferring the `ArrayBuffer`, zero-copy) back to the main thread for flush
  (§7.6). In the SAB/Atomics runtime the buffer never crosses a thread boundary at all — the main
  thread holds a reference to each worker's `CommandBuffer` object directly (workers and main share
  the same address space only for SABs; the command buffer being plain AB means the main thread
  reads it via a structured handle established at worker startup, §3.5).

### 3.2 Word layout discipline

Everything is a `u32` word (4 bytes). All offsets in §4 are **word offsets** within `words`. A
record occupies a contiguous run `words[start .. start + recordLen)`; the first word is always the
**opcode** (§4.1). Multi-word values (a full `EntityHandle`, a `ComponentId`, a `RelationId`,
payload field words) each occupy whole words — there are **no sub-word bit-packed fields** inside a
record except where a value is itself a packed handle (the `EntityHandle` is one packed u32 by
entity-model.md §2.2, stored as one word).

> **Why u32 words and not a byte stream.** Component payload field words are produced by the
> accessor/encoder as TypedArray slots (`f32`/`i32`/… are all 4-byte; `f64` is two words; `u8`/
> `bool` still occupy a whole word in the command buffer to keep record parsing word-aligned and
> branch-free — the apply path re-narrows on write). This trades a little buffer space for a
> uniform, alignment-safe decode (§4.3). Sub-word packing of `u8` payloads is a deferred
> optimization (Q-CB3, §13).

### 3.3 Growth

```
ensureWords(cb, need):                      // need = words required for the next record
  if cb.head + need <= cb.words.length: return
  newLen := cb.words.length
  while cb.head + need > newLen: newLen := newLen * 2     // double (report §2.9)
  next := new Uint32Array(newLen)                          // plain AB
  next.set(cb.words.subarray(0, cb.head))                 // copy live prefix only
  cb.words := next
```

- O(head) copy on a grow event; O(log capacity) grows over a wave (doubling). Initial capacity is
  a `createWorld` option `commandBufferInitialWords` (default `1024` words = 4 KiB per worker).
- Growth is allocation-free of any cross-thread structure; it is purely local to the owning worker
  and never touches a column SAB. There is **no** length-tracking-view concern here (§3.1).
- **Overflow policy:** there is no hard cap; the buffer grows to fit a wave's worth of ops. This
  mirrors the reactivity-log "recoverable, not a hard ceiling" stance (report §2.7) — a burst of
  structural changes in one wave must not throw. A dev-mode warning fires if a single worker's
  buffer exceeds `commandBufferWarnWords` (default `1 << 20` = 4 MiB) so runaway encoding is
  visible.

### 3.4 Reset (start of wave)

```
resetBuffer(cb):                            // serial phase, before the wave; called by scheduler
  cb.head := 0
  cb.recordCount := 0
  cb.reservationCursor := 0
  // cb.words backing is RETAINED (not freed) so the next wave reuses the allocation — zero
  // per-wave allocation in steady state. Records from the previous wave were already applied at
  // the previous flush and are now overwritten in place by new appends.
```

Resetting the write head to 0 (rather than reallocating) is the report's "reset (write head → 0)
at the start of each wave". Steady-state encoding is therefore **allocation-free** (the buffer
reaches a stable high-water size after a few frames).

### 3.5 Main-thread handle to a worker's buffer

At worker startup (workers spec), the main thread establishes a `CommandBuffer` mirror per worker.
Because the backing is plain AB:

- **SAB/Atomics runtime:** the worker keeps the authoritative `CommandBuffer`; after the wave it
  signals completion via the Atomics wave counter (workers spec, report §6.3). The main thread then
  reads the worker's buffer through a shared structured reference — in practice the worker
  `postMessage`s the `{ words: ArrayBuffer, head }` pair once per flush (the buffer is small and
  transfer is zero-copy), OR (optimization) the buffer is allocated on the main thread and the
  worker writes into a view passed at startup. v1 uses the **post-the-buffer-at-flush** model for
  simplicity and to keep the "worker-local, main-thread-reads-after" invariant literal.
- **postMessage-fallback runtime:** identical — the buffer is posted back at flush (§7.6).

> The exact transport (transfer the AB vs. share a pre-allocated AB) is a workers-spec
> concern; this spec requires only that **(a)** the buffer is written solely by its owning worker
> during the wave and **(b)** the main thread has exclusive read access to it after the wave fence.
> Both transports satisfy that (report §6.1 ownership).

---

## 4. Op encoding & exact record byte layout

### 4.1 Opcode set

```ts
export const enum Op {
  CREATE       = 0,   // OP_CREATE      reservedEid
  DESTROY      = 1,   // OP_DESTROY     eid
  ADD          = 2,   // OP_ADD         eid componentId fieldWordCount [field words...]
  REMOVE       = 3,   // OP_REMOVE      eid componentId
  ADD_PAIR     = 4,   // OP_ADD_PAIR    eid relationId targetEid payloadWordCount [payload words...]
  REMOVE_PAIR  = 5,   // OP_REMOVE_PAIR eid relationId targetEid
  SET_PAYLOAD  = 6,   // OP_SET_PAYLOAD eid componentId fieldWordCount [field words...]   (§5.6)
}
```

> **Shared structural-op ordinals (world.md §9.4, CANON).** These numeric values are **shared
> across command-buffer `Op`, serialization `DeltaOp`, and reactivity `ShapeKind`** — the member
> names differ per spec but the **numeric values are identical**: `CREATE=0, DESTROY=1, ADD=2,
> REMOVE=3, ADD_PAIR=4, REMOVE_PAIR=5, SET_PAYLOAD=6`. command-buffer.md **shares this numbering**
> (world.md invariant W-7), which is what lets the apply path be reused across command-buffer and
> serialization (§1, report §6.1).

The set is exactly the report's `OP_CREATE / OP_DESTROY / OP_ADD / OP_REMOVE / OP_ADD_PAIR /
OP_REMOVE_PAIR` (report §6.1), **plus** `OP_SET_PAYLOAD` (§5.6) — the deferred analogue of
`entity.write(C).x = 5` (Must-Fix #2): a mid-wave payload mutation of an *already-present*
component on an entity the worker does not own structurally. (`OP_ADD` carries the *initial* field
words for a newly-added component; `OP_SET_PAYLOAD` overwrites the field words of a component the
entity already has. Both are field-word records, §4.3.)

The opcode is the **first word** of every record. Argument arity is **implied by the opcode** plus,
for the variable-length ops (`ADD`, `ADD_PAIR`, `SET_PAYLOAD`), an explicit length word so the
decoder can skip a record without consulting the component schema (§4.6 "self-describing length").

### 4.2 Fixed-arity records — `CREATE`, `DESTROY`, `REMOVE`, `REMOVE_PAIR`

All multi-word eids/ids occupy one word each. `eid` words store the **full `EntityHandle` u32
bit-pattern** (index ⊕ generation), per entity-model.md §2.2 and the `eid` storage convention
(memory-buffers.md §3.4: full handle bit-pattern). `NO_ENTITY = 0xffffffff` is a valid stored
sentinel but never a record subject.

```
OP_CREATE   (2 words)
  word 0: Op.CREATE
  word 1: reservedEid        // a FULL handle popped from the worker's reservation block (§6.2)

OP_DESTROY  (2 words)
  word 0: Op.DESTROY
  word 1: eid                // full handle of the entity to despawn

OP_REMOVE   (3 words)
  word 0: Op.REMOVE
  word 1: eid
  word 2: componentId        // dense ComponentId (type-system.md §8); may be a synthetic pair id

OP_REMOVE_PAIR (4 words)
  word 0: Op.REMOVE_PAIR
  word 1: eid                // subject
  word 2: relationId         // dense u16 RelationId, stored in one word (relations.md §2.1)
  word 3: targetEid          // full handle of the target entity
```

### 4.3 Variable-arity field-word records — `OP_ADD` and `OP_SET_PAYLOAD`

```
OP_ADD / OP_SET_PAYLOAD   (4 + F words, where F = fieldWordCount)
  word 0: Op.ADD | Op.SET_PAYLOAD
  word 1: eid
  word 2: componentId
  word 3: fieldWordCount  (F)   // total payload words that follow; 0 for a tag component
  word 4 .. 4+F-1: field words  // the component's encoded field slots, in declaration order
```

- `fieldWordCount` is the **sum of `stride`** across the component's fields, with each TypedArray
  slot occupying one word except `f64`, which occupies **two** words (low word then high word,
  little-endian pairing — §4.4). For a tag component (`fields.length === 0`), `F = 0` and the
  record is exactly 4 words.
- The field words are produced by encoding each field value through its `FieldDescriptor.encode`
  (type-system.md §1.4) into TypedArray slots, then widening each slot to a `u32` word:
  - `bool`/`u8`/`i8`/`u16`/`i16`/`u32`/`i32` → one word (the integer value, masked/`>>>0` as needed
    on apply).
  - `f32` → one word: the **bit-pattern** via `Float32Array`/`Uint32Array` aliasing (a scratch
    `DataView` or a 1-elem `Float32Array`+`Uint32Array` over the same buffer). NOT the rounded
    integer — the f32 *bits*.
  - `f64` → two words (§4.4).
  - `eid` → one word (full handle, `-1`/`0xffffffff` for null per memory-buffers.md C-2).
  - `staticString(choices)` → one word (the choice index, type-system.md §1.4).
  - `vec(E,N)` → `N` words (or `2N` if `E === 'f64'`), per-axis in order.
  - `object<T>` → **NOT ENCODABLE in a command buffer.** Object-token components are
    `restrictedToMainThread` (memory-buffers.md §3.8); a worker may not add/set them. A worker-side
    `cb.add(objectComponent)` is a **compile-time TS error** (the worker-tagged system surface
    excludes object components — type-system.md §3.8 / scheduler spec) and a dev-mode runtime throw
    if reached. (§5.7)

### 4.4 `f64` two-word encoding

A `Float64Array` slot is split into two `u32` words via a shared scratch buffer:

```ts
// scratch: one ArrayBuffer aliased as f64view (len 1) and u32view (len 2).
function encodeF64(value: number, out: Uint32Array, at: number): void {
  scratchF64[0] = value;
  out[at]     = scratchU32[0];   // low  word
  out[at + 1] = scratchU32[1];   // high word
}
function decodeF64(words: Uint32Array, at: number): number {
  scratchU32[0] = words[at]; scratchU32[1] = words[at + 1];
  return scratchF64[0];
}
```

Endianness is **host-native and consistent**: the same engine writes and reads the words within
one process, and in the postMessage-fallback the buffer is transferred (not re-serialized), so the
host byte order is preserved end-to-end. No cross-endian transport exists in v1 (a created world is
single-host); cross-host snapshotting is the serialization spec's concern, not the command buffer's.

### 4.5 `OP_ADD_PAIR` byte layout

```
OP_ADD_PAIR   (5 + P words, where P = payloadWordCount)
  word 0: Op.ADD_PAIR
  word 1: eid                  // subject (full handle)
  word 2: relationId           // dense u16 RelationId in one word
  word 3: targetEid            // full handle of the target
  word 4: payloadWordCount (P) // payload field words that follow; 0 for tag relations
  word 5 .. 5+P-1: payload words   // the relation payload schema's encoded fields (§4.3 rules)
```

- The worker carries the **raw `relationId` + raw `targetEid`**, never a pair `ComponentId`.
  Workers do **not** mint pair IDs (relations.md §2.2 "Workers never mint"). The pair `ComponentId`
  for `(relationId, handleIndex(targetEid))` is **minted on the main thread at apply time** by
  `relations.addPair` (relations.md §5.6 "Apply-time minting"). The command buffer transports only
  the integer relation + target handle, which is fully SAB/worker-safe (relations.md §1 "IDs are
  integers, SAB/worker-safe").
- `payloadWordCount` follows the same field-word rules as `OP_ADD` (§4.3), encoding the relation's
  payload schema `P` (type-system.md §7.1). For a `tag` relation, `P = 0`.

### 4.6 Self-describing length & the record-length function

Every record's length is computable from its first word(s) **without** consulting any schema (the
variable ops carry an explicit count word). This lets the merge loop skip/iterate records with no
schema lookup and lets a dropped record (§8) be skipped cheaply.

```ts
function recordLen(words: Uint32Array, at: number): number {
  switch (words[at] as Op) {
    case Op.CREATE:      return 2;
    case Op.DESTROY:     return 2;
    case Op.REMOVE:      return 3;
    case Op.REMOVE_PAIR: return 4;
    case Op.ADD:
    case Op.SET_PAYLOAD: return 4 + words[at + 3];           // 4 + fieldWordCount
    case Op.ADD_PAIR:    return 5 + words[at + 4];           // 5 + payloadWordCount
    default: throw new Error(`corrupt command buffer: bad opcode ${words[at]} at ${at}`);
  }
}
```

- **Invariant CB-LEN:** `head` always lands exactly on a record boundary; iterating
  `at += recordLen(words, at)` from `0` to `head` visits every record exactly once. A dev-mode
  assertion after each `encode` checks `at === head` after the just-written record.

### 4.7 Record byte-size summary

| Op | words | bytes | notes |
|---|---|---|---|
| `OP_CREATE` | 2 | 8 | reserved handle |
| `OP_DESTROY` | 2 | 8 | |
| `OP_REMOVE` | 3 | 12 | |
| `OP_REMOVE_PAIR` | 4 | 16 | |
| `OP_ADD` | 4 + F | 16 + 4F | F = field words (0 for tag) |
| `OP_SET_PAYLOAD` | 4 + F | 16 + 4F | |
| `OP_ADD_PAIR` | 5 + P | 20 + 4P | P = payload words (0 for tag relation) |

---

## 5. The encode API (worker-side, mid-wave)

These are the methods a worker calls during a wave. **None mutates any shared structure** — each
appends one record to the owning worker's buffer and (for `create`) consumes a reserved handle.
The public ergonomic surface (`entity.add(C)`, `world.spawn()` inside a worker) routes here via
`structuralOp` (§2.2).

```ts
export interface CommandEncoder {
  /** Reserve-and-return a usable handle NOW; emits OP_CREATE. Mid-wave safe (§6). */
  create(): EntityHandle;

  /** Emit OP_DESTROY. The handle may be a reserved-this-wave handle or any prior handle. */
  destroy(h: EntityHandle): void;

  /** Emit OP_ADD with the component's initial field values (defaults if `init` omitted). */
  add<S extends Schema>(h: EntityHandle, def: ComponentDef<S>, init?: Partial<WriteView<S>>): void;

  /** Emit OP_REMOVE. */
  remove(h: EntityHandle, def: ComponentDef<Schema>): void;

  /** Emit OP_ADD_PAIR (subject, relation, target, optional payload). */
  setRelation<R extends RelationDef<Schema | void>>(
    subject: EntityHandle, relation: R, target: EntityHandle,
    payload?: R extends RelationDef<infer P> ? (P extends Schema ? Partial<WriteView<P>> : never) : never,
  ): void;

  /** Emit OP_REMOVE_PAIR. */
  unsetRelation(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): void;

  /** Emit OP_SET_PAYLOAD: deferred payload mutation of an already-present component (§5.6). */
  setPayload<S extends Schema>(h: EntityHandle, def: ComponentDef<S>, values: Partial<WriteView<S>>): void;
}
```

### 5.1 `create`

```
create():
  cb := currentWorkerBuffer()
  if cb.reservationCursor >= cb.reservation.handles.length:
      refillReservation(cb)                       // §6.4 secondary block, else NO_ENTITY + devWarn
  h := cb.reservation.handles[cb.reservationCursor]
  cb.reservationCursor += 1
  ensureWords(cb, 2); w := cb.head
  cb.words[w] := Op.CREATE; cb.words[w+1] := h
  cb.head += 2; cb.recordCount += 1
  return h         // immediately usable as a target in later records THIS wave (report §6.1)
```

- The returned handle is **already alive** at apply time (the main thread commits the create before
  any later record in merge order can reference it — §8.5; report §6.1 "Reserved IDs … always alive
  at apply time"). So a worker may `const e = cb.create(); cb.add(e, Position); cb.setRelation(e,
  ChildOf, parent)` and all three apply correctly.

### 5.2 `destroy`

Appends `OP_DESTROY h`. No liveness check at encode time (the worker may not read the bitmask, and
`isAlive` against the shared dense/sparse arrays is policy-avoided mid-wave — entity-model.md §5.3).
Liveness is resolved at apply time (§8). Destroying a handle the same worker reserved-and-created
this wave is legal (apply order handles it: create then destroy → the entity is created then
immediately despawned, both in merge order).

### 5.3 `add`

```
add(h, def, init?):
  cb := currentWorkerBuffer()
  F := def.totalFieldWords                  // sum of field stride (f64 counts 2), cached on def
  ensureWords(cb, 4 + F); w := cb.head
  cb.words[w] := Op.ADD; cb.words[w+1] := h; cb.words[w+2] := def.id; cb.words[w+3] := F
  encodeFields(cb.words, w + 4, def, init)  // §4.3; missing fields → schema default
  cb.head += 4 + F; cb.recordCount += 1
```

- `encodeFields` writes each field's encoded words; an omitted field in `init` uses the schema
  default (eid → `-1`, numeric → `0`, staticString → index 0 — archetype-storage.md §5.7).
- Adding a component the entity already has is **idempotent at apply** (storage `migrateAddingMany`
  filters already-present ids — archetype-storage.md §5.6a); if `init` was supplied for an
  already-present component, the apply path treats it as a payload overwrite (§9.2) so the worker's
  intended values are not silently lost.

### 5.4 `remove`

Appends `OP_REMOVE h def.id`. Removing an absent component is idempotent at apply (storage
`migrateRemovingMany` filters absent ids — archetype-storage.md §5.6a).

### 5.5 `setRelation` / `unsetRelation`

`setRelation` appends `OP_ADD_PAIR subject relationId targetEid [payload...]`; `unsetRelation`
appends `OP_REMOVE_PAIR subject relationId targetEid`. The worker passes the **raw `RelationId` and
raw target `EntityHandle`** (§4.5). Payload words (if the relation has a payload schema) are encoded
per §4.3. The exclusive vs non-exclusive routing is invisible here — it is decided at apply time by
`relations.addPair` from the relation's `storageKind` (relations.md §4).

### 5.6 `setPayload` — deferred `entity.write(C).x = 5`

Must-Fix #2 makes tracked mutation go through `entity.write(C)`. On the **main thread serial phase**
that setter writes the column directly and pushes to `writeLog` (type-system.md I-ACC-4). On a
**worker mid-wave**, a write to a component on an entity in a *disjoint-write* column the scheduler
granted the worker is a **direct column write** (the worker owns that column for the wave — report
T5 disjoint writes) and does NOT go through the command buffer.

`OP_SET_PAYLOAD` exists for the *other* case: a worker wants to set component fields on an entity
whose column it does **not** have wave-disjoint write access to (e.g. setting a component the worker
only reads, or on an entity it is about to create). That mutation is **deferred**:

```
setPayload(h, def, values):
  // identical encoding to add(), opcode SET_PAYLOAD; apply overwrites existing column values
  // (no migration) instead of adding the component.
```

- Apply semantics (§9.2): `OP_SET_PAYLOAD` requires the component to be **present** at apply time;
  if absent, the record is **dropped with a dev diagnostic** (it is not an add — use `OP_ADD` to
  add). This keeps `setPayload` strictly a *mutation*, mirroring `entity.write(C)` which also
  requires the component to be present.
- Applying `OP_SET_PAYLOAD` emits a `writeLog` entry per field-bearing component (the `.changed`
  filter, report §2.7), exactly as a main-thread `write()` setter would (§7.5).

> **The three field-write destinations, in one place (resolved naming note).** A field/payload
> mutation reaches storage by exactly one of three routes, picked by phase + access; readers should
> not have to reconstruct this from prose:
>
> | Situation | Destination | Tracking | Spec |
> |---|---|---|---|
> | Main thread, serial phase (`world.phase === 'serial' && isMainThread()`) | **direct column write** + `writeLog` push | `world.trackWrite(handleIndex(eid), id)` inline (accessors.md §6.4) | §2.2 direct-apply |
> | Worker mid-wave, column the scheduler granted as **wave-disjoint write** | **direct SAB column write** + **per-worker write corral** push | corral merged serially in worker-index order → `writeLog` (reactivity.md §9.1/§9.2) | this §5.6 ¶2 |
> | Worker mid-wave, component **not** wave-disjoint to this worker (read-only access, or on an entity it is creating) | **command buffer** `OP_SET_PAYLOAD` (deferred) | apply emits `writeLog` entry on the main thread (§5.6, §9.2) | this §5.6 |
>
> Structural ops (create/destroy/add/remove/pair) **always** go through the command buffer from a
> worker, never the corral (the corral is field writes only — reactivity.md §9.1). On the main-thread
> serial path, structural ops take the direct-apply fast path (§2.2). The write **corral** (field
> values) and the **command buffer** (structure) are distinct per-worker arenas (reactivity.md §9.1
> reserves the names).

### 5.7 Encode-time validation (dev mode)

- Encoding an `object<T>` component (`restrictedToMainThread`) from a worker: TS error at the typed
  surface; dev-mode throw if reached (§4.3). (Object components cannot cross the worker boundary —
  memory-buffers.md §3.8.)
- Encoding with a `def.id === UNREGISTERED (-1)`: throw (the component was never registered with the
  world — type-system.md §2.4).
- `ensureWords` failure (OOM on grow): propagates; not catchable as drop (a worker that cannot
  encode is a fatal condition, unlike a dropped *applied* op which is recoverable).

---

## 6. Entity-ID reservation handshake (the §6.1 reservation protocol)

A worker cannot allocate from the shared free-list mid-wave (it would mutate shared structure —
Must-Fix #1). So the main thread pre-reserves a small block of fully-formed handles per worker
before each wave, and `OP_CREATE` consumes from that block. This is entity-model.md §5 verbatim;
this section specifies the command-buffer side.

### 6.1 Before-wave reservation (main thread, serial)

```
prepareWave(workers, perWorkerSpawnHint):              // scheduler calls, serial phase
  for cb in workers:
     resetBuffer(cb)                                    // §3.4
     n := perWorkerSpawnHint[cb.workerIndex]            // from the system's maxSpawnsPerWave decl
     cb.reservation := world.reserveEntityBlock(cb.workerIndex, n)   // entity-model.md §5.1
     cb.reservationCursor := 0
```

- `reserveEntityBlock(workerIndex, n)` (entity-model.md §5.1) allocates `n` handles by calling the
  ordinary serial `allocEntity` `n` times; the entities are **fully alive the instant they are
  reserved** (entity-model.md §5.1), so any later command in the same flush may reference them
  safely (report §6.1 "Reserved IDs … always alive at apply time").
- `n` is sized from each participating system's `maxSpawnsPerWave` declaration (entity-model.md §5.2,
  default 64). The scheduler aggregates per-worker: a worker running multiple systems gets the sum.

### 6.2 Consuming a reservation (worker, mid-wave)

`create()` (§5.1) pops `reservation.handles[reservationCursor++]` and emits `OP_CREATE` with that
full handle. The handle is immediately returned to the system code as a usable `EntityHandle`.

### 6.3 After-wave return of unused IDs (main thread, serial, during flush)

```
// during flushAll() AFTER all of this worker's OP_CREATEs have been applied:
returnUnused(cb):
  consumed := <count of OP_CREATE records actually applied (not dropped) from this buffer>
  world.returnReservedIds(cb.reservation, consumed)      // entity-model.md §5.1: reclaims the tail
```

- `returnReservedIds(reservation, consumedCount)` (entity-model.md §5.1) returns the
  `handles[consumedCount..]` tail to the free-list (they were alive-but-unused; returning them
  re-frees the slots, bumping generation — entity-model.md §3.2). v1 returns the **unconsumed**
  reserved handles; a reserved handle that was consumed by an applied `OP_CREATE` is now a live
  entity and is NOT returned.
- **Edge case — a created entity also destroyed this flush:** the `OP_CREATE` applies (entity
  becomes alive), then the later `OP_DESTROY` applies (entity is despawned via the normal
  `freeEntity` path). The reservation accounting counts it as *consumed* (the `OP_CREATE` applied);
  the subsequent destroy frees it through the regular despawn path, not through `returnReservedIds`.
  No double-free: `returnReservedIds` only touches the *unconsumed tail*.

### 6.4 Reservation exhaustion mid-wave

If a worker exhausts its block (`reservationCursor >= handles.length`) it calls `refillReservation`:

```
refillReservation(cb):
  // A worker CANNOT call reserveEntityBlock (that allocs from the free-list = shared mutation).
  // v1: the worker draws from a SECONDARY per-worker fallback block pre-reserved by the main
  // thread alongside the primary (entity-model.md §5.2). If that too is exhausted, create()
  // returns NO_ENTITY and a dev-mode warning fires (the system under-declared maxSpawnsPerWave).
  if cb.fallbackReservation has capacity: switch cb.reservation to it; return
  devWarn('reservation exhausted; raise maxSpawnsPerWave'); return /* create() yields NO_ENTITY */
```

- A `create()` that yields `NO_ENTITY` still emits an `OP_CREATE NO_ENTITY` record? **No** — it
  emits **nothing** (there is no reserved handle to create), returns `NO_ENTITY`, and any later
  `cb.add(NO_ENTITY, …)` records are **dropped at apply** by the safety invariant (`isAlive(NO_ENTITY)
  === false`, §8). So an exhausted reservation degrades to "those spawns silently don't happen"
  with a dev diagnostic, never a crash — consistent with the recoverable-overflow philosophy
  (report §2.7).

---

## 7. Flush + deterministic merge (main thread, between waves)

`flushAll()` is the heart of the module: it applies every worker's buffer to the world, serially,
in a **deterministic** order, with the safety invariant (§8), then emits reactivity and returns
unused IDs.

### 7.1 Top-level sequence

```
flushAll(workers):                                 // main thread, world.phase MUST be 'serial'
  assert(world.phase === 'serial', 'flush must run between waves')   // CO-1 (archetype-storage §7)
  newlyCreatedThisFlush := new Set<EntityHandle>()  // §8.5 reserved-handle whitelist
  tombstones := new Set<number>()                   // §8.2 entity INDICES destroyed THIS flush
  for cb in workers (in ASCENDING workerIndex order):     // §7.2 deterministic
     applyBuffer(cb, newlyCreatedThisFlush, tombstones)   // §7.3
  for cb in workers: returnUnused(cb)               // §6.3
  // (reactivity entries were emitted inline during apply — §7.5)
```

- **Single-thread degenerate case:** with zero workers (single-threaded world), `flushAll` is a
  no-op (no buffers). All structural ops went through the `applyDirect` fast path (§2.2). The
  command-buffer machinery imposes **zero cost** on a single-threaded world (report decision:
  "correct single-threaded executor first").

### 7.2 Deterministic merge order (report §6.1)

Buffers are merged in **fixed worker-index order**: worker 0's buffer is fully applied, then worker
1's, … Within a buffer, records apply in **append order** (the order the worker encoded them). This
makes the applied result **independent of the nondeterministic wave-completion order** — critical
for replay, snapshot/restore equality, and reproducible tests (report §6.1 "important for replay
and for tests").

> **Why determinism holds despite parallel encoding.** The *encoding* order across workers is
> nondeterministic (workers run concurrently), but the *applying* order is fixed (ascending worker
> index, then append order). Two runs of the same wave produce the same per-worker buffers (each
> worker's systems are deterministic given disjoint inputs — scheduler T5), and the same fixed
> merge order, hence the same world state. This is the report's determinism guarantee.

### 7.3 `applyBuffer`

```
applyBuffer(cb, newlyCreated, tombstones):
  at := 0
  appliedCreates := 0
  while at < cb.head:
     op := cb.words[at]
     len := recordLen(cb.words, at)                  // §4.6
     applyRecord(cb.words, at, op, newlyCreated, tombstones, /*out*/ {appliedCreates})
     at += len
  cb.appliedCreateCount := appliedCreates            // for returnUnused (§6.3)
```

### 7.4 `applyRecord` (the dispatch)

```
applyRecord(words, at, op, newlyCreated, tombstones):
  switch op:
    Op.CREATE:
        h := words[at+1]
        spawnReserved(h)                  // entity-model: lands h in EMPTY_ARCHETYPE_ID, marks alive
        newlyCreated.add(h)               // §8.5 whitelist
        appliedCreates += 1
    Op.DESTROY:
        h := words[at+1]
        if not validateSubject(h, newlyCreated, tombstones): return   // §8 drop-if-dead
        world.despawn(h)                  // entity-model §6.3 (cascade, reactivity, freeEntity)
        tombstones.add(handleIndex(h))    // §8.2: record the deletion for later records THIS flush
    Op.ADD:
        h := words[at+1]; cid := words[at+2]; F := words[at+3]
        if not validateSubject(h, newlyCreated, tombstones): return
        stageAddForEntity(h, cid, words, at+4, F)     // §9.2 coalescing buffer
    Op.REMOVE:
        h := words[at+1]; cid := words[at+2]
        if not validateSubject(h, newlyCreated, tombstones): return
        stageRemoveForEntity(h, cid)                  // §9.2
    Op.SET_PAYLOAD:
        h := words[at+1]; cid := words[at+2]; F := words[at+3]
        if not validateSubject(h, newlyCreated, tombstones): return
        applySetPayload(h, cid, words, at+4, F)       // §9.2 (requires component present)
    Op.ADD_PAIR:
        s := words[at+1]; rid := words[at+2]; t := words[at+3]; P := words[at+4]
        if not validateSubject(s, newlyCreated, tombstones): return
        if not validateTarget(t, newlyCreated, tombstones): return    // §8.3 target liveness
        relations.addPair(s, relationOf(rid), t, decodePayload(words, at+5, P, rid))   // relations §5.6
    Op.REMOVE_PAIR:
        s := words[at+1]; rid := words[at+2]; t := words[at+3]
        if not validateSubject(s, newlyCreated, tombstones): return
        // target need NOT be alive to remove a (now-dangling) pair; relations.removePair tolerates it
        relations.removePair(s, relationOf(rid), t)   // relations §5.5
```

> The `stageAddForEntity` / `stageRemoveForEntity` calls do not migrate immediately — they
> accumulate per-entity add/remove sets that are flushed into **one** `migrateAddingMany` /
> `migrateRemovingMany` call per entity (§9), so an entity that gains 3 components in a wave
> migrates **once**, not 3 times. The coalescing buffer is drained at the end of `applyBuffer`
> (§9.2) — or, to preserve strict append-order observability for reactivity, at each entity's first
> *non-structural* op. v1 drains **per record-run** per entity (§9.4).

### 7.5 Reactivity emission (report §6.1 "Reactivity interaction")

Each applied record drives the **same lifecycle hooks** a main-thread direct op would:

- `Op.CREATE` → `spawn` hook → reactivity pushes a structural create entry (entity-model.md §6.2).
- `Op.DESTROY` → `despawn` protocol → `trackShape(Destroy)` + per-component remove logs
  (entity-model.md §6.3), all emitted **before** `freeEntity`.
- `Op.ADD` / `Op.REMOVE` → the coalesced `migrate*` → shape-log delta set (archetype-storage.md §5.5).
- `Op.SET_PAYLOAD` → `writeLog` push per field-bearing component (the `.changed` filter, report §2.7).
- `Op.ADD_PAIR` / `Op.REMOVE_PAIR` → the pair migration's shape-log delta (relations.md §5.2/§5.5).

Because `flushAll` runs **once, serially, in deterministic merge order, after the wave**, every
structural change is observed **exactly once** in that deterministic order (report §6.1). A
**dropped** record (§8) emits **no** reactivity (it never applied — §8.4). Observers (the deferred
`ObserverSystem`, report §2.7 Layer 2) drain these logs at their scheduler slot after the flush.

### 7.6 postMessage-fallback transport

In a no-SAB world (`workers: 'postMessage-fallback'`, report §6.3), after the wave fence each
worker `postMessage`s its `{ words: ArrayBuffer, head }` (transferring the AB, zero-copy) plus its
applied-column transfers (workers spec). `flushAll` reads those transferred buffers identically to
the SAB case — the apply path is **byte-for-byte the same** (the command buffer was always a plain
AB, §3.1). This is why the public API and determinism are identical across transports (report §6.3
"keeps the public API identical").

---

## 8. Entity-reference safety invariant (the §6.1 hazard, resolved)

This is the previously-unspecified hazard Must-Fix #3 names: **a command may reference an entity
that an earlier-applied command (possibly from another worker) destroyed in the same flush.** The
rule is **validate-then-apply, drop-if-dead**, hardened with an in-flush **tombstone set** so the
hazard is caught even within one `flushAll` before the destroyed slot is reissued.

### 8.1 The base rule

> **Invariant CB-SAFE.** Every record that names a non-reserved `eid` (as subject or target) is
> validated at apply time; if the entity is **not alive**, the record is **dropped** (skipped) — a
> no-op in production, a dev-mode diagnostic that records the dropped op *and* the destroying op
> (report §6.1).

```ts
function validateSubject(h: EntityHandle, newlyCreated: Set<EntityHandle>, tombstones: Set<number>): boolean {
  if (newlyCreated.has(h)) return true;            // §8.5 reserved-and-created THIS flush → alive
  if (tombstones.has(handleIndex(h))) {            // §8.2 destroyed earlier THIS flush
    devDiag('command references entity destroyed earlier this flush', h);
    return false;                                  // SKIP
  }
  if (!world.isAlive(h)) {                          // generation/staleness check (entity-model §3.3)
    devDiag('command references dead entity', h);
    return false;                                  // SKIP
  }
  return true;
}
```

- `world.isAlive` is the entity module's O(1) dense/sparse/generation check (entity-model.md §3.3);
  it **never reads the bitmask** (Must-Fix #1). Apply runs serial/main-thread, so reading the
  dense/sparse arrays is safe.
- `validateSubject`/`validateTarget` are the **only** safety gate; it is **cheap** (one set lookup +
  one `isAlive`) and removes the only race the command model could introduce (report §6.1).

### 8.2 Why a tombstone set is necessary (the in-flush deletion + reuse hazard)

`isAlive` alone is **insufficient** to catch the in-flush hazard in one specific case: an entity
destroyed earlier *this flush* whose **index has already been reissued** to a different entity later
*this same flush*. Sequence within one `flushAll`:

1. `OP_DESTROY A` applies → `despawn(A)` → `freeEntity(A)` bumps A's generation and **frees A's
   slot** (entity-model.md §3.2). At this instant the slot may be reused.
2. `OP_CREATE` from a *later* worker buffer consumes a reservation handle — but reservations were
   taken **before** the wave (§6.1), so a reserved handle is a *distinct, pre-allocated* slot and
   will **not** collide with A's just-freed slot within this flush. **However**, A's freed slot
   *can* be reissued by `returnReservedIds` only at the *end* of the flush (§6.3), and the next
   *wave*'s reservation — not this flush — would draw it. So within a single `flushAll`, A's slot is
   not reissued. **Given that**, plain `isAlive(A)` already returns false for the stale A handle
   (generation bumped), and a later `OP_ADD A` is correctly dropped.

So in v1's **reserve-before-wave** model, the slot-reuse-within-one-flush case **cannot occur**, and
`isAlive` is sufficient on its own. The **tombstone set is retained** for two reasons:

- **Diagnostic precision.** `isAlive(h) === false` cannot distinguish "h was never valid /
  fabricated" from "h was destroyed *this flush*". The tombstone set lets the dev diagnostic say
  *which destroying op* killed the entity (report §6.1 "records the dropped op and the destroying
  op"), which `isAlive` alone cannot.
- **Forward-compat hardening.** If a future build ever reissues freed slots **within** a flush (e.g.
  a worker-side `Atomics.sub` free-list take, entity-model.md §5.1 v2 note), `isAlive` could return
  **true** for a stale handle whose index was reissued to a *new* entity at a *new* generation — but
  the full-handle compare (`dense[sparse[index]] === h`, entity-model.md §3.3) still catches it
  because the **generation differs**. The tombstone set is the belt-and-suspenders guard that drops
  any op whose subject **index** was tombstoned this flush *regardless of generation*, closing the
  ABA window before it can exist. v1 ships it as the documented hardening even though v1's
  reserve-before-wave model makes the reissue impossible.

> **Tombstones key by INDEX, not handle.** `tombstones.add(handleIndex(h))` records the *slot*, so a
> stale handle to a tombstoned slot is dropped even if its generation field is corrupt/forged. This
> is the same index-keying the back-ref index and entity record use (entity-model.md §4.1).

### 8.3 Target liveness for relations (report §6.1)

`OP_ADD_PAIR` is dropped if **either** the subject **or** the target is dead at apply time — "a
relation to a destroyed target is meaningless" (report §6.1). `validateTarget` is `validateSubject`
applied to `targetEid`. `OP_REMOVE_PAIR` does **not** require the target to be alive (removing a
dangling pair to an already-dead target is legitimate cleanup — relations.md §7.3 'none' cascade
removes dangling pairs); only the **subject** is validated for `OP_REMOVE_PAIR`.

### 8.4 Dropped records emit no side effects

A dropped record applies **nothing**: no migration, no record commit, no bitmask change, no
reactivity entry, no reservation accounting (a dropped `OP_CREATE` cannot happen — reserved handles
are always alive, §8.5). This keeps the world state and the reactivity stream exactly as if the
dropped op were never encoded — the determinism guarantee (§7.2) holds across drops.

### 8.5 Reserved handles are never dropped (the create-then-use guarantee)

`OP_CREATE`'s handle is drawn from a block the main thread allocated **before** the wave and which
is **alive from the instant of reservation** (entity-model.md §5.1). When `applyRecord` processes
`OP_CREATE` it calls `spawnReserved(h)` and adds `h` to `newlyCreated`. Any later record (same or
later worker buffer, merge order) naming `h` passes `validateSubject` via the `newlyCreated`
whitelist — even before the dense/sparse arrays would report it alive for an external `isAlive`
call. This is the report's "created-then-used chains within one flush are safe by construction"
(report §6.1).

- **Ordering subtlety:** a worker can only reference a handle it *itself* reserved-and-created (it
  has no way to learn another worker's reserved handle mid-wave — reservations are per-worker, §6.1).
  So within one buffer, `create()` precedes any `add`/`setRelation` naming that handle (append
  order), and merge applies the `OP_CREATE` first. Cross-worker references to a freshly-created
  handle cannot be encoded (a worker never sees another worker's reserved handle), so the only
  create-then-use chains are intra-buffer and are append-ordered — `newlyCreated` covers them.

### 8.6 Worked hazard example

```
Worker 0 buffer:                 Worker 1 buffer:
  OP_DESTROY  X                    OP_ADD  X  Velocity   // X destroyed by worker 0 this flush
  OP_CREATE   r0  (=> handle e)    OP_ADD_PAIR e2 ChildOf X   // X is the target

flushAll (ascending worker index):
  apply worker 0:
    OP_DESTROY X   → isAlive(X)=T → despawn(X); tombstones.add(index(X))
    OP_CREATE  r0  → spawnReserved(r0); newlyCreated.add(r0)
  apply worker 1:
    OP_ADD X Velocity → validateSubject(X): tombstones.has(index(X)) → DROP + devDiag(destroyed by W0's OP_DESTROY)
    OP_ADD_PAIR e2 ChildOf X → validateTarget(X): tombstoned → DROP (relation to destroyed target)
```

Both worker-1 records that reference the destroyed `X` are dropped with diagnostics; no partial
state, no crash, deterministic. This is the fuzz-tested M7-exit invariant (report §6.1).

---

## 9. The multi-id migration contract (what storage MUST provide)

A worker can request several component adds/removes on the *same* entity in one wave. Applying them
as N separate single-component migrations would migrate the entity through N intermediate
archetypes (N record commits, N bitmask deltas, N shape-log entries) — wasteful and, for relations,
incorrect (Invariant P1 atomicity, relations.md §5.3). This module therefore **requires** storage's
multi-id primitives and coalesces per-entity.

### 9.1 Required storage contract (archetype-storage.md §5.6a)

This module depends on storage providing **exactly** these signatures (archetype-storage.md §5.6a,
relations.md §14 "RESOLVED — required"):

```ts
// Add SEVERAL componentIds to `handle` in ONE migration (one record commit, one bitmask delta,
// one shape-log delta set). De-dups against the current signature (idempotent adds skipped).
migrateAddingMany(handle: EntityHandle, addIds: readonly ComponentId[]): number /* newRow */;

// Remove SEVERAL componentIds in ONE migration. Filters absent ids (idempotent removes skipped).
migrateRemovingMany(handle: EntityHandle, removeIds: readonly ComponentId[]): number /* newRow */;

// Single-id specializations (used by the direct-apply fast path for one-component ops):
migrateAdding(handle: EntityHandle, c: ComponentId): number;
migrateRemoving(handle: EntityHandle, c: ComponentId): number;
```

**Contract guarantees this module relies on** (all stated normatively in archetype-storage.md §5.6a):

- **C-MIG-1 (atomicity / single commit).** `migrateAddingMany(h, ids)` performs **exactly one**
  `migrate` → **one** `commitRecord`, **one** `bitmaskApplyDelta`, **one** shape-log delta set —
  never an intermediate archetype carrying a strict subset of `ids` (archetype-storage.md §5.6a
  "Atomicity"). This is what makes a relation pair-id + presence-id land together (relations.md P1).
- **C-MIG-2 (idempotent filtering).** `addIds` already present in the signature are skipped;
  `removeIds` absent are skipped. If the effective set is empty, it is a no-op returning the current
  row (archetype-storage.md §5.6a). So this module may pass the *raw* per-entity add/remove sets
  without pre-filtering.
- **C-MIG-3 (serial-only).** Both run `assert(world.phase === 'serial')`. The flush is serial, so
  this holds (§7.1).
- **C-MIG-4 (column values).** After `migrateAddingMany`, **added** columns are initialized to
  schema defaults (archetype-storage.md §5.7); this module overwrites them with the worker's encoded
  field words via `applySetPayload` for any `OP_ADD` that carried an `init` (§9.2). **Shared**
  columns are copied from the source row (archetype-storage.md §5.5 step 2), preserving existing
  values across the migration.
- **C-MIG-5 (edge-graph caching).** The second-and-later `migrateAddingMany(h, sameIdSet)` over the
  same source archetype is O(1) via the multi-id edge cache (archetype-storage.md §5.6a
  "Edge-graph interaction"); v1 may fall back to one `canonicalize` + lookup (O(|sig|)).

> Without C-MIG-1, applying a worker's `[Position, Velocity, ChildOf-pair, ChildOf-presence]` adds
> would either migrate four times (4× the structural cost — report T1 churn) or, for the relation
> pair, transiently violate relations P1. The multi-id primitive is therefore **not** an
> optimization but a **correctness requirement** of the apply path (relations.md §14).

### 9.2 Per-entity coalescing in the apply path

`applyBuffer` does not migrate per record. It accumulates, per entity, the set of `OP_ADD` and
`OP_REMOVE` `componentId`s seen in this buffer (and any `OP_SET_PAYLOAD` field words), then issues
**one** `migrateAddingMany` and **one** `migrateRemovingMany` per entity at the coalescing drain
point (§9.4).

```ts
interface PendingStructural {
  adds: ComponentId[];                       // dedup set, order-insensitive (signature is a set)
  removes: ComponentId[];
  // field words to write AFTER the add-migration (componentId -> encoded words slice):
  payloads: Map<ComponentId, Uint32Array>;   // captured from OP_ADD init / OP_SET_PAYLOAD
}
const pending = new Map<EntityHandle, PendingStructural>();

function stageAddForEntity(h, cid, words, fieldsAt, F):
  p := pending.get(h) ?? newPending(); pending.set(h, p)
  // an add cancels a prior remove of the same component THIS buffer (and vice versa) — coalesce:
  removeFrom(p.removes, cid); pushUnique(p.adds, cid)
  if F > 0: p.payloads.set(cid, words.subarray(fieldsAt, fieldsAt + F).slice())   // copy out

function stageRemoveForEntity(h, cid):
  p := pending.get(h) ?? newPending(); pending.set(h, p)
  removeFrom(p.adds, cid); pushUnique(p.removes, cid); p.payloads.delete(cid)

function applySetPayload(h, cid, words, fieldsAt, F):
  // If the entity is getting this component THIS buffer, fold into the add's payload:
  p := pending.get(h)
  if p && p.adds.includes(cid): p.payloads.set(cid, words.subarray(fieldsAt, fieldsAt+F).slice()); return
  // else require the component already present; overwrite columns in place, NO migration:
  if not storage.has(h, componentOf(cid)): devDiag('SET_PAYLOAD on absent component', h, cid); return
  writeColumns(h, cid, words, fieldsAt, F)   // direct column write at the entity's current row
  reactivity.writeLog.push(h, cid)            // .changed filter (§7.5)
```

### 9.3 Draining the pending map (issuing the migrations)

```
drainPending(h):
  p := pending.get(h); if not p: return
  if p.removes.length: storage.migrateRemovingMany(h, p.removes)   // C-MIG-1: one migration
  if p.adds.length:    storage.migrateAddingMany(h, p.adds)        // C-MIG-1: one migration
  // write the captured initial/override payloads into the now-present columns:
  for (cid, words) in p.payloads:
     writeColumns(h, cid, words, 0, words.length)                  // at the entity's (post-migrate) row
  pending.delete(h)
```

- **Order: removes before adds** — so removing C then adding C' that depends on C's column being
  gone is consistent, and so an add that *replaces* a removed component lands in the final
  archetype. Within a wave a remove-then-add of the *same* component coalesced to nothing (§9.2), so
  the two calls operate on disjoint id sets.
- Relations adds/removes (`OP_ADD_PAIR`/`OP_REMOVE_PAIR`) are **not** coalesced into this map — they
  route directly to `relations.addPair`/`removePair` (§7.4), which *themselves* call
  `migrateAddingMany([pairId, presenceId])` internally (relations.md §5.2). Coalescing pair ops
  across multiple targets is a relations-internal concern (relations.md §5), not this module's.

### 9.4 When to drain (cadence) — preserving append-order reactivity

Two valid drain points; v1 chooses **(b)** for simplicity and correct reactivity ordering:

- **(a) End of buffer:** accumulate all of one worker's structural ops, then drain all pending
  entities once. Fewest migrations, but reorders reactivity relative to append order (an entity's
  add and a later pair op in the same buffer would emit out of encoded order).
- **(b) Drain-on-dependency (v1 default):** drain a specific entity's pending map **immediately
  before** any record that *reads* that entity's final structure — i.e. before an `OP_ADD_PAIR`/
  `OP_REMOVE_PAIR`/`OP_SET_PAYLOAD` naming it, and unconditionally at end-of-buffer for any entity
  still pending. This keeps each entity's structural change emitted in append order while still
  coalescing consecutive `OP_ADD`/`OP_REMOVE` runs on that entity into one migration pair. The
  common case (a run of adds, then a pair op) coalesces the adds and emits the pair afterward — the
  natural order.

v1 ships (b). The choice is a reactivity-ordering refinement (Q-CB1, §13), not a correctness issue —
both produce the same final world state; they differ only in shape-log entry interleaving, and (b)
matches what a main-thread direct-apply sequence would have emitted.

---

## 10. Concurrency & memory-ordering summary

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `resetBuffer` / `prepareWave` / `reserveEntityBlock` | Main only | Serial (before wave) | None (single-writer); uses serial `allocEntity` (entity-model §5.1). |
| `create`/`destroy`/`add`/`remove`/`setRelation`/`setPayload` (encode) | Owning worker only | Wave | **None** — buffer is worker-local plain AB (§3.1); no atomics. |
| reservation consume (`reservationCursor++`) | Owning worker | Wave | None (per-worker block; no shared free-list touch). |
| `flushAll` / `applyBuffer` / `applyRecord` | Main only | Serial (between waves) | None — single-threaded replay; plain stores; no atomics (report §6.1 "merge is single-threaded"). |
| `migrateAddingMany`/`migrateRemovingMany` (called by apply) | Main only | Serial | Plain stores; `commitRecord` two-store (entity-model §4.2); bitmask `|=`/`&=` (archetype-storage §6.2). |
| `isAlive` (validate) | Main only | Serial | Plain loads; never bitmask (entity-model §3.3). |
| `returnReservedIds` | Main only | Serial (during flush) | Uses serial free-list (entity-model §3.2). |
| buffer transport (post `{words, head}`) | Worker→Main | At wave fence | Transfer (zero-copy) or shared-AB read; the wave Atomics fence (workers spec) guarantees the worker is done writing before the main thread reads. |

**Load-bearing rule:** the command buffer touches **no shared mutable structure** during a wave
(write side is worker-local AB; read side is post-fence main-thread). Every structural mutation is
the main thread replaying buffers serially. So **v1 needs no atomics anywhere in this module** — the
wave fence (workers spec, report §6.3) is the only synchronization, and it sits *outside* this
module. This is the entire reason the command buffer is the correct parallel-ready seam (Must-Fix
#1 / #3).

---

## 11. Invariants (testable assertions)

- **CB-1 (worker-local, no atomics).** A `CommandBuffer`'s `words` is a plain `ArrayBuffer`-backed
  `Uint32Array`, never a `SharedArrayBuffer` (§3.1). Test: assert `!(cb.words.buffer instanceof
  SharedArrayBuffer)` in every runtime.
- **CB-LEN (record boundaries).** Iterating `at += recordLen(words, at)` from `0` lands exactly on
  `head`; every record is visited once (§4.6). Test: encode a random op stream; assert the iteration
  consumes exactly `head` words and `recordCount` records.
- **CB-2 (deterministic merge).** Two runs of the same wave with different worker-completion orders
  produce **identical** post-flush world state (§7.2). Test: shuffle apply-trigger order across
  runs (completion order varies) but assert ascending-worker-index apply yields equal snapshots.
- **CB-SAFE (drop-if-dead).** A record naming a dead/tombstoned subject or target is dropped, emits
  no reactivity, and does not mutate the world (§8). Fuzz test at M7 exit: random create/destroy/add
  streams across workers; assert no applied op ever names a non-alive entity (report §6.1 fuzz).
- **CB-3 (create-then-use).** A handle from `create()` is alive at apply time and any later
  intra-buffer record naming it applies (`newlyCreated` whitelist, §8.5). Test: `e = create();
  add(e, P); setRelation(e, R, parent)` — all three apply.
- **CB-4 (reservation accounting).** Unused reserved handles are returned; consumed ones are not
  double-freed even if also destroyed this flush (§6.3). Test: reserve N, create K<N, destroy J<=K;
  assert free-list count consistent and no handle freed twice.
- **CB-5 (single-migration coalescing).** Adding C components and removing R components to one entity
  in one wave produces **one** `migrateAddingMany` and **one** `migrateRemovingMany` call (§9). Test:
  spy on `migrate*`; assert call counts are ≤1 each per entity per flush.
- **CB-6 (single-thread bypass).** With zero workers, `flushAll` is a no-op and every structural op
  went through `applyDirect`; the command-buffer path imposes zero allocation (§7.1, §2.2). Test:
  single-threaded world; assert `recordCount === 0` across frames.
- **CB-7 (reactivity once, in order).** Each applied structural change emits exactly one shape/write
  log entry, in ascending-worker-index then append order (§7.5). Test: assert the post-flush
  shape-log equals the deterministic concatenation of per-worker applied (non-dropped) records.
- **CB-8 (object components rejected).** A worker-side `add`/`setPayload` of a `restrictedToMainThread`
  object component is a TS error and a dev-mode runtime throw (§4.3, §5.7). Test: `@ts-expect-error`
  fixture + runtime throw assertion.
- **CB-9 (reservation exhaustion is recoverable).** Exhausting a reservation yields `NO_ENTITY` and a
  dev warning, never a throw; subsequent ops naming `NO_ENTITY` are dropped (§6.4, §8). Test:
  under-size `maxSpawnsPerWave`; assert no crash, spawns silently capped.

---

## 12. Complexity summary

| Operation | Time | Space |
|---|---|---|
| `create` (encode) | O(1) amortized (amortized over buffer doubling) | O(1) words appended |
| `destroy`/`remove`/`unsetRelation` (encode) | O(1) amortized | O(1)–O(record) words |
| `add`/`setPayload`/`setRelation` (encode) | O(F) field-word copy | O(F) words |
| `ensureWords` grow | O(head) copy per grow; O(log cap) grows total | doubling |
| `resetBuffer` | O(1) (head→0, retain backing) | 0 alloc (steady state) |
| `prepareWave` (reserve) | O(workers × n) `allocEntity` | O(workers × n) handles |
| `flushAll` | O(total record words) apply + O(distinct entities) `migrate*` | O(distinct entities mutated) pending map + O(destroyed) tombstones |
| `validateSubject`/`validateTarget` | O(1) (1 set lookup + 1 `isAlive`) | 0 |
| per-entity coalesced migration | O(K) shared-column copy per entity (C-MIG-1) | O(adds+removes) per entity |
| tombstone set | O(1) add/lookup | O(destroyed this flush) |

Whole-flush cost is **O(Σ record words + Σ migrations)**, with at most one add-migration and one
remove-migration per distinct mutated entity (coalescing, §9) — the report's "batches a frame's
structural churn into one coalesced pass" (report §4 "Defer structural changes", line ~897).

---

## 13. Open questions deferred (non-blocking, from report §8)

- **Q-CB1 (drain cadence within a buffer):** §9.4 ships drain-on-dependency (b) for append-order
  reactivity; end-of-buffer (a) is a fewer-migrations alternative. Both yield identical final state;
  the choice affects only shape-log interleaving. Benchmarked at M7.
- **Q-CB2 (flush cadence across waves):** report Q-S2 — flush after every wave (v1 default, enables
  between-wave observers) vs frame-end-only (lower sync overhead, observers only at frame end). The
  `flushAll` mechanism is cadence-agnostic (§2.1); the scheduler picks.
- **Q-CB3 (sub-word payload packing):** §3.2 keeps every payload slot word-aligned for branch-free
  decode; packing `u8`/`bool` payloads to sub-word would shrink buffers at the cost of decode
  branching. Deferred; measured at M7.
- **Q-CB4 (shared pre-allocated buffer vs transfer-at-flush):** §3.5 ships transfer-at-flush for the
  literal "worker-local, main-reads-after" invariant; a main-thread-pre-allocated AB the worker
  writes into (avoiding the per-flush post) is a workers-spec transport optimization.
- **Q-CB5 (`maxSpawnsPerWave` auto-sizing):** §6.1 sizes reservations from a static per-system
  declaration (default 64); an adaptive size from observed per-wave spawn counts is a tuning knob,
  not a blocker (§6.4 already degrades gracefully on under-size).
```
