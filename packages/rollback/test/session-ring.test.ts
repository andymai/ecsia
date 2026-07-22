// Ring discipline: the session preallocates its images once and REUSES them, so a steady-state frame
// allocates nothing. Proved by wrapping the surface the session builds on and watching which image
// object each capture writes into (and whether its buffers were re-created).

import { describe, expect, test, vi } from 'vitest'
import type { World } from '@ecsia/core'
import { createSim, encodeInput, OP_NUDGE, OP_SPAWN } from './sim.js'
import type { ImageInternals } from './image-digest.js'

const spy = vi.hoisted(() => ({ newImages: 0, captures: [] as object[] }))

vi.mock('../src/rollback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rollback.js')>()
  return {
    ...actual,
    createRollbackSurface: (world: World) => {
      const surface = actual.createRollbackSurface(world)
      return {
        ...surface,
        newImage: () => {
          spy.newImages += 1
          return surface.newImage()
        },
        captureImage: (img: Parameters<typeof surface.captureImage>[0]) => {
          spy.captures.push(img as object)
          surface.captureImage(img)
        },
      }
    },
  }
})

const { createRollbackSession } = await import('../src/index.js')

describe('@ecsia/rollback — session ring reuse', () => {
  test('the ring is allocated once and every frame captures into one of its images', () => {
    const sim = createSim(1)
    const maxRollbackFrames = 3
    const session = createRollbackSession(sim.world, {
      maxRollbackFrames,
      players: [0],
      step: () => sim.step(),
      applyInputs: (_frame, inputs) => sim.applyInput(0, inputs.get(0)),
    })
    // depth + 1: a rollback to the deepest allowed frame restores the checkpoint BEFORE it.
    const ringSize = maxRollbackFrames + 1
    expect(spy.newImages).toBe(ringSize)

    for (let f = 1; f <= 5; f++) {
      session.recordInput(0, f, encodeInput(OP_SPAWN, f))
      session.advance()
    }
    for (let f = 6; f <= 12; f++) {
      session.recordInput(0, f, encodeInput(OP_NUDGE, 1))
      session.advance()
    }
    // Warm: the live set has stopped growing, so image buffers stop being re-created.
    const warm = spy.captures.map((img) => {
      const internals = img as unknown as ImageInternals
      return { dense: internals.identity.dense, words: internals.bitmaskWords }
    })

    for (let f = 13; f <= 20; f++) {
      session.recordInput(0, f, encodeInput(OP_NUDGE, 1))
      session.advance()
    }

    expect(spy.newImages).toBe(ringSize) // no image minted after construction
    expect(spy.captures).toHaveLength(21) // the frame-0 baseline + 20 frames
    expect(new Set(spy.captures).size).toBe(ringSize)
    // Frame f always lands in slot f % ringSize.
    for (let f = 0; f <= 20; f++) expect(spy.captures[f]).toBe(spy.captures[f % ringSize])
    // And the reused images kept their buffers: a steady-state frame allocates nothing.
    for (let i = 0; i < ringSize; i++) {
      const internals = spy.captures[i] as unknown as ImageInternals
      expect(internals.identity.dense).toBe(warm[i]?.dense)
      expect(internals.bitmaskWords).toBe(warm[i]?.words)
    }
  })
})
