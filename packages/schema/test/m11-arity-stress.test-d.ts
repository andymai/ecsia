// M11 — type-arity stress (type-system.md §6.5 / §6, queries.md §9.1). Compile-only: this file is
// type-checked standalone by the guard test (m11-arity-stress.test.ts) under the project's strict
// flags; no assertions run. It pins the externally-observable arity contracts:
//
//   1. arities 1..8 fully infer EVERY element type (read/write/With/Without/optional + pair) — NO any.
//   2. arity 9+ degrades to a TYPED LooseQueryElement (a Readonly<Record<...>>, NEVER any).
//   3. Has<C>/HasWrite<C> are the explicit-annotation escape hatch past the cap — e.A / e.B still type.
//
// Component naming: the element prop name is CompKey<C> = the def's `name` LITERAL. defineComponent
// types `name` as `string` (debug-only; type-system.md §2.3), so distinct-typed-prop inference is
// pinned over hand-typed ComponentDefs whose `name` IS a literal — the exact machinery the schema
// builder feeds once name-literal capture lands.

import type {
  ComponentDef,
  EntityHandle,
  LooseQueryElement,
  QueryElement,
  QueryTerm,
  WorldQuery,
  Has,
  HasWrite,
  ReadOf,
  WriteOf,
  ReadTerm,
  WriteTerm,
  WithTerm,
  WithoutTerm,
  OptionalTerm,
  RelationDef,
  PairDef,
} from '@ecsia/schema'
import { read, write, With, Without, optional } from '@ecsia/schema'

// ---------------------------------------------------------------------------
// Hand-typed defs with LITERAL names so CompKey yields distinct element keys.
// ---------------------------------------------------------------------------

declare const A: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'a' }
declare const B: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'b' }
declare const C: ComponentDef<{ n: 'i32' }> & { name: 'c' }
declare const D: ComponentDef<{ flag: 'bool' }> & { name: 'd' }
declare const E: ComponentDef<{ id: 'eid' }> & { name: 'e' }
declare const F: ComponentDef<{ k: 'u32' }> & { name: 'f' }
declare const G: ComponentDef<{ v: 'f64' }> & { name: 'g' }
declare const Tag: ComponentDef<Record<never, never>> & { name: 'tag' }
declare const Owns: RelationDef<{ weight: 'f32' }> & { name: 'owns' }

declare const w: { query: WorldQuery }

// ---------------------------------------------------------------------------
// (1) EVERY term kind in ONE within-cap query — full inference, no any.
//     read → Readonly prop · write → mutable prop · With/Without → no prop ·
//     optional → ReadOf | undefined · bare def → Readonly prop · pair → payload prop.
// ---------------------------------------------------------------------------

declare const ownsPair: PairDef<typeof Owns>

type AllKinds = [
  ReadTerm<typeof A>,
  WriteTerm<typeof B>,
  WithTerm<typeof Tag>,
  WithoutTerm<typeof C>,
  OptionalTerm<typeof D>,
  typeof E, // bare def == read
  PairDef<typeof Owns>,
]
declare const e: QueryElement<AllKinds> & { handle: EntityHandle }

export const _read: Readonly<{ x: number; y: number }> = e.a // read → Readonly view
e.b.x = 1 // write → mutable
// @ts-expect-error read term yields a Readonly view; assignment is a compile error
e.a.x = 5
export const _opt: ReadOf<typeof D> | undefined = e.d // optional → ReadOf | undefined
export const _bare: Readonly<{ id: EntityHandle }> = e.e // bare def == read (Readonly)
export const _pairWeight: number = e.owns.weight // pair → payload, read view
// @ts-expect-error 'tag' is membership-only (With contributes no value)
e.tag
// @ts-expect-error 'c' is excluded (Without contributes no value)
e.c
export const _handle: EntityHandle = e.handle

// individual contributions are well-typed (no any leaks).
export const _ro: ReadOf<typeof A> = { x: 0, y: 0 } as Readonly<{ x: number; y: number }>
export const _wo: WriteOf<typeof B> = { x: 0, y: 0 }
void ownsPair

