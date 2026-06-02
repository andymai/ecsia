# ecsia Spec — Module: Type-System & Schema Inference

> Status: implementable. Foundation module. Other specs (storage, query, accessors,
> scheduler, relations) depend on the contracts defined here.
>
> Scope (LOCKED, decision #6): a TypeScript-only schema builder with full static inference,
> **no decorators, no build-time codegen, no `new Function()`/`eval`**. This module owns the
> *type-level* contracts and the *value-level token tables* that the runtime modules consume.
> It does **not** own buffer allocation (storage), accessor closure bodies (component/accessor
> module), or the scheduler — but it defines the exact types those modules must satisfy.
>
> Citations of the form `becsy/src/type.ts:72-93` and `§2.8` reference, respectively, the
> reference-library source read during research and the sections of
> `docs/research/DESIGN-RESEARCH.md`.

---

## 0. Decisions this module satisfies

| Locked decision / must-fix | Where satisfied here |
|---|---|
| #6 schema builder, full TS inference, no decorators/codegen/`new Function()` | §2 (`defineComponent`), §3 (inference machinery), §10 (forbidden techniques) |
| #2 field types incl numeric + non-numeric encodable (eid/bool/staticString) | §1 (field token table), §1.4 (encoding/layout) |
| #3 / Must-Fix #2 `entity.write(C)` is the tracked-mutation handle; `entity.<comp>` is `Readonly` | §4 (read/write handle types) |
| #6 caveat query ARITY CAP + explicit-annotation escape hatch | §5 (query result tuple inference), §6 (arity cap + escape hatch) |
| #7 relations: integer-encoded `(relationId, targetId)` pairs as members | §7 (`defineRelation`, `Pair`, relation typing) |
| #2 storage strategies sparse/packed for rare/tag components | §1.5 (storage-strategy tokens are part of the def, type-inert) |
| Branded nominal IDs (`EntityId`, `ComponentId`, …) | §8 (branded-ID contracts) |
| Accessors: monomorphic closure class, one hidden class per `(archetype,component)` | §9 (accessor *type* contract the factory must satisfy; bodies are in the accessor module) |

What this module deliberately **rejects** from the references is enumerated in §10.

---

## 1. Field type system

### 1.1 Field token table (the single source of truth)

A schema field is declared with a **field token**. Tokens are the union below. Each token maps
to (a) a backing TypedArray constructor, (b) a per-element stride in array slots, (c) an
accessor value type, and (d) an encode/decode rule. The table is the contract; the storage
module reads columns (b) and (a), the accessor module reads (c)/(d), serialization reads (d).

```ts
// @ecsia/schema — field tokens (value-level), value-typed for inference.

export type ScalarToken =
  | 'bool'
  | 'i8'  | 'u8'  | 'u8c'   // u8c = Uint8ClampedArray
  | 'i16' | 'u16'
  | 'i32' | 'u32'
  | 'f32' | 'f64'
  | 'eid';                   // entity reference, stored as i32 (-1 = null sentinel; see memory-buffers.md §3.4)

// Composite / parameterised tokens are *objects*, not strings, so their parameters
// (length, choices, T) participate in inference.
export interface VecToken<E extends ScalarToken, N extends number> {
  readonly kind: 'vec';
  readonly elem: E;          // per-axis scalar token (must be numeric)
  readonly len: N;           // axis count, a literal number for inference
}
export interface StaticStringToken<C extends readonly string[]> {
  readonly kind: 'staticString';
  readonly choices: C;       // closed enum; stored as the smallest uint index
}
export interface ObjectToken<T> {
  readonly kind: 'object';
  readonly __t?: T;          // phantom — non-shareable escape hatch (becsy Type.object)
}

export type FieldToken =
  | ScalarToken
  | VecToken<ScalarToken, number>
  | StaticStringToken<readonly string[]>
  | ObjectToken<unknown>;
```

Helper constructors keep call-sites literal-typed (the `as const`-free path):

```ts
export const vec  = <E extends ScalarToken, N extends number>(elem: E, len: N): VecToken<E, N> =>
  ({ kind: 'vec', elem, len });
export const vec2 = <E extends ScalarToken = 'f32'>(elem?: E) => vec((elem ?? 'f32') as E, 2 as const);
export const vec3 = <E extends ScalarToken = 'f32'>(elem?: E) => vec((elem ?? 'f32') as E, 3 as const);
export const staticString = <const C extends readonly string[]>(...choices: C): StaticStringToken<C> =>
  ({ kind: 'staticString', choices });
export const object = <T>(): ObjectToken<T> => ({ kind: 'object' });
```

> `vec2`/`vec3` use a **default type argument** rather than a runtime default-only, so
> `vec2()` infers `VecToken<'f32', 2>` and `vec2('i16')` infers `VecToken<'i16', 2>`. The
> `as const` on `2`/`3` is required for the literal `N` to survive inference.

### 1.2 Token → value type (the accessor element type)

```ts
// Maps a *scalar* token to its JS read/write value type.
export type ScalarValue<T extends ScalarToken> =
  T extends 'bool' ? boolean :
  T extends 'eid'  ? EntityHandle :          // branded number, §8
  number;                                     // all numeric tokens read/write as number

// Maps any field token to its full accessor value type.
export type FieldValue<F extends FieldToken> =
  F extends ScalarToken                       ? ScalarValue<F> :
  F extends VecToken<infer E, infer N>        ? VecView<E, N> :   // §1.3
  F extends StaticStringToken<infer C>        ? C[number] :        // union of the literal choices
  F extends ObjectToken<infer T>              ? T :
  never;
```

Key inference outcomes (these are the externally-observable guarantees a test in §11 pins):

- `'f32'`        → `number`
- `'bool'`       → `boolean`
- `'eid'`        → `EntityHandle`
- `vec3('f32')`  → `VecView<'f32', 3>` (an indexable fixed-length view, §1.3)
- `staticString('idle','run')` → `'idle' | 'run'`
- `object<Mesh>()` → `Mesh`

### 1.3 Vector value type

A vec field is **per-axis SoA** (one length-tracking column per axis, §2.2 of the report;
`bitECS/src/legacy/index.ts:100-101`). Its accessor value is a fixed-length indexable view,
not a JS array (no allocation on read):

```ts
export interface VecView<E extends ScalarToken, N extends number> {
  readonly length: N;
  [index: number]: ScalarValue<E>;           // bounds are runtime-checked only in dev mode
  // convenience named axes present iff N<=4:
  x: ScalarValue<E>;
  y: N extends 1 ? never : ScalarValue<E>;
  z: N extends 1 | 2 ? never : ScalarValue<E>;
  w: N extends 1 | 2 | 3 ? never : ScalarValue<E>;
}
```

The accessor module supplies the concrete monomorphic view class (one per `(archetype, vecField)`);
this module only fixes the type. The read-only variant (`ReadonlyVecView`) makes the indexer and
axes `readonly` (§4).

### 1.4 Runtime field descriptor (value-level layout contract)

For each token the schema builder produces a **field descriptor** consumed by storage. This is
the value-level bridge; it carries the layout numbers an engineer needs.

```ts
export type TypedArrayCtor =
  | Int8ArrayConstructor   | Uint8ArrayConstructor  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor  | Uint16ArrayConstructor
  | Int32ArrayConstructor  | Uint32ArrayConstructor
  | Float32ArrayConstructor| Float64ArrayConstructor;

export interface FieldDescriptor {
  readonly name: string;
  readonly token: FieldToken;
  readonly ctor: TypedArrayCtor | null;   // null iff object-token (not column-backed)
  readonly bytesPerElem: number;          // sizeof one TypedArray slot
  readonly stride: number;                // slots per row: 1 for scalar, N for vec, 1 for staticString index, 0 for object
  readonly shareable: boolean;            // false for object-token; gates worker use (§7.3 report)
  readonly encode: (v: unknown) => number;        // value → stored slot (decode is the inverse)
  readonly decode: (slot: number) => unknown;
  readonly choices?: readonly string[];   // staticString only
}
```

**Token → descriptor resolution table** (exact, exhaustive):

| token | ctor | bytesPerElem | stride | shareable | stored encoding |
|---|---|---|---|---|---|
| `bool` | `Uint8Array` | 1 | 1 | yes | `0/1` |
| `i8` | `Int8Array` | 1 | 1 | yes | identity |
| `u8` | `Uint8Array` | 1 | 1 | yes | identity |
| `u8c` | `Uint8ClampedArray` | 1 | 1 | yes | clamp 0..255 |
| `i16` | `Int16Array` | 2 | 1 | yes | identity |
| `u16` | `Uint16Array` | 2 | 1 | yes | identity |
| `i32` | `Int32Array` | 4 | 1 | yes | identity |
| `u32` | `Uint32Array` | 4 | 1 | yes | identity |
| `f32` | `Float32Array` | 4 | 1 | yes | identity |
| `f64` | `Float64Array` | 8 | 1 | yes | identity |
| `eid` | `Int32Array` | 4 | 1 | yes | full u32 handle bit-pattern in `Int32Array`; `-1` = null sentinel. NO bit-31 stale flag — staleness is resolved by handle generation at read time (memory-buffers.md §3.4) |
| `vec(E,N)` | ctor(E) | bytes(E) | `N` | yes | per-axis identity, N parallel columns |
| `staticString(C)` | smallest uint covering `len(C)` (`Uint8`/`Uint16`/`Uint32`) | 1/2/4 | 1 | yes | index into `choices` (`becsy/src/type.ts:566-655`) |
| `object<T>` | `null` | — | 0 | **no** | not column-backed; plain JS array slot, component flagged `restrictedToMainThread` |

> `eid` encoding is **owned by memory-buffers.md §3.4**, which is normative: the **full u32
> handle bit-pattern** (index ⊕ generation) is stored via `Int32Array`, with `-1` reserved as
> the null sentinel — NOT just the index portion, and there is **no** parallel generation
> column. Staleness is resolved at read time by `world.isAlive(handle)` (entity-model.md §3.3),
> which the full handle (carrying its generation) makes possible without any extra storage. This
> module only fixes that `eid` reads back as a *validated* `EntityHandle` (the decode returns
> `NO_ENTITY` for a `-1` slot; consumers needing liveness call `isAlive`).

### 1.5 Storage strategy is a type-inert option

A component may declare a storage strategy (`sparse` for rare/tag, `packed` default). It does
**not** affect inferred types — it is carried on the def for the storage module
(`becsy/src/component.ts:179-270, 387-389`):

```ts
export type StorageStrategy = 'packed' | 'sparse';
export interface ComponentOptions {
  readonly storage?: StorageStrategy;     // default 'packed'; tags default to 'sparse'
  readonly maxHistory?: number;           // reactivity window; type-inert
}
```

---

## 2. `defineComponent`

### 2.1 Signature

```ts
export type Schema = Readonly<Record<string, FieldToken>>;

export interface ComponentDef<S extends Schema> {
  // Nominal brand: makes Position !== Velocity even with identical S.
  readonly __brand: unique symbol;        // see §2.3 on per-call uniqueness
  readonly schema: S;
  readonly fields: readonly FieldDescriptor[];   // resolved §1.4, in declaration order
  readonly id: ComponentId;               // assigned at world registration, -1 until then
  readonly name: string;                  // debug only
  readonly options: Required<ComponentOptions>;
  /** phantom carriers — never read at runtime, exist purely for inference */
  readonly __read?: ReadView<S>;
  readonly __write?: WriteView<S>;
}

export function defineComponent<const S extends Schema>(
  schema: S,
  options?: ComponentOptions,
): ComponentDef<S>;

// Tag component: zero fields, no columns (becsy sparse path).
export function defineTag(name?: string): ComponentDef<{}>;
```

`const S` (const type parameter) makes the literal schema object survive inference without the
caller writing `as const` — e.g. `defineComponent({ x: 'f32' })` infers `S = { x: 'f32' }`,
not `{ x: string }`.

### 2.2 Inferred views

```ts
export type ReadView<S extends Schema>  = Readonly<{ [K in keyof S]: FieldValue<S[K]> }>;
export type WriteView<S extends Schema> = { -readonly [K in keyof S]: FieldValue<S[K]> };
```

`ReadView` is what `entity.read(C)` and the `entity.<comp>` shorthand return; `WriteView` is
what `entity.write(C)` returns (§4). For a vec field, the read view's element is `ReadonlyVecView`
and the write view's is `VecView` — handled by a token-level read/write switch:

```ts
type FieldValueRW<F extends FieldToken, RW extends 'r' | 'w'> =
  F extends VecToken<infer E, infer N>
    ? (RW extends 'r' ? ReadonlyVecView<E, N> : VecView<E, N>)
    : F extends ObjectToken<infer T>
    ? (RW extends 'r' ? Readonly<T> : T)
    : FieldValue<F>;                       // scalars: same value type, container readonly-ness handled by the mapped modifier

export type ReadView<S extends Schema>  = Readonly<{ [K in keyof S]: FieldValueRW<S[K], 'r'> }>;
export type WriteView<S extends Schema> = { -readonly [K in keyof S]: FieldValueRW<S[K], 'w'> };
```

### 2.3 Branding: how `Position !== Velocity`

The `unique symbol` brand cannot be produced by a plain function return (a function's return
type is a single type, so all calls would share one brand). Two acceptable mechanisms; ecsia
uses **(A)**:

- **(A) Opaque nominal via `declare`-free phantom + name-as-evidence (chosen).** The brand is a
  structural phantom keyed by the *schema object identity is irrelevant at the type level*, so we
  brand nominally with a per-def **opaque interface alias** produced by intersecting a fresh
  `{ readonly __nominal: S }` phantom that differs whenever `S` differs, **plus** a runtime
  identity guarantee: two `defineComponent` calls return two different objects, so
  `Position === Velocity` is `false` at runtime and `ComponentId` differs. At the type level,
  components with *different* schemas are already incompatible (different `S`); components with
  *identical* schemas are intentionally **assignable** at the `ComponentDef<S>` level but are
  distinguished by their distinct `id`/object identity at runtime and by usage-site nominal
  helpers. Where strict nominal distinctness between identical-schema components is required at
  compile time, the caller supplies a brand literal:

```ts
export function defineComponent<const S extends Schema, B extends string = string>(
  schema: S, options?: ComponentOptions & { brand?: B },
): ComponentDef<S> & { readonly __nominalBrand?: B };
// const Position = defineComponent({x:'f32'}, { brand: 'Position' });
// const Anchor   = defineComponent({x:'f32'}, { brand: 'Anchor' });  // Position-incompatible
```

> Rationale: a true `unique symbol` per call is impossible without `new Function`/codegen
> (forbidden, §10). The optional `brand` literal is the zero-codegen way to get nominal
> distinctness when two components share a schema; absent it, identical-schema components are
> structurally interchangeable (an accepted, documented limitation — this matches becsy's
> branded-ID approach `becsy/src/component.ts:18`, which brands the *id*, not the schema).

### 2.4 Algorithm — `defineComponent` (value-level)

```
function defineComponent(schema, options):
  1. validate(schema):                       // throws synchronously, fail-fast
       - assert schema is a plain object, keys are valid identifiers
       - for each (name, token):
           assert isFieldToken(token)
           if token is vec: assert token.elem is numeric scalar, token.len is integer >= 1
           if token is staticString: assert choices nonempty, all distinct strings
           if token is object: mark shareable=false
  2. fields := []
     for each (name, token) in declaration order:
         desc := resolveDescriptor(name, token)   // table §1.4
         fields.push(desc)
  3. opts := { storage: options.storage ?? (fields.length==0 ? 'sparse':'packed'),
               maxHistory: options.maxHistory ?? 0 }
  4. return frozen ComponentDef {
         schema, fields, id: UNREGISTERED (-1), name, options: opts,
         __brand/__read/__write: undefined  // phantoms, never assigned a value
     }
```

`id` is mutated exactly once, at `createWorld` registration, to a dense `ComponentId`
(`0..numComponents`). Registration order is deterministic = the order in `createWorld({components})`
(report §2.8: "dependencies passed explicitly … validated at construction").

Complexity: `O(fieldCount)`. No buffer allocation here (storage allocates lazily per archetype,
report T4).

---

## 3. Schema-to-type inference machinery (the actual generics)

This is the load-bearing generic layer. It is intentionally **shallow** — every mapped type is
≤1 level of conditional nesting per field — to stay under TS instantiation-depth limits (§6).

```ts
// Extract the schema from a def.
export type SchemaOf<C> = C extends ComponentDef<infer S> ? S : never;

// The read/write element types for a single component (used by read()/write(), §4).
export type ReadOf<C>  = ReadView<SchemaOf<C>>;
export type WriteOf<C> = WriteView<SchemaOf<C>>;

// Lift a component's fields onto an entity-shaped type, keyed by a per-component key.
// Used for the entity.<comp> shorthand and for Has<...> (§5).
export type CompKey<C> = C extends { name: infer N extends string } ? N : never;
```

### 3.1 Why the design avoids depth blow-up

The failure mode (report §6.5 / §7.5; `bitECS/src/core/Component.ts:21-22`) is **N-ary tuple
inference**: instantiating one giant conditional over a tuple of 10+ components. ecsia's
machinery never does that on the hot path because:

1. `ReadView<S>`/`WriteView<S>` are **homomorphic mapped types** over the *fields of one
   component*, not over a tuple of components. Field count per component is small and bounded.
2. `read(C)`/`write(C)` resolve **one component at a time** — a single `SchemaOf<C>` lookup, no
   tuple recursion (mirrors becsy `entity.ts:237-265`, which threads `ComponentType<C>` one
   component per call — report §7.5 "becsy threads … one component at a time").
3. The only place a *tuple* of components is inferred is the `query([...])` element type (§5),
   which is where the arity cap (§6) applies.

Complexity (type-checker work): per component view = `O(fields)` instantiations; per `read`/`write`
call = `O(1)` extra. Query tuple = `O(arity)` bounded by the cap.

---

## 4. Entity handle types: `write` handle vs `read`/shorthand (Must-Fix #2)

### 4.1 The three accessor surfaces

```ts
export interface EntityView<Comps extends ComponentDef<Schema>> {
  readonly handle: EntityHandle;

  // (a) READ-ONLY shorthand — LOCKED: entity.position.x is read-only.
  //     Property name = component name; type = ReadView (deeply readonly).
  //     Mutating through it is a COMPILE error (Readonly), so no silent untracked write.
  //     [shorthand props are added by the Has<>-lifting type, §5]

  // (b) explicit read accessor — returns the same Readonly view, ergonomic for wide systems.
  read<C extends Comps>(c: C): ReadOf<C>;

  // (c) WRITE handle — LOCKED: tracked mutation goes through entity.write(C).x = 5.
  //     Returns a MUTABLE view; every setter on it pushes (eid, typeId) to writeLog (§2.7),
  //     driving the .changed reactivity filter. Returns the per-(archetype,component)
  //     accessor singleton with __idx poked (§9).
  write<C extends Comps>(c: C): WriteOf<C>;

  has<C extends Comps>(c: C): boolean;     // main-thread only (Must-Fix #1)
}
```

### 4.2 The read/shorthand vs write distinction at the type level

- **Shorthand `entity.position`** : type `ReadView<PositionSchema>` = deeply `Readonly`.
  `entity.position.x = 5` → `error TS2540: Cannot assign to 'x' because it is a read-only property`.
  This is the compile-time enforcement that closes Must-Fix #2 ("mutating it is a TS error …
  no silent un-tracked write").
- **`entity.read(C)`** : identical `ReadView`; exists so wide systems can avoid relying on the
  lifted shorthand props (which are subject to the arity cap, §6).
- **`entity.write(C)`** : `WriteView<Schema>` = mutable. The *only* surface that is assignable.

> Critical invariant: the shorthand and `read()` MUST resolve to the **same runtime accessor
> singleton** as `write()` (same `(archetype, component)` closure, §9) but **typed** `Readonly`.
> The read-only-ness is purely a type-level cast applied by `read()`/shorthand; the runtime
> object is the same monomorphic instance (no second hidden class). This keeps "one hidden class
> per (archetype, component)" (decision #4) intact.

### 4.3 Scheduler-visibility is orthogonal (Must-Fix #2)

The type system does **not** infer scheduler write-intent from `write(C)` calls (report §2.8:
"static TS setter-inference is abandoned"). Write-intent is **declared** in the system's
`{ read, write }` sets (§7.3 below / scheduler spec). `entity.write(C)` only (1) returns a
mutable view and (2) makes its setters push to `writeLog` for the `.changed` *reactivity*
filter. The two mechanisms are independent by design. This module exports the *declaration*
types but does not implement the conflict DAG.

---

## 5. Query result type inference (typed tuples from the component list)

### 5.1 Query term DSL

```ts
// Term wrappers. read/write affect the inferred element mutability and scheduler access sets.
export interface ReadTerm<C>  { readonly __term: 'read';  readonly c: C; }
export interface WriteTerm<C> { readonly __term: 'write'; readonly c: C; }
export interface WithTerm<C>  { readonly __term: 'with';  readonly c: C; }   // membership only, no accessor
export interface WithoutTerm<C> { readonly __term: 'without'; readonly c: C; }
export interface OptionalTerm<C> { readonly __term: 'optional'; readonly c: C; }

export const read  = <C>(c: C): ReadTerm<C>  => ({ __term: 'read', c });
export const write = <C>(c: C): WriteTerm<C> => ({ __term: 'write', c });
export const With    = <C>(c: C): WithTerm<C>    => ({ __term: 'with', c });
export const Without = <C>(c: C): WithoutTerm<C> => ({ __term: 'without', c });
export const optional= <C>(c: C): OptionalTerm<C>=> ({ __term: 'optional', c });

export type QueryTerm =
  | ReadTerm<unknown> | WriteTerm<unknown> | WithTerm<unknown>
  | WithoutTerm<unknown> | OptionalTerm<unknown> | ComponentDef<Schema>;  // bare def == read
```

### 5.2 Term → element-contribution mapping

Each term contributes a (keyed) property to the per-row element type. `With`/`Without` contribute
nothing to the value (membership-only). `optional` contributes a possibly-`undefined` view.

```ts
type TermElement<T> =
  T extends WriteTerm<infer C>    ? { [K in CompKey<C>]: WriteOf<C> } :
  T extends ReadTerm<infer C>     ? { [K in CompKey<C>]: ReadOf<C>  } :
  T extends OptionalTerm<infer C> ? { [K in CompKey<C>]: ReadOf<C> | undefined } :
  T extends WithTerm<infer C>     ? {} :
  T extends WithoutTerm<infer C>  ? {} :
  T extends ComponentDef<Schema>  ? { [K in CompKey<T>]: ReadOf<T> } :   // bare def == read
  {};
```

### 5.3 Tuple fold → query element type (bounded fold, NOT recursive over arbitrary depth)

The result element type is the **intersection** of each term's contribution. Intersection (not
deep recursion) keeps the instantiation shallow — TS evaluates `A & B & C` left-to-right without
building a deep conditional tree.

