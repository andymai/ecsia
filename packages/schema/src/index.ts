// @ecsia/schema — type-level field tokens + per-component inference.
// Type-only for the inference surface; the runtime carries only the token constructors so
// `vec`/`staticString`/`object` call-sites stay literal-typed. @ecsia/core consumes these; the
// dependency is one-directional (schema never imports core) to keep the graph acyclic.

// ---------------------------------------------------------------------------
// (the single source of truth)
// ---------------------------------------------------------------------------

export type ScalarToken =
  | 'bool'
  | 'i8'
  | 'u8'
  | 'u8c'
  | 'i16'
  | 'u16'
  | 'i32'
  | 'u32'
  | 'f32'
  | 'f64'
  | 'eid'

export interface VecToken<E extends ScalarToken, N extends number> {
  readonly kind: 'vec'
  readonly elem: E
  readonly len: N
}

export interface StaticStringToken<C extends readonly string[]> {
  readonly kind: 'staticString'
  readonly choices: C
}

export interface ObjectToken<T> {
  readonly kind: 'object'
  readonly __t?: T
}

// Free-form rich tokens: sidecar-backed, non-shareable, main-thread-pinned.
// `'string'` is a bare string literal token (used like 'f32') holding an arbitrary JS string; it is
// distinct from the enum-choices staticString. object<T> is the other rich kind.
export type RichToken = 'string'

// A token wrapped with a user-overridable default.
// `field('string', { default: 'x' })` or `field(object<T>(), { default: ... })`. The inner token drives
// every inference path through TokenOf; the default is consumed only at descriptor resolution.
export interface FieldSpec<F extends BaseFieldToken> {
  readonly __fieldSpec: true
  readonly token: F
  readonly default: unknown
}

export type BaseFieldToken =
  | ScalarToken
  | RichToken
  | VecToken<ScalarToken, number>
  | StaticStringToken<readonly string[]>
  | ObjectToken<unknown>

export type FieldToken = BaseFieldToken | FieldSpec<BaseFieldToken>

/** Unwrap a {@link FieldSpec} to its inner token; a bare token passes through. */
export type TokenOf<F extends FieldToken> = F extends FieldSpec<infer T> ? T : F

// Token constructors — keep call-sites literal-typed without caller `as const`.
export const vec = <E extends ScalarToken, N extends number>(elem: E, len: N): VecToken<E, N> => ({
  kind: 'vec',
  elem,
  len,
})
export const vec2 = <E extends ScalarToken = 'f32'>(elem?: E): VecToken<E, 2> =>
  vec((elem ?? 'f32') as E, 2 as const)
export const vec3 = <E extends ScalarToken = 'f32'>(elem?: E): VecToken<E, 3> =>
  vec((elem ?? 'f32') as E, 3 as const)
export const vec4 = <E extends ScalarToken = 'f32'>(elem?: E): VecToken<E, 4> =>
  vec((elem ?? 'f32') as E, 4 as const)
export const staticString = <const C extends readonly string[]>(...choices: C): StaticStringToken<C> => ({
  kind: 'staticString',
  choices,
})
export const object = <T>(): ObjectToken<T> => ({ kind: 'object' })

// Wrap any token with a user-overridable default. Additive: bare tokens still
// work unwrapped; `field(token, { default })` carries the default through to the FieldDescriptor.
export const field = <const F extends BaseFieldToken>(token: F, opts: { default: FieldValue<F> }): FieldSpec<F> => ({
  __fieldSpec: true,
  token,
  default: opts.default,
})

// ---------------------------------------------------------------------------
// (zero runtime cost; prevent cross-assignment)
// ---------------------------------------------------------------------------

declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type EntityHandle = Brand<number, 'EntityHandle'>
export type ComponentId = Brand<number, 'ComponentId'>
export type RelationId = Brand<number, 'RelationId'>
export type SystemId = Brand<number, 'SystemId'>
export type ArchetypeId = Brand<number, 'ArchetypeId'>
export type WorldId = Brand<number, 'WorldId'>
export type EntityIndex = Brand<number, 'EntityIndex'>
export type Tick = Brand<number, 'Tick'>

// ---------------------------------------------------------------------------
// / → value type (the accessor element type)
// ---------------------------------------------------------------------------

export type ScalarValue<T extends ScalarToken> = T extends 'bool'
  ? boolean
  : T extends 'eid'
    ? EntityHandle
    : number

