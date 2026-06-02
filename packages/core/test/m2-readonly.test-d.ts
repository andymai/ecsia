// M2 type-level fixture (type-system.md §4.2 / Must-Fix #2): the bare `entity.read(C)` view and the
// `entity.<comp>` shorthand are deeply Readonly, so assigning a field is a COMPILE error (TS2540).
// `entity.write(C)` returns the mutable view, so the SAME assignment compiles.
//
// DISCRIMINATION: the guard test (m2-readonly.test.ts) compiles this file twice — once as-is (must
// type-check clean: every @ts-expect-error is a REAL error) and once with the readonly modifier
// stripped from ReadView (the @ts-expect-error lines must then become UNUSED → tsc fails). That two
// sided check is what proves the test discriminates the readonly modifier rather than any error.

import { defineComponent, vec } from '@ecsia/core'
import type { ReadOf, WriteOf } from '@ecsia/core'
import { expectTypeOf } from 'vitest'

const Position = defineComponent({ x: 'f32', y: 'f32' })

declare const r: ReadOf<typeof Position>
declare const w: WriteOf<typeof Position>

// The read view's field is read-only — assignment must be TS2540.
// @ts-expect-error read view is Readonly (Must-Fix #2)
r.x = 5

// The write view's field is mutable — the identical assignment compiles (proves the modifier, not an
// unrelated error, is what fails above). If this line errored, tsc would report it (no expect-error).
w.x = 5

// expectTypeOf pins the modifier directly (independent of the @ts-expect-error mechanism).
expectTypeOf<ReadOf<typeof Position>>().toEqualTypeOf<Readonly<{ x: number; y: number }>>()
expectTypeOf<WriteOf<typeof Position>>().toEqualTypeOf<{ x: number; y: number }>()

// A vec field's read view is a ReadonlyVecView: indexed and named-axis writes are also TS2540.
const Body = defineComponent({ v: vec('f32', 3) })
declare const rb: ReadOf<typeof Body>
declare const wb: WriteOf<typeof Body>
// @ts-expect-error read vec view axis is readonly
rb.v.x = 1
// @ts-expect-error read vec view index is readonly
rb.v[0] = 1
wb.v.x = 1 // mutable write vec view — compiles
wb.v[0] = 1

export {}