```ts
// Bounded, position-by-position fold. Implemented as a fixed-arity overload family
// (see §6) rather than a single variadic recursive type, to cap instantiation depth.
export type QueryElement<Terms extends readonly QueryTerm[]> =
  UnionToIntersection<{ [I in keyof Terms]: TermElement<Terms[I]> }[number]>;

type UnionToIntersection<U> =
  (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

export interface Query<Terms extends readonly QueryTerm[]> {
  readonly terms: Terms;
  each(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void;
  [Symbol.iterator](): Iterator<QueryElement<Terms> & { handle: EntityHandle }>;
}
```

Inference example (the externally-pinned guarantee, §11):

```ts
const q = world.query([read(Position), write(Velocity), With(Alive), optional(Health)]);
q.each(e => {
  e.position.x;        // number (Readonly)
  e.velocity.x = 1;    // ok (mutable, tracked)
  // e.alive            // does NOT exist (With contributes no value)
  e.health?.current;   // number | undefined
  e.handle;            // EntityHandle
});
```

### 5.4 `Has<...>` entity narrowing (for the shorthand and explicit annotations)

```ts
// Lifts component shorthand props onto an entity type. Used by the escape hatch (§6.3)
// and for the entity.<comp> read-only shorthand surface.
export type Has<C extends ComponentDef<Schema>> = { readonly [K in CompKey<C>]: ReadOf<C> };
export type HasWrite<C extends ComponentDef<Schema>> = { [K in CompKey<C>]: WriteOf<C> };

// e.g. (e: Has<typeof Position> & HasWrite<typeof Velocity> & EntityView<...>) => ...
```

