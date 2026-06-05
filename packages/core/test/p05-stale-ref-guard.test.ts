// P0.5 Wave-1: the pooled EntityRef is a singleton rebound by world.entity(). A held ref that is used
// after a despawn, a structural move, or another world.entity() call silently read/wrote the wrong row.
// The RANDOM-ACCESS read()/write() accessors now fail loud on a stale/recycled/moved binding.
//
// Components are module-scope singletons registerable to ONE world, so each test mints its own defs.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'

function setup() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: 256 })
  return { world, Position, Velocity }
}

describe('P0.5 EntityRef stale-binding guard (random-access path)', () => {
  test('fresh single-statement read/write still works', () => {
    const { world, Position } = setup()
    const h = world.spawnWith(Position)
    world.entity(h).write(Position).x = 5
    expect(world.entity(h).read(Position).x).toBe(5)
  })

  test('held ref throws on read after the bound entity is despawned', () => {
    const { world, Position } = setup()
    const h = world.spawnWith(Position)
    const ref = world.entity(h)
    world.despawn(h)
    expect(() => ref.read(Position)).toThrow(/no longer alive/)
  })

  test('held ref throws on write after the bound entity is despawned', () => {
    const { world, Position } = setup()
    const h = world.spawnWith(Position)
    const ref = world.entity(h)
    world.despawn(h)
    expect(() => {
      ref.write(Position).x = 9
    }).toThrow(/no longer alive/)
  })

  test('held ref throws after the bound entity is structurally moved (add component)', () => {
    const { world, Position, Velocity } = setup()
    const h = world.spawnWith(Position)
    const ref = world.entity(h)
    // Adding a component migrates the entity to a new archetype/row; the held ref's cached location is
    // now stale and would otherwise read/write a different row.
    world.add(h, Velocity)
    expect(() => ref.read(Position)).toThrow(/stale binding|no longer alive/)
  })

  test('re-resolving via world.entity(h) after a move reads correctly', () => {
    const { world, Position, Velocity } = setup()
    const h = world.spawnWith(Position)
    world.entity(h).write(Position).x = 3
    world.add(h, Velocity)
    // The documented recovery: re-resolve at the point of use.
    expect(world.entity(h).read(Position).x).toBe(3)
    world.entity(h).write(Velocity).dx = 7
    expect(world.entity(h).read(Velocity).dx).toBe(7)
  })

  test('error message is actionable (points at re-resolving via world.entity)', () => {
    const { world, Position } = setup()
    const h = world.spawnWith(Position)
    const ref = world.entity(h)
    world.despawn(h)
    expect(() => ref.read(Position)).toThrow(/world\.entity\(h\)/)
  })
})
