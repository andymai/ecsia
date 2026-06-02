# ecsia Implementation Spec — Memory, Buffers & SharedArrayBuffer Strategy

> Module owner: `@ecsia/core` (`src/storage/`, `src/component/buffers/`).
> Status: implementable. This is a **foundation** module: the entity layer, archetype
> tables, queries, reactivity logs, scheduler workers and serialization all consume the
> contracts defined here. Other specs depend on the type signatures and invariants in
> §3, §5, §7, §8.
>
> All `file:line` citations refer to the three reference libraries surveyed in
> `docs/research/DESIGN-RESEARCH.md` (henceforth "the report"). Section pointers like
> "§7.2" refer to that report unless prefixed with "this spec".

---

## 0. Scope & Non-Goals

**In scope (this module owns the contract for):**

1. The physical column representation per field type (f32/i32/u8/bool/eid/staticString/vecN).
2. The `Buffers` registry: allocation, keying, growth, and the SAB-vs-ArrayBuffer decision.
3. Cross-origin-isolation detection and the runtime capability matrix that drives buffer
   backing selection.
4. The buffer **growth protocol** and its load-bearing correctness invariant — accessor
   **view invalidation** (report §6.2 / §7.2, Must-Fix #5).
5. The two concrete growth paths: (a) length-tracking views over resizable SABs (primary),
   (b) grow-and-patch with a live-accessor registry + serial quiescence (fallback).

**Out of scope (consumed from / handed to other modules):**

- Archetype identity, the edge graph, migration/shuffle-pop logic — `archetype-storage` spec.
  This module provides the `Column` and `ColumnSet` that an archetype owns; the archetype owns
  the rows.
- The accessor *factory-closure class* shape and `__idx` poking — `accessors` spec. This
  module specifies the **view-lifecycle contract** the accessor closures must obey (§7) and
  the `AccessorRegistry` they register into for the fallback path.
- The per-entity bitmask membership index layout — owned by **archetype-storage.md §6** (there
  is no separate `bitmask.md`; "bitmask" is a logical submodule inside the storage spec). This
  module specifies only that the bitmask words are a flat SAB region allocated through the same
  `Buffers` registry, and that it is **main-thread-only** (report Must-Fix #1).
- Command-buffer encoding — `scheduler/commands` spec (report §6.1). This module only states
  that growth never occurs mid-wave (§7.4), which the command-buffer serial-flush model
  guarantees.

---

## 1. How this module satisfies the locked decisions

| Locked decision | Where satisfied in this spec |
|---|---|
| ESM-only, strict TS | All signatures are `export`ed, no `any` except the deliberate `KernelInstance`-style escape at §3.6. |
| Storage = SoA columns kept coherent w/ bitmask | §3 (column layout), §5 (Buffers registry allocates both); bitmask is just another registered SAB region (§5.4), main-thread-only per §7.4. |
| Field types numeric + non-numeric encodable (eid/bool/staticString) | §3.2 field-type table; encoders §3.3–3.5. |
| SAB-capable, postMessage fallback REQUIRED | §4 capability probe; §6 backing selection; §4.3 postMessage-fallback backing. |
| Accessors = monomorphic factory-closure, NOT Proxy/codegen | This module does not build accessors but defines the **view contract** (§7.1) they close over and the registry (§7.5) the fallback path needs. |
| Buffer GROWTH + accessor VIEW-INVALIDATION must-fix #5 | §7 in full — primary length-tracking path (§7.2), fallback registry path (§7.5), quiescence proof (§7.4). |
| Relations: pair IDs are ordinary component IDs | §5.2 column keying is by `(archetypeId, componentTypeId, fieldIndex)`; pair IDs are component IDs, so payload columns register identically (§3.7). |
| Reactivity logs are SAB rings | §5.4 registers `shapeLog`/`writeLog` regions; growth of rings reuses the ring-resize path (§7.6). |
| Generational entity handle, two-word entity record | §3.2 `eid` field type; §5.4 entity-record arrays are registered flat SAB regions. |
| Serialization: zero-copy SAB vs copy snapshot | §6.4 exposes `column.snapshotInto()` (copy) vs `column.shared` (zero-copy); growth never reallocates on the primary path so SAB identity is stable for zero-copy sharing (§7.2). |

---

## 2. Terminology & Units

- **Word** = 4 bytes = one `Uint32`/`Int32`/`Float32` slot. Bit splits and offsets in this
  spec are expressed in words unless a `byte` suffix is given.
- **Column** = the storage for ONE field of ONE component within ONE archetype: a single
  TypedArray view over a backing buffer. `capacity` rows, `stride` elements per row.
- **ColumnSet** = all columns for one `(archetype, component)` pair.
- **Backing** = the underlying `SharedArrayBuffer | ArrayBuffer` a column's view wraps.
- **Row** = an entity's slot within an archetype (`archetypeRow` in the entity record).
- **Capacity** = number of rows a column can hold before it must grow. `count <= capacity`.
- **Resizable buffer** = `new SharedArrayBuffer(byteLength, { maxByteLength })` (or the
  `ArrayBuffer` form), supporting `.grow(newByteLength)`.
- **Length-tracking view** = a TypedArray constructed over a resizable buffer **with the
  length argument omitted** (`new Float32Array(sab)` or `new Float32Array(sab, byteOffset)`).
  Per ECMA-262 (§ `MakeTypedArrayWithBufferWitnessRecord` / auto-length), its `.length`
  re-derives from the buffer's current byte length on every access, so it widens after
  `.grow()`. This is the single ECMAScript fact the whole growth strategy turns on
  (report §6.2).

---

## 3. Column representation per field type

### 3.1 `Column` interface

```ts
/** A branded element-type tag, distinct per TypedArray ctor we use. */
export type ElementKind =
  | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64';

export interface ColumnLayout {
  /** Backing TypedArray constructor for the physical element. */
  readonly element: ElementKind;
  /** Elements per row. 1 for scalars; n for vecN; see staticString/eid below. */
  readonly stride: number;
  /** Bytes per element = element byte size. */
  readonly elementBytes: number;
  /** Bytes per row = stride * elementBytes. */
  readonly rowBytes: number;
}

export interface Column<TA extends TypedArray = TypedArray> {
  readonly layout: ColumnLayout;
  /** Key into the Buffers registry: `${archetypeId}:${componentTypeId}.${fieldIndex}`
   *  (archetype-scoped — the archetypeId prefix is REQUIRED so two archetypes sharing a
   *  component do not collide on one registry entry). Canonical format is §5.2. */
  readonly key: ColumnKey;
  /** The current length-tracking (primary) or re-created (fallback) view. */
  view: TA;                 // MUTABLE: re-pointed only on the fallback grow path (§7.5).
  readonly backing: Backing; // MUTABLE identity ONLY on fallback path; stable on primary path.
  /** Rows the current backing can hold without growth. Derived from byteLength/rowBytes. */
  capacity(): number;
}

export type TypedArray =
  | Uint8Array | Int8Array | Uint16Array | Int16Array
  | Uint32Array | Int32Array | Float32Array | Float64Array;

export type Backing = SharedArrayBuffer | ArrayBuffer;
export type ColumnKey = string & { readonly __columnKey: unique symbol };
```

Invariant **C-1**: `view.length === capacity() * layout.stride` at all observable points
(serial-phase quiescence; never asserted mid-wave). On the primary path this holds
automatically because the view is length-tracking and capacity is derived from
`backing.byteLength`. See §7.4.

### 3.2 Field type → column mapping

`defineComponent({ x: 'f32', ... })` maps each schema field to a `FieldSpec`, and each
`FieldSpec` to exactly one `ColumnLayout`. (One TypedArray per scalar field, one per vector
field — report §2.2 "Layout"; bitECS legacy `legacy/index.ts:167-189`.)

| Schema field type | `ElementKind` | stride | Row meaning | Encoding notes |
|---|---|---|---|---|
| `'bool'` | `u8` | 1 | `0`/`1` | §3.3 |
| `'i8'`/`'u8'` | `i8`/`u8` | 1 | signed/unsigned byte | — |
| `'i16'`/`'u16'` | `i16`/`u16` | 1 | — | — |
| `'i32'`/`'u32'` | `i32`/`u32` | 1 | — | — |
| `'f32'`/`'f64'` | `f32`/`f64` | 1 | — | — |
| `'eid'` | `i32` | 1 | entity handle or `-1` sentinel | §3.4 |
| `staticString(choices)` | smallest of `u8`/`u16`/`u32` covering `choices.length` | 1 | enum index into the choices table | §3.5 |
| `vecN(t, n)` | `t`'s ElementKind | `n` | n contiguous elements per row | §3.6 |
| `object<T>` | — (no column) | — | NOT a column; plain JS `Array<T>` | §3.8 |

Rationale for "one buffer per field, not packed per component": report §2.2 "Layout"
("separate buffers per field (avoids alignment bugs)") and Q-C2. Vector fields keep one
contiguous view (not one-per-axis) for `view.set(srcSlice)` snapshot speed; per-axis SIMD
bulk ops can re-derive subarrays — see §3.6.

### 3.3 `bool`

Stored as `u8` (one byte). `read => view[idx] !== 0`; `write(b) => view[idx] = b ? 1 : 0`.
A packed-bit representation is rejected for v1: a bitfield column cannot give the accessor a
stable per-row word offset that grows cleanly under length-tracking, and the byte cost
(1 B/entity) is negligible against the alignment/complexity cost. Tag components (zero
fields) are NOT bool columns — they have no column at all (report §2.2 "Tag components";
becsy `component.ts:387-389`).

### 3.4 `eid`

Stored as `i32`. The entity handle is a generational u32 (report §2.3, default 22 index /
10 generation bits) but we store it in an **`Int32Array`**, reusing becsy's convention
(`becsy/src/type.ts:787-931`): `-1` is the **null sentinel** (no referenced entity).
Because the index space is capped at `2^22 = 4_194_304` and generation occupies the high 10
bits, the full u32 handle value can exceed `2^31`; we therefore store the **entire u32 handle
bit-pattern** (index ⊕ generation — NOT just the low `indexBits`) via `Int32Array`
(two's-complement reinterpretation), and read it back through `>>> 0` to recover the unsigned
value. **This is the normative definition of `eid` storage** (type-system.md §1.4 forwards
here): one `Int32Array` store, no parallel generation column, no bit-31 stale flag.

```ts
// NORMATIVE: `encodeEid` stores the FULL u32 handle bit-pattern, not only the index bits.
export function encodeEid(handle: EntityHandle): number {
  return handle | 0;            // store full handle bit pattern; -1 reserved as null sentinel
}
export function decodeEid(stored: number): EntityHandle | null {
  return stored === -1 ? null : (stored >>> 0) as EntityHandle;
}
```

Invariant **C-2 (eid sentinel)**: a freshly-allocated `eid` column row MUST be initialized to
`-1` (null), NOT `0` (which is a valid entity index). Column initialization on row alloc and
on growth therefore fills the *new* region with `-1` for `eid` columns (§7.3). All other
column kinds zero-fill (the buffer is zero-initialized by the runtime; growth's new region is
also zero per spec, so only `eid` needs explicit fill).

> We do NOT implement becsy's bit-31 "stale ref" flag (`type.ts:787-931`) in the column.
> Staleness is resolved through the generation field of the handle itself at read time via
> `world.isAlive(handle)` (report §2.3 "Stale detection") — keeping the column a plain
> handle store and pushing liveness to the entity layer. This is a deliberate divergence; it
> avoids a per-write mask and keeps the eid column a single store.

### 3.5 `staticString(choices)`

A fixed enumeration of string constants known at `defineComponent` time. The column stores
the **index** into the choices table, NOT the bytes (report §2.2 "Static strings as
typed-array indices"; becsy `type.ts:566-784`). Element width is the smallest unsigned type
covering `choices.length` (mirrors becsy's variable-width index upgrade, `component.ts:209,
266-270`):

```
choices.length <= 256        -> u8
choices.length <= 65_536     -> u16
otherwise                    -> u32
```

The choices table (`readonly string[]`) lives once on the `ComponentDef`, NOT per archetype,
NOT per row. Read = `choices[view[idx]]`; write = `view[idx] = indexOf(value)` (the index is
resolved at the accessor boundary; an unknown value is a dev-mode throw, prod-mode no-op write
of `0`). There is **no `dynamicString`/`fixedString` in v1** (report §2.2: rejects unbounded
SAB strings, becsy `type.ts:676-784`); `fixedString(maxBytes)` may be added later.

### 3.6 `vecN(t, n)`

One contiguous column, `stride = n`, element type `t`. Row `r`'s components occupy
`view[r*n + 0 .. r*n + n-1]`. The accessor exposes them as `.x/.y/.z` (n<=4) or `[i]`. For
SIMD/bulk per-axis work, callers obtain a strided view through a helper rather than a separate
buffer:

```ts
/** Returns the contiguous slice for one row: view.subarray(r*n, r*n+n). Zero-copy. */
export function rowSlice(col: Column, row: number): TypedArray;
```

Rejecting the bitECS "one TypedArray per axis" layout (`legacy/index.ts:100-101, 171-173`):
that multiplies the number of length-tracking views (and, on the fallback path, the number of
registry re-binds — §7.5) by `n`, for a SIMD win we do not need in v1. Documented as Q-C2.

### 3.7 Relation payload columns

A pair `(relationId, targetEid)` is assigned a synthetic `componentTypeId` (report §2.6). Its
payload schema, if any, registers columns through the **identical** path as a normal component
— `componentTypeId` is just an integer to this module. The exclusivity split (report Must-Fix
#4) is decided one level up:

- **Exclusive relation payload** → an ordinary column on the *subject* archetype (this
  module sees a normal `Column`).
- **Non-exclusive relation payload** → a pair-keyed overflow SoA block. This module supplies
  the overflow block as a single `ColumnSet` keyed by a synthetic `componentTypeId` reserved
  for the relation's overflow, indexed by an overflow-row integer (the hash map
  `(relationId, subjectEid, targetEid) → overflowRow` lives in the `relations` module). The
  overflow `ColumnSet` grows through the same protocol (§7); its rows are NOT entity rows.

This spec's only obligation: the registry MUST accept synthetic component IDs identical to
real ones, and MUST NOT assume `row` indexes a live entity (overflow rows do not).

### 3.8 `object<T>` (non-shareable escape hatch)

`object<T>` fields have **no column and no buffer**. They are stored as a plain JS
`Array<T | undefined>` per `(archetype, component)` and the component is structurally marked
`restrictedToMainThread` (report §2.2 "SAB strategy": "make the split structural at the type
level"). A worker-tagged system referencing an object-field component is a **TS error**
(enforced in the `schema`/`scheduler` specs; this module only refuses to register a backing
buffer for an object field and exposes `field.shared === false`). Growth of the JS array is a
plain `array.length = newCapacity` and is NOT part of §7 (no view to invalidate).

---

## 4. Runtime capability detection

Selection happens **once at world creation** (report §2.2 "SAB strategy: one `threaded`
boolean at world creation"; becsy `buffers.ts:96-124`, `dispatcher.ts:141`). The probe is
pure (no side effects) and its result is frozen onto the world.

### 4.1 Capability record

```ts
export interface RuntimeCapabilities {
  /** SharedArrayBuffer constructor exists AND (in browser) crossOriginIsolated. */
  readonly sabAvailable: boolean;
  /** `new SharedArrayBuffer(0, { maxByteLength })` accepted (resizable SAB). */
  readonly resizableSab: boolean;
  /** `new ArrayBuffer(0, { maxByteLength })` accepted (resizable AB, for single-thread). */
  readonly resizableAb: boolean;
  /** Atomics.waitAsync present (browser-main-thread non-blocking wait). */
  readonly waitAsync: boolean;
  /** Atomics.wait present (worker / Node blocking wait). */
  readonly waitBlocking: boolean;
  /** globalThis.crossOriginIsolated === true (browser COOP/COEP). undefined outside browser. */
  readonly crossOriginIsolated: boolean | undefined;
  /** Best buffer backing strategy given the above + requested mode (§4.2). */
  readonly backing: BackingStrategy;
}

export type BackingStrategy =
  | 'resizable-sab'    // primary threaded path: resizable SAB + length-tracking views (§7.2)
  | 'grow-patch-sab'   // threaded, non-resizable SAB: allocate-and-copy + registry (§7.5)
  | 'resizable-ab'     // single-thread (or postMessage fallback): resizable ArrayBuffer
  | 'grow-patch-ab';   // single-thread, non-resizable ArrayBuffer: allocate-and-copy
```

### 4.2 Probe algorithm

```
function probeCapabilities(req: WorkerMode): RuntimeCapabilities
  // WorkerMode = 'single' | 'sab' | 'postMessage-fallback' | 'auto'   (from createWorld)
  1. sabCtor   := typeof SharedArrayBuffer === 'function'
  2. coi       := (typeof crossOriginIsolated !== 'undefined') ? crossOriginIsolated : undefined
       // Node/worker_threads: crossOriginIsolated is undefined -> treat SAB as usable.
       // Browser: SAB constructor may exist but be unusable without COI; gate on coi !== false.
  3. sabAvailable := sabCtor && (coi !== false)
  4. resizableSab := sabAvailable && tryCtor(() => new SharedArrayBuffer(8, { maxByteLength: 16 }))
  5. resizableAb  := tryCtor(() => new ArrayBuffer(8, { maxByteLength: 16 }))
  6. waitAsync    := sabAvailable && typeof Atomics.waitAsync === 'function'
  7. waitBlocking := sabAvailable && typeof Atomics.wait === 'function'
  8. backing := selectBacking(req, sabAvailable, resizableSab, resizableAb)
  9. freeze and return
```

`tryCtor` wraps construction in `try/catch` and returns the boolean (some engines expose the
options arg but reject `maxByteLength`; the only honest probe is to construct, mirroring
bitECS's `growBuffer.ts` try/catch around `.grow()`, report §2.5 qualification).

### 4.3 Backing selection (`selectBacking`)

```
selectBacking(req, sabAvailable, resizableSab, resizableAb):
  if req === 'single':
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
  if req === 'sab':
      if !sabAvailable: THROW ConfigError("workers:'sab' requires SharedArrayBuffer + cross-origin isolation")
      return resizableSab ? 'resizable-sab' : 'grow-patch-sab'
  if req === 'postMessage-fallback':
      // Columns are plain ArrayBuffers transferred per wave (report §6.3 no-SAB fallback).
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
  if req === 'auto':
      if sabAvailable: return resizableSab ? 'resizable-sab' : 'grow-patch-sab'
      // SAB unavailable: never silently fail (report §6.3). Emit startup diagnostic,
      // run single-threaded over ArrayBuffers.
      emitDiagnostic("SAB/cross-origin-isolation unavailable; running single-threaded")
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
```

**Honest claim alignment** (report §3 #9, §6.3): "all runtimes via SAB" is qualified — SAB is
used only where cross-origin isolation is present; otherwise single-thread or postMessage
fallback. This module's `backing` field is the single switch every allocation reads. The
fallback **never silently fails**: `'sab'` throws; `'auto'` diagnoses and degrades.

Edge cases:
- **Node main thread**: `crossOriginIsolated` is `undefined`; step 2/3 treat SAB as usable
  (`coi !== false`). Correct — Node has no COOP/COEP gate.
- **Browser without COOP/COEP**: SAB ctor may exist but `crossOriginIsolated === false`;
  `sabAvailable` is false; `'auto'` degrades, `'sab'` throws.
- **Engine with SAB but no resizable SAB** (older Safari): `'resizable-sab'` unselectable;
  falls to `'grow-patch-sab'` (§7.5 registry path is mandatory there).

---

## 5. The Buffers registry

Central allocator and growth coordinator. Mirrors becsy's `Buffers` (`buffers.ts:96-125`) but
(a) keys per `(archetypeId, componentTypeId, fieldIndex)` — archetype-scoped, the archetypeId is
part of the key (report §2.2 "central `Buffers`"; canonical format §5.2), and (b) replaces the
manual patch protocol
with the length-tracking-view path as primary (report §6.2; rejects becsy `makePatch`/
`applyPatch` as fragile, report §2.9).

### 5.1 Interface

```ts
export interface Buffers {
  readonly capabilities: RuntimeCapabilities;

  /** Allocate (or fetch existing) a column. Idempotent per key. */
  column(key: ColumnKey, layout: ColumnLayout, initialCapacity: number): Column;

  /** Allocate a flat global region (entity records, bitmask words, log rings). */
  region<TA extends TypedArray>(
    key: RegionKey, element: ElementKind, length: number, opts?: RegionOpts,
  ): Region<TA>;

  /** Grow a column to >= newCapacity rows. Returns the (possibly re-pointed) Column. */
  grow(col: Column, newCapacity: number): Column;

  /** Register a live accessor so the fallback grow path can re-bind its view (§7.5). */
  registerAccessor(key: ColumnKey, accessor: ViewHolder): void;
  unregisterAccessor(key: ColumnKey, accessor: ViewHolder): void;

  /** Serialize the worker-relevant buffer handles for transfer at worker startup (§6.3). */
  exportSharedHandles(): SharedHandleManifest;
}

export interface RegionOpts {
  /** Fixed-size region that never grows (entity records sized by maxEntities). */
  readonly fixed?: boolean;
  /** Max byte length reserved for a growable region's resizable buffer. */
  readonly maxLength?: number;
  /** Fill value for the (entire, on alloc) region and any grown tail. Default 0. */
  readonly fill?: number;
}

export interface Region<TA extends TypedArray> {
  view: TA;                 // length-tracking on primary; re-pointed on fallback
  readonly backing: Backing;
  readonly key: RegionKey;
  capacity(): number;       // length / 1 (regions are stride-1)
}

export type RegionKey = string & { readonly __regionKey: unique symbol };

/** Anything holding a captured view that must be re-bound on a fallback grow. */
export interface ViewHolder {
  /** Re-point the captured view(s) to the new backing. Called only on fallback grow. */
  __rebind(newBacking: Backing): void;
}
```

### 5.2 Keys

- **Column key**: `` `${archetypeId}:${componentTypeId}.${fieldIndex}` `` cast to `ColumnKey`.
  Archetype-scoped because each archetype owns its own column for a given component. Pair IDs
  use their synthetic `componentTypeId` (§3.7) — no special casing.
- **Region key**: a stable string constant per global structure:
  `'entity.archetypeId'`, `'entity.archetypeRow'`, `'entity.generation'`,
  `'idpool.dense'`, `'idpool.sparse'`,
  `'bitmask.words'`,
  `'log.shape'`, `'log.write'`.

The key map is `Map<string, Column | Region>` for idempotent allocation (the same key returns
the same object — report §2.2 "central `Buffers`").

### 5.3 Allocation algorithm (`column`)

```
column(key, layout, initialCapacity):
  if registry.has(key): return registry.get(key)        // idempotent
  rowBytes := layout.rowBytes
  byteLen  := rowBytes * initialCapacity
  maxBytes := rowBytes * maxCapacityFor(initialCapacity)   // reservation, see §7.7
  backing  := allocBacking(byteLen, maxBytes)            // §5.5
  view     := makeView(layout.element, backing)          // LENGTH-TRACKING (no length arg) §7.1
  col      := { layout, key, view, backing, capacity: () => backing.byteLength / rowBytes }
  if layout requires non-zero fill (eid -> -1): fillRange(view, 0, view.length, fillValue)
  registry.set(key, col)
  return col
```

### 5.4 Global regions allocated here

Allocated once at world creation, sized by `maxEntities` (report §4 T4: "Pre-allocate the
flat per-entity structures as SABs sized by `maxEntities`"). All are SAB when `backing` is a
`*-sab` strategy, else AB.

| Region key | Element | Length | Fixed? | Notes |
|---|---|---|---|---|
| `entity.archetypeId` | `u32` | `maxEntities` | yes | first word of the two-word entity record (report §2.3) |
| `entity.archetypeRow` | `u32` | `maxEntities` | yes | second word — structural commit point |
| `entity.generation` | `u32` | `maxEntities` | yes | generation per index slot |
| `idpool.dense` | `u32` | `maxEntities` | yes | bitECS free-list dense (report §2.3) |
| `idpool.sparse` | `u32` | `maxEntities` | yes | bitECS free-list sparse |
| `bitmask.words` | `u32` | `maxEntities * stride` | growable* | membership index; `stride = ceil(numComponentTypes/32)`. MAIN-THREAD-ONLY (report Must-Fix #1). |
| `log.shape` | `u32` | `maxShapeChangesPerFrame` | growable | reactivity ring (report §2.7) |
| `log.write` | `u32` | `maxWritesPerFrame` | growable | reactivity ring |

\* The bitmask `stride` is fixed at world creation from the **registered component-type count**
and grows only when new component *types* (not new pairs) are minted; pair IDs use a separate
lazily-grown sparse vector (report §2.1, §7.4). That sparse pair-bit vector is owned by the
`bitmask` module; it allocates through `region(..., { fixed:false })` and grows via §7.6.
**Because the bitmask is main-thread-only, its growth never needs the worker re-bind path
(§7.5) — it is always re-pointed in place on the main thread.**

### 5.5 `allocBacking`

```
allocBacking(byteLen, maxBytes):
  switch capabilities.backing:
    'resizable-sab': return new SharedArrayBuffer(byteLen, { maxByteLength: maxBytes })
    'resizable-ab' : return new ArrayBuffer(byteLen,       { maxByteLength: maxBytes })
    'grow-patch-sab': return new SharedArrayBuffer(byteLen)   // non-resizable
    'grow-patch-ab' : return new ArrayBuffer(byteLen)         // non-resizable
```

`makeView(element, backing)` constructs the TypedArray for `element` **with no length
argument** — this is the §7.1 correctness invariant.

---

## 6. SAB vs ArrayBuffer & cross-worker handoff

### 6.1 The single switch

Every backing decision reads `capabilities.backing` (§4). There is exactly one branch in the
codebase that decides SAB-vs-AB: `allocBacking` (§5.5). No subsystem re-decides.

### 6.2 What is shareable

- **Column backings**: SAB on `*-sab`; on `*-ab` they are not shared — see §6.3.
- **Object fields (§3.8)**: never shareable; component is `restrictedToMainThread`.
- **`staticString` choices table**: a JS `string[]` on the `ComponentDef`, replicated to
  workers once at startup by structured clone (immutable, tiny). Columns store only indices.

### 6.3 Worker startup transfer & postMessage fallback

**SAB path (`*-sab`)**: `exportSharedHandles()` returns a manifest of `{ key, backing,
layout }` for every column + region. SABs are posted to workers **once at startup** (report
§2.5 "SABs transferred to workers once at startup, not per frame"). Each worker re-wraps every
SAB with a length-tracking view of the matching element kind and builds its own `Column`/
`Region` mirror referencing the **same** SAB.

```ts
export interface SharedHandleManifest {
  columns: ReadonlyArray<{ key: ColumnKey; backing: SharedArrayBuffer; layout: ColumnLayout }>;
  regions: ReadonlyArray<{ key: RegionKey; backing: SharedArrayBuffer; element: ElementKind }>;
}
```

Lazily-created archetype columns appear after worker startup (report §4 T4). Their SABs are
posted to workers when the archetype is first created (always at a serial flush point); the
worker re-wraps before the next wave. (Worker-dispatch sequencing is the `scheduler/workers`
spec; this module guarantees only that the SAB identity is stable on the primary path so a
worker that re-wrapped once never needs to re-wrap due to growth — §7.2.)

**postMessage fallback (`*-ab` with `workers:'postMessage-fallback'`)**: columns are plain
`ArrayBuffer`s. Per wave, the scheduler **transfers** (zero-copy `Transferable`, NOT
structured-clone-copy — report §6.3) the columns a batch needs to its worker, and the worker
transfers them back on completion. This module's contribution: `Column.backing` is a plain
`ArrayBuffer` here, and `exportSharedHandles()` returns `transferList`-eligible buffers. The
structural delta stream (serialization spec) is the structural-change transport in this mode.

### 6.4 Zero-copy vs copy serialization boundary

Two distinct exports, satisfying the locked "separate zero-copy SAB sharing from copy-based
snapshot/delta" decision:

```ts
/** Zero-copy: the live SAB. Valid for intra-process worker sharing ONLY. */
export function sharedBacking(col: Column): SharedArrayBuffer | null; // null on *-ab

/** Copy: write `count` rows into a detached ArrayBuffer for snapshot/persistence/network. */
export function snapshotInto(col: Column, count: number, out: TypedArray, outOffset: number): number;
//   returns elements written = count * stride; uses one `out.set(view.subarray(0, count*stride))`.
```

On the **primary (resizable) path** a column's SAB identity is stable across growth (§7.2), so
a worker that captured `sharedBacking(col)` keeps a valid handle forever — this is what makes
zero-copy sharing safe without re-broadcast on growth. (Contrast becsy's patch cycle,
`buffers.ts:115-144`, report §2.9.)

---

## 7. Buffer growth protocol & accessor view-invalidation (Must-Fix #5)

This is the module's load-bearing section. It resolves report Must-Fix #5 / §6.2 (§7.2) to a
concrete protocol.

### 7.1 The correctness invariant

> **Invariant V-1 (length-tracking views).** On a `*-sab` or `*-ab` **resizable** backing,
> every column and region TypedArray view MUST be constructed **without a length argument**
> (`new Float32Array(backing)` or `new Float32Array(backing, byteOffset)`), making it a
> length-tracking view that widens automatically on `.grow()`. Constructing a view with an
> explicit length argument over a resizable backing is a **bug** and is rejected by a unit
> test at M2 (report §5.2 M2 exit).

The ECMAScript fact: a TypedArray over a resizable buffer with auto-length re-derives its
`.length` from the buffer's current byte length on each access (report §6.2 "The ECMAScript
fact this turns on"). A view created with an explicit length is fixed at construction and does
NOT widen — high rows then read/write outside the old window (the exact bug Must-Fix #5
guards against).

Why offsets are still fine: `new Float32Array(backing, byteOffset)` (length omitted) is still
length-tracking; it widens. Only the **length** argument freezes the window. Per-row offsets
within a row are computed by the accessor (`view[row*stride + axis]`), not by per-row views.

### 7.2 Primary path — resizable backing (`resizable-sab` / `resizable-ab`)

```
grow(col, newCapacity):                          // PRIMARY PATH
  required := newCapacity * col.layout.rowBytes
  if required <= col.backing.byteLength: return col           // already big enough
  target := nextCapacityBytes(col.backing.byteLength, required, col.backing.maxByteLength)  // §7.7
  col.backing.grow(target)                        // in-place; views auto-widen (V-1)
  // No view re-point. No registry walk. No worker re-broadcast.
  fillGrownTail(col, oldCapacity, newCapacity)    // §7.3: eid -> -1, else already zero
  return col
```

Properties:
- `col.view` is unchanged (same object), `col.backing` is unchanged (same SAB identity).
- **All** existing views widen: those captured in accessor closures (`accessors` spec), those
  held by workers, and `col.view` itself. **No accessor regeneration, no registry, no patch
  message** (report §6.2 "Primary strategy").
- Complexity: O(1) plus the runtime's internal grow (typically a no-copy commit of reserved
  pages, or at worst a copy hidden inside `.grow()` — but no JS-visible copy, no re-wrap).
- `nextCapacityBytes` doubles capacity (report §2.9 "double on growth"), clamped to
  `maxByteLength` (§7.7).

Edge case — `.grow()` **throws** (engine refuses, e.g. `maxByteLength` exhausted or platform
rejects despite the option): catch it and **escalate to the fallback path** (§7.5) for this
single grow, mirroring bitECS `growBuffer.ts` try/catch (report §2.5 qualification). This
keeps the primary path robust even on partially-conforming engines.

```
  try { col.backing.grow(target) }
  catch { return growFallback(col, newCapacity) }   // §7.5
```

### 7.3 Tail initialization on growth

The grown byte region is zero-filled by the runtime. Only columns whose zero value is not the
desired default need explicit fill:

```
fillGrownTail(col, oldCapacity, actualCapacity):
  // actualCapacity is the POST-GROW capacity (col.view.length / stride), NOT the requested
  // newCapacity: the doubling protocol (§7.7) over-allocates beyond newCapacity, so filling only
  // to newCapacity would leave eid rows in [newCapacity, actualCapacity) at 0 — a valid entity
  // index (entity 0), not the -1 null sentinel. C-2 requires the WHOLE grown tail be filled.
  if col.layout is an eid column:
      fillRange(col.view, oldCapacity * stride, actualCapacity * stride, -1)   // null sentinel (C-2)
  // all other kinds: zero is correct, no work
```

`fillRange(view, start, end, value)` is `view.fill(value, start, end)`. This is the only
per-growth O(newRows) cost on the primary path. Both paths pass the actual post-grow capacity:
the primary path derives it from `col.backing.byteLength / rowBytes`; the fallback path allocates
exactly `newCapacity * rowBytes` so the two coincide there.

### 7.4 Quiescence — why growth is always safe

> **Invariant V-2 (serial growth).** Column/region growth happens ONLY at a serial flush
> point on the main thread, NEVER mid-wave.

Proof obligation discharged by the command-buffer model (report §6.1 / §7.1): workers never
mutate structure during a wave; all create/add (which is what forces a column to grow) is
staged to per-worker command buffers and applied by the main thread **between waves**. Column
growth is therefore caused only by main-thread structural application, which by construction
runs while no worker is executing (report §4 T2: "growth only ever happens at a serial flush
point, never mid-wave").

Consequences:
- On the **primary** path, V-2 is not strictly required for correctness (views auto-widen even
  if a worker is mid-read — a length-tracking view widening cannot invalidate an in-range
  index), but it is still honored and it is what makes the **fallback** path correct (§7.5).
- The "registry + quiescence point" mechanism the Must-Fix names is the **fallback** path; on
  the primary path the registry is never walked (report §6.2: "on the primary path the
  registry is never walked at all").

### 7.5 Fallback path — non-resizable backing (`grow-patch-sab` / `grow-patch-ab`) + live-accessor registry

Used when `resizableSab`/`resizableAb` is false, or when a primary `.grow()` threw (§7.2). Here
a buffer cannot grow in place; we allocate a new buffer, copy, and **re-point every live view**
(report §6.2 "Fallback strategy").

```
growFallback(col, newCapacity):                  // FALLBACK PATH
  // PRECONDITION (V-2): we are at a serial flush point; no worker is executing.
  oldView := col.view
  rowBytes := col.layout.rowBytes
  newBacking := (capabilities.backing == 'grow-patch-sab')
                  ? new SharedArrayBuffer(newCapacity * rowBytes)
                  : new ArrayBuffer(newCapacity * rowBytes)
  newView := makeView(col.layout.element, newBacking)       // full-length view (non-resizable)
  newView.set(oldView)                                       // copy old rows (report buffers.ts:102-124)
  fillGrownTail-on(newView, oldCapacity, newCapacity)        // eid -> -1
  col.backing = newBacking                                   // re-point Column (mutable fields)
  col.view    = newView
  // Re-bind every live accessor closure that captured the old view:
  for holder in accessorRegistry.get(col.key) ?? []:
      holder.__rebind(newBacking)                            // accessor re-wraps -> newView
  // Re-broadcast to workers (they re-wrap before the next wave):
  if newBacking is SharedArrayBuffer:
      postNewBackingToWorkers(col.key, newBacking)
  return col
```

Registry contract:
- Accessors register via `registerAccessor(col.key, holder)` at creation, deregister on
  archetype teardown. Because accessor singletons are **one per `(archetype, component)`**
  (report §2.3), `accessorRegistry.get(key)` is a tiny set (the singleton plus, in the
  postMessage model, nothing — workers re-wrap from the broadcast, not the registry).
- `holder.__rebind(newBacking)` re-creates the holder's captured per-field views from
  `newBacking` using the per-field `byteOffset` + `ElementKind` the accessor captured at
  construction (passed as `ColumnBinding`s to the `AccessorFactory` — type-system.md §9,
  I-ACC-2b). This is the ONLY place the accessor's captured view object changes, and it closes
  the V-1 → I-ACC-2 → `__rebind` chain Must-Fix #5 requires: primary `.grow()` auto-widens the
  view (no call); a fallback grow rebuilds it from the new backing here.

Complexity / cost (the report's quantified worst case, §6.2): O(A×C) `__rebind` calls per
fallback grow event. With 1000 archetypes × 100 components = 100k cheap re-bind calls per grow.
Acceptable because (a) grows are O(log capacity) total (doubling) and (b) the registry is never
walked on the primary path.

### 7.6 Region growth (bitmask sparse pair-bits, log rings)

Regions grow through the same two paths. The reactivity log rings use the **recoverable spill**
model (report §2.7): mid-frame overflow spills to a main-thread growable `Array`, drained at
the next serial flush, and the ring is resized **next frame** to `2 × peak` — never mid-frame
(honors V-2). The ring's resize is a `grow`/`growFallback` call at the serial flush point.

The bitmask sparse pair-bit region (main-thread-only, §5.4) always re-points in place on the
main thread; it never needs `__rebind`/worker broadcast (no worker reads it — Must-Fix #1).

### 7.7 Reservation sizing (`maxByteLength`) and `nextCapacityBytes`

Resizable buffers must reserve `maxByteLength` up front; the reservation is address-space, not
committed memory (pages commit on `.grow()`). Defaults:

```
maxCapacityFor(initialCapacity):
  // Cap a column's reservation so a runaway archetype cannot reserve unbounded address space.
  return min( max(initialCapacity * GROWTH_RESERVE_FACTOR, MIN_RESERVE_ROWS), maxEntities )
  // GROWTH_RESERVE_FACTOR = 16 (default); MIN_RESERVE_ROWS = 1024; both createWorld options.

nextCapacityBytes(currentBytes, requiredBytes, maxBytes):
  // The doubling base MUST be non-zero: from currentBytes==0 the loop never progresses (0*2==0)
  // and spins forever. Seed from requiredBytes when the backing is empty so a grow off a
  // zero-capacity column still terminates at the required size.
  target := currentBytes > 0 ? currentBytes : requiredBytes
  while target < requiredBytes: target := target * 2          // double (report §2.9)
  return min(target, maxBytes)
  // If min(...) < requiredBytes (reservation exhausted), grow() will be given maxBytes and the
  // subsequent capacity check fails -> escalate to growFallback (§7.5), which allocates exactly
  // requiredBytes with no reservation cap. This is the safety valve for under-reserved columns.
```

`maxByteLength` for a column = `maxCapacityFor(initialCapacity) * rowBytes`. For `region`
allocations, `maxLength` (in `RegionOpts`) overrides; fixed regions reserve exactly their
length (no growth). Entity-record/idpool regions are `fixed:true` sized at `maxEntities`.

Q-C1 dependency: `maxEntities` is a `createWorld` option that sets index width, the fixed
region sizes, and the column reservation clamp. The default is documented in the world spec.

### 7.8 Worked example — Position { x:f32, y:f32 }, threaded resizable-SAB

```
1. defineComponent(Position): FieldSpec[] = [ {x,f32}, {y,f32} ].
2. Archetype A created. ColumnSet allocates two columns:
     key "A:cidPos.0" layout {f32,stride1,4B,4B}, initialCapacity 1024
       backing = new SharedArrayBuffer(4096, { maxByteLength: 65536 })   // 1024*16 reserve
       view    = new Float32Array(backing)            // length-tracking, length=1024
     key "A:cidPos.1" ... identical
3. Accessor singleton for (A, Position) closes over col.x.view, col.y.view; registers as
   ViewHolder for both keys (used only on fallback).
4. Worker startup: exportSharedHandles() posts both SABs; worker wraps
     xData = new Float32Array(backing_x)  // length-tracking
5. Entities fill A to row 1023. The 1025th add (at a serial flush) calls grow(col.x, 2048):
     required=8192 > 4096 -> target=8192 (<=65536) -> backing.grow(8192)
     col.x.view auto-widens to length 2048; accessor closure's xData widens; worker's xData widens.
     NO re-point, NO __rebind, NO re-broadcast. f32 tail is zero (correct).
6. Accessor created at step 3 still reads/writes row 1500 correctly post-grow (M2 exit test).
```

### 7.9 Edge cases & failure modes

| Case | Handling |
|---|---|
| `.grow()` throws on a resizable backing | Catch → `growFallback` for that grow (§7.2). |
| Reservation `maxByteLength` exhausted | `nextCapacityBytes` clamps; capacity check fails → `growFallback` (exact alloc, no cap) (§7.7). |
| Grow requested mid-wave | Cannot happen (V-2). If detected (dev assertion: `world.phase !== 'serial'`), throw. |
| `eid` column grown | Tail filled with `-1`, not 0 (§7.3, C-2). |
| Worker holds view during primary grow | Length-tracking view widens; in-range indices stay valid; no race (read of a widening view cannot tear an existing slot). |
| Worker holds view during fallback grow | Impossible by V-2 (workers idle at serial flush); re-broadcast happens before next wave. |
| `object<T>` field grows | Plain `array.length = newCapacity`; not a column; not in §7. |
| postMessage-fallback column grows | Plain `ArrayBuffer` re-alloc via `growFallback` ('grow-patch-ab'); next wave transfers the new buffer. |
| staticString choices > 2^32 | Rejected at `defineComponent` (dev throw); u32 index ceiling. |

---

## 8. Invariants (consolidated)

- **C-1** `view.length === capacity() * stride` at every serial-phase observable point (§3.1).
- **C-2** `eid` columns initialize new rows (alloc + grown tail) to `-1`, not `0` (§3.4, §7.3).
- **V-1** Views over resizable backings are constructed with NO length argument
  (length-tracking) (§7.1). Enforced by an M2 unit test.
- **V-2** Column/region growth happens ONLY at a serial flush point, never mid-wave (§7.4).
- **B-1** Exactly one code site (`allocBacking`, §5.5) decides SAB vs ArrayBuffer; everything
  else reads `capabilities.backing` (§6.1).
- **B-2** SAB identity of a column is stable across growth on the primary path (§7.2), making
  zero-copy cross-worker sharing safe without re-broadcast (§6.4).
- **M-1** The per-entity bitmask region is allocated here but is **main-thread-only**; its
  growth never uses the worker re-bind/broadcast path (report Must-Fix #1; §5.4, §7.6).
- **R-1** Registry walk (`__rebind` + broadcast) occurs ONLY on the fallback path (§7.5),
  never on the primary path (§7.2).

## 9. Complexity summary

| Operation | Primary (resizable) | Fallback (grow-patch) |
|---|---|---|
| `column()` alloc | O(1) + zero-init by runtime; O(stride·cap) only for eid fill | same |
| read/write a row | O(1), one TypedArray indexed access | O(1) |
| `grow()` (per event) | O(new rows) eid-fill only; O(1) otherwise; no JS copy | O(old rows) copy + O(A×C) `__rebind` + broadcast |
| total grows over lifetime | O(log capacity) (doubling) | O(log capacity) |
| worker startup transfer | O(#columns + #regions) SAB posts, once | same (or per-wave transfers in postMessage mode) |
| snapshot (copy) | O(count·stride) single `set()` | same |

## 10. Open questions deferred (non-blocking, from report §8)

- **Q-A2** one large SAB slab + custom allocator vs per-archetype SABs. This spec assumes
  **per-archetype column SABs** (simpler lifecycle, per-buffer length-tracking invariant).
  A slab allocator would change §5.3/§5.5 only; the §7 invariants are unaffected.
- **Q-C2** per-field independent buffers (chosen here, §3.2) vs archetype-packed. Length-
  tracking invariant V-1 is per-buffer, which favors per-field.
- **Q-C4** fixed-capacity (no-growth) component opt-in: a `column()` with
  `maxCapacity===initialCapacity` reservation; grow throws. Trivial extension of §7.7.
- **Q-A4** (RESOLVED — per-row, reactivity.md §6.1): the reactivity spec registers one parallel
  `changeVersion` `u32` column per hot archetype through §5.3 (allocated via the storage
  `archetypeCreated` hook, archetype-storage.md §5.3.1). This module only supplies the allocation
  path; the column inherits the V-1 length-tracking growth contract unchanged.

---

## Appendix A — Reference-library techniques: borrowed vs rejected

| Technique | Source `file:line` | ecsia decision |
|---|---|---|
| Central `Buffers` registry, 2× growth, copy-before-swap | becsy `buffers.ts:96-125` | **Borrowed** (registry + doubling), copy-before-swap only on fallback (§7.5). |
| `makePatch`/`applyPatch` manual re-wrap protocol | becsy `buffers.ts:115-144` | **Rejected** as fragile (report §2.9); replaced by length-tracking views (§7.2). Retained in spirit only inside `growFallback`'s broadcast (§7.5). |
| Schema-driven one-TypedArray-per-field SoA | bitECS legacy `legacy/index.ts:167-189` | **Borrowed** (§3.2). |
| One-TypedArray-per-axis vectors | bitECS legacy `legacy/index.ts:100-101, 171-173` | **Rejected** for v1 (§3.6); single contiguous vec column. |
| Static strings as typed-array indices | becsy `type.ts:566-784` | **Borrowed** (§3.5). |
| Variable-width index upgrade (Int8→16→32) | becsy `component.ts:209, 266-270` | **Borrowed** for staticString width selection (§3.5). |
| Entity refs as `Int32Array`, `-1` sentinel | becsy `type.ts:787-931` | **Borrowed** sentinel (§3.4); **rejected** the bit-31 stale flag (liveness via handle generation instead). |
| `Type.object` non-shareable escape hatch | becsy `type.ts:1024-1082` | **Borrowed**, made structural at type level (§3.8). |
| Unbounded dynamic SAB strings | becsy `type.ts:676-784` | **Rejected** (no `dynamicString` in v1, §3.5). |
| Resizable SAB + `.grow()` with try/catch fallback | bitECS `Uint32SparseSet.ts:26-67`, `growBuffer.ts` | **Borrowed** as the primary path + escalation (§7.2). |
| Transparent SAB/AB selection at creation | becsy `buffers.ts:96-124`, `dispatcher.ts:141` | **Borrowed** (§4, §6.1). |
| `Atomics.or/and` membership, `Atomics.sub` ID alloc | becsy `shapearray.ts:112-168`, `intpool.ts:88-104` | **Out of scope here**; consumed by bitmask/entity specs over regions allocated in §5.4. |
| 100 MB static backing + per-call `slice` | bitECS `SoASerializer.ts:547, 562` | **Rejected** (report §2.9); `snapshotInto` reuses a caller buffer (§6.4). |
