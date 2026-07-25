// Component definitions, minted fresh per world (ids assign at registration; the worker aligns by
// NAME from the bootstrap manifest, so names are the cross-thread contract).
//
// THREADING SHAPE: the air/heat field splits into BANDS horizontal bands, each with its OWN
// double-buffered component pair (fcurN / fnewN) — scheduler conflicts are component-level, so the
// stencil systems (read all fcur, write own fnew) have disjoint write-sets and share one wave, as
// do the swap systems (read own fnew, write own fcur). The particle pool is ONE hot component on
// one archetype: element changes are field writes, never migrations. MainPin carries an object<T>
// field: every serial system reads it, pinning the CA kernel and paint pass to the main thread.

import { defineComponent, object } from '@ecsia/kit'
import { BANDS } from './shared.js'

export function makeDefs() {
  const FCur = Array.from({ length: BANDS }, (_, b) =>
    defineComponent({ t: 'f32', p: 'f32', vx: 'f32', vy: 'f32' }, { name: `fcur${b}` }),
  )
  const FNew = Array.from({ length: BANDS }, (_, b) =>
    defineComponent({ t: 'f32', p: 'f32', vx: 'f32', vy: 'f32' }, { name: `fnew${b}` }),
  )
  const Particle = defineComponent(
    { elem: 'i32', px: 'i32', py: 'i32', vx: 'f32', vy: 'f32', temp: 'f32', life: 'i32', meta: 'i32' },
    { name: 'particle' },
  )
  const MainPin = defineComponent({ o: object<Record<string, never>>() }, { name: 'mainpin' })
  return { FCur, FNew, Particle, MainPin }
}

export type SimDefs = ReturnType<typeof makeDefs>
