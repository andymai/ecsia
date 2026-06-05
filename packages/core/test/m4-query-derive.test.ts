// Query derivation invariants. derive(...) is sugar over world.query with the merged
// term list — it MUST ride the canonical-hash dedup (reference-identical to the directly-written
// combined query), narrow the match correctly, keep the parent untouched, chain, and carry its own
// (non-inherited) flavor state.

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

describe('derivation rides the canonical-hash dedup', () => {
  test('derived query IS the directly-written combined query (same LiveQuery)', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const moving = world.query(read(Velocity), write(Position))
    const movingMortals = moving.derive(read(Health))
    expect(movingMortals).toBe(world.query(read(Velocity), write(Position), read(Health)))
  })

  test('term order is irrelevant (the hash is order-independent)', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const derived = world.query(read(Position), write(Velocity)).derive(read(Health))
    expect(derived).toBe(world.query(read(Health), read(Position), write(Velocity)))
  })

  test('chained derivation equals one-shot derivation equals the direct query', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const base = world.query(read(Position))
    const chained = base.derive(write(Velocity)).derive(read(Health))
    expect(chained).toBe(base.derive(write(Velocity), read(Health)))
    expect(chained).toBe(world.query(read(Position), write(Velocity), read(Health)))
  })

  test('deriving with zero terms returns the SAME query', () => {
    const { world, Position } = makeKit()
    const q = world.query(read(Position))
    expect(q.derive()).toBe(q)
  })
})

describe('duplicate terms (consistent with world.query)', () => {
  test('re-deriving an already-present component matches the duplicate-listed direct query', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity))
    const d = q.derive(write(Position))
    // Same instance as the user writing the duplicate directly...
    expect(d).toBe(world.query(read(Position), read(Velocity), write(Position)))
    // ...and matching is identical to the deduped form (read/write split is type-level only).
    world.spawnWith(Position, Velocity)
    expect(d.count).toBe(1)
    expect(d.count).toBe(world.query(write(Position), read(Velocity)).count)
  })
})

describe('derived matching + incremental maintenance', () => {
  test('the derived query narrows; the parent is untouched', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const moving = world.query(read(Velocity), write(Position))
    const movingMortals = moving.derive(read(Health))
    world.spawnWith(Position, Velocity)
    world.spawnWith(Position, Velocity, Health)
    expect(moving.count).toBe(2)
    expect(movingMortals.count).toBe(1)
  })

  test('add/remove migrate entities in and out of the derived match', () => {
    const { world, Position, Health } = makeKit()
    const derived = world.query(read(Position)).derive(read(Health))
    const e = world.spawnWith(Position)
    expect(derived.count).toBe(0)
    world.add(e, Health)
    expect(derived.count).toBe(1)
    world.remove(e, Health)
    expect(derived.count).toBe(0)
  })

  test('without/optional terms derive per their normal semantics', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const derived = world.query(read(Position)).derive(without(Health), optional(Velocity))
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position, Velocity)
    world.spawnWith(Position, Health) // excluded by the derived without
    expect(derived.count).toBe(2)

    const velByHandle = new Map<number, unknown>()
    derived.each((e) => {
      const el = e as unknown as { handle: EntityHandle; velocity: unknown }
      velByHandle.set(el.handle as number, el.velocity)
    })
    expect(velByHandle.get(a as number)).toBeUndefined()
    expect(velByHandle.get(b as number)).toBeDefined()
  })

  test('iteration binds the merged value props (parent + new)', () => {
    const { world, Position, Velocity, Health } = makeKit()
    const movingMortals = world.query(read(Velocity), write(Position)).derive(read(Health))
    const e = world.spawnWith(Position, Velocity, Health)
    world.entity(e).write(Health).current = 7
    world.entity(e).write(Velocity).x = 2

    let seen = 0
    movingMortals.each((el) => {
      const v = el as unknown as { position: { x: number }; velocity: { x: number }; health: { current: number } }
      expect(v.health.current).toBe(7)
      v.position.x = v.velocity.x
      seen++
    })
    expect(seen).toBe(1)
    expect(world.entity(e).read(Position).x).toBe(2)
  })

  test('membership-only derivation (has) narrows without adding a value prop', () => {
    const { world, Position, Alive } = makeKit()
    const derived = world.query(read(Position)).derive(has(Alive))
    world.spawnWith(Position)
    world.spawnWith(Position, Alive)
    expect(derived.count).toBe(1)
    derived.each((e) => {
      expect((e as Record<string, unknown>)['alive']).toBeUndefined()
    })
  })
})

describe('flavors on a derived query', () => {
  test('added/removed flavors are the derived query\'s own (per cached-query state)', () => {
    const { world, Position, Health } = makeKit()
    const parent = world.query(read(Position)).added()
    const derived = parent.derive(read(Health)).added().removed()
    const e = world.spawnWith(Position)
    world.frameReset()
    world.add(e, Health)
    let derivedAdded = 0
    derived.eachAdded(() => derivedAdded++)
    expect(derivedAdded).toBe(1)
    world.frameReset()
    world.remove(e, Health)
    let derivedRemoved = 0
    derived.eachRemoved(() => derivedRemoved++)
    expect(derivedRemoved).toBe(1)
    // The parent never lost the entity — the Health migration is invisible to it.
    expect(parent.count).toBe(1)
  })
})
