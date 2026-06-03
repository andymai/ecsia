// Compile-only query DSL inference obligations (type-system.md §5/§6, queries.md §9.1). Type-checked
// standalone (see the runtime guard test that compiles this file); no assertions run.
//
// NOTE on component naming: the element prop name is `CompKey<C>` = the def's `name` LITERAL. The
// value-level `defineComponent` types `name` as `string` (it is debug-only; §2.3 documents that
// identical-schema components are structurally interchangeable), so distinct-typed-prop inference is
// pinned here over hand-typed ComponentDefs whose `name` IS a literal — exactly the type machinery
// the schema builder would feed once name-literal capture lands. The arity cap + LooseQueryElement
// degradation + the read/write/optional fold are the load-bearing M4 obligations.

import type {
  ComponentDef,
  EntityHandle,
  LooseQueryElement,
  Query,
  QueryElement,
  ReadOf,
  WriteOf,
  Has,
  HasWrite,
  ReadTerm,
  WriteTerm,
  WithTerm,
  OptionalTerm,
  WorldQuery,
} from '@ecsia/core'
import { read, write, With, Without, optional, defineComponent } from '@ecsia/core'

// Hand-typed defs with LITERAL names so CompKey yields distinct element keys.
declare const Position: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'position' }
declare const Velocity: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'velocity' }
declare const Health: ComponentDef<{ current: 'i32' }> & { name: 'health' }
declare const Alive: ComponentDef<Record<never, never>> & { name: 'alive' }

// §5.3 the fold: read → Readonly prop; write → mutable prop; With → no prop; optional → | undefined.
type Terms = [
  ReadTerm<typeof Position>,
  WriteTerm<typeof Velocity>,
  WithTerm<typeof Alive>,
  OptionalTerm<typeof Health>,
]
declare const e: QueryElement<Terms> & { handle: EntityHandle }

export const _read: Readonly<{ x: number; y: number }> = e.position // read → Readonly view
e.velocity.x = 1 // write → mutable
export const _handle: EntityHandle = e.handle
// @ts-expect-error read term yields a Readonly view; assignment is a compile error
e.position.x = 5
export const _opt: ReadOf<typeof Health> | undefined = e.health // optional → ReadOf | undefined
// @ts-expect-error 'alive' does not exist on the element (With is membership-only)
e.alive

// individual contributions are well-typed.
export const _ro: ReadOf<typeof Position> = { x: 0, y: 0 } as Readonly<{ x: number; y: number }>
export const _wo: WriteOf<typeof Velocity> = { x: 0, y: 0 }

// the runtime constructors stay value-level callable (terms drive matching regardless of arity).
const _t1 = read(Position)
const _t2 = write(Velocity)
const _t3 = With(Alive)
const _t4 = Without(Health)
const _t5 = optional(Health)
void [_t1, _t2, _t3, _t4, _t5]

// §6 arity cap: an 8-term query is fully inferred; the element exposes `handle`.
declare const w: { query: WorldQuery }
const realPos = defineComponent({ x: 'f32' }, { name: 'p' })
const q8 = w.query(
  read(realPos),
  read(realPos),
  read(realPos),
  read(realPos),
  With(realPos),
  With(realPos),
  Without(realPos),
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
