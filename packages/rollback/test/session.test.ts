// createRollbackSession: the predict → confirm → rollback → re-simulate loop. The properties under
// test are (a) a correct prediction costs nothing (RB-5), (b) a wrong one is corrected to the same
// state a never-mispredicted run reaches, handles and eid references intact (RB-1), (c) a rollback
// past the window is refused whole, leaving the world untouched (RB-3), and (d) the frame-boundary /
// one-tick-per-step contracts are asserted rather than assumed.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onRemove } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRollbackSession, createRollbackSurface } from '../src/index.js'
import type { FrameInputs, PlayerId, RollbackSession, UnrecoverableRollback } from '../src/index.js'
import { digest } from './image-digest.js'
import { createSim, encodeInput, OP_NONE, OP_NUDGE, OP_SPAWN } from './sim.js'
import type { Sim } from './sim.js'

interface Harness {
  sim: Sim
  session: RollbackSession
  steps: () => number
  unrecoverable: UnrecoverableRollback[]
  /** The world's current state as comparable data. */
  snapshot: () => unknown
}

function harness(maxRollbackFrames = 4): Harness {
  const sim = createSim(2)
  const unrecoverable: UnrecoverableRollback[] = []
  let steps = 0
  const session = createRollbackSession(sim.world, {
    maxRollbackFrames,
    players: [0, 1],
    step: () => {
      steps += 1
      sim.step()
    },
    applyInputs: (_frame: number, inputs: FrameInputs) => {
      for (const player of inputs.players) sim.applyInput(player as number, inputs.get(player))
    },
    onUnrecoverable: (info) => void unrecoverable.push(info),
  })
  const probe = createRollbackSurface(sim.world)
  const probeImage = probe.newImage()
  return {
    sim,
    session,
    steps: () => steps,
    unrecoverable,
    snapshot: () => {
      probe.captureImage(probeImage)
      return digest(probeImage)
    },
  }
}