// A fixed-length, indexable vec view — no allocation on read.
export interface VecView<E extends ScalarToken, N extends number> {
  readonly length: N
  [index: number]: ScalarValue<E>
  x: ScalarValue<E>
  y: N extends 1 ? never : ScalarValue<E>
  z: N extends 1 | 2 ? never : ScalarValue<E>
  w: N extends 1 | 2 | 3 ? never : ScalarValue<E>
}

export interface ReadonlyVecView<E extends ScalarToken, N extends number> {
  readonly length: N
  readonly [index: number]: ScalarValue<E>
  readonly x: ScalarValue<E>
  readonly y: N extends 1 ? never : ScalarValue<E>
  readonly z: N extends 1 | 2 ? never : ScalarValue<E>
  readonly w: N extends 1 | 2 | 3 ? never : ScalarValue<E>
}

export type FieldValue<F extends FieldToken> = F extends FieldSpec<infer Inner>
  ? FieldValue<Inner>
  : F extends 'string'
    ? string
    : F extends ScalarToken
      ? ScalarValue<F>
      : F extends VecToken<infer E, infer N>
        ? VecView<E, N>
        : F extends StaticStringToken<infer C>
          ? C[number]
          : F extends ObjectToken<infer T>
            ? T
            : never

// ---------------------------------------------------------------------------
// (value-level layout contract)
// ---------------------------------------------------------------------------

export type TypedArrayCtor =
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor

export interface FieldDescriptor {
  readonly name: string
  readonly token: FieldToken
  /** null iff object-token (not column-backed). */
  readonly ctor: TypedArrayCtor | null
  readonly bytesPerElem: number
  /** Slots per row: 1 scalar, N vec, 1 staticString index, 0 object. */
  readonly stride: number
  /** false for object-token AND 'string'; gates worker use. */
  readonly shareable: boolean
  /**
   * The sidecar kind for a non-column rich field; undefined for column-backed fields.
   * `ctor === null ⟺ rich !== undefined ⟺ shareable === false`.
   */
  readonly rich?: 'string' | 'object'
  readonly encode: (v: unknown) => number
  readonly decode: (slot: number) => unknown
  /** staticString only. */
  readonly choices?: readonly string[]
  // Runtime-only extensions: the value-level default and whether
  // a fresh row must be explicitly written (true for eid and user-overridden defaults).
  readonly default: unknown
  readonly needsExplicitInit: boolean
}

// ---------------------------------------------------------------------------
// (type-inert) +
// ---------------------------------------------------------------------------

export type StorageStrategy = 'packed' | 'sparse'

export interface ComponentOptions {
  readonly storage?: StorageStrategy
  readonly maxHistory?: number
}

export type Schema = Readonly<Record<string, FieldToken>>

// WriteView is mutable; vec/object fields switch
// their container readonly-ness through the per-token read/write fork (FieldValueRW).
type FieldValueRW<F extends FieldToken, RW extends 'r' | 'w'> = F extends FieldSpec<infer Inner>
  ? FieldValueRW<Inner, RW>
  : F extends VecToken<infer E, infer N>
    ? RW extends 'r'
      ? ReadonlyVecView<E, N>
      : VecView<E, N>
    : F extends ObjectToken<infer T>
      ? RW extends 'r'
        ? Readonly<T>
        : T
      : FieldValue<F>

export type ReadView<S extends Schema> = { readonly [K in keyof S]: FieldValueRW<S[K], 'r'> }
export type WriteView<S extends Schema> = { -readonly [K in keyof S]: FieldValueRW<S[K], 'w'> }

// `N` is the component's NAME LITERAL, captured by defineComponent so CompKey<C> can lift it to a
// precise element-property key. It defaults to `string` so every
// existing `ComponentDef<S>` annotation stays valid and an unbranded/inferred-name def degrades to a
// string-index element key rather than a compile error. `name` is debug-only at runtime; the
// literal lives only in the type so the named-shorthand surface (entity.position, Has<C>) is real.
export interface ComponentDef<S extends Schema, N extends string = string> {
  readonly schema: S
  readonly fields: readonly FieldDescriptor[]
  /** Assigned at world registration; UNREGISTERED (-1) until then. */
  readonly id: ComponentId
  readonly name: N
  readonly options: Required<ComponentOptions>
  readonly __nominalBrand?: string
  /** phantom carriers — never assigned a value; exist purely for inference. */
  readonly __read?: ReadView<S>
  readonly __write?: WriteView<S>
}

// (one component at a time — no N-ary tuple recursion).
export type SchemaOf<C> = C extends ComponentDef<infer S> ? S : never
export type ReadOf<C> = ReadView<SchemaOf<C>>
export type WriteOf<C> = WriteView<SchemaOf<C>>