This mirrors miniplex's `With<E,P>` narrowing (`miniplex/packages/core/src/core.ts:12-14,
199-205`) but driven by the schema, not a pre-declared entity interface.

---

## 6. Query arity cap + explicit-annotation escape hatch (decision #6 caveat)

### 6.1 The cap

Full positional tuple inference is supported up to **arity 8** (`MAX_QUERY_ARITY = 8`,
report §7.5 target). The cap is realised as a **fixed overload family** on `world.query`,
each overload binding `Terms` to a concrete-length tuple so TS never instantiates the variadic
`QueryElement` recursively past the cap:

```ts
interface WorldQuery {
  // 1..8 fully-inferred overloads (one shown; generate T0..T7 analogously):
  <T0 extends QueryTerm>(terms: readonly [T0]): Query<[T0]>;
  <T0 extends QueryTerm, T1 extends QueryTerm>(terms: readonly [T0, T1]): Query<[T0, T1]>;
  // ... up to 8 ...
  <T0 extends QueryTerm, /*...*/ T7 extends QueryTerm>(
    terms: readonly [T0, T1, T2, T3, T4, T5, T6, T7]): Query<[T0,T1,T2,T3,T4,T5,T6,T7]>;

  // 9+ : degraded overload. Element type collapses to a documented loose record union;
  // compile time stays bounded. Runtime is identical — only typing degrades.
  (terms: readonly QueryTerm[]): Query<readonly QueryTerm[]>;  // QueryElement → loose record
}
```

For the 9+ overload, `QueryElement<readonly QueryTerm[]>` resolves to a **non-exploding** type:

```ts
// Loose fallback element when arity > cap: every named component is present-but-loose.
export type LooseQueryElement = Readonly<Record<string, Readonly<Record<string, unknown>>>>
  & { handle: EntityHandle };
