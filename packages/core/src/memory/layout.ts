// Physical column layout per field type (memory-buffers.md §3). Owns the ElementKind tag, the
// ColumnLayout shape, the field-token → ColumnLayout table (eid → i32 with -1 sentinel C-2;
// staticString → smallest uint; vecN → stride n; object<T> → no column), and the normative eid
// encode/decode (§3.4).

import type { EntityHandle, FieldDescriptor, FieldToken, StaticStringToken, VecToken } from '@ecsia/schema'

export type ElementKind = 'u8' | 'u8c' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64'

export type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array

type AnyTypedArrayCtor = {
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): TypedArray
  readonly BYTES_PER_ELEMENT: number
}

const ELEMENT_CTORS: Record<ElementKind, AnyTypedArrayCtor> = {
  u8: Uint8Array,
  u8c: Uint8ClampedArray,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
}

export function elementCtor(element: ElementKind): AnyTypedArrayCtor {
  return ELEMENT_CTORS[element]
}

export function elementBytes(element: ElementKind): number {
  return ELEMENT_CTORS[element].BYTES_PER_ELEMENT
}

export interface ColumnLayout {
  readonly element: ElementKind
  /** Elements per row: 1 scalar, N vec, 1 staticString index. */
  readonly stride: number
  readonly elementBytes: number
  readonly rowBytes: number
  /**
   * The non-zero fill applied to fresh AND grown rows. `-1` for eid columns (C-2: a fresh eid row
   * is the null sentinel, never 0 which is a valid entity index). 0 for every other kind (the
   * runtime zero-inits the buffer), unless a user default makes it non-zero-equivalent.
   */
  readonly fillOnInit: number
}

export function makeColumnLayout(element: ElementKind, stride: number, fillOnInit = 0): ColumnLayout {
  const eb = elementBytes(element)
  return {
    element,
    stride,
    elementBytes: eb,
    rowBytes: eb * stride,
    fillOnInit,
  }
}

// --- §3.4 eid encode/decode (NORMATIVE) ------------------------------------
// The full u32 handle bit-pattern is stored via Int32Array; -1 is the null sentinel.

export const EID_NULL = -1

export function encodeEid(handle: EntityHandle | number): number {
  return handle | 0
}

export function decodeEid(stored: number): EntityHandle | null {
  return stored === EID_NULL ? null : ((stored >>> 0) as EntityHandle)
}

// --- §3.5 staticString width selection -------------------------------------

export function stringIndexElement(choicesLength: number): ElementKind {
  if (choicesLength <= 256) return 'u8'
  if (choicesLength <= 65_536) return 'u16'
  return 'u32'
}

// --- §3.2 the field-token → ElementKind table ------------------------------

const SCALAR_ELEMENT: Record<string, ElementKind> = {
  bool: 'u8',
  i8: 'i8',
  u8: 'u8',
  u8c: 'u8c',
  i16: 'i16',
  u16: 'u16',
  i32: 'i32',
  u32: 'u32',
  f32: 'f32',
  f64: 'f64',
  eid: 'i32',
}

function isVecToken(t: FieldToken): t is VecToken<never, number> {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'vec'
}
function isStaticStringToken(t: FieldToken): t is StaticStringToken<readonly string[]> {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'staticString'
}
function isObjectToken(t: FieldToken): boolean {
  return typeof t === 'object' && (t as { kind?: string }).kind === 'object'
}

/**
 * Project a field token to its ColumnLayout, or `null` for object tokens (§3.8 — no column, no
 * buffer). `fillOnInit` is taken from the descriptor when the field needs an explicit init (eid,
 * or a user-overridden non-zero default); otherwise 0.
 */
export function tokenToColumnLayout(token: FieldToken, fillOnInit = 0): ColumnLayout | null {
  if (typeof token === 'string') {
    if (isObjectToken(token)) return null
    // The 'string' rich token projects to no column, like object<T> (rich-fields.md §3).
    if (token === 'string') return null
    const element = SCALAR_ELEMENT[token]
    if (element === undefined) throw new Error(`unknown scalar token: ${token}`)
    return makeColumnLayout(element, 1, fillOnInit)
  }
  if (isVecToken(token)) {
    const element = SCALAR_ELEMENT[token.elem as unknown as string]
    if (element === undefined) throw new Error(`unknown vec element token: ${String(token.elem)}`)
    return makeColumnLayout(element, token.len, fillOnInit)
  }
  if (isStaticStringToken(token)) {
    return makeColumnLayout(stringIndexElement(token.choices.length), 1, fillOnInit)
  }
  // object token (the only remaining branch): no column.
  return null
}

/** Project a resolved FieldDescriptor to its ColumnLayout, or `null` for non-column-backed fields. */
export function fieldToColumnLayout(field: FieldDescriptor): ColumnLayout | null {
  if (field.ctor === null) return null
  const fill = field.needsExplicitInit ? toFillValue(field) : 0
  return tokenToColumnLayout(field.token, fill)
}

function toFillValue(field: FieldDescriptor): number {
  // The grown-tail/fresh-row fill is encoded into the column's slot space. For eid the default is
  // the null sentinel (-1); for a user-overridden scalar it is the encoded default.
  const d = field.default
  if (d === null || d === undefined) return EID_NULL
  return field.encode(d)
}