// Value-carrying spawn (Item 8). A spawn argument is either a bare ComponentDef (membership only) or a
// `[def, values]` tuple whose value object is a partial write view inferred FROM the def's schema, so
// `world.spawnWith([Position, { x: 1, y: 2 }], Velocity)` type-checks the values against Position.
export type SpawnTuple<C extends ComponentDef<Schema> = ComponentDef<Schema>> = readonly [
  C,
  Partial<WriteView<SchemaOf<C>>>,
]
export type SpawnArg = ComponentDef<Schema> | SpawnTuple
/**
 * Per-element constraint: when an arg is a `[def, values]` tuple, re-type its value slot as the partial
 * write view of THAT def's schema so each tuple's values are checked against its own component.
 */
export type SpawnArgFor<E> = E extends readonly [infer C, unknown]
  ? C extends ComponentDef<Schema>
    ? readonly [C, Partial<WriteView<SchemaOf<C>>>]
    : E
  : E

// ---------------------------------------------------------------------------
// (the factory the component module must satisfy)
// ---------------------------------------------------------------------------

export interface AccessorInstance {
  __idx: number
}

export interface TypedArrayLike {
  readonly length: number
  [index: number]: number
}

export interface ColumnBinding {
  view: TypedArrayLike
  readonly byteOffset: number
  readonly element: string
}

export type AccessorFactory<S extends Schema> = (
  columns: ReadonlyArray<ColumnBinding>,
) => new () => WriteView<S> &
  AccessorInstance & {
    __rebind(newBacking: SharedArrayBuffer | ArrayBuffer): void
  }

// ---------------------------------------------------------------------------
// +
// ---------------------------------------------------------------------------

export const NO_ENTITY = 0xffffffff as EntityHandle
export const NULL_ENTITY = NO_ENTITY

export const MAX_QUERY_ARITY = 8

// ---------------------------------------------------------------------------
// (the relations
// RUNTIME lands at; needs only the PairDef/Wildcard/RelationDef SHAPES so a
// Pair(...) term type-checks through query([...])).
// ---------------------------------------------------------------------------

export interface RelationDef<P extends Schema | void> {
  readonly id: RelationId
  readonly name: string
  readonly payload: P extends Schema ? P : null
  readonly exclusive: boolean
  readonly cascade: 'none' | 'deleteSubject' | 'removeRelation'
  /** phantom payload carriers — never assigned a value; exist purely for inference. */
  readonly __payloadRead?: P extends Schema ? ReadView<P> : never
  readonly __payloadWrite?: P extends Schema ? WriteView<P> : never
}

export interface RelationOptions {
  readonly exclusive?: boolean
  readonly cascade?: 'none' | 'deleteSubject' | 'removeRelation'
}

/** The wildcard target sentinel: `Pair(R, Wildcard)` matches every `R`-pair via the presence bit. */
export declare const Wildcard: unique symbol
export type WildcardToken = typeof Wildcard

export interface PairDef<R extends RelationDef<Schema | void>> {
  readonly relation: R
  readonly target: EntityHandle | WildcardToken
  /** Synthetic ComponentId minted at addPair; UNREGISTERED (-1) for a query-only pair. */
  readonly id: ComponentId
  /** A pair carries its relation's payload schema as its read/write views. */
  readonly __read?: R extends RelationDef<infer P> ? (P extends Schema ? ReadView<P> : Record<never, never>) : Record<never, never>
  readonly __write?: R extends RelationDef<infer P> ? (P extends Schema ? WriteView<P> : Record<never, never>) : Record<never, never>
}

// ---------------------------------------------------------------------------
// (the typed wrappers + value-level constructors). read/write fork the
// inferred element mutability; has/without are membership-only; optional narrows to `| undefined`.
// A bare ComponentDef is treated as read.
// ---------------------------------------------------------------------------

export interface ReadTerm<C> {
  readonly __term: 'read'
  readonly c: C
}
export interface WriteTerm<C> {
  readonly __term: 'write'
  readonly c: C
}
export interface HasTerm<C> {
  readonly __term: 'has'
  readonly c: C
}
export interface WithoutTerm<C> {
  readonly __term: 'without'
  readonly c: C
}
export interface OptionalTerm<C> {
  readonly __term: 'optional'
  readonly c: C
}

export const read = <C>(c: C): ReadTerm<C> => ({ __term: 'read', c })
export const write = <C>(c: C): WriteTerm<C> => ({ __term: 'write', c })
export const has = <C>(c: C): HasTerm<C> => ({ __term: 'has', c })
export const without = <C>(c: C): WithoutTerm<C> => ({ __term: 'without', c })
export const optional = <C>(c: C): OptionalTerm<C> => ({ __term: 'optional', c })