```

This is the *typed* degradation (contrast bitECS's `ComponentRef = any`,
`bitECS/src/core/Component.ts:21-22` — report §7.5 mitigation 1: "degrades to a documented
`Readonly<Record<...>>` … rather than exploding compile time").

### 6.2 Why overloads, not a recursive variadic type

A single `<const Terms extends readonly QueryTerm[]>` with a recursive `QueryElement` would force
TS to instantiate the conditional tree to the tuple's full depth at every call — the exact
instantiation-depth/multisecond-compile failure (report §7.5). Fixed-length overloads bound the
instantiation to the matched arity; the 9+ catch-all stops recursion entirely.

### 6.3 Explicit-annotation escape hatch

For systems wider than the cap (or where the user wants zero inference cost), annotate the
iteration variable directly with `Has<...>`/`HasWrite<...>` and pass `read`/`write` terms whose
*values* still drive runtime matching, but whose *type* is ignored:

```ts
// Past the cap: annotate explicitly, query terms still drive runtime matching.
world.query([read(A), read(B), /* ...12 more... */]).each(
  (e: Has<typeof A> & HasWrite<typeof B> & { handle: EntityHandle }) => {
    e.a.x;            // typed via the annotation, not via inference
    e.b.y = 1;
  }
);
```

The escape hatch is the deliberate, **typed** fallback (report §7.5 mitigation 3) — never `any`.

### 6.4 CI budget gate

A `tsc` compile-time budget fixture at the maximum supported arity is part of M11 exit
(report §5.2, §7.5 mitigation 4). This module ships the fixture under
`packages/schema/__type_tests__/arity-budget.ts`; regression in instantiation count fails CI.

---

## 7. Relation typing

### 7.1 `defineRelation`

```ts
export interface RelationDef<P extends Schema | void> {
  readonly __relationBrand: unique symbol;
  readonly id: RelationId;                 // u16, assigned at world creation
  readonly name: string;
  readonly payload: P extends Schema ? P : null;
  readonly exclusive: boolean;             // splits payload storage (Must-Fix #4)
  readonly cascade: 'none' | 'deleteSubject' | 'removeRelation';
  readonly __payloadRead?:  P extends Schema ? ReadView<P>  : never;   // phantom
  readonly __payloadWrite?: P extends Schema ? WriteView<P> : never;   // phantom
}

