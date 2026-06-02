// @ecsia/schema — type-level field tokens + per-component inference (type-system.md §1–§4, §9).
// Type-only for the inference surface; the runtime carries only the token constructors (§1.1) so
// `vec`/`staticString`/`object` call-sites stay literal-typed. @ecsia/core consumes these; the
// dependency is one-directional (schema never imports core) to keep the graph acyclic.

// ---------------------------------------------------------------------------
// §1.1 Field token table (the single source of truth)
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

export type FieldToken =
  | ScalarToken
  | VecToken<ScalarToken, number>
  | StaticStringToken<readonly string[]>
  | ObjectToken<unknown>

// Token constructors — keep call-sites literal-typed without caller `as const` (type-system.md §1.1).
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

// ---------------------------------------------------------------------------
// §8 Branded ID contracts (zero runtime cost; prevent cross-assignment)
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
// §1.2 / §1.3 Token → value type (the accessor element type)
// ---------------------------------------------------------------------------

export type ScalarValue<T extends ScalarToken> = T extends 'bool'
  ? boolean
  : T extends 'eid'
    ? EntityHandle
    : number

// A fixed-length, indexable vec view — no allocation on read (§1.3).
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

export type FieldValue<F extends FieldToken> = F extends ScalarToken
  ? ScalarValue<F>
  : F extends VecToken<infer E, infer N>
    ? VecView<E, N>
    : F extends StaticStringToken<infer C>
      ? C[number]
      : F extends ObjectToken<infer T>
        ? T
        : never

// ---------------------------------------------------------------------------
// §1.4 Runtime field descriptor (value-level layout contract)
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
  /** false for object-token; gates worker use. */
  readonly shareable: boolean
  readonly encode: (v: unknown) => number
  readonly decode: (slot: number) => unknown
  /** staticString only. */
  readonly choices?: readonly string[]
  // Runtime-only extensions (component-schema.md §3.2 / §4): the value-level default and whether
  // a fresh row must be explicitly written (true for eid and user-overridden defaults).
  readonly default: unknown
  readonly needsExplicitInit: boolean
}

// ---------------------------------------------------------------------------
// §1.5 Storage strategy (type-inert) + §2.1 ComponentDef
// ---------------------------------------------------------------------------

export type StorageStrategy = 'packed' | 'sparse'

export interface ComponentOptions {
  readonly storage?: StorageStrategy
  readonly maxHistory?: number
}

export type Schema = Readonly<Record<string, FieldToken>>

// §2.2 inferred views. ReadView is deeply readonly; WriteView is mutable; vec/object fields switch
// their container readonly-ness through the per-token read/write fork (FieldValueRW).
type FieldValueRW<F extends FieldToken, RW extends 'r' | 'w'> = F extends VecToken<infer E, infer N>
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

export interface ComponentDef<S extends Schema> {
  readonly schema: S
  readonly fields: readonly FieldDescriptor[]
  /** Assigned at world registration; UNREGISTERED (-1) until then. */
  readonly id: ComponentId
  readonly name: string
  readonly options: Required<ComponentOptions>
  readonly __nominalBrand?: string
  /** phantom carriers — never assigned a value; exist purely for inference. */
  readonly __read?: ReadView<S>
  readonly __write?: WriteView<S>
}

// §3 inference helpers (one component at a time — no N-ary tuple recursion).
export type SchemaOf<C> = C extends ComponentDef<infer S> ? S : never
export type ReadOf<C> = ReadView<SchemaOf<C>>
export type WriteOf<C> = WriteView<SchemaOf<C>>

// ---------------------------------------------------------------------------
// §9 Accessor type contract (the factory the component module must satisfy)
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
// §8 entity sentinel + §12 misc constants
// ---------------------------------------------------------------------------

export const NO_ENTITY = 0xffffffff as EntityHandle
export const NULL_ENTITY = NO_ENTITY

export const MAX_QUERY_ARITY = 8

export const SCHEMA_PACKAGE = 'schema' as const
