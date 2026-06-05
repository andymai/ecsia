// Compile-only query DERIVATION inference obligations. Type-checked standalone
// (see the runtime guard test that compiles this file); no assertions run.
//
// The load-bearing contracts: the derived element is the parent terms + new terms folded through
// the SAME TermElement/QueryElement machinery (read stays Readonly, write stays mutable, has
// contributes nothing, optional narrows to | undefined); chaining re-runs the fold per step;
// combined arity past MAX_QUERY_ARITY degrades to the typed LooseQuery (never any); deriving an
// already-present component upgrades read→write at the type level (the readonly/mutable view
// intersection is writable); a LooseQuery derivation stays loose.

import type { EntityHandle, LooseQuery, ReadOf } from '@ecsia/core'
import type { LooseQueryElement, WorldQuery } from '../src/internal.js'
import { read, write, has, optional, defineComponent } from '@ecsia/core'

declare const w: { query: WorldQuery }
const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32' }, { name: 'velocity' })
const Health = defineComponent({ current: 'i32' }, { name: 'health' })

// The motivating shape: derive a narrower query; the element merges parent + new contributions.
const moving = w.query(read(Velocity), write(Position))
const movingMortals = moving.derive(read(Health))
movingMortals.each((el) => {
  const _hp: number = el.health.current // new read term → bound, Readonly
  el.position.x = el.velocity.dx // parent write stays mutable, parent read readable
  const _h: EntityHandle = el.handle
  // @ts-expect-error the derived read term yields a Readonly view; assignment is a compile error
  el.health.current = 1
  // @ts-expect-error the parent's read term stays Readonly through derivation
  el.velocity.dx = 1
  void [_hp, _h]
})

// Chaining: each derive step folds the combined tuple through the same inference.
w.query(read(Position))
  .derive(write(Velocity))
  .derive(optional(Health))
  .each((el) => {
    el.velocity.dx = 1 // chained write → mutable
    const _opt: ReadOf<typeof Health> | undefined = el.health // chained optional → | undefined
    // @ts-expect-error the base read term stays Readonly through two derivations
    el.position.x = 5
    void _opt
  })

// has derives membership-only: no element prop.
w.query(read(Position))
  .derive(has(Velocity))
  .each((el) => {
    // @ts-expect-error 'velocity' does not exist on the element (has is membership-only)
    el.velocity
  })

// Deriving an already-present component with write upgrades the prop: the Readonly & mutable
// view intersection is writable (the type-level read→write upgrade).
w.query(read(Position))
  .derive(write(Position))
  .each((el) => {
    el.position.x = 1
  })

// Zero-arg derive keeps full inference (returns this query's own type, not LooseQuery).
moving.derive().each((el) => {
  el.position.x = el.velocity.dx
  // @ts-expect-error the read term stays Readonly through a zero-arg derive
  el.velocity.dx = 1
})

// Combined arity 9+ → typed LooseQuery / LooseQueryElement degradation (NOT any).
const loose = w
  .query(
    read(Position),
    read(Position),
    read(Position),
    read(Position),
    read(Position),
    read(Position),
    read(Position),
    read(Position),
  )
  .derive(read(Velocity))
const _loose: LooseQuery = loose
loose.each((el) => {
  const _el: LooseQueryElement = el
  void _el
})

// A LooseQuery derivation stays loose (runtime terms still drive matching).
const stillLoose: LooseQuery = loose.derive(read(Health))
void [_loose, stillLoose]

// Anti-any guard: if LooseQuery ever regressed to `any`, this bogus call would type-check and the
// expect-error directive itself would fail compilation.
// @ts-expect-error LooseQuery is a typed surface, not any — a bogus method must not resolve
loose.definitelyNotAQueryMethod()