export interface RelationOptions {
  readonly exclusive?: boolean;            // default false
  readonly cascade?: 'none' | 'deleteSubject' | 'removeRelation';   // default 'none'
}

export function defineRelation(name?: string, opts?: RelationOptions): RelationDef<void>;
export function defineRelation<const P extends Schema>(
  payload: P, opts?: RelationOptions): RelationDef<P>;
```

### 7.2 Pair encoding and pair type

A pair `(relationId, targetEntityId)` is a synthetic `ComponentId` (report §2.6;
`bitECS/src/core/Relation.ts:69-93`). The type system exposes it as a `PairDef` so it threads
through queries identically to a component:

```ts
export interface PairDef<R extends RelationDef<Schema | void>> {
  readonly relation: R;
  readonly target: EntityHandle | typeof Wildcard;
  readonly id: ComponentId;                // synthetic, minted eagerly at addPair (report §2.6)
  // A pair carries the relation's payload schema as its read/write views:
  readonly __read?:  R extends RelationDef<infer P> ? (P extends Schema ? ReadView<P>  : {}) : {};
  readonly __write?: R extends RelationDef<infer P> ? (P extends Schema ? WriteView<P> : {}) : {};
}

export declare const Wildcard: unique symbol;

export function Pair<R extends RelationDef<Schema | void>>(
  relation: R, target: EntityHandle): PairDef<R>;
