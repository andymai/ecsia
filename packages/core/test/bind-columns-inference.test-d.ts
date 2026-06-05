// Compile-only bindColumns inference obligations. Type-checked standalone (see the runtime guard
// test that compiles this file); no assertions run.
//
// The obligations: each [ComponentDef, field] spec's view type resolves from its field token through
// the token→TypedArray table ('f32' → Float32Array, 'i32' → Int32Array, 'eid' → Int32Array, vec →
// its element array type), the factory's `views` parameter is the inferred TUPLE (positional, not a
// union), field names are constrained to the component's COLUMN-BACKED fields at the type level
// (unknown and rich fields are compile errors), meta.count is a readonly number, and the returned
// runner is zero-argument.

import type { BoundColumnsMeta, ComponentDef, Query } from '@ecsia/core'
import type { ReadTerm, WorldQuery } from '../src/internal.js'
import { defineComponent, object, read, vec3, write } from '@ecsia/core'

declare const Position: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'position' }
declare const Body: ComponentDef<{
  health: 'i32'
  flags: 'u8'
  mass: 'f64'
  target: 'eid'
  pos: { readonly kind: 'vec'; readonly elem: 'f32'; readonly len: 3 }
  label: 'string'
}> & { name: 'body' }
declare const q: Query<[ReadTerm<typeof Position>, ReadTerm<typeof Body>]>

// Token → typed-array view inference, positional through the views tuple.
const run = q.bindColumns(
  [Position, 'x'],
  [Body, 'health'],
  [Body, 'flags'],
  [Body, 'mass'],
  [Body, 'target'],
  [Body, 'pos'],
  ([px, health, flags, mass, target, pos], meta) => () => {
    const _f32: Float32Array = px
    const _i32: Int32Array = health
    const _u8: Uint8Array = flags
    const _f64: Float64Array = mass
    const _eid: Int32Array = target // eid columns store encoded indices in an Int32Array
    const _vec: Float32Array = pos // vec3('f32') → the raw element array
    const _count: number = meta.count
    void [_f32, _i32, _u8, _f64, _eid, _vec, _count]
  },
)
export const _run: () => void = run

// meta is the structural BoundColumnsMeta; count is readonly.
q.bindColumns([Position, 'x'], (_views, meta) => {
  const _meta: BoundColumnsMeta = meta
  void _meta
  // @ts-expect-error meta.count is readonly
  meta.count = 5
  return () => {}
})

// @ts-expect-error 'nope' is not a field of Position
q.bindColumns([Position, 'nope'], () => () => {})

// @ts-expect-error 'label' is a rich ('string') field — not column-backed
q.bindColumns([Body, 'label'], () => () => {})

q.bindColumns([Position, 'x'], ([px]) => () => {
  // @ts-expect-error the view is a Float32Array, not an Int32Array
  const _bad: Int32Array = px
  void _bad
})

// @ts-expect-error the runner must be zero-argument () => void, not a value
q.bindColumns([Position, 'x'], () => 42)

// REAL-DEF inference: drive an actual defineComponent call (not a hand-typed def) so the schema
// literal threads through the public builder end-to-end.
declare const w: { query: WorldQuery }
const realT = defineComponent({ pos: vec3('f32'), w: 'f32', tag: object<{ z: number }>() }, { name: 't' })
w.query(write(realT)).bindColumns([realT, 'pos'], [realT, 'w'], ([pos, ww]) => () => {
  const _p: Float32Array = pos
  const _w: Float32Array = ww
  void [_p, _w]
})
// @ts-expect-error object<T> fields carry no column
w.query(write(realT)).bindColumns([realT, 'tag'], () => () => {})

// The 9+ degraded LooseQuery surface still exposes bindColumns with the same inference.
const q9 = w.query(
  read(realT),
  read(realT),
  read(realT),
  read(realT),
  read(realT),
  read(realT),
  read(realT),
  read(realT),
  read(realT),
)
q9.bindColumns([realT, 'w'], ([ww], meta) => () => {
  const _w: Float32Array = ww
  const _n: number = meta.count
  void [_w, _n]
})
