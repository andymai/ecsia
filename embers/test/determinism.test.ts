import { describe, expect, it } from 'vitest'
import { runEvents } from '../src/game/feed.js'
import { volcanoProgram } from '../src/game/scripts.js'
import { buildSim } from '../src/sim/world.js'
import type { Sim } from '../src/sim/world.js'

const serial = (seed: number): Sim => buildSim({ seed, threaded: false, workers: 1 })

describe('determinism', () => {
  it('same seed + same strokes → identical hash and population', async () => {
    const prog = volcanoProgram()
    const a = serial(7)
    const b = serial(7)
    await runEvents(a, prog.events, 400)
    await runEvents(b, prog.events, 400)
    expect(a.live()).toBeGreaterThan(100)
    expect(a.live()).toBe(b.live())
    expect(a.hash()).toBe(b.hash())
    await a.dispose()
    await b.dispose()
  })

  it('different seed diverges under the same strokes', async () => {
    const prog = volcanoProgram()
    const a = serial(7)
    const b = serial(8)
    await runEvents(a, prog.events, 300)
    await runEvents(b, prog.events, 300)
    expect(a.hash()).not.toBe(b.hash())
    await a.dispose()
    await b.dispose()
  })

  it('hash is stable when nothing happens', async () => {
    const a = serial(1)
    await runEvents(a, [], 50)
    const h1 = a.hash()
    const h2 = a.hash()
    expect(h1).toBe(h2)
    await a.dispose()
  })
})