export function Pair<R extends RelationDef<Schema | void>>(
  relation: R, target: typeof Wildcard): PairDef<R>;   // wildcard → per-relation presence bit (report §2.6)
```

### 7.3 Pair value type in queries / accessors

A pair appears in `query([...])` like a component term. Its element contribution uses the
relation payload schema:

```ts
type PairValue<P extends PairDef<RelationDef<Schema | void>>, RW extends 'r'|'w'> =
  P extends PairDef<infer R>
    ? (R extends RelationDef<infer Pay>
        ? (Pay extends Schema ? (RW extends 'r' ? ReadView<Pay> : WriteView<Pay>) : {})
        : {})
    : {};

// Payload access uses the same monomorphic accessor path as components (report §2.6):
//   getPairData(item, Owns, owner).weight = 5
export interface PairAccessor<R extends RelationDef<Schema>> {
  read(): ReadView<NonNullable<R['payload']> extends Schema ? NonNullable<R['payload']> : never>;
  write(): WriteView<NonNullable<R['payload']> extends Schema ? NonNullable<R['payload']> : never>;
}
```

The *storage location* of the payload (subject column for exclusive vs pair-keyed overflow
table for non-exclusive — Must-Fix #4, report §2.6/§6.4) is invisible to the type system: both
resolve to the same `ReadView`/`WriteView` payload type. This module only fixes the type; the
relations module fixes the storage split. The `exclusive` flag on `RelationDef` is the
value-level signal that routes storage.

### 7.4 System access declaration types (consumed by scheduler)

The type system exports the *shape* of access declarations; the scheduler builds the DAG.

```ts
export interface SystemAccess<
  R extends readonly (ComponentDef<Schema> | RelationDef<Schema | void>)[],
  W extends readonly (ComponentDef<Schema> | RelationDef<Schema | void>)[],
> {
  readonly read: R;
  readonly write: W;
}
// Declaration is the contract (Must-Fix #2); not inferred from runtime writes.
```

---

## 8. Branded ID contracts

All IDs are branded `number` (`becsy/src/entity.ts:8`, `component.ts:18`, `system.ts:25` —
report §2.8). Branding is zero-cost at runtime (plain numbers) and prevents cross-assignment.

```ts
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type EntityHandle = Brand<number, 'EntityHandle'>;   // generational, §8.1
export type ComponentId  = Brand<number, 'ComponentId'>;    // dense 0..N
export type RelationId    = Brand<number, 'RelationId'>;     // dense u16 (relations.md §2.1): 0..65535.
                                                            // The u16 ceiling is a SEMANTIC constraint the
                                                            // brand cannot enforce; world creation validates
                                                            // numRelations <= 65535 and throws ConfigError on
                                                            // overflow (fail-fast, never a silent wrap).
export type SystemId      = Brand<number, 'SystemId'>;
export type ArchetypeId   = Brand<number, 'ArchetypeId'>;
export type WorldId       = Brand<number, 'WorldId'>;

/**
 * The "no entity" sentinel. There is exactly ONE conceptual null entity; it has two
 * bit-equivalent spellings depending on the storage context, and they MUST be treated as
 * the same value:
 *   - handle space (entity-model.md §2.5):  NO_ENTITY = 0xffffffff  (unsigned u32 all-ones)
 *   - eid column   (Int32Array, mem-buffers §3.4 C-2):  -1  (two's-complement of the same bits)
 * Writing NO_ENTITY into an Int32Array yields -1; reading -1 back via `>>> 0` yields
 * 0xffffffff. `NULL_ENTITY` is kept as a deprecated alias of NO_ENTITY for the eid-column
 * spelling; new code SHOULD use NO_ENTITY (the canonical handle-space sentinel, defined in
 * entity-model.md §2.5 and re-exported here).
 */
export const NO_ENTITY   = 0xffffffff as EntityHandle;      // canonical (entity-model.md §2.5)
export const NULL_ENTITY = NO_ENTITY;                       // alias; same value, eid-column spelling is -1 in an Int32Array
```

### 8.1 Generational handle bit layout (decision: configurable split, default 22/10)

The handle is a single `u32` packed as `[ generation | index ]`. Split is **configurable** at
world creation (`createWorld({ generationBits })`), default **22 index / 10 generation**
(report §2.3; `bitECS/src/core/EntityIndex.ts:31-52, 76-96`).

```
bit:  31                         10 9                     0      (default 22/10)
      +---------------------------+-----------------------+
      |   generation (10 bits)    |     index (22 bits)   |
      +---------------------------+-----------------------+
       MSB                                            LSB
```

Word size: 32 bits (one `u32` slot in a `Uint32Array`/`Int32Array` entity record column).

Default-split derived constants:

| name | value (default 22/10) | formula |
|---|---|---|
| `INDEX_BITS` | 22 | `32 - generationBits` |
| `GENERATION_BITS` | 10 | `generationBits` |
| `MAX_ENTITIES` | 4_194_304 | `2^INDEX_BITS` |
| `MAX_GENERATION` | 1024 | `2^GENERATION_BITS` |
| `INDEX_MASK` | `0x003FFFFF` | `(1 << INDEX_BITS) - 1` |
| `GENERATION_MASK` | `0xFFC00000` | `((1 << GENERATION_BITS) - 1) << INDEX_BITS` |

Pack/unpack (the canonical bit ops; no allocation):

```ts
export const makeHandle = (index: number, gen: number, indexBits = 22): EntityHandle =>
  (((gen << indexBits) | index) >>> 0) as EntityHandle;          // >>>0 keeps it u32