// ---------------------------------------------------------------------------
// (1b) MATRIX — EVERY arity 1..8 fully infers through the WorldQuery overload family. Each row
//      asserts the EXACT value type of every inferred element prop (a wrong/widened/any inference
//      makes the `const _x: number = ...` assignment fail) AND carries a not-any sentinel: a bogus
//      method call under @ts-expect-error. `any` would swallow the bogus call → the directive goes
//      unused → TS2578 → the guard test fails. So an arity-k row FAILS if inference broke at k.
//      The components A..G carry DISTINCT field value types (f32→number, eid→EntityHandle, bool via
//      ReadOf<D>, etc.) so each row pins a real value type, not just structural presence.
// ---------------------------------------------------------------------------

// arity 1
w.query(read(A)).each((el) => {
  const _h: EntityHandle = el.handle
  const _ax: number = el.a.x
  const _ay: number = el.a.y
  // @ts-expect-error arity-1 element is precise, NOT any
  el.zzz()
  void [_h, _ax, _ay]
})

// arity 2 — read + write fork (mutable vs Readonly).
w.query(read(A), write(B)).each((el) => {
  const _ax: number = el.a.x
  el.b.x = 1 // write → mutable
  // @ts-expect-error read term yields Readonly; assignment is a compile error
  el.a.x = 5
  // @ts-expect-error arity-2 element is precise, NOT any
  el.zzz()
  void _ax
})

// arity 3 — read + write + bare def.
w.query(read(A), write(B), C).each((el) => {
  const _ax: number = el.a.x
  el.b.y = 2
  const _cn: number = el.c.n // bare def == read
  // @ts-expect-error arity-3 element is precise, NOT any
  el.zzz()
  void [_ax, _cn]
})

// arity 4 — read + write + With (membership-only) + optional.
w.query(read(A), write(B), With(Tag), optional(D)).each((el) => {
  el.b.y = 2
  const _ax: number = el.a.x
  const _dopt: ReadOf<typeof D> | undefined = el.d
  // @ts-expect-error 'tag' is membership-only (With contributes no value)
  el.tag
  // @ts-expect-error arity-4 element is precise, NOT any
  el.zzz()
  void [_ax, _dopt]
})

// arity 5 — adds Without (membership-only, excludes its prop) + eid-typed component.
w.query(read(A), write(B), With(Tag), Without(C), E).each((el) => {
  const _ax: number = el.a.x
  el.b.x = 3
  const _eid: EntityHandle = el.e.id // eid → EntityHandle, not plain number
  // @ts-expect-error 'c' is excluded (Without contributes no value)
  el.c
  // @ts-expect-error arity-5 element is precise, NOT any
  el.zzz()
  void [_ax, _eid]
})

// arity 6 — six accessor-bearing terms (read/write/bare/optional + two more reads).
w.query(read(A), write(B), C, optional(D), E, read(F)).each((el) => {
  const _ax: number = el.a.x
  el.b.y = 4
  const _cn: number = el.c.n
  const _dopt: ReadOf<typeof D> | undefined = el.d
  const _eid: EntityHandle = el.e.id
  const _fk: number = el.f.k
  // @ts-expect-error arity-6 element is precise, NOT any
  el.zzz()
  void [_ax, _cn, _dopt, _eid, _fk]
})

// arity 7 — seven terms incl. a pair payload contribution.
w.query(read(A), write(B), C, optional(D), E, read(F), ownsPair).each((el) => {
  const _ax: number = el.a.x
  el.b.x = 5
  const _fk: number = el.f.k
  const _w: number = el.owns.weight // pair → payload, read view
  // @ts-expect-error arity-7 element is precise, NOT any
  el.zzz()
  void [_ax, _fk, _w]
})