export type QueryTerm =
  | ReadTerm<unknown>
  | WriteTerm<unknown>
  | HasTerm<unknown>
  | WithoutTerm<unknown>
  | OptionalTerm<unknown>
  | PairDef<RelationDef<Schema | void>>
  | ComponentDef<Schema>

// <...> entity narrowing (the escape hatch + the read-only shorthand surface).
export type Has<C extends ComponentDef<Schema>> = { readonly [K in CompKey<C>]: ReadOf<C> }
export type HasWrite<C extends ComponentDef<Schema>> = { [K in CompKey<C>]: WriteOf<C> }

// Lift a component's per-component key (its name) for the element property name.
export type CompKey<C> = C extends { name: infer N extends string } ? N : never

// forked by read/write.
type PairValue<P extends PairDef<RelationDef<Schema | void>>, RW extends 'r' | 'w'> = P extends PairDef<infer R>
  ? R extends RelationDef<infer Pay>
    ? Pay extends Schema
      ? RW extends 'r'
        ? ReadView<Pay>
        : WriteView<Pay>
      : Record<never, never>
    : Record<never, never>
  : Record<never, never>

// → element-contribution mapping. has/without contribute nothing (membership-only);
// optional contributes a possibly-undefined view; a Pair contributes its payload under the relation name.
export type TermElement<T> = T extends WriteTerm<infer C>
  ? { [K in CompKey<C>]: WriteOf<C> }
  : T extends ReadTerm<infer C>
    ? { [K in CompKey<C>]: ReadOf<C> }
    : T extends OptionalTerm<infer C>
      ? { [K in CompKey<C>]: ReadOf<C> | undefined }
      : T extends HasTerm<infer _C>
        ? Record<never, never>
        : T extends WithoutTerm<infer _C>
          ? Record<never, never>
          : T extends PairDef<RelationDef<Schema | void>>
            ? T extends { relation: { name: infer N extends string } }
              ? { [K in N]: PairValue<T, 'r'> }
              : Record<never, never>
            : T extends ComponentDef<Schema>
              ? { [K in CompKey<T>]: ReadOf<T> }
              : Record<never, never>

// → query element type: the INTERSECTION of each term's contribution. Intersection
// (not deep recursion) keeps instantiation shallow — TS folds A & B & C left-to-right.
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type QueryElement<Terms extends readonly QueryTerm[]> = readonly QueryTerm[] extends Terms
  ? LooseQueryElement
  : UnionToIntersection<{ [I in keyof Terms]: TermElement<Terms[I]> }[number]>

// > the cap: every named slot present-but-loose (a typed
// degradation, NEVER `any` — rejecting bitECS's ComponentRef = any).
export type LooseQueryElement = Readonly<Record<string, Readonly<Record<string, unknown>>>> & {
  handle: EntityHandle
}

// One reused chunk per matched hot archetype exposing raw SoA
// columns + a row span. The runtime class lands in @ecsia/core; this fixes the structural shape.
export interface QueryChunk {
  /** Rows in this chunk (the archetype's dense row count). Iterate `0..count`. */
  readonly count: number
  /** Dense row→EntityHandle list (row `r`'s entity is `entities[r]`). */
  readonly entities: Uint32Array
  /** The live typed column view for `def.field`. Stride-1 scalars index by row directly. */
  column<S extends Schema>(def: ComponentDef<S>, field: string): ArrayLike<number> & { [i: number]: number }
  /** Slots per row for `def.field` (1 scalar, N vec): row `r` starts at `r * stride`. */
  stride<S extends Schema>(def: ComponentDef<S>, field: string): number
}