export const handleIndex = (h: EntityHandle, indexBits = 22): number =>
  (h & ((1 << indexBits) - 1)) >>> 0;

export const handleGeneration = (h: EntityHandle, indexBits = 22): number =>
  (h >>> indexBits) & ((1 << (32 - indexBits)) - 1);
```

> Staleness check is `dense[sparse[index]] === handle` (full-handle compare, generation
> included), per bitECS `EntityIndex.ts:104-165`. Generation-wrap time is `2^GENERATION_BITS / r`
> for per-slot recycle rate `r` (report §2.3 derivation). The split is documented as a tuning
> knob; 16/16 recommended for hours-long high-churn sims.

This module defines the *layout and the pack/unpack contract*; the entity module owns the
free-list/recycling.

---

## 9. Accessor *type* contract (the factory must satisfy this)

The accessor module produces a monomorphic closure class **per `(archetype, component)`**
(decision #4; report §2.2/§2.3). This module fixes the *type* that factory output must satisfy
so the rest of the type system can rely on it. It does **not** define the closure bodies.

```ts
// One instance per (archetype, component); __idx is poked before use (becsy binding.writableIndex
// analogue, but closure-captured columns — NOT a Proxy, NOT new Function, report §2.2/§2.3).
export interface AccessorInstance {
  __idx: number;                            // current row within the archetype's columns
}

// The factory signature the accessor module MUST export and the storage module calls once
// per (archetype, component) pair at archetype creation.
//
// It receives the per-field COLUMN BINDINGS (not bare views): each binding carries the current
// length-tracking view PLUS the layout numbers (byteOffset within the backing, ElementKind) the
// closure needs to rebuild that view on a fallback grow. The factory captures both, so the
// returned class can satisfy I-ACC-2 (primary: use the captured view, auto-widening) AND
// I-ACC-2b (fallback: rebuild views from a new backing via `__rebind`).
export interface ColumnBinding {
  view: TypedArrayLike;            // current length-tracking view (widens on primary .grow())
  readonly byteOffset: number;     // this field's offset within its backing (for fallback rebuild)
  readonly element: string;        // ElementKind, to pick the TypedArray ctor on rebuild
}

export type AccessorFactory<S extends Schema> = (
  columns: ReadonlyArray<ColumnBinding>,    // one binding per field/axis (§7.2 report)
) => new () => WriteView<S> & AccessorInstance & {
  /** Fallback-grow rebind (Must-Fix #5 / I-ACC-2b): rebuild captured views from the new backing.
   *  No-op-equivalent on the primary path (never called there — memory-buffers.md R-1). */
  __rebind(newBacking: SharedArrayBuffer | ArrayBuffer): void;
};

// Length-tracking view contract (Must-Fix #5): MUST be constructed WITHOUT a length argument
// over a resizable SAB so it widens on .grow(). Enforced by a unit test (report §6.2).
export interface TypedArrayLike {
  readonly length: number;                  // auto-tracks resizable buffer length
  [index: number]: number;
}
```

Invariants the factory output must hold (cross-checked by storage tests):

- **I-ACC-1**: exactly one hidden class per `(archetype, component)` — the returned class is
  created once at archetype creation, never re-created on `.grow()` (length-tracking views make
  regeneration unnecessary; report §6.2 primary path).
- **I-ACC-2**: getters/setters close over the **column view references**, not the buffer, so a
  resizable-SAB `.grow()` is transparent (the **primary** path — no rebind needed).
- **I-ACC-2b (fallback rebind link, Must-Fix #5).** On the non-resizable fallback path, the
  buffer identity changes (memory-buffers.md §7.5 `growFallback` allocates a new backing). The
  factory output therefore MUST also implement a `__rebind(newBacking: Backing): void` method
  (the `ViewHolder` contract, memory-buffers.md §5.1) that **reconstructs each captured per-field
  view from `newBacking`** using the per-field `byteOffset`/`element` the closure captured at
  construction (the same numbers it used to build the original views from `columns`). The factory
  thus closes over both the live view *and* enough layout (byteOffset, ElementKind) to rebuild it.
  This is the missing link V-1 → I-ACC-2 → `__rebind`: on `.grow()` over a resizable backing the
  views auto-widen (I-ACC-2, no call); on a fallback grow the accessor's `__rebind` rebuilds them
  from the new backing (I-ACC-2b). The accessor module owns the `__rebind` body; this contract
  fixes that it MUST exist and MUST rebuild from `(newBacking, byteOffset, element)`.
- **I-ACC-3**: the `read()`/shorthand `Readonly` typing (§4) is a *type-only* view over the
  same instance — no separate read-only class is constructed.
- **I-ACC-4**: a `write()` setter MUST call `world.trackWrite(handleIndex(eid), componentId,
  fieldIndex?)` (push to `writeLog`) on assignment, for the `.changed` filter (report §2.7). The
  first argument is the **entity index** (`handleIndex(__eid)`, the low handle bits — NOT the full
  handle), matching the reactivity write-log packing (reactivity.md §3.1/§3.3
  `trackWrite(index: EntityIndex, componentId, fieldIndex?)` — the OWNER signature; world.md §9.1 is
  the canonical-constant home this restates verbatim); passing the full handle would be a type error
  and would strip the generation. The optional `fieldIndex` is forwarded **only** by field-granular setters
  (`changeTrackingDefault: 'field'`, reactivity.md §6.2; serialization.md §6.3); default
  component-granular setters omit it. This is the only side effect a setter has beyond the slot store.

---

## 10. Forbidden techniques (decision #6) and what is permitted

Explicitly rejected (with citations to the rejected reference patterns):

- **Decorators** (`becsy/src/decorators.ts:12-26, 58-76`) — require `experimentalDecorators`,
  mutate prototypes via `any`, infer nothing. Rejected (report §2.8).
- **`new Function()`/`eval` codegen** (`becsy/src/component.ts:105-133`) — CSP-blocked,
  type-erased. This is the *only* thing "no codegen" forbids (report §2.8/§3 #6).
- **ES `Proxy` accessors** (avoided by becsy, `type.ts:72-93`) — disables V8 ICs (~3-5×),
  not worker-transferable. Rejected (decision #4).
- **`ComponentRef = any`** (`bitECS/src/core/Component.ts:21-22`) — total type-erasure.
  Rejected; the arity-cap *typed* degradation (§6.1) is the alternative.
- **Symbol-keyed untyped query operators** (`bitECS/src/core/Query.ts:67-91`) — illegal
  compositions compile. Rejected; terms are typed wrappers (§5.1).
- **`as unknown as S` placeholder injection** (`becsy/src/system.ts:218, 308-316`) — a property
  typed as one thing but actually a placeholder. Rejected; deps passed explicitly through
  `createWorld` and validated (report §2.8).

Explicitly **permitted** and used here (NOT codegen):

- **Factory-closure accessor classes** — a parameterised closure returning a plain JS class
  (report §2.2 "this is not code generation in the textual sense; it is a parameterised
  closure"). §9.
- **`const` type parameters** for literal schema capture (TS 5.0+), avoiding caller `as const`.
- **Homomorphic mapped types + bounded fixed-arity overloads** for inference within the depth
  budget (§3, §6).

---

## 11. Type-level test obligations (pin the contracts)

These compile-only assertions live in `packages/schema/__type_tests__/` and gate CI. They are
the externally-observable guarantees of this module.

```ts
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// Field token → value type
type _f1 = Expect<Equal<FieldValue<'f32'>, number>>;
type _f2 = Expect<Equal<FieldValue<'bool'>, boolean>>;
type _f3 = Expect<Equal<FieldValue<'eid'>, EntityHandle>>;
type _f4 = Expect<Equal<FieldValue<StaticStringToken<['idle','run']>>, 'idle' | 'run'>>;

