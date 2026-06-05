// The opt-in column-cursor iteration surface: eachChunk hands one reused QueryChunk
// per matched hot archetype, exposing raw SoA column views + a contiguous row span. It bypasses the
// per-row accessor AND the reactivity write log — so it must read/write the same columns the accessor
// path sees, NOT visit cold archetypes, and NOT record a write the .changed flavor can observe.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, vec2, write } from '@ecsia/core'
import type { ComponentDef, QueryChunk, Schema } from '@ecsia/core'

function makeKit(): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const components = [Position, Velocity] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ components }), Position, Velocity }
}

describe('eachChunk column-cursor', () => {
  test('cursor read/write matches the accessor path', () => {
    const { world, Position, Velocity } = makeKit()
    const n = 1000
    for (let i = 0; i < n; i++) {
      const h = world.spawnWith(Position, Velocity)
      const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
      v.dx = 1
      v.dy = 0.5
    }
    const q = world.query(write(Position), write(Velocity))
    const dt = 1 / 60

    let rows = 0
    q.eachChunk((c: QueryChunk) => {
      const px = c.column(Position, 'x')
      const dx = c.column(Velocity, 'dx')
      for (let i = 0; i < c.count; i++) {
        ;(px as { [k: number]: number })[i] = (px as { [k: number]: number })[i]! + dx[i]! * dt
      }
      rows += c.count
      // entities span the chunk's rows
      expect(c.entities.length).toBeGreaterThanOrEqual(c.count)
    })
    expect(rows).toBe(n)

    // The accessor read sees exactly what the cursor wrote.
    let seen = 0
    q.each((e) => {
      const el = e as unknown as { position: { x: number } }
      expect(el.position.x).toBeCloseTo(dt, 6)
      seen++
    })
    expect(seen).toBe(n)
  })

  test('cursor integration equals the accessor path ABOVE the 1024 growth boundary', () => {
    // INITIAL_ROWS (64) × GROWTH_RESERVE (16) = 1024: spawning past it forces a fallback column grow
    // that re-binds per-field column views. A pre-fix bug aliased the second f32 field onto the first
    // field's backing, so the cursor (and accessor) read corrupt data above 1024. n=5000 crosses it.
    const { world, Position, Velocity } = makeKit()
    const n = 5000
    for (let i = 0; i < n; i++) {
      const h = world.spawnWith(Position, Velocity)
      const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
      v.dx = 1
      v.dy = 0.5
    }
    const q = world.query(write(Position), write(Velocity))
    const dt = 1 / 60
    const steps = 10

    for (let s = 0; s < steps; s++) {
      q.eachChunk((c: QueryChunk) => {
        const px = c.column(Position, 'x')
        const py = c.column(Position, 'y')
        const dx = c.column(Velocity, 'dx')
        const dy = c.column(Velocity, 'dy')
        for (let i = 0; i < c.count; i++) {
          ;(px as { [k: number]: number })[i] = px[i]! + dx[i]! * dt
          ;(py as { [k: number]: number })[i] = py[i]! + dy[i]! * dt
        }
      })
    }

    // Every entity integrated dx=1, dy=0.5 for `steps` frames; the accessor read must agree and NOT
    // be halved/aliased to the dy column's value.
    let seen = 0
    q.each((e) => {
      const el = e as unknown as { position: { x: number; y: number } }
      expect(el.position.x).toBeCloseTo(steps * dt, 6)
      expect(el.position.y).toBeCloseTo(steps * 0.5 * dt, 6)
      seen++
    })
    expect(seen).toBe(n)
  })

  test('vec field exposes its stride; row r starts at r*stride', () => {
    const Transform = defineComponent({ pos: vec2('f32') }, { name: 'transform' })
    const world = createWorld({ components: [Transform] as readonly ComponentDef<Schema>[] })
    for (let i = 0; i < 8; i++) world.spawnWith(Transform)
    const q = world.query(write(Transform))
    q.eachChunk((c: QueryChunk) => {
      const stride = c.stride(Transform, 'pos')
      expect(stride).toBe(2)
      const view = c.column(Transform, 'pos') as { [k: number]: number }
      for (let r = 0; r < c.count; r++) {
        view[r * stride] = r
        view[r * stride + 1] = r * 10
      }
    })
    // Read back through the accessor.
    let r = 0
    q.each((e) => {
      const el = e as unknown as { transform: { pos: { x: number; y: number } } }
      expect(el.transform.pos.x).toBe(r)
      expect(el.transform.pos.y).toBe(r * 10)
      r++
    })
    expect(r).toBe(8)
  })

  test('column on an absent component throws', () => {
    const { world, Position, Velocity } = makeKit()
    world.spawnWith(Position)
    const q = world.query(write(Position))
    expect(() => {
      q.eachChunk((c: QueryChunk) => {
        c.column(Velocity, 'dx')
      })
    }).toThrow()
  })

  test('column on an unknown field throws', () => {
    const { world, Position } = makeKit()
    world.spawnWith(Position)
    const q = world.query(write(Position))
    expect(() => {
      q.eachChunk((c: QueryChunk) => {
        c.column(Position, 'nope')
      })
    }).toThrow()
  })

  test('the chunk is reused across archetypes (zero per-archetype allocation)', () => {
    const { world, Position, Velocity } = makeKit()
    // Two archetypes: {Position} and {Position, Velocity}.
    world.spawnWith(Position)
    world.spawnWith(Position, Velocity)
    const q = world.query(write(Position))
    const seen = new Set<QueryChunk>()
    q.eachChunk((c: QueryChunk) => seen.add(c))
    expect(seen.size).toBe(1)
  })
})
