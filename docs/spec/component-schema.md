# ecsia Implementation Spec — Module: Component & Relation Schema API

> Module owner: `@ecsia/core` (`packages/core/src/component/`) — the `component/` directory in the
> monorepo layout (DESIGN-RESEARCH.md §5.1: "`component/` — `defineComponent`, schema → SoA,
> accessor factory (closure, NOT codegen)"). Status: implementable.
>
> This module owns the **runtime** of the public schema API: `defineComponent` / `defineTag` /
> `defineRelation` value-level construction, **field-token → `FieldDescriptor` resolution**,
> **default values**, **tag (zero-field) components**, **storage-strategy selection**
> (`sparse`/`packed`), **relation exclusivity → `storageKind` routing**, the **component/relation
> registry and dense type-id assignment** (`ComponentId`, `RelationId`, synthetic pair IDs), and
> the **schema → column** mapping handed to memory-buffers and the **schema → accessor-factory**
> mapping handed to the accessor module.
>
> It is the *value-level* sibling of `type-system.md`: that spec owns the **types** (`ComponentDef<S>`,
> `RelationDef<P>`, `FieldToken`, `FieldDescriptor`, `AccessorFactory<S>`, branded IDs); this spec
> gives those types **bodies** and a **registry** without changing a single signature. Every type
> name, token, descriptor field, sentinel, and ID layout below is consumed verbatim from the five
> already-written specs and is **not redefined**:
> - `type-system.md` — `FieldToken`, `ScalarToken`, `VecToken`, `StaticStringToken`, `ObjectToken`,
>   `FieldDescriptor`, `TypedArrayCtor`, `ComponentDef<S>`, `ComponentOptions`, `StorageStrategy`,
>   `RelationDef<P>`, `RelationOptions`, `PairDef`, `AccessorFactory<S>`, `ComponentId`, `RelationId`,
>   `ArchetypeId`, `EntityHandle`, `NO_ENTITY`, `MAX_QUERY_ARITY`.
> - `memory-buffers.md` — `ColumnLayout`, `ElementKind`, `Buffers.column`, `ColumnKey`, the `eid` C-2
>   sentinel (`-1`), `staticString` width selection, `object<T>` non-column path.
> - `archetype-storage.md` — `buildColumnSet`, `AccessorInstance`, `EMPTY_ARCHETYPE_ID`,
>   `allocSyntheticComponentId` (the storage-owned dense-id allocator this module calls).
> - `entity-model.md` — `handleIndex`, `isAlive`, lifecycle hooks, `NO_ENTITY`.
> - `relations.md` — `RelationRuntime`, `presenceId(R)`, `mintPair`, `storageKind`, the exclusive
>   column-bearing presence component, the overflow table. This module supplies the *constructors*
>   (`defineRelation` body, presence-component synthesis, descriptor resolution) the relations module
>   *drives*; relations.md owns the structural ops (`addPair`/`removePair`/cascade).
>
> Citations of the form `DESIGN-RESEARCH.md §x.y` reference the report; `lib/path:line` references the
> reference-library source the report read.

---

## 0. Scope & Non-Goals

**In scope (this module owns):**

1. `defineComponent(schema, options)` runtime: validation, field-descriptor resolution, options
   defaulting (incl. tag-vs-packed storage default), `ComponentDef<S>` value construction. (§2)
2. `defineTag(name?)` zero-field components. (§2.6)
3. **Field-token → `FieldDescriptor` resolution** (`resolveDescriptor`): the exhaustive token table
   from type-system.md §1.4 given a *runtime body* — `ctor`, `bytesPerElem`, `stride`, `shareable`,
   `encode`/`decode`, `choices`. (§3)
4. **Default values**: per-token defaults, the user-overridable `default` schema annotation, and the
   `eid → -1` / `staticString → 0` rules consumed by `archetype-storage.initColumnRow`. (§4)
5. **Storage-strategy selection** (`packed`/`sparse`): how the strategy is chosen, what it means to
   downstream storage, and why it is type-inert. (§5)
6. `defineRelation(...)` runtime: `RelationId` assignment, `storageKind` resolution, **synthesis of
   the per-relation presence `ComponentDef`** (the column-bearing one for `exclusive-column`, the
   zero-field tag for `tag`/`overflow-table`), and overflow `ComponentDef` synthesis. (§6)
7. The **component/relation registry** living on the world: dense `ComponentId`/`RelationId`
   assignment at `createWorld`, the synthetic-id allocator contract, the `id → def` reverse map, the
   bitmask-stride seed, and validation (duplicate registration, arity, u16 relation cap). (§7)
8. The **schema → ColumnLayout** projection (`fieldToColumnLayout`) and the **schema → AccessorFactory**
   wiring (`def.accessorFactory`) that storage's `buildColumnSet` invokes. (§8)

**Out of scope (consumed from / handed to other modules):**

- The **types** `ComponentDef<S>`, `RelationDef<P>`, `FieldToken`, `FieldDescriptor`,
  `AccessorFactory<S>`, branded IDs — `type-system.md`. This module *implements* them; it does not
  re-declare them. (Any TS block below that re-states a signature is a **restatement for locality**,
  not a redefinition; the normative source is type-system.md.)
- Column allocation, growth, length-tracking views, SAB/AB selection, the `Buffers` registry —
  `memory-buffers.md`. This module produces `ColumnLayout`s and calls `Buffers.column` only through
  `archetype-storage.buildColumnSet`; it never decides backing.
- Archetype tables, the edge graph, `buildColumnSet`, `migrate`, `initColumnRow`, `allocSyntheticComponentId`
  — `archetype-storage.md`. This module hands storage the resolved `ComponentDef.fields` and the
  `accessorFactory`; storage allocates columns and rows.
- The accessor closure **bodies**, `__idx` poking, `read`/`write` views, `__rebind` — `accessors`
  module. This module fixes the factory *input* (the resolved field descriptors) and constructs the
  factory closure shell that satisfies `AccessorFactory<S>` (type-system.md §9); the per-field getter/
  setter bodies are authored there.
- Relation **structural operations** (`addPair`/`removePair`/cascade/back-ref/overflow row alloc) —
  `relations.md`. This module only *constructs* the `RelationRuntime` skeleton and the presence/overflow
  `ComponentDef`s; relations.md fills in the behavior.
- Query DSL, scheduler access declarations — `query`/`scheduler` specs. This module exports nothing
  about queries beyond the `ComponentDef`/`RelationDef`/`PairDef` references they consume.

---

## 1. How this module satisfies the locked decisions

| Locked decision (report) | Where satisfied in this spec |
|---|---|
| Components: schema'd TypedArray-backed fields, numeric + non-numeric encodable (eid/bool/staticString) (decision #2, §2.2) | §3 `resolveDescriptor` resolves every token to a `(ctor, encode, decode)` triple; §3.3–3.7 give the non-numeric encoders. Honors type-system.md §1.4 table verbatim. |
| `defineComponent` full TS inference, no decorators/codegen/`new Function()` (decision #6, §2.8) | §2: pure value construction; `const S` capture is the type-system's job; this module emits a plain frozen object. No `new Function`, no decorators, no `eval`. §10 forbidden list. |
| Tag (zero-field) components — pure bitmask/archetype membership, no buffers (§2.2) | §2.6 `defineTag` → `fields: []`, storage default `'sparse'`; §8.1 emits **no** `ColumnLayout` for a tag (becsy `component.ts:387-389`). |
| sparse/packed storage strategies for rare/tag components (decision #2, §2.2) | §5 selection rule (`tags default 'sparse'`, others `'packed'`); type-inert per type-system.md §1.5. |
| Public write API LOCKED: `entity.<comp>.x` READ-ONLY; tracked mutation via `entity.write(C)` (Must-Fix #2) | §8.2: the factory this module wires produces a single monomorphic instance typed `Readonly` for read/shorthand and mutable for `write()` (type-system.md §4.2, I-ACC-3). This module never installs a setter on the shorthand. |
| Accessors: MONOMORPHIC factory-closure, one hidden class per (archetype,component); NOT Proxy/codegen (decision #4) | §8.2: `def.accessorFactory` is a closure factory satisfying `AccessorFactory<S>`; invoked once per `(archetype, component)` by storage `buildColumnSet`. No Proxy, no `new Function`. |
| Relations: integer-encoded `(relationId,targetId)` pairs; payload split by exclusivity (decision #7, Must-Fix #4) | §6: `RelationId` assignment, `storageKind` routing, presence-component synthesis (column-bearing for exclusive). The split-by-exclusivity decision is *made here* (`resolveStorageKind`) and consumed by relations.md §4. |
| Relation exclusivity declaration + per-relation presence bit (§2.6) | §6.3 mints exactly one `presenceId(R)` `ComponentDef` per relation *type* at `defineRelation`; column-bearing iff `exclusive-column`. |
| Component type-id assignment + registry (this module's explicit focus) | §7: deterministic dense `ComponentId` 0..N at `createWorld`; `RelationId` dense u16; synthetic pair/overflow IDs via `allocSyntheticComponentId`; reverse map; bitmask-stride seed. |
| Generational handle `eid` storage: full u32 bit-pattern in `Int32Array`, `-1` sentinel, NO bit-31 flag (Must-Fix, memory-buffers §3.4) | §3.4 `eid` descriptor `encode`/`decode` forward to memory-buffers.md `encodeEid`/`decodeEid`; default `-1` (§4.2). |
| ESM-only, strict TS, SAB + postMessage fallback | All exports are ESM, no `any` except the deliberate `object<T>` phantom; this module makes no SAB/AB decision (B-1: memory-buffers owns it). |

---

## 2. `defineComponent`

### 2.1 Signature (restated from type-system.md §2.1 — normative source is there)

```ts
import type {
  Schema, ComponentDef, ComponentOptions, FieldDescriptor, FieldToken,
  ComponentId, AccessorFactory,
} from '@ecsia/schema';   // type-system.md §12 exports

export function defineComponent<const S extends Schema>(
  schema: S,
  options?: ComponentOptions & { brand?: string },
): ComponentDef<S>;

export function defineTag(name?: string): ComponentDef<{}>;   // §2.6
```

The `const S` const-type-parameter (type-system.md §2.1) makes `defineComponent({ x: 'f32' })` infer
`S = { x: 'f32' }`. This module's *runtime* never inspects the type parameter — it reads only the
runtime `schema` object. The `brand` literal (type-system.md §2.3) is passed straight onto the def
for nominal distinctness of identical-schema components; it is type-inert at runtime.

### 2.2 The `ComponentDef<S>` value this module produces (runtime shape)

The runtime object exactly fills the type-system.md §2.1 interface. The `__brand`/`__read`/`__write`
phantoms are **never assigned a value** (they exist only for inference); `id` is `UNREGISTERED` until
`createWorld` (§7). This module ADDS three runtime-only fields type-system.md leaves to the
implementation (they are not part of the inferred type surface, carried under a `__runtime` namespace
to avoid colliding with the public interface):

```ts
const UNREGISTERED = -1 as ComponentId;   // id before world registration (type-system.md §2.1 "-1 until then")

interface ComponentRuntime<S extends Schema> {
  // ---- exactly the type-system.md §2.1 ComponentDef<S> fields: ----
  readonly schema: S;
  readonly fields: readonly FieldDescriptor[];   // resolved §3, declaration order
  id: ComponentId;                                // MUTATED once at createWorld (§7.2); UNREGISTERED before
  readonly name: string;
  readonly options: Required<ComponentOptions>;
  readonly __nominalBrand?: string;               // type-system.md §2.3 optional brand literal

  // ---- runtime-only, NOT in the inferred type (implementation detail of THIS module): ----
  /** Lazily built once at createWorld, after `id` is known: the closure factory storage calls
   *  per (archetype, component). Satisfies AccessorFactory<S> (type-system.md §9). §8.2. */
  accessorFactory: AccessorFactory<S>;
  /** Per-field resolved ColumnLayouts (memory-buffers.md §3.1), parallel to `fields`. Tag => []. §8.1. */
  readonly columnLayouts: readonly ColumnLayout[];
  /** kind discriminator so the registry, storage, and relations can branch without instanceof. */
  readonly defKind: 'component' | 'relation-presence' | 'relation-overflow';
}
```

> **Why `id` is mutable.** type-system.md §2.4 mandates "`id` is mutated exactly once, at `createWorld`
> registration, to a dense `ComponentId`". This module owns that mutation (§7.2). Everything else on the
> def is frozen at `defineComponent` time. The single mutable field is the only deviation from full
> immutability and is the registry's commit point for the def, analogous to the entity record being the
> structural commit point for an entity (entity-model.md §4.2).

### 2.3 Algorithm — `defineComponent` (value-level, expands type-system.md §2.4)

```
defineComponent(schema, options):
  assertNotInsideWorld()                     # dev guard: defining after createWorld is allowed but
                                             #   the def must be passed to a LATER createWorld; a def
                                             #   already registered to a world cannot be re-registered (§7.5)
  # ---- 1. validate (throws synchronously, fail-fast — report §2.8 "validated at construction") ----
  validateSchema(schema)                      # §2.4
  validateOptions(options)                    # §2.5

  # ---- 2. resolve field descriptors in declaration order (§3) ----
  fields := []
  for (name, decl) in entriesInDeclarationOrder(schema):
      token   := tokenOf(decl)                # decl may be a bare token or { token, default } (§4.1)
      default := userDefaultOf(decl)          # undefined if not annotated
      desc    := resolveDescriptor(name, token, default)   # §3
      fields.push(desc)

  # ---- 3. derive options (tag => sparse default; else packed) ----
  isTag := fields.length === 0
  opts := {
    storage:    options?.storage    ?? (isTag ? 'sparse' : 'packed'),    # §5
    maxHistory: options?.maxHistory ?? 0,                                # type-system.md §1.5, reactivity-inert here
  }

  # ---- 4. derive per-field ColumnLayouts (memory-buffers.md §3.1); tag/object contribute none (§8.1) ----
  columnLayouts := fields.filter(f => f.ctor !== null).map(fieldToColumnLayout)   # §8.1

  # ---- 5. build the frozen def; id UNREGISTERED until createWorld; accessorFactory wired lazily ----
  def := freeze({
    schema, fields, id: UNREGISTERED,
    name: options?.brand ?? options?.name ?? inferName() ?? 'Component',
    options: opts,
    __nominalBrand: options?.brand,
    columnLayouts,
    defKind: 'component',
    accessorFactory: UNWIRED,                 # set at createWorld step §7.2 once `id` is known
  })
  return def
```

- **Complexity:** `O(fieldCount)` — descriptor resolution and layout projection are O(1) per field; no
  buffer allocation (storage allocates lazily per archetype — report T4). Matches type-system.md §2.4.
- **No allocation beyond the def object + its small arrays.** No columns, no registry mutation (the def
  is *world-agnostic* until passed to `createWorld`).
- `inferName()` reads a `Function.name`-style debug hint if the def is assigned to a `const` via a
  build-tool-free heuristic (best-effort; falls back to `'Component'`). Debug only — not load-bearing.

### 2.4 `validateSchema` (exhaustive, fail-fast)

```
validateSchema(schema):
  assert isPlainObject(schema)                                   # not array, not class instance
  seen := new Set()
  for (name, decl) in schema:
      assert isValidIdentifier(name)                            # /^[A-Za-z_$][A-Za-z0-9_$]*$/; no reserved __ prefix
      assert not seen.has(name); seen.add(name)
      token := tokenOf(decl)
      assert isFieldToken(token)                                # type-system.md §1.1 union membership
      switch token.kind ?? 'scalar':
        'scalar':       assert token in SCALAR_TOKENS           # §3.1 set
        'vec':          assert isNumericScalar(token.elem) and Number.isInteger(token.len) and token.len >= 1
        'staticString': assert token.choices.length >= 1
                        assert allDistinct(token.choices)        # §3.5
                        assert token.choices.length <= 0xffffffff # u32 index ceiling (memory-buffers.md §7.9)
        'object':       /* always valid; marks shareable=false (§3.8) */
      if hasUserDefault(decl): assert defaultIsAssignable(token, userDefaultOf(decl))   # §4.3
```

- Reserved-name rule: schema keys may not begin with `__` (avoids collision with the def's phantom
  carriers and the accessor's `__idx`/`__rebind`).
- `staticString` distinctness mirrors becsy's enum index requirement (`type.ts:566-655`).
- All throws are synchronous `SchemaError`s with the offending `(componentName, fieldName, reason)` —
  no deferred placeholder (report §2.8 rejects becsy's `as unknown as S`).

### 2.5 `validateOptions`

```
validateOptions(options):
  if options?.storage !== undefined: assert options.storage in {'packed','sparse'}
  if options?.maxHistory !== undefined: assert Number.isInteger(options.maxHistory) and options.maxHistory >= 0
  if options?.brand !== undefined: assert typeof options.brand === 'string' and options.brand.length > 0
```

### 2.6 `defineTag` (zero-field component)

```ts
export function defineTag(name = 'Tag'): ComponentDef<{}> {
  return defineComponent({}, { storage: 'sparse', brand: name });
}
```

- A tag has `fields: []`, `columnLayouts: []`, and storage `'sparse'` (the rare-component path, becsy
  `component.ts:387-389`; report §2.2 "Tag components (zero fields): skip all buffer registration").
- Presence is **pure signature/bitmask membership** — `archetype-storage.buildColumnSet` is never
  invoked for a tag (§8.1 emits no layout, and the archetype's `columnSets` excludes zero-field
  components per archetype-storage.md §3.4). `entity.add(Tag)` / `remove(Tag)` are pure migrations.
- The empty archetype (`EMPTY_ARCHETYPE_ID`) is the archetype of an entity holding only tags-and-nothing
  — but a tag still occupies a signature bit, so an entity with one tag is in a *non-empty-signature*
  archetype with an empty `columnSets`. This is consistent with archetype-storage.md §3.4 ("The empty
  archetype has an empty `columnSets`" but a one-tag archetype also has empty `columnSets`).

---

## 3. Field-token → `FieldDescriptor` resolution

`resolveDescriptor(name, token, userDefault?)` produces the `FieldDescriptor` (type-system.md §1.4)
**body**. The table below is type-system.md §1.4's table given concrete `encode`/`decode` functions and
the `default` value (§4). This module is the normative owner of the *runtime bodies*; type-system.md
owns the *shape*.

### 3.1 The descriptor resolution table (exhaustive, matches type-system.md §1.4 verbatim)

| token | `ctor` | `bytesPerElem` | `stride` | `shareable` | `encode(v)` | `decode(slot)` | `default` (§4) |
|---|---|---|---|---|---|---|---|
| `'bool'` | `Uint8Array` | 1 | 1 | yes | `v ? 1 : 0` | `slot !== 0` | `false` (0) |
| `'i8'` | `Int8Array` | 1 | 1 | yes | `v\|0` | `slot` | `0` |
| `'u8'` | `Uint8Array` | 1 | 1 | yes | `v & 0xff` | `slot` | `0` |
| `'u8c'` | `Uint8ClampedArray` | 1 | 1 | yes | `v` (ctor clamps) | `slot` | `0` |
| `'i16'` | `Int16Array` | 2 | 1 | yes | `v\|0` | `slot` | `0` |
| `'u16'` | `Uint16Array` | 2 | 1 | yes | `v & 0xffff` | `slot` | `0` |
| `'i32'` | `Int32Array` | 4 | 1 | yes | `v\|0` | `slot` | `0` |
| `'u32'` | `Uint32Array` | 4 | 1 | yes | `v >>> 0` | `slot >>> 0` | `0` |
| `'f32'` | `Float32Array` | 4 | 1 | yes | `+v` | `slot` | `0` |
| `'f64'` | `Float64Array` | 8 | 1 | yes | `+v` | `slot` | `0` |
| `'eid'` | `Int32Array` | 4 | 1 | yes | `encodeEid(v)` (memory-buffers.md §3.4) | `decodeEid(slot)` | `-1` (NO_ENTITY/null) |
| `vec(E,N)` | `ctorOf(E)` | `bytesOf(E)` | `N` | yes | per-axis `encodeOf(E)` | per-axis `decodeOf(E)` | per-axis `defaultOf(E)` |
| `staticString(C)` | smallest uint covering `len(C)` (§3.5) | 1/2/4 | 1 | yes | `indexOf(v)` in `C` | `C[slot]` | `0` (= `C[0]`) |
| `object<T>` | `null` | `0` | `0` | **no** | identity (stored in JS array, not a slot) | identity | `undefined` |

`ctorOf`/`bytesOf`/`encodeOf`/`decodeOf` for a scalar token `E` are the corresponding rows above. The
`encode`/`decode` signatures are `(v: unknown) => number` / `(slot: number) => unknown` exactly as
type-system.md §1.4 declares; for `vec` and `object` the descriptor's `encode`/`decode` operate
per-axis / per-slot and the accessor (§8.2) loops.

### 3.2 Algorithm

```
resolveDescriptor(name, token, userDefault?) -> FieldDescriptor:
  switch classify(token):
    SCALAR(s):                                   # s in SCALAR_TOKENS
      row := SCALAR_ROW[s]                        # the table line above
      return { name, token, ctor: row.ctor, bytesPerElem: row.bytes, stride: 1,
               shareable: true, encode: row.encode, decode: row.decode,
               choices: undefined, default: userDefault ?? row.default }
    VEC(elem, len):
      r := SCALAR_ROW[elem]
      return { name, token, ctor: r.ctor, bytesPerElem: r.bytes, stride: len,
               shareable: true, encode: r.encode, decode: r.decode,
               choices: undefined, default: userDefault ?? Array(len).fill(r.default) }   # §4.4
    STATIC_STRING(choices):
      ctor := stringIndexCtor(choices.length)     # §3.5
      idxOf := buildChoiceIndex(choices)          # Map<string, number> for O(1) encode
      return { name, token, ctor, bytesPerElem: ctor.BYTES_PER_ELEMENT, stride: 1,
               shareable: true,
               encode: (v) => idxOf.get(v) ?? throwOrZero(v),     # §3.5 unknown-value policy
               decode: (slot) => choices[slot],
               choices, default: userDefault !== undefined ? idxOf.get(userDefault) ?? 0 : 0 }
    OBJECT():
      return { name, token, ctor: null, bytesPerElem: 0, stride: 0,
               shareable: false, encode: (v)=>v as any, decode: (s)=>s as any,
               choices: undefined, default: userDefault ?? undefined }
```

- **Complexity:** O(1) per field except `staticString`, which is O(|choices|) to build `idxOf` (done
  once at `defineComponent`, never per access).
- `FieldDescriptor.default` is an extension this module adds to the type-system.md §1.4 interface for
  the value-level default (type-system.md §1.4 does not name `default`; this module appends it as a
  runtime-only descriptor field, the same way §2.2 appends runtime-only def fields). It is consumed by
  `archetype-storage.initColumnRow` (archetype-storage.md §5.7) and §4.

### 3.3 `bool`

Stored `u8`, `0`/`1` (memory-buffers.md §3.3 — "A packed-bit representation is rejected for v1").
`encode(v) = v ? 1 : 0`; `decode(slot) = slot !== 0`. Accessor value type is `boolean` (type-system.md
§1.2 `ScalarValue<'bool'> = boolean`). Tag components are **not** bool columns — they have no column at
all (§2.6).

### 3.4 `eid`

The descriptor's `encode`/`decode` **forward to the normative memory-buffers.md §3.4 functions**; this
module does not re-implement the bit-pattern logic:

```ts
import { encodeEid, decodeEid } from '@ecsia/core/memory-buffers';   // memory-buffers.md §3.4 NORMATIVE
// encode: (v) => encodeEid(v as EntityHandle)   // stores FULL u32 handle bit-pattern via Int32Array
// decode: (slot) => decodeEid(slot)             // -1 => null; else (slot >>> 0) as EntityHandle
```

- `ctor = Int32Array`, `stride = 1`, default `-1` (memory-buffers.md C-2 — the null sentinel; **not** 0,
  which is a valid entity index). The grown-tail and fresh-row fill of `-1` is owned by memory-buffers.md
  §7.3 / archetype-storage.md §5.7 (which read `descriptor.default`).
- **No bit-31 stale flag, no parallel generation column** (memory-buffers.md §3.4; type-system.md §1.4).
  Staleness is resolved at *read time* by `world.isAlive(handle)` (entity-model.md §3.3), not by this
  descriptor. The descriptor's job ends at "store the handle bit-pattern; return `null` for `-1`".

### 3.5 `staticString(choices)`

Element width is the **smallest unsigned TypedArray** covering `choices.length` (memory-buffers.md §3.5;
becsy variable-width index upgrade `component.ts:209, 266-270`):

```
stringIndexCtor(n):
  if n <= 256:        return Uint8Array      # indices 0..255
  if n <= 65_536:     return Uint16Array     # 0..65_535
  else:               return Uint32Array     # 0..2^32-1   (n > 2^32 rejected in validateSchema §2.4)
```

- The `choices: readonly string[]` table lives **once on the descriptor** (and thus on the
  `ComponentDef`), never per archetype, never per row (memory-buffers.md §3.5; type-system.md §1.4). It
  is replicated to workers once at startup by structured clone (immutable, tiny — memory-buffers.md §6.2).
- `encode` resolves `v → index` via the prebuilt `Map<string, number>` (`idxOf`), O(1). **Unknown-value
  policy** (memory-buffers.md §3.5): dev-mode → throw `SchemaError`; prod-mode → write `0` (the first
  choice) and continue. `throwOrZero(v)` implements this branch on `world.devMode`.
- `decode(slot) = choices[slot]` returns the literal string; the inferred accessor type is the union
  `C[number]` (type-system.md §1.2). No `dynamicString`/`fixedString` in v1 (memory-buffers.md §3.5).

### 3.6 `vec(E, N)`

One **contiguous** column, `stride = N`, element ctor of `E` (memory-buffers.md §3.6 — rejecting the
bitECS one-array-per-axis layout `legacy/index.ts:100-101`). Row `r`'s axes occupy
`view[r*N + 0 .. r*N + N-1]`. The descriptor carries `E`'s scalar `encode`/`decode`; the accessor (§8.2)
exposes `.x/.y/.z/.w` (for `N<=4`) and `[i]`, producing a `VecView<E,N>` (type-system.md §1.3) over the
contiguous slice (`memory-buffers.rowSlice` is the zero-copy helper). `E` must be a **numeric** scalar
(validateSchema §2.4 rejects `vec` of `bool`/`eid`/`staticString`).

### 3.7 Relation payload columns reuse the same path

A relation's payload schema `P` resolves to descriptors through the **identical** `resolveDescriptor`
path (a payload field is an ordinary field). The exclusivity split (§6) decides *where* those columns
live (subject archetype vs overflow table — memory-buffers.md §3.7), but the descriptors themselves are
component-agnostic. The synthetic `eid` target field of an exclusive relation (§6.3) is one extra
`eid` descriptor prepended to `P`'s descriptors.

### 3.8 `object<T>` (non-shareable escape hatch)

`ctor = null`, `stride = 0`, `shareable = false` (memory-buffers.md §3.8; becsy `type.ts:1024-1082`).
**No column, no buffer** — the value lives in a plain JS `Array<T | undefined>` per `(archetype,
component)`, allocated by the accessor/storage path, never through `Buffers.column` (§8.1 emits no
`ColumnLayout` for it). The component carrying *any* `object` field is structurally
`restrictedToMainThread` (memory-buffers.md §3.8). This module sets a derived flag on the def:

```ts
// derived once at defineComponent: true iff any field is non-shareable (object<T>).
readonly restrictedToMainThread: boolean = fields.some(f => !f.shareable);
```

A worker-tagged system referencing such a component is a **TS error** (enforced in type-system.md §3.8 /
scheduler spec); at runtime this module additionally refuses to wire SAB columns for the object field
(it has none) and surfaces `restrictedToMainThread` so the scheduler can validate.

---

## 4. Default values

### 4.1 Schema field may be a bare token or an annotated `{ token, default }`

To let a user override the per-token default without a separate options blob, a schema value may be
either the bare `FieldToken` (type-system.md §1.1) or a one-key wrapper `{ token, default }`. The
type-system already infers `FieldValue` from the *token*; the wrapper is a runtime-only annotation that
this module reads. type-system.md's `Schema = Readonly<Record<string, FieldToken>>` is widened at the
value level (NOT the type level — inference still keys off the token) to accept the wrapper:

```ts
// VALUE-LEVEL ONLY. The type-level Schema stays as type-system.md §2.1 declares (token-keyed);
// the wrapper is unwrapped by tokenOf()/userDefaultOf() before inference ever sees it, because
// `defineComponent` accepts `S` whose values are `FieldToken | FieldWithDefault<FieldToken>` and
// the inference helpers project back to the bare token. (type-system.md §2.1 const-S still applies.)
interface FieldWithDefault<F extends FieldToken> { readonly token: F; readonly default: FieldValue<F>; }

function tokenOf(decl):        FieldToken { return isWrapper(decl) ? decl.token   : decl; }
function userDefaultOf(decl):  unknown    { return isWrapper(decl) ? decl.default : undefined; }
function isWrapper(decl): boolean { return decl !== null && typeof decl === 'object' && 'token' in decl && 'default' in decl; }
```

> **Inference note (defers to type-system.md).** The `FieldValueRW`/`ReadView`/`WriteView` machinery
> (type-system.md §2.2) keys off `S[K]`. To keep inference unchanged, the wrapper is recognized at the
> type level by mapping `S[K] extends FieldWithDefault<infer F> ? F : S[K]` *before* `FieldValue` is
> applied. This is a one-line addition to type-system.md §2.2's mapped type and is the ONLY type-level
> change this module requests of type-system.md; it does not alter any existing inferred outcome (a
> bare token still infers identically). It stays within the depth budget (one extra conditional level,
> type-system.md §3.1).

### 4.2 Per-token defaults (the zero-default invariant)

Every token's intrinsic default is **the zero value of its storage** *except* `eid` (whose zero is a
valid entity, so its null is `-1`):

| token | intrinsic default | column zero-init suffices? |
|---|---|---|
| numeric (`i*`/`u*`/`f*`/`u8c`) | `0` | yes — runtime zero-inits the buffer (memory-buffers.md §3.4) |
| `bool` | `false` (slot 0) | yes |
| `staticString` | `choices[0]` (slot 0) | yes |
| `vec(E,N)` | `N`×`defaultOf(E)` | yes (numeric E) |
| `eid` | `null` (slot `-1`) | **no** — needs explicit `-1` fill (memory-buffers.md C-2 / §7.3) |
| `object<T>` | `undefined` | n/a (JS array slot, set to `undefined`) |

This is the **DEF-1 invariant**: *a column's intrinsic default equals its zero-initialized buffer value
for every token except `eid`*. Consequently `archetype-storage.initColumnRow` (archetype-storage.md §5.7)
and memory-buffers.md §7.3 only special-case `eid` (fill `-1`); every other column relies on runtime
zero-init. This module's `resolveDescriptor` encodes that by setting `descriptor.default` to the exact
value above, and storage reads `descriptor.default` only when it is **non-zero-equivalent** (i.e. `eid`,
or a user override §4.3).

### 4.3 User-overridable defaults

A user default (from the `{ token, default }` wrapper, §4.1) overrides the intrinsic default. It is
validated at `defineComponent` (`validateSchema` §2.4 `defaultIsAssignable`):

```
defaultIsAssignable(token, d):
  SCALAR numeric:   Number.isFinite(d)            # and within range in dev mode (e.g. u8: 0..255)
  bool:             typeof d === 'boolean'
  eid:              d === NO_ENTITY or isEntityHandleShaped(d)   # encoded via encodeEid at init
  staticString(C):  d in C                        # must be one of the choices
  vec(E,N):         Array.isArray(d) and d.length === N and each element assignable to E
  object<T>:        always (the value is stored as-is)
```

A user default makes the column's row-init **non-trivial** (storage must write `descriptor.default`
into every fresh row, not rely on zero-init). `resolveDescriptor` flags this:

```ts
// derived: true iff descriptor.default differs from the buffer's zero value -> storage must explicitly fill.
readonly needsExplicitInit: boolean = !isZeroEquivalent(token, descriptor.default);
```

- For `eid`, `needsExplicitInit` is always `true` (default `-1` ≠ buffer-zero `0`).
- For a user-overridden numeric default `5`, `needsExplicitInit` is `true`.
- For an un-overridden numeric/bool/staticString, it is `false` (zero-init suffices — DEF-1).

`archetype-storage.initColumnRow` / `memory-buffers.fillGrownTail` consult `needsExplicitInit` to decide
whether to write each row on alloc/growth, keeping the hot path zero-cost for the common (no user
default, non-eid) case.

### 4.4 Vector defaults

`vec(E,N)` default is an `N`-length array (§3.2). A bare `vec('f32',3)` defaults to `[0,0,0]`
(zero-equivalent, `needsExplicitInit=false`). A user override `{ token: vec('f32',3), default: [1,0,0] }`
sets `needsExplicitInit=true` and storage writes all three axes per fresh row.

---

## 5. Storage-strategy selection (`packed` / `sparse`)

### 5.1 The rule

`ComponentOptions.storage` (type-system.md §1.5) is **type-inert** — it does not change any inferred
type. This module selects it as follows (type-system.md §2.4 default rule, made normative here):

```
storageOf(options, fieldCount):
  if options?.storage is set: return options.storage      # explicit user choice wins
  if fieldCount === 0:        return 'sparse'              # tags default sparse (rare/membership-only)
  else:                       return 'packed'              # data components default packed
```

### 5.2 What the strategy means downstream (informative; storage owns the mechanism)

The strategy is carried on `def.options.storage` for the storage module (becsy
`component.ts:179-270, 387-389`). This module makes no allocation decision from it; it only records the
intent. Semantics consumed by archetype-storage:

- **`packed`** (default for data components): the component participates normally in archetype `ColumnSet`
  allocation (archetype-storage.md §3.7). Its columns are dense SoA, indexed by `archetypeRow`. This is
  the cache-coherent iteration path and the common case.
- **`sparse`** (default for tags, opt-in for rare data components): a hint that the component is held by
  a small fraction of entities. For a **tag** (`fieldCount===0`) it is moot — there are no columns either
  way — but the hint lets storage prefer keeping such components out of hot archetype fast-paths. For a
  **rare data component**, `sparse` signals storage that an entity-indexed indirection (becsy's `packed`
  storage with an indirect map + free-list, `component.ts:209, 266-270`) *may* be preferable to a full
  archetype column; v1 storage MAY treat `sparse` identically to `packed` for data components (the hint
  is advisory) and is free to specialize in a later milestone. The **type-inert guarantee** means
  switching `packed`↔`sparse` never changes a `ReadView`/`WriteView` (type-system.md §1.5).

> **v1 minimalism.** v1 honors the strategy fully only for the tag case (no columns). For rare data
> components, v1 may map `sparse → packed` storage (advisory). The selection is recorded so a future
> storage milestone can implement the indirection without an API change. This is consistent with the
> report (§2.1 "three orthogonal strategies … so rare tag components cost no per-entity allocation") and
> defers the rare-data-component sparse implementation as a non-blocking refinement.

### 5.3 Complexity

`storageOf` is O(1). No per-entity cost is incurred at `defineComponent` (storage is lazy — report T4).

---

## 6. `defineRelation`

### 6.1 Signature (restated from type-system.md §7.1 — normative source is there)

```ts
import type { RelationDef, RelationOptions, Schema } from '@ecsia/schema';   // type-system.md §7.1

export function defineRelation(name?: string, opts?: RelationOptions): RelationDef<void>;
export function defineRelation<const P extends Schema>(
  payload: P, opts?: RelationOptions): RelationDef<P>;
```

`RelationOptions = { exclusive?: boolean (default false); cascade?: 'none'|'deleteSubject'|'removeRelation'
(default 'none') }` (type-system.md §7.1). The two overloads distinguish tag (`void`) from payload
(`P extends Schema`) relations. `const P` captures the payload schema literal like `defineComponent`'s
`const S`.

### 6.2 The `RelationDef<P>` value + the `RelationRuntime` skeleton

`defineRelation` produces the type-system.md §7.1 `RelationDef<P>` (with `__relationBrand` phantom,
`id: RelationId` = `UNREGISTERED_RELATION` until `createWorld`, `name`, `payload`, `exclusive`,
`cascade`, payload-view phantoms). It **also** constructs the `RelationRuntime` skeleton (relations.md
§3.2) that the relations module fills in — but `defineRelation` runs at world-setup, before
`createWorld` assigns the `RelationId` and `presenceId`, so the runtime's id fields are `UNREGISTERED`
until §7.3 wires them. This module owns the *construction*; relations.md owns the *behavior* (back-ref,
overflow ops, cascade).

```ts
const UNREGISTERED_RELATION = -1 as RelationId;

interface RelationDefRuntime<P extends Schema | void> {
  // ---- type-system.md §7.1 RelationDef<P> fields: ----
  readonly id: RelationId;                 // UNREGISTERED_RELATION until createWorld (§7.3)
  readonly name: string;
  readonly payload: P extends Schema ? P : null;
  readonly exclusive: boolean;
  readonly cascade: 'none' | 'deleteSubject' | 'removeRelation';
  // ---- runtime-only (this module): ----
  readonly storageKind: 'tag' | 'exclusive-column' | 'overflow-table';   // §6.4 (relations.md §4)
  readonly payloadDescriptors: readonly FieldDescriptor[];               // resolved P (§3.7); [] for tag
  /** The synthetic presence ComponentDef minted at createWorld (§6.3); UNWIRED until then. */
  presenceDef: ComponentDef<any>;          // column-bearing iff exclusive-column; zero-field tag otherwise
  /** The synthetic overflow ComponentDef (overflow-table only); null otherwise. §6.5. */
  overflowDef: ComponentDef<any> | null;
}
```

### 6.3 `storageKind` resolution + presence-component synthesis (Must-Fix #4)

The exclusivity split is **decided here** (relations.md §4 consumes the result):

```
resolveStorageKind(payloadSchema, exclusive):       # relations.md §4 exact rule
  if payloadSchema === null: return 'tag'            # payload-free: zero bytes either way
  if exclusive:              return 'exclusive-column'
  else:                      return 'overflow-table'
```

For each `storageKind`, `defineRelation` synthesizes the **per-relation presence `ComponentDef`**
(`presenceDef`) — exactly **one per relation type**, the Flecs "wildcard id" (report §2.6 boxed note,
§6.4 #2; relations.md §3.2). It is constructed via the *same* `defineComponent` machinery (§2), so it
is an ordinary `ComponentDef` to storage/queries/bitmask:

```
synthesizePresenceDef(rel) -> ComponentDef:
  switch rel.storageKind:
    'tag':
        # zero-field: presence bit only. defineComponent({}, sparse). defKind tagged.
        return makeSynthetic({}, defKind='relation-presence', sparse=true)

    'overflow-table':
        # zero-field presence bit; payload lives in the overflow ColumnSet (§6.5), NOT here.
        return makeSynthetic({}, defKind='relation-presence', sparse=true)

    'exclusive-column':
        # COLUMN-BEARING: this single def is BOTH the wildcard presence bit AND the column owner
        # for the subject archetype (relations.md §4.2 "Which ComponentId keys these columns").
        # field 0 = synthetic eid target; fields 1..|P| = the payload descriptors.
        targetDesc := resolveDescriptor('__target', 'eid')            # subjectTargetFieldIndex = 0
        fields := [ targetDesc, ...rel.payloadDescriptors ]           # §3.7
        return makeSyntheticFromDescriptors(fields, defKind='relation-presence', packed=true)
```

- **`makeSynthetic`/`makeSyntheticFromDescriptors`** are internal builders that produce a frozen
  `ComponentDef` with `id: UNREGISTERED` (assigned in §7.3 from the dense component space via
  `allocSyntheticComponentId`), the supplied `fields`/`columnLayouts`, and `defKind:'relation-presence'`.
  They reuse §3 descriptor resolution and §8.1 layout projection unchanged — a presence def is
  indistinguishable from a user component to storage, *which is the entire point of integer encoding*
  (relations.md §2.2; report §2.6).
- For `exclusive-column`, the presence def's `subjectTargetFieldIndex = 0` is recorded on the
  `RelationRuntime` (relations.md §3.2). Re-targeting writes that `eid` field in place — **no migration**
  (the T1 valve, relations.md §5.4). For a payload-free **exclusive** relation, `P === null` so
  `storageKind === 'tag'` (the table above) and the presence def is zero-field — but the relations module
  may still want the `eid` target column; this module synthesizes the target-only column-bearing def
  (`fields = [targetDesc]`) when `exclusive && payloadSchema === null` is explicitly requested via a
  `storageKind` override, matching relations.md §4.2's parenthetical ("a truly payload-free exclusive
  relation … just the target column"). The default for `exclusive && payload===null` is `'tag'` (no
  target column) unless the relation declares it needs the target stored.

> **Edge: `exclusive && payload===null`.** By the table, this is `'tag'` (no payload to store, and an
> exclusive *tag* relation's single-target constraint is enforced by the relations module at `addPair`
> time, not by a column). If the application needs `targetsOf` to be O(1) for such a relation, it must
> give it a (possibly empty) payload or opt into the target column; v1 default keeps it a pure tag.
> This precisely mirrors relations.md §4.2's final paragraph.

### 6.4 `defineRelation` algorithm

```
defineRelation(arg, opts):                          # arg = name(string) | payloadSchema(object)
  assertNotInsideWorld()
  if typeof arg === 'string' or arg === undefined:
      payloadSchema := null; name := arg ?? 'Relation'
  else:
      validateSchema(arg)                            # §2.4 — payload is an ordinary schema
      payloadSchema := arg; name := opts?.name ?? 'Relation'
  exclusive := opts?.exclusive ?? false
  cascade   := opts?.cascade   ?? 'none'
  payloadDescriptors := payloadSchema ? resolveAll(payloadSchema) : []     # §3
  storageKind := resolveStorageKind(payloadSchema, exclusive)              # §6.3
  rel := freeze({
    id: UNREGISTERED_RELATION, name, payload: payloadSchema, exclusive, cascade,
    storageKind, payloadDescriptors,
    presenceDef: UNWIRED, overflowDef: UNWIRED,
    __relationBrand: undefined,                      # phantom (type-system.md §7.1)
  })
  return rel
```

- Validation throws synchronously on a bad payload schema (fail-fast, report §2.8).
- `presenceDef`/`overflowDef` are synthesized but **id-unassigned** until `createWorld` (§7.3) because
  they draw from the world's dense component space.
- Complexity: O(|payload fields|).

### 6.5 Overflow `ComponentDef` synthesis (`overflow-table` only)

For a non-exclusive payload relation, the payload lives in a pair-keyed overflow SoA `ColumnSet`
(relations.md §4.3; memory-buffers.md §3.7), keyed by a **synthetic overflow `ComponentId`**. This
module synthesizes its `ComponentDef`:

```
synthesizeOverflowDef(rel) -> ComponentDef | null:
  if rel.storageKind !== 'overflow-table': return null
  # the overflow def's fields ARE the payload descriptors (no eid target — the pair key carries that):
  return makeSyntheticFromDescriptors(rel.payloadDescriptors, defKind='relation-overflow', packed=true)
```

- The overflow def's columns are allocated by the relations module through `Buffers.column` with the
  synthetic `overflowComponentId` (relations.md §4.3); its rows are **not entity rows** (memory-buffers.md
  §3.7 — "MUST NOT assume `row` indexes a live entity"). This module only produces the *descriptor set*
  and the `ColumnLayout`s (§8.1); relations.md owns the row alloc/free.

---

## 7. The component & relation registry (type-id assignment)

This is the module's explicit focus. The registry lives on the world; `defineComponent`/`defineRelation`
produce **world-agnostic** defs (ids `UNREGISTERED`), and `createWorld` interns them into a dense id
space deterministically.

### 7.1 Registry layout

```ts
interface SchemaRegistry {
  /** Dense ComponentId -> def. Index === ComponentId. Includes user components, relation-presence,
   *  relation-overflow, and the reserved synthetic changeVersion id (archetype-storage.md §5.3.1). */
  readonly componentsById: ComponentDef<any>[];          // index = ComponentId
  /** Stable identity -> ComponentId, for re-lookup (object identity is the key). */
  readonly idByDef: Map<ComponentDef<any>, ComponentId>;
  /** Dense RelationId -> RelationDef. Index === RelationId. */
  readonly relationsById: RelationDef<any>[];            // index = RelationId
  readonly relationIdByDef: Map<RelationDef<any>, RelationId>;

  /** Next dense ComponentId to hand out. Starts at FIRST_USER_COMPONENT_ID (after reserved). */
  nextComponentId: number;
  /** Next dense RelationId. */
  nextRelationId: number;

  /** Count of components registered at createWorld (seeds the bitmask fixed stride). §7.4. */
  readonly registeredComponentCount: number;
}
```

- **Reserved low ids.** A small fixed prefix of the `ComponentId` space is reserved for synthetic
  internals so they never collide with user components and have stable positions:
  - **`ComponentId 0` is NEVER a user component.** It is reserved as the canonical **"no component"
    sentinel** (`NO_COMPONENT = 0`). This is exactly the value the reactivity shape log packs into
    word A's `componentId` field for `CREATE`/`DESTROY` entries (reactivity.md §4.1/§4.2:
    `trackShape(index, 0, ShapeKind.Create)`), where there is no associated component. Because id 0 is
    never minted for a user component, a `componentId = 0` in a shape-log word A unambiguously means
    "entity-lifecycle event, no component" — the `kind` field in word B then distinguishes
    `CREATE` from `DESTROY`. (`EMPTY_ARCHETYPE_ID = 0` is an *ArchetypeId*, a different space —
    archetype-storage.md §3.1 — and does not interact with this reservation.)
  - `CHANGEVERSION_COMPONENT_ID` — the reserved synthetic id archetype-storage.md §5.3.1 uses for the
    per-archetype `changeVersion` column. It is a **hidden synthetic** id, never a user component and
    never appearing in a signature (archetype-storage.md §5.3.1); it does **not** consume a *user* id.
  Per CANON (world.md §5.2), **`FIRST_USER_COMPONENT_ID = 1`**: `ComponentId 0` is the reserved
  `NO_COMPONENT` sentinel and the first user component is minted at id 1. Because the `changeVersion`
  column is a hidden synthetic id excluded from the user space, user ids begin densely at 1. The
  **full reserved-`ComponentId` set is owned by world.md §5** (the keystone) and is not re-enumerated
  here; this module relies only on `ComponentId 0` never being a user component and on
  `FIRST_USER_COMPONENT_ID = 1`. reactivity.md §4.1 relies on `0` being non-user, and all callers MUST
  treat a shape-log `componentId = 0` as the no-component sentinel, never as user-component-0.

### 7.2 Component registration (deterministic, at `createWorld`)

```
registerComponents(registry, components: ComponentDef[]):       # serial, at createWorld; order deterministic
  for def in components in declaration order (the createWorld({ components }) array order):
      assert def.id === UNREGISTERED         # not already registered (§7.5) — else ConfigError
      cid := registry.nextComponentId++ as ComponentId
      def.id := cid                          # the ONE mutation (§2.2); commits the def into this world
      registry.componentsById[cid] := def
      registry.idByDef.set(def, cid)
      wireAccessorFactory(def)               # §8.2 — now that `id` is known, build the factory shell
  registry.registeredComponentCount := registry.nextComponentId   # seeds bitmask fixed stride (§7.4)
```

- **Deterministic order** = the order of the `components` array passed to `createWorld` (type-system.md
  §2.4: "Registration order is deterministic = the order in `createWorld({components})`"; report §2.8
  "dependencies passed explicitly … validated at construction"). This makes `ComponentId`s reproducible
  across runs — required for the canonical query hash (query spec / type-system.md §5) and for snapshot
  compatibility (serialization spec).
- Each `def.id` assignment is the **commit** that ties a def to a world (analogous to the entity record
  commit). A def with `id !== UNREGISTERED` is already owned by a world (§7.5).
- **Complexity:** O(numComponents). One pass.

### 7.3 Relation registration (at `createWorld`, after components)

```
registerRelations(registry, relations: RelationDef[]):           # serial, at createWorld, AFTER components
  assert registry.relationsById.length === 0
  for rel in relations in declaration order:
      assert rel.id === UNREGISTERED_RELATION
      rid := registry.nextRelationId++ as RelationId
      assert rid <= 0xffff   ELSE throw ConfigError('numRelations > 65535')   # u16 cap (type-system.md §8; relations.md §2.1)
      rel.id := rid
      registry.relationsById[rid] := rel
      registry.relationIdByDef.set(rel, rid)
      # presence def gets a DENSE ComponentId from the SAME component space (report §2.6):
      rel.presenceDef.id := allocSyntheticComponentId()           # archetype-storage.md / §7.6
      registerSyntheticDef(registry, rel.presenceDef)
      wireAccessorFactory(rel.presenceDef)                        # column-bearing exclusive presence needs it
      if rel.storageKind === 'overflow-table':
          rel.overflowDef.id := allocSyntheticComponentId()
          registerSyntheticDef(registry, rel.overflowDef)
          wireAccessorFactory(rel.overflowDef)
      handOffToRelationsModule(rel)         # relations.md builds RelationRuntime from the now-id'd defs
```

- **u16 relation cap enforced fail-fast** (type-system.md §8; relations.md §2.1): `numRelations <= 65535`,
  else `ConfigError` at world creation — **never a silent wrap**.
- **Presence/overflow ids are dense `ComponentId`s** drawn from the same space as user components (report
  §2.6 "each unique `(relation, target)` pair gets a synthetic `ComponentId`; edges work identically").
  Because presence ids are bounded by relation count (known at world creation), they fall in the
  **fixed** bitmask-stride region (relations.md §3.4). Pair ids minted later (`mintPair`, relations.md
  §2.2) fall in the lazily-grown sparse pair-bit region — those are NOT assigned here (they are runtime).
- **Complexity:** O(numRelations) + O(payload fields) per relation.

### 7.4 Bitmask fixed-stride seed (the registry → bitmask contract)

After registration, the bitmask fixed stride (memory-buffers.md §5.4; archetype-storage.md §6.1) is, per
CANON (world.md §5.3 / §9.3, the single canonical "fixed component-id count"):

```
bmFixedBitCount  := registry.nextComponentId           # all ids assigned at createWorld (user + presence + overflow + reserved)
bmStride         := ceil(registry.nextComponentId / 32) # world.md §9.3 stride — the ONE rule all bit-vectors share
```

- This is **the** canonical stride: `ceil(registry.nextComponentId / 32)` from the post-`createWorld`
  count. archetype-storage.md §3.3 and scheduler.md §3.3 derive the **identical** stride from this one
  value (scheduler.md drops its separate `+ numRelations` term — world.md C4). This is the report's
  "stride for ordinary components is fixed at world creation from the registered
  component count, growing only when new component **types** (not new pairs) are minted" (§2.1). Synthetic
  presence/overflow ids minted at `createWorld` are counted here; runtime pair ids are NOT (they use the
  sparse pair-bit region — §7.6, relations.md §3.4).
- The registry hands `bmFixedBitCount`/`bmStride` to memory-buffers.md §5.4 (`bitmask.words` length =
  `maxEntities * bmStride`) and to archetype-storage.md §3.3 (`buildSigWords` stride). This is the single
  point where the component count flows into the storage layout.

### 7.5 Re-registration & multi-world guard

A `ComponentDef`/`RelationDef` carries a mutable `id`; registering the *same def object* in two worlds
would alias their id spaces. v1 policy (fail-fast):

```
assertRegisterable(def):
  if def.id !== UNREGISTERED:
     throw ConfigError(`${def.name} is already registered to a world; define a fresh def per world ` +
                       `(or share a world).`)
```

- A def is **single-world** in v1. Sharing component *schemas* across worlds means calling
  `defineComponent` once per world OR (advanced) using a `cloneDef(def)` helper that returns a fresh
  `UNREGISTERED` copy. v1 ships the fail-fast guard; a multi-world re-entrant id table is a deferred
  refinement (Q-CS1, §13). This matches the report's "no deferred placeholders … validated at
  construction" (§2.8) — a double-registration is caught synchronously, not silently aliased.

### 7.6 Synthetic id allocation (the runtime pair-id path)

`allocSyntheticComponentId()` is **owned by archetype-storage** (`componentRegistry.allocSyntheticComponentId`,
relations.md §2.2) and simply returns `registry.nextComponentId++`. This module exposes it (it owns
`nextComponentId`) and storage/relations call it for:

- presence/overflow ids at `createWorld` (§7.3) — counted in the fixed stride (§7.4),
- **runtime pair ids** at `mintPair` (relations.md §2.2) — these push `nextComponentId` past
  `bmFixedBitCount`, so they land in the bitmask's lazily-grown sparse pair-bit region (relations.md §3.4;
  memory-buffers.md §5.4). The registry does NOT grow `bmStride` for these (the report's invariant: pairs
  do not widen the fixed stride). Because pair-id growth is **unbounded at runtime**, it also exceeds the
  reactivity write/shape-log one-word `componentId` field; the resolved rule is that registering any
  relation forces the reactivity logs to the two-word entry form (reactivity.md §3.1/§3.5; relations.md
  §2.2). `registerSyntheticDef` is NOT called for a bare pair id (a pair id has
  no `ComponentDef` of its own unless it is column-bearing — exclusive payloads live on the presence def,
  §6.3; non-exclusive payloads in the overflow table, §6.5; tag pairs have no columns).

> **The pair-id has no schema.** A pair `(relationId, targetIndex)` mints a `ComponentId` (relations.md
> §2.2) but **no `ComponentDef`** — it is a pure signature/bitmask member (tag-like). Its payload, if any,
> is reached through the relation's presence/overflow def, not through a per-pair def. So
> `componentsById[pairId]` is `undefined`; storage/queries must treat a `ComponentId` with no `componentsById`
> entry as a zero-field member (no `ColumnSet`). This is the registry's contract to storage:
> `defOf(cid)` returns `undefined` for bare pair ids, and `buildColumnSet` is skipped for them
> (archetype-storage.md §3.4 "Tag components … contribute no `ColumnSet`").

### 7.7 `defOf` / `relationOf` lookups

```ts
function defOf(registry: SchemaRegistry, cid: ComponentId): ComponentDef<any> | undefined {
  return registry.componentsById[cid];        // undefined for bare pair ids (§7.6) and reserved internal ids with no schema
}
function relationOf(registry: SchemaRegistry, rid: RelationId): RelationDef<any> {
  return registry.relationsById[rid];
}
```

- O(1) array index. Consumed by archetype-storage (`defOf(c)` in `createArchetype` §5.3,
  `migrate` §5.5) and relations (`relationRuntime(R)`).

---

## 8. Schema → columns and schema → accessor wiring

### 8.1 `fieldToColumnLayout` (schema → memory-buffers `ColumnLayout`)

For each **column-backed** field (`ctor !== null`), project its descriptor to a `ColumnLayout`
(memory-buffers.md §3.1). Tag and `object<T>` fields produce **no** layout:

```ts
import type { ColumnLayout, ElementKind } from '@ecsia/core/memory-buffers';   // §3.1

function fieldToColumnLayout(f: FieldDescriptor): ColumnLayout {
  // (precondition: f.ctor !== null — object fields are filtered out before this is called, §2.3 step 4)
  const element: ElementKind = elementKindOf(f.ctor);   // ctor -> 'u8'|'i8'|...|'f64' (memory-buffers.md §3.1)
  return {
    element,
    stride: f.stride,                                   // 1 for scalar/staticString/eid; N for vec
    elementBytes: f.bytesPerElem,
    rowBytes: f.stride * f.bytesPerElem,
  };
}
```

- `elementKindOf(ctor)` maps the `TypedArrayCtor` (type-system.md §1.4) to the memory-buffers `ElementKind`
  string (`Int8Array → 'i8'`, `Float32Array → 'f32'`, `Uint8ClampedArray → 'u8'` since memory-buffers has
  no clamped kind — the clamp is applied at `encode`, the storage element is plain `u8`). This is the ONE
  place the `Uint8ClampedArray` token degrades to a `u8` *storage* element while preserving clamp semantics
  in `encode` (§3.1 table). Documented divergence, lossless (clamp is an input transform).
- `columnLayouts` is parallel to the **column-backed subset** of `fields` (object fields omitted). Storage's
  `buildColumnSet` (archetype-storage.md §3.7) calls `Buffers.column(columnKey(arch.id, def.id, fieldIndex),
  layout, capacity)` once per layout. `fieldIndex` is the index **within the column-backed subset** —
  matching archetype-storage.md §3.7's `def.fields.map((f, fieldIndex) => ...)`; to keep that mapping exact,
  this module guarantees object fields are absent from `def.fields` is **false** (object fields ARE in
  `def.fields` for the accessor to know about them) — so the column key uses the field's **position in the
  full `fields` array**, and `Buffers.column` is simply skipped (not called) for object fields. The
  `fieldIndex` therefore matches the full-array index, and the column registry has gaps for object fields
  (no key collision, since object fields register no column). This is consistent with archetype-storage.md
  §3.7's loop, which maps over `def.fields` and would call `Buffers.column` per field; this module's
  contract is that storage **must skip** fields with `ctor === null` (object) — the loop guards on
  `f.layout` presence.

> **Resolved ambiguity (column key indexing).** `ColumnKey = ${archetypeId}:${componentTypeId}.${fieldIndex}`
> (memory-buffers.md §5.2) uses `fieldIndex` = the field's index in `def.fields` (the FULL array). Object
> fields occupy an index in `def.fields` but register no column, so their index is simply unused in the
> column registry. This keeps `fieldIndex` stable and unambiguous and matches archetype-storage.md §3.7
> exactly (which iterates `def.fields` with index). The accessor (§8.2) receives one `ColumnBinding` per
> **column-backed** field; for object fields it receives a JS-array binding instead (memory-buffers.md §3.8).

### 8.2 `wireAccessorFactory` (schema → `AccessorFactory<S>`)

After `id` assignment (§7.2/§7.3), this module builds the closure factory that satisfies
`AccessorFactory<S>` (type-system.md §9). The factory is a **parameterised closure**, NOT codegen
(decision #4/#6; report §2.2 "a parameterised closure … never re-emitted as source"). This module
authors the **factory shell** (the loop that builds per-field getter/setter descriptors from the
resolved `FieldDescriptor`s); the accessor module supplies the per-field getter/setter *implementations*
keyed by token. The split is: *this module knows the schema; the accessor module knows how to read/write
a slot*.

```ts
import type { AccessorFactory, ColumnBinding, AccessorInstance } from '@ecsia/schema';   // §9

function wireAccessorFactory<S extends Schema>(def: ComponentRuntime<S>): void {
  // captured once: the resolved field descriptors (encode/decode/stride/token) for THIS def.
  const fields = def.fields;
  def.accessorFactory = ((bindings: ReadonlyArray<ColumnBinding>) => {
    // bindings: one per COLUMN-BACKED field (length-tracking views + byteOffset + element), §9.
    // Object fields receive a JS-array binding spliced in by storage (memory-buffers.md §3.8).
    // Build a plain JS class with one accessor per field; getters/setters close over the binding's
    // view and the field's encode/decode + stride. ONE hidden class per (archetype, component).
    return buildAccessorClass(fields, bindings);   // accessor-module-owned body; satisfies §9 contract
  }) as AccessorFactory<S>;
}
```

- **One hidden class per `(archetype, component)`** (I-ACC-1, type-system.md §9): `buildAccessorClass` is
  invoked once per archetype by `archetype-storage.buildColumnSet` (§3.7) with that archetype's bindings,
  producing one class; storage instantiates it once and pokes `__idx` per row (I-ACC-1).
- **Read-only shorthand / `read()` vs `write()` share the instance** (I-ACC-3, type-system.md §4.2): the
  same monomorphic instance is returned typed `Readonly` by `read()`/shorthand and mutable by `write()`.
  This module installs **no** separate read-only class and **no** setter on the shorthand — the
  read-only-ness is the *type* (type-system.md §4.2), the runtime object is identical. This is how
  Must-Fix #2 (`entity.<comp>.x` is read-only, tracked write via `entity.write(C)`) is honored without a
  second hidden class.
- **`write()` setter side effect** (I-ACC-4, type-system.md §9): each setter calls
  `world.trackWrite(handleIndex(eid), componentId, fieldIndex?)` (push to `writeLog`) for the
  `.changed` reactivity filter — the only side effect beyond the slot store. The first argument is the
  **entity index** (`handleIndex(__eid)`), matching the reactivity write-log packing (reactivity.md
  §3.1; the OWNER signature is `trackWrite(index, componentId, fieldIndex?)`); the `componentId` is
  `def.id` (now assigned); `fieldIndex` is forwarded only by field-granular setters (reactivity.md
  §6.2). This is the ONLY
  reactivity hook this module wires; the scheduler write-intent is **declared separately** (type-system.md
  §4.3; Must-Fix #2) and this module emits nothing for it.
- **`__rebind` (I-ACC-2b / Must-Fix #5):** `buildAccessorClass` also implements `__rebind(newBacking)`
  that reconstructs each captured per-field view from `(newBacking, byteOffset, element)` — the layout
  numbers the factory captured from `bindings`. On the primary resizable-SAB path `__rebind` is never
  called (views auto-widen, memory-buffers.md R-1); on the fallback path storage's
  `growFallback` calls it via the `ViewHolder` registry (memory-buffers.md §7.5). This module's contract:
  the factory MUST pass `byteOffset`+`element` through so the body can rebuild — it does (the
  `ColumnBinding` carries them, §9). The body is accessor-module-owned; this module guarantees the inputs.

- **No Proxy, no `new Function`, no decorators** (§10). `buildAccessorClass` returns a plain JS class
  literal closing over the bindings — the explicitly *permitted* factory-closure pattern (type-system.md
  §10; report §2.2).

### 8.3 Per-token getter/setter shape (informative — accessor module owns bodies)

For locality, the shape `buildAccessorClass` produces per field (the accessor module's responsibility,
shown so the descriptor contract is concrete):

| token | getter | setter (write view only) |
|---|---|---|
| scalar numeric | `return view[__idx]` | `view[__idx] = encode(v); world.trackWrite(handleIndex(eid), id)` |
| `bool` | `return view[__idx] !== 0` | `view[__idx] = v ? 1 : 0; trackWrite` |
| `eid` | `return decodeEid(view[__idx])` | `view[__idx] = encodeEid(v); trackWrite` |
| `staticString` | `return choices[view[__idx]]` | `view[__idx] = idxOf(v); trackWrite` |
| `vec(E,N)` | `return vecViewOver(view, __idx*N, N)` (a `VecView`, type-system.md §1.3) | per-axis stores + `trackWrite` |
| `object<T>` | `return jsArray[__idx]` | `jsArray[__idx] = v; trackWrite` (main-thread only) |

The getter/setter close over the *descriptor's* `encode`/`decode`/`choices` (resolved §3) and the
binding's `view`. `__idx` is poked by storage per row (archetype-storage.md §3.7). Monomorphic: the
closure captures concrete references, so V8 keeps one hidden class (decision #4; report §2.2; rejecting
the ES `Proxy` ~3-5× overhead, `becsy/src/type.ts:72-93`).

---

## 9. Concurrency & phase

| Operation | Thread | Phase | Synchronization |
|---|---|---|---|
| `defineComponent` / `defineTag` / `defineRelation` | Main (setup) | Pre-world (before `createWorld`) | None; produces a frozen world-agnostic def. |
| `resolveDescriptor` / `fieldToColumnLayout` | Main | Pre-world / setup | Pure; no allocation beyond the descriptor object. |
| `registerComponents` / `registerRelations` (id assignment) | Main only | `createWorld` (serial) | None (single-writer); the one `id` mutation per def. |
| `wireAccessorFactory` | Main only | `createWorld` (serial) | Builds the closure shell; no allocation per access. |
| `allocSyntheticComponentId` (runtime pair-id mint) | Main only | Serial (relations.md §2.2) | None; bumps `nextComponentId`; may grow sparse pair-bit region in place (relations.md §3.4). |
| Accessor getter/setter (produced by the factory) | Main or worker | Any / Wave (disjoint per scheduler) | Plain TypedArray access over SAB; setter `trackWrite` pushes to `writeLog` (reactivity owns SAB-ring safety). |

- **All schema definition and registration is main-thread / serial.** Defs are constructed before
  `createWorld` and interned at `createWorld`; workers receive the frozen `componentsById`/`relationsById`
  + the `choices` tables + the `HandleLayout` once at startup (memory-buffers.md §6.2) and never mutate
  the registry.
- **No atomics on the schema path.** Id assignment is single-writer; the factory closures are pure
  read/write of columns (the scheduler's wave fence provides disjointness — report §4 T5).
- This module makes **no SAB/AB decision** (B-1: memory-buffers.md §5.5 owns it). It emits `ColumnLayout`s;
  storage allocates.

---

## 10. Forbidden techniques (decision #6/#4) — restated for this module

Inherited from type-system.md §10; the runtime-relevant prohibitions this module obeys:

- **No `new Function()`/`eval`** (`becsy/src/component.ts:105-133`) — CSP-blocked, type-erased. The
  accessor factory is a closure, NOT generated source (§8.2).
- **No ES `Proxy`** for accessors (`becsy/src/type.ts:72-93`) — ~3-5× overhead, not worker-transferable.
  This module wires a monomorphic closure class.
- **No decorators** (`becsy/src/decorators.ts:12-26`) — `defineComponent` is a plain function call.
- **No `as unknown as S` placeholders** (`becsy/src/system.ts:218`) — defs are concrete, ids assigned
  explicitly, double-registration caught fail-fast (§7.5).
- **No `ComponentRef = any`** (`bitECS/src/core/Component.ts:21-22`) — every descriptor is typed; the
  only `any` is the deliberate `object<T>` phantom store.

Permitted (used here): **factory-closure accessor classes** (§8.2), **`const` type-parameter schema
capture** (delegated to type-system.md), **frozen plain-object defs**.

---

## 11. Invariants (testable assertions)

- **DEF-1** (zero-default). For every token except `eid`, the descriptor's `default` equals the buffer's
  zero value (`needsExplicitInit === false`); `eid`'s default is `-1` (`needsExplicitInit === true`).
  (§4.2) Test: assert `needsExplicitInit` is false for `f32`/`bool`/`staticString`/`vec` without a user
  default, true for `eid` and any user-overridden field.
- **DEF-2** (descriptor exhaustiveness). `resolveDescriptor` returns a `FieldDescriptor` with a non-null
  `ctor` for every token except `object<T>` (`ctor === null`), and `shareable === false` iff `object<T>`.
  (§3) Test: round-trip every token through `resolveDescriptor` and assert the §3.1 table.
- **DEF-3** (encode/decode round-trip). For every column-backed token, `decode(encode(v)) === v` for
  in-range `v` (modulo `f32` precision and `staticString` membership). `eid`: `decodeEid(encodeEid(h)) === h`
  and `decodeEid(-1) === null`. (§3) Test: property-based round-trip per token.
- **TAG-1** (tags have no columns). `defineTag()` yields `fields.length === 0`, `columnLayouts.length === 0`,
  `options.storage === 'sparse'`; `archetype-storage.buildColumnSet` is never called for it. (§2.6) Test:
  spy on `Buffers.column`; add a tag to an entity; assert zero column allocations for the tag's id.
- **REG-1** (deterministic ids). `registerComponents` assigns `ComponentId`s in `createWorld({components})`
  array order, densely from `FIRST_USER_COMPONENT_ID`. Two `createWorld` calls with the same `components`
  array produce identical id→def maps. (§7.2) Test: register the same array twice; assert id equality.
- **REG-2** (single-world). Registering a def with `id !== UNREGISTERED` throws `ConfigError`. (§7.5)
  Test: register a def in world A, then in world B; assert throw.
- **REG-3** (relation u16 cap). Registering the 65 536th relation throws `ConfigError` at `createWorld`,
  never wraps. (§7.3) Test: register 65 536 relations; assert throw on the last.
- **REG-4** (presence id is a fixed-stride component id). `presenceId(R)` is a dense `ComponentId <
  bmFixedBitCount`; a runtime pair id is `>= bmFixedBitCount` (sparse region). (§7.3/§7.4/§7.6) Test:
  assert `rel.presenceDef.id < registry.registeredComponentCount` and a minted pair id `>=` it.
- **REG-5** (pair ids have no def). `defOf(pairId) === undefined` for a bare (tag) pair id; storage skips
  `buildColumnSet` for it. (§7.6) Test: mint a tag pair; assert `componentsById[pairId] === undefined`.
- **EXCL-1** (exclusive presence is column-bearing). For `exclusive-column`, `rel.presenceDef.fields[0]`
  is the synthetic `eid` target (`subjectTargetFieldIndex === 0`) and `fields[1..]` are the payload
  descriptors; `presenceDef.columnLayouts.length === 1 + |payload column-backed fields|`. (§6.3) Test:
  define `ChildOf({weight:'f32'}, {exclusive:true})`; assert presence def shape.
- **OVF-1** (non-exclusive payload off the subject archetype). For `overflow-table`, `presenceDef` is
  zero-field and `overflowDef.fields === payloadDescriptors`. (§6.3/§6.5) Test: define a non-exclusive
  payload relation; assert presence def has no columns and overflow def carries the payload.
- **WIRE-1** (one hidden class, read-only shorthand shares instance). The factory produces one class per
  `(archetype, component)`; `read()`/shorthand and `write()` return the same instance, the former typed
  `Readonly`. (§8.2) Test: assert `entity.position` and `entity.write(Position)` are the same object;
  assert (type-test) `entity.position.x = 5` is a TS error and `entity.write(Position).x = 5` compiles.
- **WIRE-2** (no codegen/Proxy). The factory output is a plain class instance (`Object.getPrototypeOf` is
  a class prototype, not a `Proxy`); no `new Function` is invoked. (§8.2/§10) Test: assert
  `util.types.isProxy(accessor) === false` (Node) and a CSP `'unsafe-eval'`-free environment constructs
  accessors without throwing.

---

## 12. Complexity summary

| API | Time | Space |
|---|---|---|
| `defineComponent(schema)` | O(fieldCount) (O(\|choices\|) extra per staticString) | O(fieldCount) descriptors + layouts |
| `defineTag()` | O(1) | O(1) |
| `defineRelation(payload?)` | O(\|payload fields\|) | O(\|payload fields\|) + presence/overflow defs |
| `resolveDescriptor` | O(1) (O(\|choices\|) for staticString, once) | O(1) (O(\|choices\|) choice map) |
| `fieldToColumnLayout` | O(1) | O(1) |
| `registerComponents` | O(numComponents) | O(numComponents) registry |
| `registerRelations` | O(numRelations + Σ payload fields) | O(numRelations) + presence/overflow defs |
| `wireAccessorFactory` | O(1) (builds the shell; per-archetype invocation is O(fieldCount)) | O(1) closure |
| `allocSyntheticComponentId` | O(1) | O(1) (+ rare sparse-bit grow, relations.md) |
| `defOf` / `relationOf` | O(1) array index | 0 |
| accessor getter/setter (produced) | O(1) (O(N) for a full vec write) | 0 alloc (pooled instance) |

---

## 13. Open questions deferred (non-blocking)

- **Q-CS1** (multi-world def sharing): v1 is single-world per def (§7.5, fail-fast). A `cloneDef`/
  re-entrant id table is deferred. The common case (one world) is unaffected.
- **Q-CS2** (`sparse` storage for *rare data* components): v1 records the strategy but may map
  `sparse → packed` storage for data components (§5.2 advisory). A true entity-indexed sparse store
  (becsy `component.ts:209, 266-270`) is a later storage milestone; the API and type are already in place
  (type-inert, type-system.md §1.5).
- **Q-CS3** (`fixedString(maxBytes)`): not in v1 (memory-buffers.md §3.5). The token table (§3.1) leaves
  room; adding it is a new token row + a `vecN`-style multi-slot column, no registry change.
- **Q-CS4** (user-default validation strictness): v1 validates assignability and (dev-mode) range; whether
  to clamp vs throw on an out-of-range numeric default is a dev-ergonomics tuning knob (§4.3). v1 throws
  in dev, stores the encoded (possibly clamped) value in prod.
- **Q-CS5** (`object<T>` field on a non-`restrictedToMainThread` component): structurally a TS error
  (type-system.md §3.8); v1 also sets `def.restrictedToMainThread` (§3.8) so the scheduler can validate
  at world build. No runtime escape — an object field always restricts the component.

---

## Appendix A — Reference-library techniques: borrowed vs rejected

| Technique | Source `file:line` | ecsia decision |
|---|---|---|
| Schema-driven `defineComponent({x:'f32'})` → typed def | bitECS legacy `legacy/index.ts:167-189` | **Borrowed** (§2), typed via type-system.md inference. |
| Static strings as typed-array indices, variable-width upgrade | becsy `type.ts:566-655`, `component.ts:209, 266-270` | **Borrowed** (§3.5). |
| Entity refs as `Int32Array`, `-1` sentinel | becsy `type.ts:787-931` | **Borrowed** sentinel (§3.4); **rejected** bit-31 stale flag (liveness via `isAlive`). |
| `Type.object` non-shareable escape hatch | becsy `type.ts:1024-1082` | **Borrowed**, made structural (`restrictedToMainThread`, §3.8). |
| Sparse / packed / compact storage strategies | becsy `component.ts:179-270, 387-389` | **Borrowed** the sparse/packed split (§5); compact (singletons) deferred. |
| Branded `ComponentId`/`RelationId`, id-not-schema branding | becsy `component.ts:18`, `entity.ts:8` | **Borrowed** (§7, type-system.md §8). |
| Pair as lazily-minted synthetic component (dense id space) | bitECS `Relation.ts:69-93`, `Component.ts:232-234` | **Borrowed** the integer-encoding (§6, §7.6); **rejected** JS-object identity. |
| `exclusiveRelation` enforced at add time | bitECS `Component.ts:270-275` | **Adapted** into the column model — exclusivity is implicit in the single-target `eid` column (§6.3), stronger than add-time prior-target removal. |
| Eager Wildcard ghost components | bitECS `Component.ts:250-267` | **Rejected** (one presence def per relation type instead, §6.3). |
| `new Function()` accessor codegen | becsy `component.ts:105-133` | **Rejected** (§10); factory-closure (§8.2) instead. |
| ES `Proxy` accessors | (becsy avoids) `type.ts:72-93` | **Rejected** (§8.2/§10); monomorphic closure class. |
| Decorator schemas | becsy `decorators.ts:12-26` | **Rejected** (§10). |
| `ComponentRef = any` | bitECS `Component.ts:21-22` | **Rejected** (§3, §10); every descriptor typed. |