// (runtime side lands in @ecsia/core; this fixes the typed shape).
export interface Query<Terms extends readonly QueryTerm[]> {
  readonly terms: Terms
  /** Iterate every matching entity; `e` is the pooled element (do NOT store it across iterations). */
  each(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void
  [Symbol.iterator](): Iterator<QueryElement<Terms> & { handle: EntityHandle }>
  /** Opt-in SoA fast path: one reused {@link QueryChunk} per matched hot archetype, with
   * raw typed column views + a row span. Bypasses the per-row accessor AND the reactivity write log. */
  eachChunk(fn: (chunk: QueryChunk) => void): void
  /** Flavor declarations (chainable). */
  added(): this
  removed(): this
  changed(...components: ComponentDef<Schema>[]): this
  /** Flavor result iterators (entities entered/left/changed this frame). */
  eachAdded(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void
  eachRemoved(fn: (index: number, handle: EntityHandle) => void): void
  eachChanged(fn: (e: QueryElement<Terms> & { handle: EntityHandle }) => void): void
  /** Count of currently-matching entities. O(1). */
  readonly count: number
}

// /(arity > MAX_QUERY_ARITY). Its element is the typed
// LooseQueryElement by default, but `each`/iterators are GENERIC on the element so the explicit
// escape hatch (a `(e: Has<A> & HasWrite<B>) => ...` annotation) binds `EL` from the annotation
// rather than failing against the loose record — the loose element is NOT structurally assignable to
// a precise `Has<C>`, so a non-generic `each` would reject the annotation. The default keeps the
// unannotated case typed (LooseQueryElement, never `any`); the annotation drives typing past the cap
// with zero inference cost (report ). `EL` is unconstrained so
// any user annotation is accepted; the runtime terms still drive matching regardless.
export interface LooseQuery {
  readonly terms: readonly QueryTerm[]
  each<EL = LooseQueryElement>(fn: (e: EL & { handle: EntityHandle }) => void): void
  [Symbol.iterator](): Iterator<LooseQueryElement>
  /** Opt-in SoA fast path: see {@link Query.eachChunk}. */
  eachChunk(fn: (chunk: QueryChunk) => void): void
  /** Flavor declarations (chainable). */
  added(): this
  removed(): this
  changed(...components: ComponentDef<Schema>[]): this
  eachAdded<EL = LooseQueryElement>(fn: (e: EL & { handle: EntityHandle }) => void): void
  eachRemoved(fn: (index: number, handle: EntityHandle) => void): void
  eachChanged<EL = LooseQueryElement>(fn: (e: EL & { handle: EntityHandle }) => void): void
  /** Count of currently-matching entities. O(1). */
  readonly count: number
}

// 1..8 fully inferred, 9+ → typed LooseQueryElement. Fixed-length
// overloads bound TS instantiation to the matched arity; the catch-all stops recursion entirely (the
// COMPILE-TIME budget assertion itself is — this just lands the cap + escape hatch).
export interface WorldQuery {
  <T0 extends QueryTerm>(...terms: [T0]): Query<[T0]>
  <T0 extends QueryTerm, T1 extends QueryTerm>(...terms: [T0, T1]): Query<[T0, T1]>
  <T0 extends QueryTerm, T1 extends QueryTerm, T2 extends QueryTerm>(...terms: [T0, T1, T2]): Query<[T0, T1, T2]>
  <T0 extends QueryTerm, T1 extends QueryTerm, T2 extends QueryTerm, T3 extends QueryTerm>(
    ...terms: [T0, T1, T2, T3]
  ): Query<[T0, T1, T2, T3]>
  <T0 extends QueryTerm, T1 extends QueryTerm, T2 extends QueryTerm, T3 extends QueryTerm, T4 extends QueryTerm>(
    ...terms: [T0, T1, T2, T3, T4]
  ): Query<[T0, T1, T2, T3, T4]>
  <
    T0 extends QueryTerm,
    T1 extends QueryTerm,
    T2 extends QueryTerm,
    T3 extends QueryTerm,
    T4 extends QueryTerm,
    T5 extends QueryTerm,
  >(
    ...terms: [T0, T1, T2, T3, T4, T5]
  ): Query<[T0, T1, T2, T3, T4, T5]>
  <
    T0 extends QueryTerm,
    T1 extends QueryTerm,
    T2 extends QueryTerm,
    T3 extends QueryTerm,
    T4 extends QueryTerm,
    T5 extends QueryTerm,
    T6 extends QueryTerm,
  >(
    ...terms: [T0, T1, T2, T3, T4, T5, T6]
  ): Query<[T0, T1, T2, T3, T4, T5, T6]>
  <
    T0 extends QueryTerm,
    T1 extends QueryTerm,
    T2 extends QueryTerm,
    T3 extends QueryTerm,
    T4 extends QueryTerm,
    T5 extends QueryTerm,
    T6 extends QueryTerm,
    T7 extends QueryTerm,
  >(
    ...terms: [T0, T1, T2, T3, T4, T5, T6, T7]
  ): Query<[T0, T1, T2, T3, T4, T5, T6, T7]>
  /** 9+: degraded overload — returns a LooseQuery whose element is the typed LooseQueryElement and
   * whose `each` is generic-on-element for the explicit Has/HasWrite escape hatch. Compile
   * time stays bounded: the catch-all stops the variadic fold entirely. */
  (...terms: QueryTerm[]): LooseQuery
}
