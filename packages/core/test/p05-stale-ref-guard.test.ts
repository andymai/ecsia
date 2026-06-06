// the pooled EntityRef is a singleton rebound by world.entity(). A held ref that is used
// after a despawn, a structural move, or another world.entity() call silently read/wrote the wrong row.
// The RANDOM-ACCESS read()/write() accessors now fail loud on a stale/recycled/moved binding.
//
// Components are module-scope singletons registerable to ONE world, so each test mints its own defs.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onRemove } from '@ecsia/core'

function setup() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: 256 })
  return { world, Position, Velocity }
}

describe('EntityRef stale-binding guard (random-access path)', () => {
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

describe('accessor VIEW stale guard (dev mode) — the held-view re-point footgun', () => {
  test('a held read view throws after world.entity() re-points it at ANOTHER entity', () => {
    const { world, Position } = setup()
    const a = world.spawnWith([Position, { x: 1, y: 1 }])
    const b = world.spawnWith([Position, { x: 2, y: 2 }])
    const viewA = world.entity(a).read(Position)
    expect(viewA.x).toBe(1) // fresh — fine
    void world.entity(b).read(Position) // re-pokes the pooled singleton at b
    // Pre-guard this read returned 2 (entity b's data) silently.
    expect(() => viewA.x).toThrow(/stale accessor view/)
  })

  test('a held write view throws on assignment after a re-point (no silent cross-entity write)', () => {
    const { world, Position } = setup()
    const a = world.spawnWith([Position, { x: 1, y: 1 }])
    const b = world.spawnWith([Position, { x: 2, y: 2 }])
    const wa = world.entity(a).write(Position)
    void world.entity(b).read(Position)
    expect(() => {
      wa.x = 99 // pre-guard this landed on b
    }).toThrow(/stale accessor view/)
    expect(world.entity(b).read(Position).x).toBe(2) // b untouched
  })

  test('a held view throws after a swap-pop hands its row to another entity (no re-point needed)', () => {
    const { world, Position } = setup()
    const a = world.spawnWith([Position, { x: 1, y: 1 }])
    const last = world.spawnWith([Position, { x: 9, y: 9 }])
    const viewA = world.entity(a).read(Position)
    world.despawn(a) // swap-pop: `last` moves into a's row; __eid still names a
    void last
    expect(() => viewA.x).toThrow(/stale accessor view/)
  })

  test('re-resolving the SAME entity keeps an older view of it valid (same row, same data)', () => {
    const { world, Position } = setup()
    const a = world.spawnWith([Position, { x: 5, y: 5 }])
    const v1 = world.entity(a).read(Position)
    const v2 = world.entity(a).read(Position)
    expect(v1.x).toBe(5)
    expect(v2.x).toBe(5)
  })

  test('views of DIFFERENT components on one entity coexist (distinct singletons)', () => {
    const { world, Position, Velocity } = setup()
    const a = world.spawnWith([Position, { x: 1, y: 2 }], [Velocity, { dx: 3, dy: 4 }])
    const p = world.entity(a).read(Position)
    const v = world.entity(a).read(Velocity)
    expect(p.x).toBe(1)
    expect(v.dx).toBe(3)
    expect(p.y).toBe(2) // still valid after the Velocity resolve — different (archetype, component) singleton
  })

  test('observer-window (lenient) reads of a dying entity are exempt from the view guard', () => {
    const { world, Position } = setup()
    const onRemoveValues: number[] = []
    world.observe(onRemove(Position), (e) => {
      onRemoveValues.push((e.read(Position) as { x: number }).x)
    })
    const a = world.spawnWith([Position, { x: 7, y: 0 }])
    const b = world.spawnWith([Position, { x: 8, y: 0 }])
    void b
    world.frameReset()
    world.despawn(a)
    world.observerDrain()
    expect(onRemoveValues).toEqual([7])
  })
})
