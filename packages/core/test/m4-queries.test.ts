// M4 query subsystem invariant suite (queries.md §13). Driven through the real createWorld surface
// so the archetypeCreated hook + single-entity maintenance are exercised end to end.
//
//   Q-H1   hash dedup: same terms (any order, read/write) share ONE LiveQuery; has(A) vs read(A)
//          share matching but distinct value bindings.
//   Q-M1   per-archetype matching: iteration walks matchingArchetypes; late queries seed, new
//          archetypes join via the archetypeCreated hook.
//   Q-M2   maintenance scope: add/remove/despawn move entities in and out of the matching set.
//   Q-I1   current ⟺ matchingArchetypes coherence after every structural op.
//   Q-F1   added/removed coalescing: remove-then-add and add-then-remove net to no delta.
//   Q-A1   zero-alloc iteration: pooled element reused across rows and iterations.
//   iteration correctness: each yields exactly the matching entities; value props read/write.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTag, read, write, has, without, optional } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

// A component def's id is mutated once at world registration, so each world needs FRESH defs.
function makeKit(): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
  Health: ComponentDef<Schema>
  Alive: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ x: 'f32', y: 'f32' }, { name: 'velocity' })
  const Health = defineComponent({ current: 'i32' }, { name: 'health' })
  const Alive = defineTag('alive')
  const components = [Position, Velocity, Health, Alive] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ components }), Position, Velocity, Health, Alive }
}

describe('Q-H1 canonical-hash dedup', () => {
  test('identical term sets (order-independent) return the SAME LiveQuery', () => {
    const { world, Position, Velocity } = makeKit()
    const a = world.query(read(Position), read(Velocity))
    const b = world.query(read(Velocity), read(Position))
    expect(a).toBe(b)
  })

  test('read(A) and write(A) share matching state (same LiveQuery)', () => {
    const { world, Position } = makeKit()
    expect(world.query(read(Position))).toBe(world.query(write(Position)))
  })

  test('has(A) and read(A) share matching but are distinct LiveQueries (value binding)', () => {
    const { world, Position } = makeKit()
    const withQ = world.query(has(Position))
    const readQ = world.query(read(Position))
    expect(withQ).not.toBe(readQ)
    world.spawnWith(Position)
    expect(withQ.count).toBe(1)
    expect(readQ.count).toBe(1)
  })
})

describe('iteration correctness + per-archetype matching (Q-M1)', () => {
  test('each yields exactly the matching entities with readable value props', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), write(Velocity))
    const e0 = world.spawnWith(Position, Velocity)
    world.spawnWith(Position) // no Velocity → excluded
    world.spawnWith(Velocity) // no Position → excluded
    const e3 = world.spawnWith(Position, Velocity)

    world.entity(e0).write(Position).x = 10
    world.entity(e3).write(Position).x = 30

    const seen: number[] = []
    q.each((e) => {
      const el = e as unknown as { position: { x: number }; velocity: { x: number } }
      seen.push(el.position.x)
      el.velocity.x = 1 // write through the mutable velocity prop
    })
    expect(seen.sort((a, b) => a - b)).toEqual([10, 30])
    expect(q.count).toBe(2)
    expect(world.entity(e0).read(Velocity).x).toBe(1)
  })

  test('without excludes; optional yields the value or undefined', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const q = world.query(read(Position), without(Health), optional(Velocity))
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position, Velocity)
    world.spawnWith(Position, Health) // excluded by without
    expect(q.count).toBe(2)

    const velByHandle = new Map<number, unknown>()
    q.each((e) => {
      const el = e as unknown as { handle: EntityHandle; velocity: unknown }
      velByHandle.set(el.handle as number, el.velocity)
    })
    expect(velByHandle.get(a as number)).toBeUndefined()
    expect(velByHandle.get(b as number)).toBeDefined()
  })

  test('a query created AFTER archetypes exist seeds against all existing archetypes', () => {
    const { world, Position, Velocity } = makeKit()
    world.spawnWith(Position, Velocity)
    world.spawnWith(Position)
    expect(world.query(read(Position)).count).toBe(2)
  })

  test('a new archetype created after the query joins it via the archetypeCreated hook', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Velocity))
    expect(q.count).toBe(0)
    world.spawnWith(Velocity)
    world.spawnWith(Position, Velocity)
    expect(q.count).toBe(2)
  })
})

describe('Q-M2 incremental maintenance', () => {
  test('add/remove migrate the entity in and out of the matching set', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity))
    const e = world.spawnWith(Position)
    expect(q.count).toBe(0)
    world.add(e, Velocity)
    expect(q.count).toBe(1)
    world.remove(e, Velocity)
    expect(q.count).toBe(0)
  })

  test('despawn removes the entity from every matching query', () => {
    const { world, Position } = makeKit()
    const q = world.query(read(Position))
    const e = world.spawnWith(Position)
    expect(q.count).toBe(1)
    world.despawn(e)
    expect(q.count).toBe(0)
  })

  test('a constraint-less query matches live entities and drops despawned ones', () => {
    const { world, Position } = makeKit()
    const q = world.query(has(Position))
    const e = world.spawnWith(Position)
    expect(q.count).toBe(1)
    world.despawn(e)
    expect(q.count).toBe(0)
  })
})

describe('Q-I1 current ⟺ matchingArchetypes coherence', () => {
  test('the matchingArchetypes walk yields exactly current.size entities', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position))
    const handles: EntityHandle[] = []
    for (let i = 0; i < 20; i++) handles.push(world.spawnWith(...(i % 2 ? [Position, Velocity] : [Position])))
    for (let i = 0; i < 20; i += 3) world.despawn(handles[i] as EntityHandle)

    let walked = 0
    q.each(() => walked++)
    expect(walked).toBe(q.count)
  })
})

describe('Q-F1 added/removed coalescing', () => {
  test('remove-then-add within a frame nets to no delta', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity)).added().removed()
    const e = world.spawnWith(Position, Velocity)
    world.frameReset()
    world.remove(e, Velocity)
    world.add(e, Velocity)
    let added = 0
    let removed = 0
    q.eachAdded(() => added++)
    q.eachRemoved(() => removed++)
    expect(added).toBe(0)
    expect(removed).toBe(0)
    expect(q.count).toBe(1)
  })

  test('add-then-remove within a frame nets to no delta', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity)).added().removed()
    const e = world.spawnWith(Position)
    world.frameReset()
    world.add(e, Velocity)
    world.remove(e, Velocity)
    let added = 0
    let removed = 0
    q.eachAdded(() => added++)
    q.eachRemoved(() => removed++)
    expect(added).toBe(0)
    expect(removed).toBe(0)
    expect(q.count).toBe(0)
  })

  test('a real entrance records exactly one added delta', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity)).added()
    const e = world.spawnWith(Position)
    world.frameReset()
    world.add(e, Velocity)
    let added = 0
    q.eachAdded(() => added++)
    expect(added).toBe(1)
  })
})

describe('Q-A1 zero-alloc iteration (pooled element + cursor)', () => {
  test('the pooled element is the SAME object across rows and iterations', () => {
    const { world, Position } = makeKit()
    const q = world.query(read(Position))
    for (let i = 0; i < 5; i++) world.spawnWith(Position)
    const seen = new Set<unknown>()
    q.each((e) => seen.add(e))
    q.each((e) => seen.add(e))
    expect(seen.size).toBe(1)
  })
})
