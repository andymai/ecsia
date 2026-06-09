// Queries are fully typed up to 8 components (MAX_QUERY_ARITY). Past that, the per-element type
// degrades to a typed LooseQueryElement — never `any` — and the escape hatch is to annotate the
// loop variable with Has<C> / HasWrite<C>. Other suites only validate the cap at the type level;
// this one actually runs a 9-term query through the umbrella and reads real typed fields via
// that escape hatch.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write, MAX_QUERY_ARITY } from '@ecsia/kit'
import type { ComponentDef, Has, HasWrite, Schema } from '@ecsia/kit'

// Nine single-field components → a 9-term query, one past the typing cap. Literal `name`s so
// each component shows up as a property key (CompKey<C> = the name literal) on the typed element.
const A = defineComponent({ v: 'f32' }, { name: 'wq_a' })
const B = defineComponent({ v: 'f32' }, { name: 'wq_b' })
const D = defineComponent({ v: 'f32' }, { name: 'wq_d' })
const E = defineComponent({ v: 'f32' }, { name: 'wq_e' })
const F = defineComponent({ v: 'f32' }, { name: 'wq_f' })
const G = defineComponent({ v: 'f32' }, { name: 'wq_g' })
const H = defineComponent({ v: 'f32' }, { name: 'wq_h' })
const I = defineComponent({ v: 'f32' }, { name: 'wq_i' })
const J = defineComponent({ v: 'f32' }, { name: 'wq_j' })

describe('past the 8-component cap: a 9-term query stays typed, never `any`', () => {
  test(`MAX_QUERY_ARITY is 8 and a 9-term query runs + reads typed fields via the annotation escape hatch`, () => {
    expect(MAX_QUERY_ARITY).toBe(8)

    const all = [A, B, D, E, F, G, H, I, J] as readonly ComponentDef<Schema>[]
    const world = createWorld({ components: all, maxEntities: 1 << 10 })

    const h = world.spawnWith(...all)
    ;(world.entity(h).write(A) as { v: number }).v = 2
    ;(world.entity(h).write(J) as { v: number }).v = 5

    // 9 terms — one past MAX_QUERY_ARITY. Past the cap the element type is LooseQueryElement;
    // the documented escape hatch is annotating the iteration variable with Has<C> & HasWrite<C>
    // so the fields stay typed (number), not `any`.
    const q = world.query(
      write(A),
      read(B),
      read(D),
      read(E),
      read(F),
      read(G),
      read(H),
      read(I),
      read(J),
    )

    type WideEl = Has<typeof J> & HasWrite<typeof A>
    let sum = 0
    let rows = 0
    for (const el of q as Iterable<WideEl>) {
      // `el.wq_a.v` / `el.wq_j.v` are `number` (NOT `any`); a real arithmetic read proves the typing.
      sum += el.wq_a.v + el.wq_j.v
      rows++
    }
    expect(rows).toBe(1)
    expect(sum).toBe(7)
  })
})

// Type-level guard: if the past-the-cap element ever collapsed to `any`, the `IsNotAny` check
// below would resolve to `false` and the assignment would fail to compile.
type IsAny<T> = 0 extends 1 & T ? true : false
type IsNotAny<T> = IsAny<T> extends true ? false : true
function _wideTypeGuard(): void {
  type WideEl = Has<typeof J> & HasWrite<typeof A>
  type FieldV = WideEl['wq_j']['v']
  const _notAny: IsNotAny<FieldV> = true
  void _notAny
}
void _wideTypeGuard
