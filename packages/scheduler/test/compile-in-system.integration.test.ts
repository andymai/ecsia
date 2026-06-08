// compile() inside a system, driven by the scheduler. `query.compile` is a call-ONCE API (it codegens
// per-archetype runners), but a SystemDef has only a per-frame `run` and no init hook — so the idiomatic
// pattern is to lazily build the runner on first frame and cache it in the system's closure. This locks in
// that pattern end-to-end: the cached compiled runner integrates correctly across frames under
// scheduler.update(), matches an equivalent `.each` system byte-for-byte, and a `.changed()` consumer sees
// the compiled writes (compile preserves reactivity where bindColumns/eachChunk would not).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'

type CompileQuery = {
  compile<Ctx>(body: (e: { position: { x: number; y: number }; velocity: { dx: number; dy: number } }, ctx: Ctx) => void): (
    ctx: Ctx,
  ) => void
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

describe('compile() inside a scheduler-driven system', () => {
  test('a lazily-cached compiled runner integrates correctly across frames', () => {
    const N = 40
    const { world, Position, Velocity, handles } = kit(N)
    let run: ((ctx: { dt: number }) => void) | null = null
    let builds = 0
    const Movement = defineSystem({
      name: 'Movement',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        // Build once, reuse every frame — the call-once API in a per-frame body.
        if (run === null) {
          builds++
          run = (query(read(Velocity), write(Position)) as unknown as CompileQuery).compile<{ dt: number }>((e, ctx) => {
            e.position.x += e.velocity.dx * ctx.dt
            e.position.y += e.velocity.dy * ctx.dt
          })
        }
        run({ dt })
      },
    })
    const scheduler = createScheduler(world, [Movement])
    const FRAMES = 5
    for (let f = 0; f < FRAMES; f++) scheduler.update(1)

    expect(builds).toBe(1) // built exactly once, not per frame
    for (let i = 0; i < N; i++) {
      const p = world.entity(handles[i] as EntityHandle).read(Position) as { x: number; y: number }
      expect(p.x).toBe((i + 1) * FRAMES)
      expect(p.y).toBe(-(i + 1) * FRAMES)
    }
  })

  test('matches an equivalent .each system byte-for-byte', () => {
    const N = 33
    const buildWorld = (compiled: boolean) => {
      const { world, Position, Velocity, handles } = kit(N)
      let run: ((ctx: { dt: number }) => void) | null = null
      const sys = defineSystem({
        name: 'Move',
        read: [Velocity],
        write: [Position],
        run({ query, dt }) {
          const q = query(read(Velocity), write(Position))
          if (compiled) {
            run ??= (q as unknown as CompileQuery).compile<{ dt: number }>((e, ctx) => {
              e.position.x += e.velocity.dx * ctx.dt
              e.position.y += e.velocity.dy * ctx.dt
            })
            run({ dt })
          } else {
            q.each((e) => {
              const el = e as unknown as { position: { x: number; y: number }; velocity: { dx: number; dy: number } }
              el.position.x += el.velocity.dx * dt
              el.position.y += el.velocity.dy * dt
            })
          }
        },
      })
      const scheduler = createScheduler(world, [sys])
      for (let f = 0; f < 7; f++) scheduler.update(1 / 60)
      // Extract plain values per-resolve — the pooled accessor view is re-pointed on the next resolve.
      return handles.map((h) => {
        const p = world.entity(h).read(Position) as { x: number; y: number }
        return { x: p.x, y: p.y }
      })
    }
    expect(buildWorld(true)).toEqual(buildWorld(false))
  })

  test('a .changed(Position) consumer sees the compiled writes each frame', () => {
    const N = 16
    const { world, Position, Velocity } = kit(N)
    let run: ((ctx: { dt: number }) => void) | null = null
    let lastChanged = -1
    const changed = world.query(read(Position)).changed(Position) as unknown as {
      eachChanged(fn: () => void): void
    }
    const Movement = defineSystem({
      name: 'Movement',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        run ??= (query(read(Velocity), write(Position)) as unknown as CompileQuery).compile<{ dt: number }>((e, ctx) => {
          e.position.x += e.velocity.dx * ctx.dt
        })
        run({ dt })
      },
    })
    const scheduler = createScheduler(world, [Movement])
    for (let f = 0; f < 3; f++) {
      scheduler.update(1)
      let n = 0
      changed.eachChanged(() => n++)
      lastChanged = n
    }
    expect(lastChanged).toBe(N) // every entity's Position write is observed
  })
})