describe('@ecsia/rollback — session loop', () => {
  test('advance drives frame and world.tick together; confirmedFrame trails a prediction', () => {
    const h = harness()
    expect(h.session.currentFrame).toBe(0)
    expect(h.session.confirmedFrame).toBe(0)

    h.session.recordInput(0, 1, encodeInput(OP_SPAWN, 3))
    expect(h.session.advance()).toBe(1)
    expect(h.sim.world.tick).toBe(1)
    // Player 1's frame-1 input was predicted, so the frame is not confirmed.
    expect(h.session.confirmedFrame).toBe(0)

    h.session.recordInput(1, 1, encodeInput(OP_NONE, 0))
    expect(h.session.confirmedFrame).toBe(1)
  })

  test('RB-5: a confirmed input equal to its prediction triggers no re-simulation', () => {
    const h = harness()
    const held = encodeInput(OP_NUDGE, 2)
    // Confirm frame 1 for both players up front, so frames 2+ predict by repeating it.
    h.session.recordInput(0, 1, held)
    h.session.recordInput(1, 1, held)
    h.session.advance()
    h.session.recordInput(0, 2, held)
    h.session.advance()
    h.session.recordInput(0, 3, held)
    h.session.advance()
    expect(h.steps()).toBe(3)
    expect(h.session.confirmedFrame).toBe(1)

    h.session.recordInput(1, 2, held) // exactly what was predicted
    expect(h.steps()).toBe(3)
    expect(h.session.confirmedFrame).toBe(2)

    h.session.recordInput(1, 3, held)
    expect(h.steps()).toBe(3)
    expect(h.session.confirmedFrame).toBe(3)
  })

  test('a misprediction corrects to the same state a never-mispredicted run reaches', () => {
    const p0 = [encodeInput(OP_SPAWN, 4), encodeInput(OP_NUDGE, 7), encodeInput(OP_SPAWN, 9), encodeInput(OP_NUDGE, 1), encodeInput(OP_NONE, 0)]
    const p1 = [encodeInput(OP_NONE, 0), encodeInput(OP_NONE, 0), encodeInput(OP_SPAWN, 5), encodeInput(OP_NUDGE, 3), encodeInput(OP_SPAWN, 2)]

    // Reference: every input known before its frame is simulated — no prediction anywhere.
    const ref = harness()
    for (let f = 1; f <= 5; f++) {
      ref.session.recordInput(0, f, p0[f - 1] as Uint8Array)
      ref.session.recordInput(1, f, p1[f - 1] as Uint8Array)
      ref.session.advance()
    }
    expect(ref.steps()).toBe(5)
    expect(ref.session.confirmedFrame).toBe(5)

    // Late: player 1's frame-3 input arrives only after frame 5, contradicting the prediction
    // (which repeated their frame-2 input).
    const late = harness()
    for (let f = 1; f <= 5; f++) {
      late.session.recordInput(0, f, p0[f - 1] as Uint8Array)
      if (f !== 3) late.session.recordInput(1, f, p1[f - 1] as Uint8Array)
      late.session.advance()
    }
    expect(late.steps()).toBe(5)
    expect(late.session.confirmedFrame).toBe(2)

    late.session.recordInput(1, 3, p1[2] as Uint8Array)
    expect(late.steps()).toBe(8) // frames 3, 4, 5 re-simulated
    expect(late.session.currentFrame).toBe(5)
    expect(late.session.confirmedFrame).toBe(5)
    expect(late.sim.world.tick).toBe(5)

    expect(late.sim.actors()).toEqual(ref.sim.actors())
    expect(late.snapshot()).toEqual(ref.snapshot())
  })

  test('handles and eid references survive a mispredict-driven rollback', () => {
    const h = harness()
    const spawn = encodeInput(OP_SPAWN, 6)
    for (let f = 1; f <= 4; f++) {
      h.session.recordInput(0, f, spawn)
      if (f !== 2) h.session.recordInput(1, f, encodeInput(OP_NONE, 0))
      h.session.advance()
    }
    const before = h.sim.actors()
    expect(before.length).toBe(4)
    const linked = before.filter((a) => a.target !== 0)
    expect(linked.length).toBeGreaterThan(0)

    h.session.recordInput(1, 2, encodeInput(OP_SPAWN, 8)) // contradicts the predicted no-op
    expect(h.steps()).toBeGreaterThan(4)

    const after = h.sim.actors()
    expect(after.length).toBe(5)
    // Every actor the rollback kept is at its original handle, and every eid target resolves.
    for (const actor of after) {
      expect(h.sim.world.isAlive(actor.handle as EntityHandle)).toBe(true)
      if (actor.target !== 0) expect(h.sim.world.isAlive(actor.target as EntityHandle)).toBe(true)
    }
    expect(after.map((a) => a.handle)).toContain(before[0]?.handle)
  })

  test('RB-3: a rollback past the window is reported unrecoverable and rewinds nothing', () => {
    const h = harness(3)
    for (let f = 1; f <= 6; f++) {
      h.session.recordInput(0, f, encodeInput(OP_SPAWN, f))
      h.session.advance()
    }
    const before = h.snapshot()

    h.session.recordInput(1, 3, encodeInput(OP_NUDGE, 9)) // 3 frames back, at the window's edge
    expect(h.unrecoverable).toHaveLength(1)
    expect(h.unrecoverable[0]?.frame).toBe(3)
    expect(h.unrecoverable[0]?.currentFrame).toBe(6)
    expect(h.unrecoverable[0]?.message).toMatch(/rollback window/)
    expect(h.steps()).toBe(6) // no partial rewind, no re-simulation
    expect(h.snapshot()).toEqual(before)
  })

  test('a rollback to the deepest frame still inside the window succeeds', () => {
    const h = harness(3)
    for (let f = 1; f <= 6; f++) {
      h.session.recordInput(0, f, encodeInput(OP_SPAWN, f))
      h.session.advance()
    }
    h.session.recordInput(1, 4, encodeInput(OP_NUDGE, 9)) // depth 2 — inside a 3-frame window
    expect(h.unrecoverable).toHaveLength(0)
    expect(h.steps()).toBe(9)
    expect(h.session.currentFrame).toBe(6)
    expect(h.sim.world.tick).toBe(6)
  })

  test('without onUnrecoverable an unrecoverable rollback throws', () => {
    const sim = createSim(1)
    const session = createRollbackSession(sim.world, {
      maxRollbackFrames: 2,
      players: [0, 1],
      step: () => sim.step(),
      applyInputs: (_frame, inputs) => sim.applyInput(0, inputs.get(0)),
    })
    for (let f = 1; f <= 4; f++) session.advance()
    expect(() => session.recordInput(1, 1, encodeInput(OP_SPAWN, 1))).toThrow(/resync from a fresh authoritative state/)
  })

  test('a step that does not advance the tick exactly once is refused', () => {
    const sim = createSim(1)
    const session = createRollbackSession(sim.world, {
      maxRollbackFrames: 2,
      players: [0],
      step: () => {},
      applyInputs: (_frame, inputs) => sim.applyInput(0, inputs.get(0)),
    })
    expect(() => session.advance()).toThrow(/ONE fixed step/)
  })

  test('a checkpoint is refused when step() ended before the observer drain', () => {
    const Pos = defineComponent({ x: 'i32' }, { name: `sess_pos_${Date.now()}` })
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    world.observe(onRemove(Pos), () => {}) // arms the deferred-dead row hold
    const doomed = world.spawnWith([Pos, { x: 1 }])
    const session = createRollbackSession(world, {
      maxRollbackFrames: 2,
      players: [0],
      step: () => {
        world.frameReset()
        world.despawn(doomed)
        // No observerDrain: the dying row is still HELD, so this is mid-frame.
      },
      applyInputs: () => {},
    })
    expect(() => session.advance()).toThrow(/frame boundary/)
  })

  test('input for a frame beyond the buffer is refused', () => {
    const h = harness(3)
    h.session.advance()
    expect(() => h.session.recordInput(0, 5, encodeInput(OP_NONE, 0))).toThrow(/frames ahead/)
    h.session.recordInput(0, 4, encodeInput(OP_NONE, 0)) // exactly at the limit: buffered
  })

  test('input for a frame the session never simulates is refused', () => {
    const h = harness(3)
    expect(() => h.session.recordInput(0, 0, encodeInput(OP_NONE, 0))).toThrow(/first frame is 1/)
    expect(() => h.session.recordInput(0, -2, encodeInput(OP_NONE, 0))).toThrow(/first frame is 1/)
    expect(() => h.session.recordInput(0, 1.5, encodeInput(OP_NONE, 0))).toThrow(/first frame is 1/)
  })

  test('an input for a frame that left the buffer is unrecoverable, not silently applied', () => {
    const h = harness(2)
    for (let f = 1; f <= 6; f++) h.session.advance()
    h.session.recordInput(0, 1, encodeInput(OP_SPAWN, 1))
    expect(h.unrecoverable).toHaveLength(1)
    expect(h.unrecoverable[0]?.message).toMatch(/input buffer/)
    expect(h.steps()).toBe(6)
  })

  test('config guards: maxRollbackFrames, players, and unknown player ids', () => {
    const sim = createSim(1)
    const base = { players: [0] as PlayerId[], step: () => sim.step(), applyInputs: () => {} }
    expect(() => createRollbackSession(sim.world, { ...base, maxRollbackFrames: 0 })).toThrow(/positive integer/)
    expect(() => createRollbackSession(sim.world, { ...base, maxRollbackFrames: 1.5 })).toThrow(/positive integer/)
    expect(() => createRollbackSession(sim.world, { ...base, maxRollbackFrames: 2, players: [] })).toThrow(/must not be empty/)
    expect(() => createRollbackSession(sim.world, { ...base, maxRollbackFrames: 2, players: [0, 0] })).toThrow(/duplicate player/)

    const session = createRollbackSession(sim.world, { ...base, maxRollbackFrames: 2 })
    expect(() => session.recordInput(7, 1, encodeInput(OP_NONE, 0))).toThrow(/unknown player/)
  })

  test('a custom prediction policy and equalsInput override the defaults', () => {
    const sim = createSim(1)
    const predicted: number[] = []
    let steps = 0
    const session = createRollbackSession(sim.world, {
      maxRollbackFrames: 4,
      players: [0],
      step: () => {
        steps += 1
        sim.step()
      },
      applyInputs: (_frame, inputs) => sim.applyInput(0, inputs.get(0)),
      predict: (_player, frame) => {
        predicted.push(frame)
        return encodeInput(OP_SPAWN, 1)
      },
      // Only the op byte matters, so a differing value byte is NOT a misprediction.
      equalsInput: (a, b) => a[0] === b[0],
    })
    session.advance()
    session.advance()
    expect(predicted).toEqual([1, 2])

    session.recordInput(0, 1, encodeInput(OP_SPAWN, 200))
    expect(steps).toBe(2) // same op ⇒ no rollback under the custom equality
    expect(session.confirmedFrame).toBe(1)

    session.recordInput(0, 2, encodeInput(OP_NUDGE, 1))
    expect(steps).toBe(3) // different op ⇒ frame 2 re-simulated
  })

  test('inputs expose predicted-ness to applyInputs', () => {
    const sim = createSim(2)
    const flags: boolean[][] = []
    const session = createRollbackSession(sim.world, {
      maxRollbackFrames: 4,
      players: [0, 1],
      step: () => sim.step(),
      applyInputs: (_frame, inputs) => {
        flags.push(inputs.players.map((p) => inputs.isPredicted(p)))
        for (const p of inputs.players) sim.applyInput(p as number, inputs.get(p))
      },
    })
    session.recordInput(0, 1, encodeInput(OP_SPAWN, 1))
    session.advance()
    expect(flags).toEqual([[false, true]])
  })
})
