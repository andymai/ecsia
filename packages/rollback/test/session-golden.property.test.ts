// RB-4 (re-sim equivalence) — the invariant the whole rollback feature rests on. Simulate frames
// A..K capturing every one, rewind to A, re-simulate A..K with identical inputs, and assert each
// replayed frame's image is BYTE-IDENTICAL to the original. The schedules are fuzzed over
// spawn/despawn/mutation sequences.
//
// The last two tests are the discrimination controls: the same comparison, run against a replay that
// deliberately drops an input / mis-restores the tick, MUST fail. Without them a byte-identity
// assertion that silently compared nothing would look just as green.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import type { EntityHandle } from '@ecsia/core'
import { createRollbackSurface } from '../src/index.js'
import type { RollbackImage, RollbackSurface } from '../src/index.js'
import { digest } from './image-digest.js'
import { createSim, encodeInput } from './sim.js'
import type { Sim } from './sim.js'

interface Run {
  sim: Sim
  rb: RollbackSurface
  /** Index f holds the state AFTER frame f; index 0 is the pre-simulation baseline. */
  images: RollbackImage[]
}

function startRun(frames: number): Run {
  const sim = createSim(1)
  const rb = createRollbackSurface(sim.world)
  const images: RollbackImage[] = []
  for (let f = 0; f <= frames; f++) images.push(rb.newImage())
  rb.captureImage(images[0] as RollbackImage)
  return { sim, rb, images }
}

/** Simulate `from..to` with `schedule`, checkpointing after each frame. Returns the digests. */
function simulate(run: Run, schedule: readonly Uint8Array[], from: number, to: number, skipInputAt = -1): unknown[] {
  const out: unknown[] = []
  for (let f = from; f <= to; f++) {
    if (f !== skipInputAt) run.sim.applyInput(0, schedule[f - 1] as Uint8Array)
    run.sim.step()
    run.rb.captureImage(run.images[f] as RollbackImage)
    out[f] = digest(run.images[f] as RollbackImage)
  }
  return out
}

const scheduleArb = fc.array(
  fc.record({ op: fc.integer({ min: 0, max: 3 }), value: fc.integer({ min: 0, max: 255 }) }),
  { minLength: 8, maxLength: 16 },
)

describe('@ecsia/rollback — RB-4 golden image', () => {
  test('re-simulating from a checkpoint reproduces every frame byte-identically', () => {
    fc.assert(
      fc.property(scheduleArb, fc.integer({ min: 1, max: 8 }), (ops, rewind) => {
        const schedule = ops.map((o) => encodeInput(o.op, o.value))
        const frames = schedule.length
        const a = Math.min(rewind, frames)
        const run = startRun(frames)

        const forward = simulate(run, schedule, 1, frames)
        run.rb.restoreImage(run.images[a - 1] as RollbackImage)
        const replay = simulate(run, schedule, a, frames)

        for (let f = a; f <= frames; f++) expect(replay[f]).toEqual(forward[f])
      }),
      { numRuns: 60 },
    )
  })

  test('the re-simulation also reproduces the observable state and the eid references', () => {
    const schedule = [
      encodeInput(1, 5),
      encodeInput(1, 9),
      encodeInput(3, 4),
      encodeInput(2, 0),
      encodeInput(1, 7),
      encodeInput(3, 2),
    ]
    const run = startRun(schedule.length)
    simulate(run, schedule, 1, schedule.length)
    const liveness = (): { target: number; alive: boolean }[] =>
      run.sim.actors().map((actor) => ({ target: actor.target, alive: run.sim.world.isAlive(actor.target as EntityHandle) }))
    const forwardActors = run.sim.actors()
    const forwardLiveness = liveness()
    expect(forwardActors.length).toBeGreaterThan(0)
    expect(forwardLiveness.some((l) => l.alive)).toBe(true)

    run.rb.restoreImage(run.images[2] as RollbackImage)
    simulate(run, schedule, 3, schedule.length)

    expect(run.sim.actors()).toEqual(forwardActors)
    expect(liveness()).toEqual(forwardLiveness)
  })

  test('DISCRIMINATION: dropping one input during the replay breaks byte-identity', () => {
    const schedule = [encodeInput(1, 5), encodeInput(1, 9), encodeInput(3, 4), encodeInput(1, 2), encodeInput(3, 6)]
    const run = startRun(schedule.length)
    const forward = simulate(run, schedule, 1, schedule.length)

    run.rb.restoreImage(run.images[2] as RollbackImage)
    // Frame 3 keeps the (restored) frame-2 control values instead of its own input.
    const replay = simulate(run, schedule, 3, schedule.length, 3)

    expect(replay[schedule.length]).not.toEqual(forward[schedule.length])
  })

  test('DISCRIMINATION: replaying from a mis-restored tick breaks byte-identity', () => {
    const schedule = [encodeInput(1, 5), encodeInput(1, 9), encodeInput(1, 4), encodeInput(3, 2), encodeInput(1, 6)]
    const run = startRun(schedule.length)
    const forward = simulate(run, schedule, 1, schedule.length)

    run.rb.restoreImage(run.images[2] as RollbackImage)
    run.rb.setTick(99) // the state is right, the frame counter is not — a spawn stamps world.tick into Pos.y
    const replay = simulate(run, schedule, 3, schedule.length)

    expect(replay[schedule.length]).not.toEqual(forward[schedule.length])
  })
})