// Read view is deeply readonly; write view is mutable
const P = defineComponent({ x: 'f32', y: 'f32' });
type _r1 = Expect<Equal<ReadOf<typeof P>, Readonly<{ x: number; y: number }>>>;
type _w1 = Expect<Equal<WriteOf<typeof P>, { x: number; y: number }>>;

// Shorthand is read-only (Must-Fix #2): assignment must be a type error
declare const e: EntityView<typeof P> & Has<typeof P>;
// @ts-expect-error  shorthand is Readonly
e.p.x = 5;
e.write(P).x = 5;        // ok — tracked write handle

// Query element inference (arity within cap)
declare const w: { query: WorldQuery };
const q = w.query([read(P), write(P)]);   // element: Readonly P props & mutable P props collapse via & (same key)
```

Negative obligation (arity cap): a `query([...])` of length 9 must compile in **bounded** time
and produce `LooseQueryElement` (not `any`, not a compile error) — checked by the M11 budget
fixture (§6.4).

---

## 12. Public exports (the API surface this module owns)

```ts
// @ecsia/schema
export { defineComponent, defineTag, defineRelation };
export { vec, vec2, vec3, staticString, object };
export { read, write, With, Without, optional, Pair, Wildcard };
export { makeHandle, handleIndex, handleGeneration, NO_ENTITY, NULL_ENTITY };
export type {
  // tokens & fields
  ScalarToken, VecToken, StaticStringToken, ObjectToken, FieldToken,
  ScalarValue, FieldValue, VecView, ReadonlyVecView, FieldDescriptor, TypedArrayCtor,
  // components
  Schema, ComponentDef, ComponentOptions, StorageStrategy,
  ReadView, WriteView, ReadOf, WriteOf, SchemaOf, CompKey, Has, HasWrite,
  // queries
  QueryTerm, ReadTerm, WriteTerm, WithTerm, WithoutTerm, OptionalTerm,
  TermElement, QueryElement, Query, WorldQuery, LooseQueryElement,
  // relations
  RelationDef, RelationOptions, PairDef, PairAccessor,
  // entity / ids
  EntityView, EntityHandle, ComponentId, RelationId, SystemId, ArchetypeId, WorldId,
  // accessor contract
  AccessorInstance, AccessorFactory, TypedArrayLike,
  // scheduler access decl
  SystemAccess,
};
export const MAX_QUERY_ARITY = 8;
```

---

## 13. Open items handed to dependent specs (non-blocking)

- **Storage spec**: consumes `FieldDescriptor` (§1.4), `AccessorFactory` (§9), `ComponentDef.id`
  assignment. Owns lazy per-archetype column allocation, length-tracking views (report §6.2).
  (The `eid` encoding — full handle bit-pattern, `-1` sentinel, no parallel generation column —
  is fixed normatively in memory-buffers.md §3.4; staleness via `isAlive`, not a stored flag.)
- **Query spec**: consumes `QueryTerm`/`QueryElement` (§5), the canonical hash (must encode pair
  IDs, report §2.4). Owns `LiveQuery`, sparse-set results, incremental maintenance.
- **Scheduler spec**: consumes `SystemAccess` (§7.4); owns the conflict DAG, waves, worker
  dispatch (declaration is the write-intent contract, Must-Fix #2).
- **Relations spec**: consumes `RelationDef`/`PairDef` (§7); owns the exclusivity payload split
  (Must-Fix #4), per-relation presence bit, back-ref index.
- **Tuning (report §8 open Qs)**: `MAX_QUERY_ARITY` exact value pending the M11 budget fixture;
  identical-schema nominal-branding policy (§2.3) — `brand` literal is the v1 answer.
```
