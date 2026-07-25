// Component + topic definitions, minted fresh per world (ids assign at registration; the worker
// aligns by NAME from the bootstrap manifest, so names are the cross-thread contract).
//
// THREADING SHAPE: the horde splits into COHORTS cohorts, each with its OWN position/velocity
// components — scheduler conflicts are component-level, so the four steering systems have disjoint
// write-sets, share one wave, and run on up to four workers. Everything serial-only (EMeta, Player,
// Bullet, Gem, Boss) stays in components workers never declare. MainPin carries an object<T> field:
// any system that reads it is worker-INELIGIBLE and pinned to the main thread — the demo's serial
// systems all read it so the auto-threading path can never dispatch a kernel-less system.

import { defineComponent, defineTopic, object } from '@ecsia/kit'
import { COHORTS } from './shared.js'

export function makeDefs() {
  const EPos = Array.from({ length: COHORTS }, (_, c) => defineComponent({ x: 'f32', y: 'f32' }, { name: `epos${c}` }))
  const EVel = Array.from({ length: COHORTS }, (_, c) =>
    defineComponent({ vx: 'f32', vy: 'f32', phase: 'f32', agi: 'f32' }, { name: `evel${c}` }),
  )
  const EMeta = defineComponent({ hp: 'f32', kind: 'i32' }, { name: 'emeta' })
  const Player = defineComponent(
    { x: 'f32', y: 'f32', hp: 'f32', cd: 'f32', inv: 'f32', pow: 'f32', slot: 'i32' },
    { name: 'player' },
  )
  const Bullet = defineComponent({ x: 'f32', y: 'f32', vx: 'f32', vy: 'f32', ttl: 'f32', dmg: 'f32' }, { name: 'bullet' })
  const Gem = defineComponent({ x: 'f32', y: 'f32', kind: 'i32' }, { name: 'gem' })
  const Boss = defineComponent({ x: 'f32', y: 'f32', vx: 'f32', vy: 'f32', hp: 'f32', active: 'i32' }, { name: 'boss' })
  const MainPin = defineComponent({ o: object<Record<string, never>>() }, { name: 'mainpin' })
  const Beacon = defineTopic('beacon', { slot: 'i32', x: 'f32', y: 'f32', alive: 'i32' })
  return { EPos, EVel, EMeta, Player, Bullet, Gem, Boss, MainPin, Beacon }
}

export type SimDefs = ReturnType<typeof makeDefs>
