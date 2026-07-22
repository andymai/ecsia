// RB-4 WITH RELATIONS — the same re-simulation-equivalence invariant, over a world whose archetype
// signatures are minted by the relations runtime rather than declared up front. Simulate frames
// A..K capturing every one, rewind to A, replay A..K with identical inputs, and assert each replayed
// frame's image is BYTE-IDENTICAL.
//
// This is the test that could not pass before the relations leg existed: pair membership rides
// ordinary signature bits, but the bit NUMBERS come from a monotonic synthetic-id counter and the
// maps keyed off it. The two DISCRIMINATION tests prove exactly that by sabotaging one leg at a time
// — a replay that keeps the future id counter, and one that keeps the future topology — and
// asserting the digests diverge.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createRollbackSurface } from '../src/index.js'
import type { RollbackImage, RollbackSurface } from '../src/index.js'
import { digest } from './image-digest.js'
import { createRelSim, encodeInput, OP_SPAWN, OP_CHILD_OF, OP_LIKES, OP_TAG } from './sim-relations.js'
import type { RelSim } from './sim-relations.js'

/** The two image fields the sabotage controls tamper with (see the DISCRIMINATION tests). */
interface RelationLegs {
  syntheticIdMark: number
  relations: unknown
}

interface Run {
  sim: RelSim
  rb: RollbackSurface
  /** Index f holds the state AFTER frame f; index 0 is the pre-simulation baseline. */
  images: RollbackImage[]
}

function startRun(frames: number): Run {
  const sim = createRelSim()
  const rb = createRollbackSurface(sim.world)
  const images: RollbackImage[] = []
  for (let f = 0; f <= frames; f++) images.push(rb.newImage())
  rb.captureImage(images[0] as RollbackImage)
  return { sim, rb, images }
}

function simulate(run: Run, schedule: readonly Uint8Array[], from: number, to: number): unknown[] {
  const out: unknown[] = []
  for (let f = from; f <= to; f++) {
    run.sim.applyInput(schedule[f - 1] as Uint8Array)
    run.sim.step()
    run.rb.captureImage(run.images[f] as RollbackImage)
    out[f] = digest(run.images[f] as RollbackImage)
  }
  return out
}

/** Four spawns so the fuzzed relation ops have subjects/targets to work with, then the schedule. */
const seeded = (ops: readonly { op: number; value: number }[]): Uint8Array[] => [
  encodeInput(OP_SPAWN, 3),
  encodeInput(OP_SPAWN, 7),
  encodeInput(OP_SPAWN, 11),
  encodeInput(OP_SPAWN, 19),
  ...ops.map((o) => encodeInput(o.op, o.value)),
]

const scheduleArb = fc.array(fc.record({ op: fc.integer({ min: 0, max: 8 }), value: fc.integer({ min: 0, max: 255 }) }), {
  minLength: 8,
  maxLength: 16,
})

/** A hand-built schedule that mints NEW tag/likes pair ids on every frame after the rewind point. */
const mintingSchedule: Uint8Array[] = [
  encodeInput(OP_SPAWN, 1),
  encodeInput(OP_SPAWN, 2),
  encodeInput(OP_SPAWN, 3),
  encodeInput(OP_SPAWN, 4),
  encodeInput(OP_TAG, 0),
  encodeInput(OP_LIKES, 9),
  encodeInput(OP_TAG, 18),
  encodeInput(OP_CHILD_OF, 11),
  encodeInput(OP_SPAWN, 5),
  encodeInput(OP_TAG, 36),
  encodeInput(OP_LIKES, 27),
]

describe('@ecsia/rollback — RB-4 golden image WITH relations', () => {
  test('re-simulating a pair-churning world from a checkpoint reproduces every frame byte-identically', () => {
    fc.assert(
      fc.property(scheduleArb, fc.integer({ min: 1, max: 12 }), (ops, rewind) => {
        const schedule = seeded(ops)
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

  test('the re-simulation also reproduces the observable pair topology and payloads', () => {
    const run = startRun(mintingSchedule.length)
    simulate(run, mintingSchedule, 1, mintingSchedule.length)
    const forwardPairs = run.sim.pairs()
    expect(forwardPairs.some((p) => p.tags.length > 0)).toBe(true)
    expect(forwardPairs.some((p) => p.likes.length > 0)).toBe(true)
    expect(forwardPairs.some((p) => p.parent !== -1)).toBe(true)

    run.rb.restoreImage(run.images[4] as RollbackImage)
    simulate(run, mintingSchedule, 5, mintingSchedule.length)

    expect(run.sim.pairs()).toEqual(forwardPairs)
  })

  test('DISCRIMINATION: replaying with the FUTURE synthetic-id counter breaks byte-identity', () => {
    const run = startRun(mintingSchedule.length)
    const forward = simulate(run, mintingSchedule, 1, mintingSchedule.length)

    // Everything is restored except the pair-id high-water mark, which keeps the value the forward
    // run left it at — so the replay mints the SAME logical pairs at DIFFERENT component ids.
    const baseline = run.images[4] as unknown as RelationLegs
    const stale = (run.images[mintingSchedule.length] as unknown as RelationLegs).syntheticIdMark
    const original = baseline.syntheticIdMark
    expect(stale).toBeGreaterThan(original)
    baseline.syntheticIdMark = stale
    run.rb.restoreImage(run.images[4] as RollbackImage)
    baseline.syntheticIdMark = original

    const replay = simulate(run, mintingSchedule, 5, mintingSchedule.length)
    expect(replay[mintingSchedule.length]).not.toEqual(forward[mintingSchedule.length])
  })

  test('DISCRIMINATION: replaying with the FUTURE relation topology breaks byte-identity', () => {
    const run = startRun(mintingSchedule.length)
    const forward = simulate(run, mintingSchedule, 1, mintingSchedule.length)

    // The columns and the counter rewind, but the topology handed to the leg is the LAST frame's:
    // the pair-count / back-ref bookkeeping keeps describing pairs the restore revoked, so the
    // replay's migrations no longer match the forward run's.
    const baseline = run.images[4] as unknown as RelationLegs
    const topology = baseline.relations
    baseline.relations = (run.images[mintingSchedule.length] as unknown as RelationLegs).relations
    run.rb.restoreImage(run.images[4] as RollbackImage)
    baseline.relations = topology

    const replay = simulate(run, mintingSchedule, 5, mintingSchedule.length)
    expect(replay[mintingSchedule.length]).not.toEqual(forward[mintingSchedule.length])
  })
})
