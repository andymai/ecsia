// scheduler INTEGRATION suite — end-to-end, in lieu of the deferred boids bench. A small system
// pipeline runs via the single-threaded executor and DETERMINISTICALLY mutates the right components;
// the reactivity `.changed` flavor sees the writes after the frame (the wave/frame-boundary drain).
//
// DEFERRED: the wall-clock graph-build bench (plan-construction throughput) is NOT measured here —
// no bench harness in this milestone. Its STRUCTURAL surrogate is the property suite's plan-shape
// assertions plus the "plan built once" check below; the timing surrogate is flagged for the
// reviewer.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'

interface PosView {
  position: { x: number; y: number }
  velocity: { dx: number; dy: number }
}

function kit(n: number) {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 14 })
  const handles: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Position, Velocity)
    const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
    v.dx = i + 1
    v.dy = -(i + 1)
    handles.push(h)
  }
  return { world, Position, Velocity, handles }
}

describe('movement pipeline end-to-end', () => {
  test('a movement system integrates Position from Velocity across N entities, deterministically', () => {
    const N = 32
    const { world, Position, Velocity, handles } = kit(N)
    const Movement = defineSystem({
      name: 'Movement',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        for (const e of query(Velocity, write(Position))) {
          const el = e as unknown as PosView
          el.position.x += el.velocity.dx * dt
          el.position.y += el.velocity.dy * dt
        }
      },
    })
    const scheduler = createScheduler(world, [Movement])

    // Three frames of dt=0.5 ⇒ each entity's x = dx * 1.5, y = dy * 1.5.
    for (let f = 0; f < 3; f++) scheduler.update(0.5)

    for (let i = 0; i < N; i++) {
      const p = world.entity(handles[i]!).read(Position)
      expect(p.x).toBeCloseTo((i + 1) * 1.5)
      expect(p.y).toBeCloseTo(-(i + 1) * 1.5)
    }
    // Single-thread executor never leaves 'serial'.
    expect(world.phase).toBe('serial')
  })

  test('reactivity .changed sees the frame writes AFTER the frame (wave/frame-boundary drain)', () => {
    const N = 16
    const { world, Position, Velocity } = kit(N)
    const changedQ = world.query(read(Position)).changed()
    const Movement = defineSystem({
      name: 'Movement',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        for (const e of query(Velocity, write(Position))) {
          const el = e as unknown as PosView
          el.position.x += el.velocity.dx * dt
        }
      },
    })
    const scheduler = createScheduler(world, [Movement])

    scheduler.update(1)
    // The `.changed` filter, drained after the frame, must see exactly the N entities Movement wrote.
    let changed = 0
    changedQ.eachChanged(() => changed++)
    expect(changed).toBe(N)
  })

  test('a two-stage pipeline (Accelerate → Move) deterministically composes across a frame', () => {
    const N = 8
    const { world, Position, Velocity, handles } = kit(N)
    // Accelerate writes Velocity (wave 0); Move reads Velocity writes Position (wave 1, after).
    const Accelerate = defineSystem({
      name: 'Accelerate',
      write: [Velocity],
      run({ query }) {
        for (const e of query(write(Velocity))) {
          const v = (e as unknown as PosView).velocity
          v.dx *= 2
        }
      },
    })
    const Move = defineSystem({
      name: 'Move',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        for (const e of query(Velocity, write(Position))) {
          const el = e as unknown as PosView
          el.position.x += el.velocity.dx * dt
        }
      },
    })
    // Registration order is the implicit-edge direction: Accelerate first ⇒ Accelerate→Move.
    const scheduler = createScheduler(world, [Accelerate, Move])

    // Accelerate runs BEFORE Move within the frame (conflict on Velocity: Accelerate writes,
    // Move reads ⇒ Accelerate's wave precedes Move's). So x picks up the DOUBLED dx.
    scheduler.update(1)
    for (let i = 0; i < N; i++) {
      // dx started at i+1, doubled to 2*(i+1), then x += that * 1.
      expect(world.entity(handles[i]!).read(Position).x).toBeCloseTo(2 * (i + 1))
    }

    // Verify the wave ordering structurally: Accelerate is in a strictly earlier wave than Move.
    const idOf = (name: string) => scheduler.plan.systems.findIndex((s) => s.name === name)
    const waveOf = (id: number) =>
      scheduler.plan.waves.findIndex((w) => w.rounds.flat().some((b) => (b.systemId as unknown as number) === id))
    expect(waveOf(idOf('Accelerate'))).toBeLessThan(waveOf(idOf('Move')))
  })

  test('the plan is built ONCE — repeated updates never rebuild it ( surrogate)', () => {
    const { world, Position, Velocity } = kit(4)
    const Move = defineSystem({
      name: 'Move',
      read: [Velocity],
      write: [Position],
      run() {},
    })
    const scheduler = createScheduler(world, [Move])
    const planRef = scheduler.plan
    for (let f = 0; f < 10; f++) scheduler.update(1)
    // The handle exposes a single frozen plan; identity is stable across every update (no re-plan).
    expect(scheduler.plan).toBe(planRef)
  })
})
