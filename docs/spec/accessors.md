# ecsia Implementation Spec — Module: Monomorphic Accessor Layer

> Module owner: `@ecsia/core` (`src/component/accessor/`).
> Status: implementable. This module owns the **value-level accessor machinery**: the
> factory-closure accessor *class generator* (one hidden class per `(archetype, component)`), the
> per-archetype accessor singleton pool, the read-only `entity.<comp>` shorthand vs the tracked
> `entity.write(C)` handle (Must-Fix #2), the `ViewHolder.__rebind` hook into buffer
> view-invalidation (Must-Fix #5), the vec view class, the relation-payload (`PairAccessor`) path,
> the cold-archetype accessor variant, and the **iteration cursor** systems iterate rows through.
>
> It sits on four already-written specs and honors their contracts **verbatim** — matching their
> type names, layouts, sentinels and signatures. It introduces **no** new field-encoding rules,
> **no** new buffer-growth decisions, and **no** new handle codec: those are owned upstream and
> consumed here.
> - `type-system.md` — `AccessorFactory<S>`, `ColumnBinding`, `AccessorInstance`,
>   `TypedArrayLike`, `ReadView<S>`/`WriteView<S>`, `ReadOf<C>`/`WriteOf<C>`, `FieldValue`,
>   `VecView`/`ReadonlyVecView`, `ComponentDef<S>`, `FieldDescriptor`, `PairAccessor`,
>   invariants I-ACC-1..I-ACC-4, `MAX_QUERY_ARITY`.
> - `memory-buffers.md` — `Column`, `ColumnLayout`, `ElementKind`, `TypedArray`, `Backing`,
>   `ColumnKey`, `Buffers.registerAccessor/unregisterAccessor`, `ViewHolder`, the length-tracking
>   invariant V-1, serial-growth invariant V-2, fallback `growFallback`/broadcast (§7.5), the
>   `encodeEid`/`decodeEid`/`-1` sentinel (C-2), `snapshotInto`.
> - `entity-model.md` — `EntityHandle`, `handleIndex`, `isAlive`, `resolveLocation`,
>   `EntityRef.__bind`/`__handle`/`__archetypeId`/`__row`, `NO_ENTITY`, `world.trackWrite`,
>   `world.phase`.
> - `archetype-storage.md` — `Archetype`, `ColumnSet`, `buildColumnSet` (§3.7), `EMPTY_ARCHETYPE_ID`,
>   `ARCHETYPE_NONE`, the per-archetype `rows`/`count`, the cold `ColdStore` (§10.3),
>   `world.tick`/`world.phase`.
>
> `file:line` citations reference the three reference libraries surveyed in
> `docs/research/DESIGN-RESEARCH.md` ("the report"). Section pointers like "§2.3" refer to the
> report unless prefixed with a spec filename.

---

## 0. Scope & Non-Goals

**In scope (this module owns):**

1. The **accessor factory** — `makeAccessorFactory(def)` producing the concrete
   `AccessorFactory<S>` value `defineComponent` records on the `ComponentDef` and
   `buildColumnSet` (archetype-storage §3.7) invokes once per `(archetype, component)`.
2. The **closure-bound accessor class** body: getters/setters that close over per-field column
   views (length-tracking) plus the layout numbers needed for fallback `__rebind`, reading a
   mutable `__idx`. NOT a Proxy, NOT `new Function()`/codegen (decision #4/#6).
3. The **read-only vs tracked-write surface** (Must-Fix #2): `entity.<comp>` / `entity.read(C)`
   typed `Readonly` over the *same* runtime instance; `entity.write(C)` mutable, whose setters
   call `world.trackWrite(handleIndex(eid), componentId)` for the `.changed` reactivity filter.
4. The **per-archetype accessor singleton pool**: one instance per `(archetype, component)`,
   reused across all rows by poking `__idx`; zero per-iteration allocation.
5. The **`ViewHolder.__rebind`** implementation (Must-Fix #5 / I-ACC-2b): on a fallback grow it
   reconstructs each captured field view from the new backing; never called on the primary path.
6. The **`VecView`/`ReadonlyVecView`** monomorphic view class (one per `(archetype, vec field)`).
7. The **`PairAccessor`** relation-payload accessor (exclusive subject-column path; non-exclusive
   overflow-row path), reusing the identical closure machinery.
8. The **cold-archetype accessor variant** that resolves a row through `ColdStore.rowOf` instead of
   a direct column index, behind the same `AccessorInstance` shape.
9. The **iteration cursor** — `ArchetypeCursor` / the `each`/`[Symbol.iterator]` driver that walks
   `arch.rows[0..count)`, pokes `__idx`, and yields a pooled element. Zero allocation per row.

**Out of scope (consumed from / handed to other modules):**

- Field → column physical layout, `ColumnLayout`, the `Buffers` registry, the growth protocol
  (length-tracking primary, grow-and-patch fallback), SAB-vs-AB selection — `memory-buffers.md`.
  This module *captures* a `Column.view` and *reconstructs* it on `__rebind`; it never decides
  backing or growth policy.
- `defineComponent` schema validation, the static `ReadView`/`WriteView`/`VecView` *types*, the
  arity cap, branded IDs, the `AccessorFactory<S>` *type signature* — `type-system.md`. This module
  supplies the factory *value* satisfying that type.
- `EntityRef` identity resolution (`handle → (archetypeId, row)`), `isAlive`, `resolveLocation`,
  `spawn`/`despawn`, `world.trackWrite` body — `entity-model.md`. This module installs the
  `read`/`write`/shorthand getters on `EntityRef.prototype` and calls `__bind`/`trackWrite`; it
  does not own them.
- Archetype identity, edge graph, migration, `buildColumnSet`'s archetype-side bookkeeping, the
  cold-store map structure — `archetype-storage.md`. This module owns only the accessor object that
  a `ColumnSet` holds and the cursor that iterates rows.
- Query compilation, `matchingArchetypes`, change-log rings, the scheduler — `query`/`reactivity`/
  `scheduler` specs. This module exposes the cursor those modules drive; it does not compile
  queries or fence waves.

---

## 1. How this module satisfies the locked decisions

| Locked decision (report) | Where satisfied in this spec |
|---|---|
| Accessors = MONOMORPHIC factory-closure classes, one hidden class per `(archetype, component)`; NOT ES Proxy, NOT `new Function()`/codegen (decision #4/#6, §2.2/§2.3) | §3 (factory), §4 (class shape), §5 (singleton pool). One class minted per pair at archetype creation; closures capture views; no `eval`, no Proxy. |
| `entity.<comp>.x` is **READ-ONLY** shorthand; tracked mutation via `entity.write(C).x = 5` (Must-Fix #2, §2.8) | §6: shorthand and `read()` return the same instance typed `Readonly`; `write()` returns it mutable, setters call `world.trackWrite`. Read-only-ness is type-only — one runtime hidden class. |
| Per-archetype accessor singleton pooling; zero per-iteration allocation (§2.3 "Shared-per-type accessor singleton") | §5 (one instance per pair, `__idx` poke), §9 (cursor reuses a single pooled element; 0 alloc/row). |
| Hook into buffer view-invalidation on growth (Must-Fix #5, §6.2) | §7: primary path — captured length-tracking views auto-widen, `__rebind` never called (V-1, R-1); fallback path — `__rebind(newBacking)` rebuilds views from captured `byteOffset`/`element`. |
| Setter side effect for `.changed` is the write log, NOT scheduler write-intent (Must-Fix #2, §2.7/§2.8) | §6.4: I-ACC-4 — a `write()` setter's only side effect beyond the slot store is `world.trackWrite(handleIndex(eid), componentId)`. Scheduler write-intent stays declared (§7.4 type-system.md). |
| eid stored as full u32 handle in `Int32Array`, `-1` null sentinel, staleness via `isAlive` (memory-buffers §3.4) | §4.4: eid getter/setter use `decodeEid`/`encodeEid`; reads return a validated `EntityHandle`/`NO_ENTITY`; no bit-31 flag. |
| staticString stored as smallest-uint index into a `choices` table (memory-buffers §3.5) | §4.5: index encode/decode through the `ComponentDef`'s `choices`; unknown value = dev throw / prod no-op write of 0. |
| vecN one contiguous column, accessor exposes `.x/.y/.z/[i]` (memory-buffers §3.6, type-system §1.3) | §4.6 + §8 (the `VecView` class over `view[__idx*stride + axis]`). |
| object<T> not column-backed; component `restrictedToMainThread` | §4.7: plain-array slot accessor; main-thread-only; not a `ViewHolder`. |
| ESM-only, strict TS, SAB + postMessage fallback | All allocation deferred to `Buffers`; no SAB/AB branch here. Worker-side accessors re-wrap from the broadcast/manifest (§7.5, §10). |

---

## 2. Terminology & Units

- **Accessor (instance)** = the per-`(archetype, component)` object whose getters/setters read/write
  one row's fields. Exactly one per pair (§5). Carries a mutable `__idx` (the current row).
- **Accessor class** = the JS class the factory returns (one *hidden class* per pair). Constructed
  once; instantiated once; reused for every row.
- **Binding** (`ColumnBinding`, type-system §9) = `{ view, byteOffset, element }` for ONE field —
  the live length-tracking view plus the two numbers `__rebind` needs to rebuild it.
- **Cursor** = the iteration driver that walks an archetype's live rows, pokes `__idx`, and yields a
  pooled element (§9).
- **Element** = the object a query yields per row: a small façade keyed by component name onto the
  relevant accessor singletons (§9.3). Pooled, not per-row allocated.
- **Phase** = `world.phase`: `'serial'` (main thread, between waves; structural mutation legal) or
  `'wave'` (workers executing; column *value* reads/writes only). Accessor construction and
  `__rebind` are serial-only; accessor *value* read/write happens in either phase.

---

## 3. The accessor factory (`makeAccessorFactory`)

### 3.1 Contract

`type-system.md §9` fixes the *type* the factory output must satisfy:

```ts
// (reproduced from type-system.md §9 — NORMATIVE; this module supplies the value)
export interface ColumnBinding {
  view: TypedArrayLike;          // current length-tracking view (widens on primary .grow())
  readonly byteOffset: number;   // this field's offset within its backing (for fallback rebuild)
  readonly element: string;      // ElementKind, to pick the TypedArray ctor on rebuild
}

export type AccessorFactory<S extends Schema> = (
  columns: ReadonlyArray<ColumnBinding>,    // one binding per field/axis, in fields[] order
) => new () => WriteView<S> & AccessorInstance & {
  __rebind(newBacking: SharedArrayBuffer | ArrayBuffer): void;
};

export interface AccessorInstance { __idx: number; }
```

This module exports `makeAccessorFactory(def)` returning exactly that `AccessorFactory<S>`. It is
called **once** at `defineComponent` time and stored on the `ComponentDef` as `def.accessorFactory`
(the field `buildColumnSet` reads — archetype-storage §3.7). `defineComponent` itself does no buffer
work (type-system §2.4 step 4); the factory closes over nothing until `buildColumnSet` invokes it
with an archetype's bindings.

> **Two-stage closure (load-bearing).** Stage 1, `makeAccessorFactory(def)`, captures only the
> **schema shape** (the per-field plan: name, ElementKind, stride, encode/decode rule). Stage 2, the
> returned factory invoked by `buildColumnSet`, captures the **concrete bindings** (live views +
> byteOffsets) for ONE archetype and returns the class. Stage 1 runs once per component; stage 2
> runs once per `(archetype, component)`. This keeps the per-pair work to one class mint + one
> instantiation (§5), and is what "factory function returning a closure-bound accessor class"
> (report §2.2) means concretely.

### 3.2 The field plan (stage-1 capture)

```ts
interface FieldPlan {
  readonly name: string;            // schema key (also the accessor property name for scalars)
  readonly fieldIndex: number;      // position in def.fields[]; maps to a binding slot
  readonly kind: FieldPlanKind;     // 'scalar' | 'bool' | 'eid' | 'staticString' | 'vec' | 'object'
  readonly stride: number;          // 1 for scalar/bool/eid/staticString; N for vec; 0 for object
  readonly element: ElementKind;    // physical TypedArray element (memory-buffers §3.2 table)
  readonly choices?: readonly string[];   // staticString only (def-level table)
  readonly vecLen?: number;         // vec only
  readonly bindingBase: number;     // index into the bindings[] array of this field's FIRST view
                                    //   scalar/eid/etc → 1 binding; vec(N) → N consecutive bindings
}
```

`bindingBase` resolves the report's "one binding per field/axis" mapping (type-system §9 comment).
**vecN occupies one contiguous column** (memory-buffers §3.6) — so a vec field consumes **one**
binding (its single contiguous view), not N. The per-axis subarrays are derived from
`view[__idx*stride + axis]` inside the `VecView` (§8), not separate bindings.

> **Binding count = `def.fields.length`** (one binding per `FieldDescriptor`), matching
> `buildColumnSet`'s `columns.map(...)` which produces one `Column` per field
> (archetype-storage §3.7). `bindingBase[i] === i`. The "per field/axis" phrasing in type-system §9
> reduces to per-field here because vec is a single contiguous column (the rejected per-axis layout,
> memory-buffers §3.6, would have made it per-axis).

### 3.3 Factory algorithm

```
makeAccessorFactory(def):                         // stage 1, once per component, serial
  plans := def.fields.map((fd, i) => buildFieldPlan(fd, i))     // §3.2 from FieldDescriptor (type-system §1.4)
  return (bindings) => {                           // stage 2, once per (archetype, component)
    assert(bindings.length === def.fields.length)  // dev guard
    return makeAccessorClass(def, plans, bindings) // §4 — returns `new () => Accessor`
  }
```

- Complexity: stage 1 O(fields); stage 2 O(fields) to build the class (one closure per field). No
  allocation per row, ever.
- `makeAccessorClass` is the only place a class is minted; it is minted **once per pair**
  (I-ACC-1). The class is then instantiated exactly once by `buildColumnSet` (it stores
  `accessor` on the `ColumnSet`).

---

## 4. The accessor class shape

The class is a plain JS class (NOT a Proxy, NOT `new Function()`). One **hidden class per
`(archetype, component)`** because each pair's getters/setters close over *that archetype's* views;
V8 keeps the shape monomorphic because every instance of one minted class has the identical hidden
class and the views are captured in the closure scope, not stored as polymorphic instance fields
(report §2.2/§2.3, decision #4; rejecting becsy's `binding.writableIndex` indirection,
`becsy/src/type.ts:72-93`, in favor of direct closure capture).

### 4.1 Canonical scalar shape (the `Position { x:f32, y:f32 }` worked example)

```ts
// Produced by makeAccessorClass for (archetype A, Position). NOT emitted as source — this is the
// in-memory class the closure builds. xView/yView are LENGTH-TRACKING Float32Array views (V-1)
// captured from bindings[0].view / bindings[1].view.
function makeAccessorClass(def, plans, bindings) {
  // capture per-field state arrays (closure scope, not instance fields):
  const views: TypedArrayLike[]   = bindings.map(b => b.view);          // mutable cells (rebind swaps them)
  const byteOffsets: number[]     = bindings.map(b => b.byteOffset);
  const elements: string[]        = bindings.map(b => b.element);
  const world = def.__world;        // for trackWrite (set at registration); see §6.4

  // For the canonical scalar case the class is, conceptually:
  return class Accessor /* implements WriteView<S> & AccessorInstance & ViewHolder */ {
    __idx = 0;
    // one getter/setter pair per scalar field, closing over views[fieldIndex]:
    get x() { return views[0][this.__idx]; }
    set x(v) { views[0][this.__idx] = v; world.trackWrite(handleIndex(this.__eid), def.id); }   // I-ACC-4
    get y() { return views[1][this.__idx]; }
    set y(v) { views[1][this.__idx] = v; world.trackWrite(handleIndex(this.__eid), def.id); }

    __eid: EntityHandle = NO_ENTITY;     // current row's owning handle, for trackWrite (§6.4)

    __rebind(newBacking: Backing): void {            // §7.5 — fallback grow only
      for (let i = 0; i < views.length; i++) {
        views[i] = makeView(elements[i], newBacking, byteOffsets[i]);   // memory-buffers makeView, no length arg
      }
    }
  };
}
```

- **No per-field branch in the hot getter/setter.** Each field gets its own getter/setter closing
  over a fixed `views[i]` cell — V8 inlines these to a single typed-array indexed load/store. The
  `views` cells are reassigned only by `__rebind` (fallback grow), so on the primary path the load
  is `views[i][__idx]` with a hoistable `views[i]`.
- **`__idx`** is the only mutated instance field on the hot path; the cursor (§9) and
  `EntityRef.__bind` (§6.2) poke it before access. Keeping it a declared field (initialized in the
  class body) preserves a single hidden class (the field exists from construction).
- **`__eid`** carries the current row's owning handle so a setter can call
  `world.trackWrite(handleIndex(__eid), componentId)` (I-ACC-4) without a `__idx → handle` lookup. The
  setter strips the generation via `handleIndex` (entity-model.md §3.2) because the write log is
  indexed by entity index, not full handle (reactivity.md §3.1). It is poked alongside `__idx` (§6.2,
  §9.2). On the read/shorthand path it is irrelevant (no setter fires).

> **Why getters/setters per named field, not a generic `get(i)`/`set(i,v)`.** The named-property
> shape is what makes `entity.write(Position).x = 5` ergonomic AND monomorphic: V8 builds an inline
> cache keyed on the (single) hidden class and the property name, inlining straight to the
> typed-array access. A generic indexed method would defeat the property-name IC and reintroduce a
> branch. This is the becsy ergonomics result (`type.ts:72-93`) achieved via closure capture rather
> than shared-prototype `defineProperty`.

### 4.2 Generated member set per token

For a component with schema `S`, `makeAccessorClass` installs, per field token (resolving the
`FieldPlan.kind`):

| token (FieldPlan.kind) | members installed | getter body | setter body (write surface only) |
|---|---|---|---|
| numeric scalar (`i8…f64`, `u8c`) | `get/set name` | `views[i][__idx]` | `views[i][__idx] = v; trackWrite` |
| `bool` | `get/set name` | `views[i][__idx] !== 0` | `views[i][__idx] = v ? 1 : 0; trackWrite` |
| `eid` | `get/set name` | `decodeEid(views[i][__idx])` → `EntityHandle | NO_ENTITY` | `views[i][__idx] = encodeEid(v); trackWrite` |
| `staticString` | `get/set name` | `choices[views[i][__idx]]` | `views[i][__idx] = indexOf(v); trackWrite` |
| `vec(E,N)` | `get name` (returns the per-pair `VecView`), no plain setter | returns the bound `VecView` instance (poked, §8) | (axis writes go through the `VecView` setter — §8) |
| `object<T>` | `get/set name` | `objArray[__idx]` | `objArray[__idx] = v; trackWrite` (main-thread only) |

`trackWrite` denotes `world.trackWrite(handleIndex(this.__eid), def.id)` (plus a forwarded
`fieldIndex` for field-granular setters, §6.4) and is present **only on the write-handle
surface** — see §6.4 for why the same instance's setters are reachable only through `write()`.

### 4.3 bool

`get => views[i][__idx] !== 0` (the column is `u8`, memory-buffers §3.3); `set => views[i][__idx] = v
? 1 : 0`. No packed-bit representation (memory-buffers §3.3 rejects it — a bitfield cannot give a
stable per-row word offset that grows cleanly under length-tracking).

### 4.4 eid

The column is `Int32Array` storing the **full u32 handle** with `-1` as the null sentinel
(memory-buffers §3.4, NORMATIVE). The accessor delegates to that module's codec — it does **not**
re-derive encoding:

```ts
get refField(): EntityHandle | typeof NO_ENTITY {
  const stored = views[i][this.__idx];           // Int32Array slot, may be -1
  const h = decodeEid(stored);                    // memory-buffers §3.4: -1 → null, else (stored>>>0)
  return h === null ? NO_ENTITY : h;              // surface NO_ENTITY (handle-space sentinel)
}
set refField(v: EntityHandle | typeof NO_ENTITY) {
  views[i][this.__idx] = encodeEid(v);            // NO_ENTITY (0xffffffff) | 0 === -1; else full handle | 0
  world.trackWrite(handleIndex(this.__eid), def.id);
}
```

- **Staleness is NOT checked here** (per memory-buffers §3.4: no bit-31 flag). A consumer that needs
  to know whether the referenced entity is still alive calls `world.isAlive(handleReturned)`
  (entity-model §3.3). The accessor returns the raw stored handle (or `NO_ENTITY`); liveness is a
  separate, explicit call. This keeps the eid read a single load + codec, no `isAlive` on the hot
  path.
- Writing `NO_ENTITY` (`0xffffffff`) yields `-1` in the `Int32Array` (`0xffffffff | 0 === -1`),
  exactly the null sentinel (the two spellings are the same value — type-system §8, entity-model
  §3.3 cross-reference). Reading it back via `decodeEid(-1)` → `null` → surfaced as `NO_ENTITY`.

### 4.5 staticString

```ts
const choices = plan.choices!;                    // def-level table (type-system §1.4)
get state(): string { return choices[views[i][this.__idx]]; }     // memory-buffers §3.5
set state(v: string) {
  const ix = choices.indexOf(v);
  if (ix < 0) {
    if (world.devMode) throw new RangeError(`'${v}' not in staticString choices`);
    views[i][this.__idx] = 0;                     // prod: no-op-ish write of index 0 (memory-buffers §3.5)
  } else {
    views[i][this.__idx] = ix;
  }
  world.trackWrite(handleIndex(this.__eid), def.id);
}
```

- The `choices` table lives once on the `ComponentDef`, never per archetype or per row
  (memory-buffers §3.5). The stored column width is the smallest uint covering `choices.length`
  (u8/u16/u32) — chosen by the field descriptor (type-system §1.4); the accessor reads it as a plain
  index regardless of width.
- `indexOf` is O(choices.length). For large enums a `Map<string,number>` cached on the `FieldPlan`
  reduces it to O(1); v1 uses `indexOf` (choices lists are small) and notes the Map as a trivial
  opt-in.

### 4.6 vec — the named getter returns the bound `VecView`

A vec field installs a **getter only** (no plain setter) returning the per-pair `VecView` instance
with its `__idx` synced. The full `VecView` class is §8.

```ts
const vecView = makeVecView(plan, views[i], world, def.id);   // §8, one per (archetype, vec field)
get position(): VecView<'f32', 3> { vecView.__idx = this.__idx; vecView.__eid = this.__eid; return vecView; }
```

- The `VecView` is itself a pooled singleton (one per `(archetype, vec field)`), so `e.position.x =
  1` allocates nothing. Syncing `__idx`/`__eid` on the getter keeps the returned view pointing at the
  current row.

### 4.7 object<T> (non-shareable)

`object<T>` has no column (memory-buffers §3.8); storage is a plain `Array<T | undefined>` per
`(archetype, component)`. The accessor closes over that array instead of a view, the component is
`restrictedToMainThread`, and `__rebind` is a **no-op** for object slots (no backing). The factory
receives the object array via a side-channel binding (`{ objArray }`) rather than a `ColumnBinding`;
a worker-side accessor never installs object members (the component is main-thread-only, enforced at
the type level — memory-buffers §3.8).

---

## 5. Per-archetype singleton pool

### 5.1 One instance per `(archetype, component)`

`buildColumnSet` (archetype-storage §3.7) calls `def.accessorFactory(bindings)` to get the class,
then `new` it **once**, storing the instance on the `ColumnSet.accessor`. There is exactly one
accessor instance per `(archetype, component)` for the world's lifetime (I-ACC-1, ACC-1). The
pool is therefore implicit: it is the set of `ColumnSet.accessor` values across all archetypes.

```ts
// (archetype-storage §3.7, reproduced for the contract this module satisfies)
const accessor = def.accessorFactory(bindings) as AccessorInstance;   // ONE instance
for (const c of columns) buffers.registerAccessor(c.key, accessorViewHolder(accessor, c));  // §7.5
return { columns, accessor, componentId: def.id };
```

- **Zero per-iteration allocation** (the locked decision and report §2.3): the singleton is reused
  for every row by poking `accessor.__idx = row`. Iteration (§9) and `EntityRef.write` (§6.2) reuse
  it. No `new` in any hot path.
- **Lifetime:** the instance is created at archetype creation (serial) and lives until the archetype
  is torn down; on teardown the module calls `buffers.unregisterAccessor(c.key, holder)` for each of
  its columns (memory-buffers §5.1). Worlds with `A` archetypes and `C` components hold ≤ `A×C`
  accessor instances — the bounded population the report quantifies (§2.3, §7.2). They are tiny
  (one `__idx` + one `__eid` + closure scope); the dominant memory is the columns, not the
  accessors.

### 5.2 Registration as a `ViewHolder` (the rebind wiring)

The single accessor instance implements `ViewHolder` (`__rebind`, memory-buffers §5.1). It is
registered against **each** of its columns' keys so that a fallback grow of *any* of those columns
re-binds the instance:

```ts
function accessorViewHolder(accessor: AccessorInstance & ViewHolder, col: Column): ViewHolder {
  // The accessor's __rebind rebuilds ALL its field views from the new backing; passing one column's
  // newBacking is sufficient ONLY when all fields of this component share that backing. Because
  // memory-buffers keys columns per (archetype, component, fieldIndex) with SEPARATE backings
  // (memory-buffers §3.2 "separate buffers per field"), __rebind must rebind only the field(s)
  // whose backing changed. See §7.5 for the per-field rebind.
  return { __rebind: (newBacking) => accessor.__rebind(newBacking) };
}
```

§7.5 makes `__rebind` precise about *which* field views rebind (per-field backings ⇒ the holder must
identify the changed column). The instance is **never** walked on the primary path (memory-buffers
R-1).

---

## 6. Read-only shorthand vs tracked write handle (Must-Fix #2)

This is the load-bearing public-API decision. **Both surfaces resolve to the SAME runtime accessor
singleton** (one hidden class per pair, §5); the difference is purely a **type-level** read-only cast
and **whether the setter path is reachable** (report §2.8, type-system §4.2; "the read-only-ness is
purely a type-level cast … the runtime object is the same monomorphic instance").

### 6.1 The three surfaces on `EntityRef`

`EntityRef` (entity-model §6.4) carries identity (`__handle`, `__archetypeId`, `__row`, `__bind`).
This module installs `read`, `write`, the `entity.<comp>` shorthand getters, and `has` on
`EntityRef.prototype` at world build:

```ts
interface EntityRefAccessorSurface {
  // (b) explicit read — Readonly view over the (archetype, component) singleton, __idx poked.
  read<C extends ComponentDef<Schema>>(def: C): ReadOf<C>;          // type-system ReadOf
  // (c) tracked WRITE — the SAME singleton, typed mutable; setters call world.trackWrite.
  write<C extends ComponentDef<Schema>>(def: C): WriteOf<C>;        // type-system WriteOf
  // (a) shorthand props (entity.position) are lifted by Has<...> (type-system §5.4) → Readonly,
  //     and resolve through read() at runtime (§6.3).
  has<C extends ComponentDef<Schema>>(def: C): boolean;             // main-thread only (Must-Fix #1)
}
```

### 6.2 `read` / `write` resolution algorithm

```
resolveAccessor(entityRef, def) -> AccessorInstance:
  arch := store.byId[entityRef.__archetypeId]          // location resolved by __bind (entity-model §6.4)
  cs   := arch.columnSets.get(def.id)
  if cs === undefined: throw MissingComponent(def, entityRef.__handle)   // entity lacks the component
  acc := cs.accessor
  acc.__idx := entityRef.__row                          // poke row
  acc.__eid := entityRef.__handle                       // poke owning handle (for trackWrite on write())
  return acc

read(def):  return resolveAccessor(this, def)  as ReadOf<def>     // typed Readonly (type-only cast)
write(def): return resolveAccessor(this, def)  as WriteOf<def>    // typed mutable (same instance)
```

- **Same instance for read and write** (I-ACC-3): `read(def)` and `write(def)` return the *identical*
  object; only the static type differs (`ReadOf` deeply readonly vs `WriteOf` mutable). No second
  hidden class, no second instance (decision #4 intact).
- **Why read-only is safe at runtime even though the instance has setters.** The setters physically
  exist on the instance, but the `ReadOf<C>` type makes every property `readonly`, so
  `entity.position.x = 5` is `error TS2540` (type-system §4.2). There is no runtime guard — the
  compile-time `Readonly` is the entire enforcement (the locked Must-Fix #2 mechanism). A caller who
  defeats the type (e.g. `as any`) *can* write through a read view; that is an explicit type-safety
  escape, identical in spirit to becsy's discipline, and is documented, not defended at runtime
  (avoids a per-access branch on the hot path).
- **`MissingComponent`** is thrown only when the entity's archetype lacks the component. Inside a
  query iteration the cursor never calls `read`/`write` for a component the matched archetype lacks
  (the element only exposes matched components — §9.3), so this throw is a misuse guard for the
  ad-hoc `world.entity(h).write(C)` path, not a hot-path cost.

### 6.3 Shorthand `entity.<comp>` resolution

The lifted shorthand props (`Has<C>`, type-system §5.4) are **accessor properties on
`EntityRef.prototype`**, one per registered component, each delegating to `read`:

```
// installed once at world build, per registered component def:
Object.defineProperty(EntityRef.prototype, def.name, {
  get() { return this.read(def); },     // Readonly view; same singleton, __idx/__eid poked
  enumerable: false, configurable: false,
});
```

- `entity.position` → `read(Position)` → the `Readonly`-typed singleton. `entity.position.x` is one
  `__idx` poke + one typed-array load. `entity.position.x = 5` is a compile error (Readonly).
- This is a `defineProperty` on the **`EntityRef` prototype** (a fixed, world-lifetime shape) — NOT
  a Proxy and NOT a per-instance property; it does not perturb the accessor singleton's hidden class.
  It is the only `defineProperty` this module uses, and it is on the carrier (`EntityRef`), not on
  the hot accessor.

### 6.4 The write-setter side effect (I-ACC-4) and its independence from the scheduler

Every setter on the accessor instance (reachable through `write()` or through the cursor's writable
element — §9.3) performs **exactly two** operations:

1. `views[i][this.__idx] = encoded(v)` — the slot store.
2. `world.trackWrite(handleIndex(this.__eid), def.id, fieldIndex?)` — push `(index, componentId)` to
   the `writeLog` ring (reactivity, report §2.7), driving the `.changed` *reactivity* filter.

```ts
// world.trackWrite signature this module depends on (reactivity.md §3.3/§6.2 OWNS the body;
// world.md §9.1 is the canonical-constant home, which this signature matches verbatim):
trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void;   // appends to writeLog
```

> **First arg is the entity INDEX, not the full handle (resolved cross-spec contract).** The
> reactivity write-log packs `(entityIndex, componentId)` into one u32 (reactivity.md §3.1), so the
> canonical `trackWrite` takes the 22-bit **index**, not the generational handle. This module carries
> the owning handle in `__eid` (it is the right value for the eid surface and for `resolveLocation`),
> and the setter passes `handleIndex(this.__eid)` (entity-model.md §3.2 codec) so the generation is
> stripped at the call site rather than masked silently inside `packWrite`. `handleIndex` is imported
> from `entity-model.md`. The optional `fieldIndex` is forwarded **only** by field-granular setters
> (`changeTrackingDefault: 'field'`, reactivity.md §6.2) — it never enters the (component-granular)
> log entry, only the `changeVersion` stamp; default setters omit it, which is why the field-granular
> opt-in now has a live caller.

- **Independence from scheduler write-intent (Must-Fix #2, report §2.8).** `trackWrite` is the
  `.changed`-filter mechanism ONLY. It does **not** participate in the scheduler's conflict DAG —
  scheduler write-intent is *declared* in the system's `{ read, write }` sets (type-system §7.4),
  not inferred from setter calls. The two mechanisms are deliberately separate; this module
  implements only the reactivity half.
- **Read surface has no side effect.** Because `read()`/shorthand return the *same* instance typed
  `Readonly`, no setter can fire through them (assignment is a compile error), so a read never calls
  `trackWrite`. The side effect is thus reachable *only* via the write surface, exactly matching the
  locked semantics: reads are free, tracked writes go through `write()`.
- **`__eid` must be current.** `trackWrite` needs the owning index (`handleIndex(__eid)`).
  `resolveAccessor` (§6.2) pokes
  `__eid := entityRef.__handle`; the cursor pokes `__eid := arch.rows[row]` (§9.2). A setter firing
  with a stale `__eid` would mis-attribute the change; the poke-before-yield discipline (§9.2)
  guarantees `__eid`/`__idx` are paired.

### 6.5 Optional dev-mode write guard on read views (defense in depth, opt-in)

In `world.devMode`, the module MAY hand `read()`/shorthand a **frozen façade** that throws on write
instead of relying solely on the `Readonly` type, to catch `as any` escapes during development. This
is OFF by default (it costs a façade allocation, defeating the zero-alloc goal) and is a debugging
aid only; production always returns the bare singleton typed `Readonly`. Documented as Q-ACC-1.

---

## 7. View invalidation on growth (Must-Fix #5) — the `__rebind` hook

The accessor closes over `views[i]` cells. Buffer growth is owned by `memory-buffers.md §7`; this
module's obligation is the **I-ACC-2 / I-ACC-2b** contract (type-system §9): be transparent on the
primary path, and rebuild on the fallback path.

### 7.1 Primary path — length-tracking views auto-widen (no call)

On a resizable backing, `Column.view` is length-tracking (constructed with NO length argument, V-1).
`grow()` calls `backing.grow()` in place; the **same view object** widens automatically
(memory-buffers §7.2). The accessor captured `bindings[i].view`, which **is** that same object, so:

- The captured `views[i]` cell still points at the now-wider view. No reassignment, no `__rebind`
  call, no regeneration of the class. This is I-ACC-2 and memory-buffers R-1 ("registry never walked
  on the primary path").
- The accessor created before the grow reads/writes a row beyond the old capacity correctly after
  the grow — the M2 exit test (memory-buffers §7.8 step 6, ACC-1).

> **The capture must be the view object, not a snapshot of it.** The factory captures
> `bindings[i].view` by reference into the `views` array. Because memory-buffers' length-tracking
> view *is the same object* before and after `.grow()`, referencing it is sufficient. The accessor
> MUST NOT cache `view.length` or a `subarray` across accesses (a `subarray` is a fixed-length view —
> V-1 violation); §8's `VecView` recomputes its window from `__idx*stride` on every access for the
> same reason.

### 7.2 Fallback path — `__rebind` reconstructs the captured views

On a non-resizable backing (or when primary `.grow()` threw), `growFallback` (memory-buffers §7.5)
allocates a **new** backing, copies, re-points `Column.view`/`Column.backing`, then walks the
registry calling `holder.__rebind(newBacking)`. The accessor's `__rebind` reconstructs each affected
field view from the captured `byteOffset`/`element`:

```ts
__rebind(newBacking: Backing, changedColumnKey?: ColumnKey): void {
  // Per-field backings (memory-buffers §3.2): rebuild ONLY the field view(s) whose column grew.
  // The holder (§5.2) knows which column key it was registered under; rebuild that field.
  for (let i = 0; i < views.length; i++) {
    if (changedColumnKey === undefined || fieldColumnKey[i] === changedColumnKey) {
      views[i] = makeView(elements[i], newBacking, byteOffsets[i]);   // NO length arg (V-1 preserved)
    }
  }
}
```

- **Per-field precision.** Because each `(archetype, component, fieldIndex)` has its own backing
  (memory-buffers §3.2 "separate buffers per field … avoids alignment bugs"), a fallback grow of one
  field's column must rebind only *that* field's view. The `ViewHolder` registered per column key
  (§5.2) carries the key, so `__rebind` rebuilds only the matching `views[i]`. (If §5.2 passes only
  `newBacking`, the holder closure also captures the column's `fieldIndex`, reducing this to
  reassigning `views[fieldIndex]`.)
- **Serial-only (V-2).** `__rebind` runs only at a serial flush point (memory-buffers §7.4/§7.5
  precondition: no worker executing). The reassignment of `views[i]` is therefore not racing any
  reader. The accessor's `__idx` is irrelevant during rebind (no read/write in flight).
- **Worker accessors re-wrap from the broadcast, not the registry** (memory-buffers §7.5): after a
  fallback grow, the main thread posts the new backing; each worker re-wraps its mirror column and
  re-invokes its *own* accessor's `__rebind` before the next wave (§10). The registry walk re-binds
  only main-thread accessors.
- **No-op on object fields** (§4.7): object slots have no backing; `__rebind` skips them.

### 7.3 The V-1 → I-ACC-2 → `__rebind` chain (consolidated)

| Backing | `.grow()` effect on captured view | Accessor action | Citation |
|---|---|---|---|
| resizable-sab / resizable-ab | same view object widens automatically | none (I-ACC-2; never called) | memory-buffers §7.2, R-1 |
| grow-patch-sab / grow-patch-ab | new backing; `Column.view` re-pointed | `__rebind` rebuilds `views[i]` from `(newBacking, byteOffset, element)` (I-ACC-2b) | memory-buffers §7.5; type-system §9 |
| primary `.grow()` throws | escalates to fallback for that grow | `__rebind` (as fallback row) | memory-buffers §7.2 edge case |

This is the exact "missing link V-1 → I-ACC-2 → `__rebind`" type-system §9 (I-ACC-2b) requires; this
module supplies the `__rebind` body that closes it.

---

## 8. The `VecView` monomorphic view class

`vec(E,N)` is one contiguous column, `stride = N` (memory-buffers §3.6). The named getter (§4.6)
returns a pooled `VecView` whose `__idx` is synced to the row. The view computes its window from
`__idx*stride` on every access (never caches a `subarray` — V-1).

```ts
function makeVecView(plan: FieldPlan, view: TypedArrayLike, world, componentId): VecView<E,N> {
  const N = plan.vecLen!;                      // axis count
  const axisName = ['x','y','z','w'];          // named axes iff N<=4 (type-system §1.3)
  return new class implements VecView<E,N> {
    __idx = 0;
    __eid: EntityHandle = NO_ENTITY;
    readonly length = N as N;
    // indexer:
    get(i: number) { return view[this.__idx * N + i]; }              // []-read; bounds checked in dev only
    set(i: number, v: number) { view[this.__idx * N + i] = v; world.trackWrite(handleIndex(this.__eid), componentId); }
    // named axes (installed for i < N, i <= 3):
    get x() { return view[this.__idx * N + 0]; }
    set x(v) { view[this.__idx * N + 0] = v; world.trackWrite(handleIndex(this.__eid), componentId); }
    // ...y (i=1), z (i=2), w (i=3) installed iff N permits...
    __rebind?(newBacking: Backing): void { /* parent accessor's __rebind already rebuilt `view` */ }
  };
}
```

- **TS indexer (`[i]`) vs `get/set` methods.** The static `VecView` type (type-system §1.3) declares
  a numeric index signature `[index: number]: ScalarValue<E>`. A JS class cannot expose a true
  numeric index signature with custom get/set without a Proxy (forbidden). v1 therefore exposes the
  named axes (`x/y/z/w`, the common ≤4 case) as real getters/setters AND, for `N>4` or generic code,
  the explicit `get(i)`/`set(i,v)` methods; the *type* presents the indexer for ergonomics while the
  runtime uses named axes / `get`/`set`. Element bracket access `vv[i]` in user code routes to the
  named axis at the type level for `i` literal ≤3; for dynamic `i` the user calls `vv.get(i)`. This
  is the documented, Proxy-free realization of `VecView`. (Q-ACC-2.)
- **Read-only variant.** The read/shorthand surface types the vec as `ReadonlyVecView` (axes and
  indexer `readonly`); same instance, setters unreachable through the type. No separate class.
- **Pooled.** One `VecView` per `(archetype, vec field)`, returned by the parent accessor's named
  getter with `__idx`/`__eid` synced — zero allocation per access (consistent with §5).
- **`view` is the parent's captured length-tracking cell.** The `VecView` closes over the same
  `view` reference; on a fallback grow the parent accessor's `__rebind` reassigns that field's
  `views[i]`, so the `VecView` must read its `view` from the parent's `views[i]` cell (not a private
  copy) — implemented by having `makeVecView` close over `() => parentViews[i]` or by the parent
  re-poking the `VecView`'s view on `__rebind`. v1 has the parent's `__rebind` also update the
  `VecView`'s captured cell (one extra assignment, fallback-only).

---

## 9. The iteration cursor (systems iterate rows through this)

Systems iterate a query's matching archetypes; within each archetype they walk `rows[0..count)`,
poke the per-component accessors' `__idx`, and process a pooled element. This module owns the
**cursor** and the **pooled element**; the query module owns `matchingArchetypes` and which
components are read/written.

### 9.1 `ArchetypeCursor`

```ts
interface ArchetypeCursor {
  readonly arch: Archetype;
  row: number;                          // current row, 0..arch.count-1
  /** Advance to the next live row; pokes every bound accessor's __idx/__eid; returns false at end. */
  next(): boolean;
  /** Reset to row 0 (re-usable across queries that share the archetype). */
  reset(): void;
}
```

The cursor holds references to the accessor singletons for the components the query touches (a small
fixed array, resolved once when the query first matches the archetype). `next()` is the hot loop:

```
next():
  row := row + 1
  if row >= arch.count: return false
  h := arch.rows[row]                   // full handle (archetype-storage §3.5)
  for acc in boundAccessors:            // the query's read/write component singletons for this arch
    acc.__idx := row
    acc.__eid := h                       // for trackWrite on the write surface (§6.4)
  return true
```

- **Zero allocation per row.** The cursor mutates `row`/`__idx`/`__eid` in place; the element (§9.3)
  is a single pooled object. The loop over `boundAccessors` is `O(touched components)` per row — tiny
  and fixed, not `O(all components)`.
- **`__eid` poke is conditional.** For a read-only query (no `write` term) the `__eid` poke can be
  skipped (no setter fires) to shave one store per accessor per row; v1 pokes it unconditionally for
  simplicity and notes the read-only skip as a micro-opt (Q-ACC-3). The cursor knows the query's
  read/write split (the query module supplies it) so the skip is decidable at bind time.

### 9.2 Cursor binding (resolve singletons once per `(query, archetype)`)

When a query first matches an archetype (archetype-storage §8, on `archetypeCreated` or first run),
the cursor for that `(query, archetype)` resolves and caches the accessor singletons:

```
bindCursor(query, arch) -> ArchetypeCursor:
  boundAccessors := []
  for term in query.valueTerms:          // read/write/optional terms that yield a value (type-system §5.2)
    cs := arch.columnSets.get(term.componentId)
    if cs: boundAccessors.push(cs.accessor)        // present component → its singleton
    else if term.optional: boundAccessors.push(MISSING_SENTINEL)   // optional absent → element yields undefined
    // With/Without terms contribute no accessor (membership only)
  return { arch, row: -1, boundAccessors, next, reset }
```

- Resolution is once per `(query, archetype)` pair, amortized at match time — **not** per row, not
  per frame. The bound singletons are stable for the archetype's lifetime (one instance per pair,
  §5), so the cache never invalidates except on archetype teardown.
- Cold archetypes bind to the **cold accessor variant** (§10) instead of `cs.accessor`; the cursor
  is otherwise identical.

### 9.3 The pooled element (`each` / iterator)

The element the system's callback receives is a small pooled façade exposing the query's components
by name onto the bound accessor singletons:

```ts
// QueryElement<Terms> (type-system §5.3) realized as a pooled object with name → accessor props.
interface PooledElement {
  handle: EntityHandle;                  // arch.rows[cursor.row]
  // one property per value term, e.g. `position` (Readonly via read terms) / `velocity` (mutable via write terms)
}
```

```
each(query, fn):                          // the system-facing iteration entry point
  for arch in query.matchingArchetypes:
    cur := query.cursorFor(arch)          // §9.2, cached
    cur.reset()
    el  := query.pooledElementFor(arch)   // one per (query, archetype); props bound to cur's accessors
    while cur.next():
      el.handle := arch.rows[cur.row]
      fn(el)                              // el.position.x (read), el.velocity.x = 1 (tracked write)
```

- **The element's component props ARE the bound accessor singletons** (read terms typed `ReadOf`,
  write terms typed `WriteOf`). `el.position` returns the read accessor with `__idx` already poked by
  `next()`; `el.velocity.x = 1` fires the singleton's setter → slot store + `trackWrite` (§6.4).
  Optional-absent terms surface `undefined` (type-system §5.2 `OptionalTerm`).
- **One pooled element per `(query, archetype)`** (props bound to that archetype's singletons), reset
  by repointing `handle` per row. Zero allocation per row. The element MUST NOT be stored across
  iterations (it is reused) — same discipline as `EntityRef` (entity-model §6.4, report §2.3).
- **Read/write surface on the element matches the query terms** (the type-level Must-Fix #2): a
  component entered via `read(C)`/bare def → `Readonly` prop (assignment is a compile error); via
  `write(C)` → mutable prop (setter tracked). This is the per-term realization of §6's read-vs-write
  split inside iteration.

### 9.4 Worker iteration

A worker running a system over its assigned batch drives the **same** cursor over the same archetype
columns (SAB-shared on the primary path; transferred per wave in postMessage mode — §10). Crucially:

- The worker's accessors read/write **column values only** — plain typed-array access over the SAB
  (archetype-storage §9, memory-buffers §7.2 widening-safe). No bitmask read (Must-Fix #1): the
  cursor establishes membership purely from `arch.rows`/`arch.columnSets` (the archetype it iterates),
  never from the bitmask.
- The worker's `write` setters still call `world.trackWrite` — but in worker context `trackWrite`
  appends to the **per-worker corral / write staging** (reactivity, report §2.7 / §7.1), merged
  serially by the main thread between waves, not to a shared ring directly. This module calls
  `world.trackWrite`; the reactivity module routes it to the worker-local stage. No atomics on the
  accessor hot path.
- **Structural changes are NOT made through accessors.** An accessor only reads/writes existing
  column slots. `add`/`remove`/`spawn`/`despawn` are staged to command buffers (report §6.1), never
  expressed as accessor writes — so accessor mutation never grows a column or migrates a row (which
  is why growth is always serial, V-2).

---

## 10. Worker-side accessor mirrors

On the SAB primary path, workers receive the column SABs once at startup (memory-buffers §6.3,
`exportSharedHandles`). Each worker builds its **own** accessor singletons by re-invoking the same
`AccessorFactory` (the `ComponentDef` and its `accessorFactory` closure are replicated to workers as
part of world setup — the factory is a pure function of the schema; only the *bindings* differ per
worker because the views wrap the worker's own SAB mirror).

```
workerBuildColumnSet(arch, def, workerColumns):       // mirror of buildColumnSet on the worker
  bindings := workerColumns.map(c => ({ view: c.view, byteOffset: c.view.byteOffset, element: c.layout.element }))
  accessor := def.accessorFactory(bindings)            // SAME factory; worker-local instance
  // register against the worker-local Buffers mirror so a fallback re-broadcast re-binds it:
  for c in workerColumns: workerBuffers.registerAccessor(c.key, accessorViewHolder(accessor, c))
  return { columns: workerColumns, accessor, componentId: def.id }
```

- Worker accessors wrap the **same SAB** as the main thread's (primary path) — so a primary `.grow()`
  widens the worker's length-tracking view automatically too (no re-broadcast; memory-buffers §7.2).
- On a fallback grow, the main thread broadcasts the new backing; the worker re-wraps its mirror
  column and re-invokes its accessor's `__rebind(newBacking, key)` (§7.2) before the next wave —
  this is the worker half of the registry path (memory-buffers §7.5).
- **postMessage fallback** (no SAB, report §6.3): the worker receives transferred plain
  `ArrayBuffer`s per wave; it rebuilds bindings (and thus accessors) for the transferred columns at
  the start of each wave and transfers them back on completion. The accessor *class* is unchanged;
  only the backing/transfer differs. (The cursor and element are identical.)
- **The `AccessorFactory` is worker-transferable because it is closure-only** — no Proxy, no
  `new Function`, no per-instance DOM/host references. This is precisely why the factory-closure
  pattern was chosen over a Proxy (report §2.3 "Proxy … not transferable to workers"): the schema is
  structured-cloned, the factory re-derived from it, and each worker mints its own monomorphic class.

---

## 11. Cold-archetype accessor variant (archetype-storage §10.3)

A cold archetype has **no dedicated columns**; its entities live in the shared `ColdStore`
(archetype-storage §10.3), keyed `(entityIndex, componentId) → row` in per-component blocks. The
accessor for a `(coldArchetype, component)` resolves through `ColdStore.rowOf` instead of a direct
`__idx`:

```ts
// Cold accessor: __idx is NOT a contiguous archetype row; it is resolved via the cold store.
function makeColdAccessorClass(def, plans, coldBlocks /* ColumnSet per component */, world) {
  // closes over the cold block's column views for `def`, plus the rowOf map.
  return class ColdAccessor {
    __idx = 0;                 // the COLD ROW (already resolved by the cursor, §11.1), not the archetype row
    __eid: EntityHandle = NO_ENTITY;
    get x() { return coldViews[0][this.__idx]; }   // identical body — __idx is the cold-block row
    set x(v) { coldViews[0][this.__idx] = v; world.trackWrite(handleIndex(this.__eid), def.id); }
    __rebind(b) { /* rebind cold-block views, same as §7.5 */ }
  };
}
```

- **Key insight:** by making `__idx` the *cold-block row* (resolved up front), the cold accessor's
  getter/setter bodies are **identical** to the hot accessor's — the cold-ness is entirely in *how
  `__idx` is computed*, not in the accessor body. This keeps one code path and preserves
  monomorphism.
- **Cold cursor (§11.1)** resolves `__idx` via `cold.rowOf.get(entityIndex * N + componentId)` per
  row instead of using the contiguous archetype row directly. This is the one extra map lookup the
  report names as cold's throughput cost (archetype-storage §10.3, report §6.4); the query API is
  unchanged.

### 11.1 Cold cursor

```
coldNext():                               // cursor over a cold archetype
  advance to next entity index in this cold archetype's membership (cold.archOf inverse / iteration set)
  if exhausted: return false
  entityIndex := currentColdEntityIndex
  h := makeHandleFromIndex(entityIndex)   // or read full handle from cold membership
  for (acc, componentId) in boundColdAccessors:
    acc.__idx := cold.rowOf.get(entityIndex * N + componentId)   // resolve cold-block row
    acc.__eid := h
  return true
```

- Cold iteration is `O(cold entities × touched components × map-lookup)`; the per-row map lookup is
  the documented cold penalty. `world.warm(sig)` (archetype-storage §10.4) promotes the archetype to
  hot, after which the ordinary contiguous cursor (§9) applies — same accessor *bodies*, no cold
  lookup.
- v1 ships cold read/write through this path; promotion is explicit (`world.warm`), so the cold
  path is exercised only under genuine fragmentation (archetype-storage §10).

---

## 12. `PairAccessor` (relation payload)

A relation pair's payload is accessed through the **same monomorphic accessor machinery** (report
§2.6 "Payload access via the same monomorphic accessor path"). The storage location depends on
exclusivity (Must-Fix #4) but the accessor *type* (`PairAccessor`, type-system §7.3) is identical
for both; only the column source differs.

### 12.1 Exclusive relation payload → ordinary subject column

For an exclusive relation (e.g. `ChildOf`), the presence component `presenceId(R)` is
**column-bearing** on the subject archetype (its fields = the `eid` target + payload schema —
archetype-storage §3.6, relations.md §4.2). The pair accessor is therefore just the ordinary
`(subjectArchetype, presenceId(R))` accessor singleton (§5) — **no new machinery**:

```ts
// getPairData(subjectRef, ChildOf) → the (subjectArchetype, presenceId(ChildOf)) accessor, __idx poked.
function getPairData(subjectRef, relationDef): PairAccessor<typeof relationDef> {
  const def = relationDef.presenceDef;          // the synthetic column-bearing ComponentDef (relations.md)
  const acc = resolveAccessor(subjectRef, def); // §6.2 — same poke logic
  return acc as unknown as PairAccessor<...>;    // typed via type-system §7.3 PairAccessor
}
```

Re-targeting writes the `eid` target field in place (`acc.target = newParent`) — a field write, **no
migration** (archetype-storage §3.6, the T1 pressure-release valve).

### 12.2 Non-exclusive relation payload → overflow-row accessor

For a non-exclusive payload relation, the payload rows live in a pair-keyed overflow `ColumnSet`
(memory-buffers §3.7, owned by relations.md). The accessor is again the ordinary closure class over
the overflow `ColumnSet`'s views, but `__idx` is the **overflow row** resolved by the relations
module's `Map<(relationId, subjectEid, targetEid) → overflowRow>`:

```ts
// getPairData(subjectRef, Damage, targetEid) → overflow ColumnSet accessor, __idx = overflowRow.
function getPairData(subjectRef, relationDef, targetEid): PairAccessor<typeof relationDef> {
  const overflowRow = relations.overflowRowOf(relationDef.id, subjectRef.__handle, targetEid);
  const acc = relations.overflowAccessor(relationDef.id);   // singleton over the overflow ColumnSet
  acc.__idx = overflowRow;                                   // overflow row, not an entity row
  acc.__eid = subjectRef.__handle;                          // trackWrite attributes to the subject
  return acc as unknown as PairAccessor<...>;
}
```

- The overflow accessor is built by the **identical** `makeAccessorFactory` path (§3) over the
  overflow `ColumnSet`'s columns — one singleton per `(relation, overflow block)`. The only
  difference from a component accessor is that `__idx` indexes overflow rows (which are NOT entity
  rows — memory-buffers §3.7) and the relations module supplies the row. Same getter/setter bodies,
  same `__rebind`, same zero-alloc poke.
- This satisfies type-system §7.3: both exclusive and non-exclusive payloads resolve to the same
  `ReadView`/`WriteView` payload type; the storage split is invisible to the accessor *type*, visible
  only in how `__idx` is sourced.

---

## 13. Concurrency, memory ordering & worker policy

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `makeAccessorFactory` (stage 1) | Main | Serial (defineComponent) | None; pure. |
| factory invocation / class mint / `new` (stage 2) | Main (and each worker at startup, §10) | Serial / worker-startup | None; per-pair once. |
| accessor read (`get`) of a column slot | Main or worker | Any (incl. wave) | Plain typed-array load over SAB; widening-safe (memory-buffers §7.2). |
| accessor write (`set`) of a column slot + `trackWrite` | Main, or worker (disjoint per scheduler) | Serial / wave (disjoint columns) | Plain store; `trackWrite` routes to per-worker corral in wave (reactivity §7.1). No atomics. |
| `__idx` / `__eid` poke (cursor / `resolveAccessor`) | Main or worker | Any | Plain stores to the worker-local / main singleton (each thread has its OWN accessor instances, §10). |
| `__rebind` (fallback grow) | Main (registry) + each worker (broadcast) | Serial flush (V-2) | None; no reader in flight (quiescence, memory-buffers §7.4). |
| `has` (point membership) | Main only | Serial | Via archetype-storage `bitmaskHas`; **not** in accessors (Must-Fix #1). |

- **Each thread owns its own accessor instances** (§10): a worker pokes *its* singleton's `__idx`,
  never the main thread's. So `__idx`/`__eid` poking is never cross-thread and needs no atomics. The
  shared state is only the column SAB content, governed by the scheduler's disjoint read/write
  declarations (report T5).
- **No atomics on the accessor hot path** — read is a plain load, write is a plain store +
  `trackWrite` (which the reactivity module makes wave-safe via per-worker staging). This is the
  load-bearing T2/T3 consequence: the scheduler's wave fence is the synchronization, not per-access
  atomics (report §4 T2/T3).

---

## 14. Invariants (testable)

- **ACC-A1 (one hidden class per pair).** For each `(archetype, component)`, exactly one accessor
  class is minted and exactly one instance is created, reused for all rows. Test: spy on
  `makeAccessorClass` and `new`; assert each runs once per pair; assert
  `%HaveSameMap`-style hidden-class stability across rows (or a monomorphic-IC bench, report M2). (=
  archetype-storage ACC-1, type-system I-ACC-1.)
- **ACC-A2 (zero per-iteration allocation).** Iterating `N` rows of an archetype performs **0**
  allocations after binding (cursor + element + accessors are all pooled). Test: allocation counter
  around `each` over a large archetype reads 0.
- **ACC-A3 (read shorthand is compile-error-on-write).** `entity.position.x = 5` and an iteration
  element's read-term prop assignment are `error TS2540`. Test: type-test fixture with
  `@ts-expect-error` (mirrors type-system §11). (Must-Fix #2.)
- **ACC-A4 (read and write are the same instance).** `entity.read(C)` and `entity.write(C)` return
  the identical object (`===`); only the static type differs. Test: identity assertion + a write
  through `write(C)` is visible through a subsequently-read `read(C)`. (I-ACC-3.)
- **ACC-A5 (write setter side effect = exactly trackWrite).** A `write(C)` setter (and a writable
  element setter) performs the slot store and one `world.trackWrite(handleIndex(eid), componentId)`
  and nothing else; a read never calls `trackWrite`. Test: stub `trackWrite`, assert called once per
  write with the current `(index, componentId)` (index = `handleIndex(handle)`), never on reads.
  (I-ACC-4, Must-Fix #2.)
- **ACC-A6 (primary-grow transparency).** An accessor created before a primary-path `.grow()`
  reads/writes a row beyond the old capacity correctly afterward, with **zero** `__rebind` calls.
  Test: write row 1500 through an accessor created when capacity was 1024, after `grow` to 2048; spy
  asserts `__rebind` not called. (memory-buffers §7.8 step 6, R-1; Must-Fix #5 primary.)
- **ACC-A7 (fallback-grow rebind).** On a `grow-patch-*` backing, a fallback grow calls the
  accessor's `__rebind`, which rebuilds the affected field view(s) from the new backing with NO
  length argument; subsequent reads/writes hit the new backing. Test: force `growFallback`; assert
  `__rebind` called, post-grow read returns the copied value, the rebuilt view is length-tracking.
  (I-ACC-2b; Must-Fix #5 fallback.)
- **ACC-A8 (eid codec round-trip + sentinel).** Writing `NO_ENTITY` through an eid setter stores `-1`
  and reads back `NO_ENTITY`; writing a live handle stores its full u32 and reads it back; the
  accessor performs no liveness check. Test against `encodeEid`/`decodeEid` (memory-buffers §3.4).
- **ACC-A9 (staticString index encode/decode).** Reads return `choices[slot]`; writing a known choice
  stores its index; an unknown choice throws in dev / writes 0 in prod. (memory-buffers §3.5.)
- **ACC-A10 (vec pooled, recomputed window).** `e.position.x` and `e.position.get(i)` read
  `view[__idx*N + i]`; the `VecView` is one pooled instance per `(archetype, vec field)`; no
  `subarray` is cached across accesses (survives a primary grow). (V-1, §8.)
- **ACC-A11 (worker accessor isolation).** A worker pokes only its own accessor instances; main and
  worker accessors over the same SAB both read/write the same slot; no cross-thread `__idx` write
  occurs. Test: a multi-worker harness asserts disjoint instance identity and consistent column
  reads. (§10, §13.)
- **ACC-A12 (no structural mutation via accessors).** No accessor get/set grows a column, migrates a
  row, or mutates an entity record/bitmask. Test: a stubbed `Buffers.grow`/`migrate` is never called
  during accessor read/write. (V-2 precondition; §9.4.)
- **ACC-A13 (cold accessor body identity).** The cold and hot accessor getter/setter bodies are the
  same code (cold-ness only changes `__idx` resolution); a cold-archetype query yields the same
  values as after `world.warm`. (archetype-storage §10.3, FRAG-1.)

---

## 15. Complexity summary

| Operation | Time | Space |
|---|---|---|
| `makeAccessorFactory` (stage 1) | O(fields) | O(fields) field plans, once/component |
| factory invocation + class mint + `new` (stage 2) | O(fields) | O(1) instance + O(fields) closure cells, once/pair |
| accessor scalar read | O(1), 1 typed-array load (+ codec for eid/staticString) | 0 alloc |
| accessor scalar write | O(1), 1 store + 1 `trackWrite` | 0 alloc |
| `resolveAccessor` (`read`/`write`/shorthand) | O(1): record resolve + Map.get + 2 pokes | 0 alloc |
| `__rebind` (fallback grow only) | O(fields rebuilt) = O(1) per field changed | 0 alloc (reassigns view cells) |
| cursor `next()` | O(touched components) pokes | 0 alloc |
| `each` over an archetype | O(rows × touched components) | 0 alloc/row (pooled element + accessors) |
| `VecView` axis read/write | O(1), 1 load/store from `__idx*N+axis` | 0 alloc |
| cold cursor `next()` | O(touched components × map-lookup) | 0 alloc |
| `getPairData` (exclusive) | O(1) (= `resolveAccessor`) | 0 alloc |
| `getPairData` (non-exclusive) | O(1) overflow-row map lookup + 2 pokes | 0 alloc |
| Accessor-instance population | — | ≤ `A×C` tiny instances (report §2.3/§7.2 bounded) |

---

## 16. Open questions deferred (non-blocking)

- **Q-ACC-1** (dev-mode write-guard façade on read views, §6.5): OFF by default; benchmarked opt-in
  in M2/M9. Production relies on the `Readonly` type (Must-Fix #2).
- **Q-ACC-2** (`VecView` true numeric indexer vs named-axis + `get`/`set`, §8): v1 uses named axes
  (≤4) + explicit `get`/`set`; a Proxy-based true indexer is rejected (decision #4). Revisit only if
  ergonomics demand it past v1.
- **Q-ACC-3** (skip `__eid` poke for read-only queries, §9.1): a micro-opt decidable from the
  query's read/write split; v1 pokes unconditionally. Benchmarked in M4.
- **Q-ACC-4** (staticString `indexOf` vs cached `Map`, §4.5): v1 `indexOf` (small choice lists);
  `Map` is a trivial drop-in if a wide enum profiles hot.
- **Q-ACC-5** (worker-side accessor re-mint cost in postMessage mode, §10): rebuilding bindings per
  wave; measured at M7. Primary SAB path has no per-wave re-mint (re-wrap once at startup).

---

## 17. Dependencies (summary for the orchestrator)

This module **depends on** (consumes contracts from): `type-system.md` (`AccessorFactory`,
`ColumnBinding`, `AccessorInstance`, `ReadOf`/`WriteOf`, `VecView`/`ReadonlyVecView`,
`PairAccessor`, invariants I-ACC-1..4); `memory-buffers.md` (`Column`/`ColumnLayout`/`ElementKind`,
`makeView`, `ViewHolder`/`registerAccessor`, length-tracking V-1, serial-growth V-2,
`growFallback`/broadcast, `encodeEid`/`decodeEid`, `Buffers.column`); `entity-model.md`
(`EntityHandle`, `handleIndex`, `EntityRef.__bind`/identity fields, `NO_ENTITY`, `world.trackWrite`,
`world.phase`, `world.tick`, `isAlive`); `archetype-storage.md` (`Archetype`/`ColumnSet`,
`buildColumnSet` invocation site §3.7, `matchingArchetypes` §8, `ColdStore` §10.3,
`EMPTY_ARCHETYPE_ID`).

This module is **depended on by**: the `query` module (drives the cursor §9 / pooled element),
the `reactivity` module (receives `trackWrite` setter pushes §6.4), the `scheduler`/`workers`
(worker-side accessor mirrors §10), the `relations` module (`getPairData`/`PairAccessor` §12), and
`world.ts` (installs `read`/`write`/shorthand/`has` on `EntityRef.prototype`).
