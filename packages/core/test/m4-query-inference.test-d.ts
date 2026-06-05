// Compile-only query DSL inference obligations (type-system.md §5/§6, queries.md §9.1). Type-checked
// standalone (see the runtime guard test that compiles this file); no assertions run.
//
// NOTE on component naming: the element prop name is `CompKey<C>` = the def's `name` LITERAL.
// Name-literal capture HAS landed: `defineComponent({...}, { name: 'p' })` returns
// `ComponentDef<S, 'p'>` (the literal threads through the `const N` param), so a REAL def produces a
// precise named element key — not a `string`-index record. The "real-def named key" block below
// drives an actual `defineComponent` call and pins that contract end-to-end (value type preserved,
// key precise, NOT any). The hand-typed literal-name defs above exercise the same machinery the
// builder now emits. The arity cap + LooseQueryElement degradation + the read/write/optional fold
// are the other load-bearing M4 obligations.

import type { ComponentDef, EntityHandle, Query, QueryElement, ReadOf, WriteOf, Has, HasWrite } from '@ecsia/core'
import type { LooseQueryElement, ReadTerm, WriteTerm, HasTerm, OptionalTerm, WorldQuery } from '../src/internal.js'
import { read, write, has, without, optional, defineComponent } from '@ecsia/core'

// Hand-typed defs with LITERAL names so CompKey yields distinct element keys.
declare const Position: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'position' }
declare const Velocity: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'velocity' }
declare const Health: ComponentDef<{ current: 'i32' }> & { name: 'health' }
declare const Alive: ComponentDef<Record<never, never>> & { name: 'alive' }

// §5.3 the fold: read → Readonly prop; write → mutable prop; has → no prop; optional → | undefined.
type Terms = [
  ReadTerm<typeof Position>,
  WriteTerm<typeof Velocity>,
  HasTerm<typeof Alive>,
  OptionalTerm<typeof Health>,
]
declare const e: QueryElement<Terms> & { handle: EntityHandle }

export const _read: Readonly<{ x: number; y: number }> = e.position // read → Readonly view
e.velocity.x = 1 // write → mutable
export const _handle: EntityHandle = e.handle
// @ts-expect-error read term yields a Readonly view; assignment is a compile error
e.position.x = 5
export const _opt: ReadOf<typeof Health> | undefined = e.health // optional → ReadOf | undefined
// @ts-expect-error 'alive' does not exist on the element (has is membership-only)
e.alive

// individual contributions are well-typed.
export const _ro: ReadOf<typeof Position> = { x: 0, y: 0 } as Readonly<{ x: number; y: number }>
export const _wo: WriteOf<typeof Velocity> = { x: 0, y: 0 }

// the runtime constructors stay value-level callable (terms drive matching regardless of arity).
const _t1 = read(Position)
const _t2 = write(Velocity)
const _t3 = has(Alive)
const _t4 = without(Health)
const _t5 = optional(Health)
void [_t1, _t2, _t3, _t4, _t5]

// ── REAL-DEF NAMED KEY (name-literal capture, type-system.md §3 CompKey / §5.2) ──────────────────
// Drive an ACTUAL `defineComponent` call (not a hand-typed literal-name def) and assert the named
// shorthand surface holds against real public-API output: the element key is the captured name
// literal ('p'/'vel'), the value type is the inferred Read/Write view (not widened, not any), and a
// bogus method is rejected (the not-any sentinel). A regression that drops name-literal capture
// collapses CompKey to `string` → `el.p` becomes a string-index access → the @ts-expect-error on the
// bogus key/method goes unused → TS2578 → the guard fails.
declare const w: { query: WorldQuery }
const realPos = defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' })
const realVel = defineComponent({ x: 'f32' }, { brand: 'vel' })
w.query(read(realPos), write(realVel)).each((el) => {
  const _px: number = el.p.x // real-def read view → precise named key, number field
  el.vel.x = 1 // real-def write view → mutable named key
  // @ts-expect-error real-def read view is Readonly; assignment is a compile error
  el.p.x = 5
  // @ts-expect-error name-literal capture makes `el.p` a PRECISE key, not a string index → no `zzz`
  el.zzz
  // @ts-expect-error the bogus method does not exist on the precise element (not any)
  el.alsoBogus()
  void _px
})

// §6 arity cap: an 8-term query is fully inferred; the element exposes `handle`.
const q8 = w.query(
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  has(realPos),
  has(realPos),
  without(realPos),
  optional(realPos),
)
q8.each((el) => {
  const _h: EntityHandle = el.handle
  void _h
})

// 9+ → degraded overload: element collapses to LooseQueryElement (typed, NOT any).
const q9 = w.query(
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
)
q9.each((el) => {
  const _loose: LooseQueryElement = el
  void _loose
})

// The escape hatch: annotate the iteration variable directly with Has/HasWrite.
w.query(read(Position), write(Velocity)).each(
  (el: Has<typeof Position> & HasWrite<typeof Velocity> & { handle: EntityHandle }) => {
    const _x: number = el.position.x
    el.velocity.y = 1
    void _x
  },
)

// A bare Query type is constructible from a term tuple.
export type _Q = Query<[ReadTerm<typeof Position>]>
