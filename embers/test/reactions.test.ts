import { describe, expect, it } from 'vitest'
import { runEvents } from '../src/game/feed.js'
import {
  E_FIRE,
  E_GLASS,
  E_GUNPOWDER,
  E_ICE,
  E_LAVA,
  E_OIL,
  E_PLANT,
  E_SALT,
  E_SAND,
  E_SMOKE,
  E_STEAM,
  E_WATER,
} from '../src/sim/elements.js'
import { PART_CAP } from '../src/sim/shared.js'
import { buildSim } from '../src/sim/world.js'
import type { Sim } from '../src/sim/world.js'
import type { RecEvent } from '../src/game/codec.js'

const serial = (): Sim => buildSim({ seed: 42, threaded: false, workers: 1 })

const pour = (elem: number, x: number, y: number, r: number, from: number, ticks: number): RecEvent[] =>
  Array.from({ length: ticks }, (_, i) => ({ tick: from + i, elem, x, y, r, stroke: i === 0 }))

function count(sim: Sim, elem: number): number {
  const c = sim.cols()
  let n = 0
  for (let row = 0; row < PART_CAP; row++) if (c.elem[row] === elem) n++
  return n
}

function avgY(sim: Sim, elem: number): number {
  const c = sim.cols()
  let sum = 0
  let n = 0
  for (let row = 0; row < PART_CAP; row++) {
    if (c.elem[row] === elem) {
      sum += c.py[row]!
      n++
    }
  }
  return n === 0 ? -1 : sum / n
}

describe('element reactions', () => {
  it('sand falls under gravity', async () => {
    const sim = serial()
    await runEvents(sim, pour(E_SAND, 320, 40, 6, 0, 10), 12)
    const early = avgY(sim, E_SAND)
    await runEvents(sim, [], 90)
    expect(avgY(sim, E_SAND)).toBeGreaterThan(early + 40)
    await sim.dispose()
  })

  it('fire ignites oil into flame and smoke', async () => {
    const sim = serial()
    const evs = [...pour(E_OIL, 320, 300, 10, 0, 40), ...pour(E_FIRE, 320, 285, 6, 60, 20)]
    await runEvents(sim, evs, 160)
    expect(count(sim, E_FIRE) + count(sim, E_SMOKE)).toBeGreaterThan(5)
    await sim.dispose()
  })

  it('lava meets water → steam and glass', async () => {
    const sim = serial()
    // Pour water straight onto the lava so they touch before the superheated air flashes it away.
    const evs = [...pour(E_LAVA, 320, 330, 10, 0, 30), ...pour(E_WATER, 320, 322, 8, 34, 50)]
    await runEvents(sim, evs, 160)
    expect(count(sim, E_GLASS)).toBeGreaterThan(0)
    expect(count(sim, E_STEAM) + count(sim, E_WATER)).toBeGreaterThan(0)
    await sim.dispose()
  })

  it('fire detonates gunpowder', async () => {
    const sim = serial()
    // Fire is a gas and rises, so drop it straight onto the pile (same cells) to guarantee contact.
    const before = [...pour(E_GUNPOWDER, 320, 330, 9, 0, 40)]
    const sim2 = sim
    await runEvents(sim2, before, 42)
    const powderBefore = count(sim2, E_GUNPOWDER)
    await runEvents(sim2, pour(E_FIRE, 320, 330, 5, 42, 12), 80)
    // The magazine ignites: the pile is consumed and the blast is still burning right after.
    expect(count(sim2, E_GUNPOWDER)).toBeLessThan(powderBefore / 2)
    expect(count(sim2, E_FIRE) + count(sim2, E_SMOKE)).toBeGreaterThan(0)
    await sim.dispose()
  })

  it('salt dissolves into water and lowers its freezing point', async () => {
    const sim = serial()
    const evs = [...pour(E_WATER, 320, 330, 10, 0, 40), ...pour(E_SALT, 320, 300, 5, 60, 20)]
    await runEvents(sim, evs, 260)
    expect(count(sim, E_SALT)).toBeLessThan(8)
    const c = sim.cols()
    let salty = 0
    for (let row = 0; row < PART_CAP; row++) {
      if (c.elem[row] === E_WATER && (c.meta[row]! & 1) !== 0) salty++
    }
    expect(salty).toBeGreaterThan(0)
    await sim.dispose()
  })

  it('ice melts near fire', async () => {
    const sim = serial()
    const evs = [...pour(E_ICE, 320, 330, 8, 0, 30), ...pour(E_FIRE, 320, 310, 8, 40, 60)]
    await runEvents(sim, evs, 300)
    expect(count(sim, E_WATER) + count(sim, E_STEAM)).toBeGreaterThan(0)
    await sim.dispose()
  })

  it('plants grow into water', async () => {
    const sim = serial()
    const evs = [...pour(E_WATER, 320, 320, 9, 0, 40), ...pour(E_PLANT, 300, 330, 3, 50, 10)]
    await runEvents(sim, evs, 400)
    expect(count(sim, E_PLANT)).toBeGreaterThan(6)
    await sim.dispose()
  })
})
