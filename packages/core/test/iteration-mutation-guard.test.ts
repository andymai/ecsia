// Dev-mode guard: structural mutation (add/remove/despawn) DURING a query iteration corrupts the
// live set (swap-pop skips/double-visits rows). The world arms a flag for the duration of
// each/eachChunk/iterator and the immediate structural mutators throw while it's armed. The
// supported idiom is collect-in-the-loop, mutate-after — these tests pin both halves.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

// A component def registers to exactly one world, so each world gets a fresh Position.
function seeded() {
  const Position = defineComponent({ x: 'f32' }, { name: 'position' })
  const world = createWorld({ components: [Position] })
  const handles: EntityHandle[] = []
  for (let i = 0; i < 5; i++) handles.push(world.spawnWith([Position, { x: i }]))
  return { world, handles, Position: Position as ComponentDef<Schema> }
}

describe('structural mutation during query iteration throws in dev', () => {
  test('despawn inside each() throws', () => {
    const { world, handles, Position } = seeded()
    const q = world.query(read(Position))
    expect(() =>
      q.each((e) => {
        world.despawn(e.handle)
      }),
    ).toThrow(/despawn\(\) ran during query iteration/)
    // The guard throws BEFORE the despawn runs, so nothing is mutated — fail loud, corrupt nothing.
    expect(world.isAlive(handles[0]!)).toBe(true)
  })

  test('add inside each() throws', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32' }, { name: 'velocity' })
    const world = createWorld({ components: [Position, Velocity] })
    world.spawnWith([Position, { x: 1 }])
    const q = world.query(read(Position as ComponentDef<Schema>))
    expect(() =>
      q.each((e) => {
        world.add(e.handle, Velocity as ComponentDef<Schema>)
      }),
    ).toThrow(/add\(\) ran during query iteration/)
  })

  test('remove inside each() throws', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    expect(() =>
      q.each((e) => {
        world.remove(e.handle, Position)
      }),
    ).toThrow(/remove\(\) ran during query iteration/)
  })

  test('despawn inside eachChunk() throws', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    expect(() =>
      q.eachChunk((chunk) => {
        world.despawn(chunk.entities[0] as unknown as EntityHandle)
      }),
    ).toThrow(/despawn\(\) ran during query iteration/)
  })

  test('despawn inside a for-of iterator throws', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    expect(() => {
      for (const e of q) world.despawn(e.handle)
    }).toThrow(/despawn\(\) ran during query iteration/)
  })
})

describe('the guard does not fire on supported patterns', () => {
  test('collect-in-the-loop, despawn-after does NOT throw', () => {
    const { world, handles, Position } = seeded()
    const q = world.query(read(Position))
    const dead: EntityHandle[] = []
    q.each((e) => {
      if ((e as unknown as { position: { x: number } }).position.x >= 3) dead.push(e.handle)
    })
    expect(() => {
      for (const h of dead) world.despawn(h)
    }).not.toThrow()
    expect(dead.length).toBe(2)
    expect(world.isAlive(handles[4]!)).toBe(false)
  })

  test('nested read-only iteration does not throw (the counter is balanced)', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    let pairs = 0
    expect(() =>
      q.each(() => {
        q.each(() => {
          pairs += 1
        })
      }),
    ).not.toThrow()
    expect(pairs).toBe(25)
    expect(() => world.despawn(world.spawn())).not.toThrow()
  })

  test('a callback that throws still unwinds the guard (try/finally balance)', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    expect(() =>
      q.each(() => {
        throw new Error('boom')
      }),
    ).toThrow(/boom/)
    // The counter was restored despite the throw — a later despawn outside iteration works.
    expect(() => world.despawn(world.spawn())).not.toThrow()
  })

  test('breaking out of a for-of early balances the guard', () => {
    const { world, Position } = seeded()
    const q = world.query(read(Position))
    for (const e of q) {
      void e
      break
    }
    expect(() => world.despawn(world.spawn())).not.toThrow()
  })
})