// arity 8 (MAX) — read/write/With/Without/optional + bare + pair all present.
w.query(read(A), write(B), With(Tag), Without(C), optional(D), E, F, G).each((el) => {
  const _h: EntityHandle = el.handle
  const _ax: number = el.a.x
  el.b.x = 3
  const _fk: number = el.f.k
  const _gv: number = el.g.v
  const _eid: EntityHandle = el.e.id
  const _dopt: ReadOf<typeof D> | undefined = el.d
  // @ts-expect-error 'c' is excluded at arity 8 too (Without contributes no value)
  el.c
  // @ts-expect-error arity-8 element is precise, NOT any
  el.zzz()
  void [_h, _ax, _fk, _gv, _eid, _dopt]
})

// ---------------------------------------------------------------------------
// (2) arity 9+ → typed LooseQueryElement (NEVER any). The element is assignable TO
//     LooseQueryElement (typed degradation), and a bogus method call MUST error (proves not-any).
// ---------------------------------------------------------------------------

const q9 = w.query(read(A), read(A), read(A), read(A), read(A), read(A), read(A), read(A), read(A))
q9.each((el) => {
  const _loose: LooseQueryElement = el // typed degradation: assignable to the loose record
  const _h: EntityHandle = el.handle // handle still present
  // @ts-expect-error LooseQueryElement is a typed Record, NOT any — bogus methods do not exist
  el.nonexistentMethod()
  void [_loose, _h]
})

// QueryElement over the unbounded tuple type itself resolves to the loose element (not any).
// Round-trip both directions to pin EXACT equality with LooseQueryElement (not a wider/narrower type).
export type _LooseFromUnbounded = QueryElement<readonly QueryTerm[]>
declare const _le2lqe: _LooseFromUnbounded
export const _looseEq: LooseQueryElement = _le2lqe
declare const _lqe2le: LooseQueryElement
export const _looseEqBack: _LooseFromUnbounded = _lqe2le

// ---------------------------------------------------------------------------
// (3) Escape hatch: annotate the iteration variable past the cap with Has<C> & HasWrite<C>.
//     The runtime terms still drive matching; the annotation drives typing (no inference cost).
// ---------------------------------------------------------------------------

w.query(
  read(A), read(B), read(C), read(D), read(E), read(F), read(G),
  read(A), read(B), read(C), read(D), read(E), // 12 terms — well past the cap
).each((el: Has<typeof A> & HasWrite<typeof B> & { handle: EntityHandle }) => {
  const _ax: number = el.a.x // typed via the annotation, not via inference
  el.b.y = 1 // HasWrite → mutable
  // @ts-expect-error Has<A> yields a Readonly view; assignment is a compile error
  el.a.x = 5
  const _h: EntityHandle = el.handle
  void [_ax, _h]
})

// Has/HasWrite compose for multiple components and keep each prop precisely typed.
declare const annotated: Has<typeof A> & Has<typeof C> & HasWrite<typeof B> & { handle: EntityHandle }
export const _hasA: number = annotated.a.x
export const _hasC: number = annotated.c.n
annotated.b.x = 7
// @ts-expect-error Has<C> is Readonly — assignment is a compile error
annotated.c.n = 9

// ---------------------------------------------------------------------------
// (4) READONLY-SHORTHAND carry (M2 / type-system.md §4.2, Must-Fix #2). The lifted `entity.<comp>`
//     shorthand surface (Has<C>) is deeply Readonly: assigning a field is specifically TS2540
//     ("Cannot assign to 'x' because it is a read-only property") — NOT just any error. The guard
//     test asserts this code is present, so a regression that drops the readonly modifier surfaces.
// ---------------------------------------------------------------------------

declare const shorthand: Has<typeof A>
// @ts-expect-error TS2540 — shorthand (Has<A>) is Readonly; the field assignment cannot compile
shorthand.a.x = 5
// HasWrite is the mutable counterpart — the identical assignment compiles (proves the readonly
// modifier, not an unrelated error, is what fails above).
declare const writable: HasWrite<typeof A>
writable.a.x = 5

// runtime constructors stay value-level callable (terms drive matching at any arity).
void [read(A), write(B), With(Tag), Without(C), optional(D)]
