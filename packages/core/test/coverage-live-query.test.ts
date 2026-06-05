// Edge-case coverage for LiveQuery flavor + iteration corners reached through the public world:
//   - changed(...components) with an EXPLICIT component subset (#resolveChangedComponents id push);
//   - eachAdded/eachRemoved/eachChanged guard arms when no delta / no reactivity is declared;
//   - the scattered-index cold branch (eachAdded over a COLD matching archetype);
//   - a cold OPTIONAL value term whose component block was never cold-allocated -> undefined prop.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, optional, read, write } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

function kit(opts?: { maxHotArchetypes?: number }): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ x: 'f32', y: 'f32' }, { name: 'velocity' })
  const components = [Position, Velocity] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ ...opts, components }), Position, Velocity }
}

describe('changed(...components): explicit subset resolution', () => {
  test('changed(Position) drains only writes to the named component', () => {
    const { world, Position, Velocity } = kit()
    const q = world.query(read(Position), read(Velocity)).changed(Position)
    const e = world.spawnWith(Position, Velocity)
    world.frameReset()

    // A write to Velocity (NOT named in changed()) must not surface; a write to Position must.
    ;(world.entity(e).write(Velocity) as { x: number }).x = 1
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(0)

    ;(world.entity(e).write(Position) as { x: number }).x = 2
    q.eachChanged((el) => {
      // the pooled element exposes the named value term
      expect((el as unknown as { handle: EntityHandle }).handle as number).toBe(e as number)
      changed++
    })
    expect(changed).toBe(1)
  })

  test('changed() with no args falls back to the whole referenced set', () => {
    const { world, Position, Velocity } = kit()
    const q = world.query(read(Position), read(Velocity)).changed()
    const e = world.spawnWith(Position, Velocity)
    world.frameReset()
    ;(world.entity(e).write(Velocity) as { x: number }).x = 9 // a Velocity write now counts
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(1)
  })
})

describe('flavor drain guards when nothing is declared', () => {
  test('eachAdded / eachRemoved are inert when no delta is declared', () => {
    const { world, Position } = kit()
    const q = world.query(read(Position)) // no .added()/.removed()
    world.spawnWith(Position)
    let added = 0
    let removed = 0
    q.eachAdded(() => added++)
    q.eachRemoved(() => removed++)
    expect(added).toBe(0)
    expect(removed).toBe(0)
  })

  test('eachChanged is inert when .changed() was never declared', () => {
    const { world, Position } = kit()
    const q = world.query(read(Position))
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 3
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(0) // not declared -> drain short-circuits
  })

  test('declaring .added() but not .removed() leaves eachRemoved inert', () => {
    const { world, Position } = kit()
    const q = world.query(read(Position)).added()
    world.spawnWith(Position)
    let removed = 0
    q.eachRemoved(() => removed++)
    expect(removed).toBe(0) // hasRemoved is false
  })
})

describe('added delta over a COLD matching archetype (scattered cold-bind path)', () => {
  test('eachAdded binds a cold row via the cold blocks, surfacing the cold value', () => {
    // maxHotArchetypes 1 keeps only EMPTY hot; {Position} is cold.
    const { world, Position } = kit({ maxHotArchetypes: 1 })
    const q = world.query(read(Position)).added()
    world.frameReset() // clear any pre-existing delta

    const e = world.spawnWith(Position) // migrates into the COLD {Position} archetype this frame
    ;(world.entity(e).write(Position) as { x: number }).x = 33
    expect(q.matchingArchetypes.find((a) => a.signature.length === 1)?.cold).toBe(true)

    const seen: Array<{ handle: number; x: number }> = []
    q.eachAdded((el) => {
      const e2 = el as unknown as { handle: EntityHandle; position: { x: number } }
      seen.push({ handle: e2.handle as number, x: e2.position.x })
    })
    expect(seen).toEqual([{ handle: e as number, x: 33 }])
  })
})

describe('cold optional value whose block was never allocated -> undefined', () => {
  test('optional(Velocity) over a cold {Position} archetype yields undefined when no Velocity is cold', () => {
    const { world, Position, Velocity } = kit({ maxHotArchetypes: 1 })
    // Only Position entities exist; the Velocity cold block is never created.
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position)
    ;(world.entity(a).write(Position) as { x: number }).x = 1
    ;(world.entity(b).write(Position) as { x: number }).x = 2

    const q = world.query(read(Position), optional(Velocity))
    expect(q.matchingArchetypes.some((ar) => ar.cold)).toBe(true)

    const vel = new Map<number, number | undefined>()
    q.each((el) => {
      const e = el as unknown as { handle: EntityHandle; velocity: { x: number } | undefined; position: { x: number } }
      vel.set(e.handle as number, e.velocity?.x)
      // the Position value still resolves through the cold block
      expect(typeof e.position.x).toBe('number')
    })
    expect(vel.get(a as number)).toBeUndefined()
    expect(vel.get(b as number)).toBeUndefined()
  })
})

describe('removed delta surfaces the despawned index + handle', () => {
  test('eachRemoved reports an entity that left the query this frame', () => {
    const { world, Position } = kit()
    const q = world.query(read(Position)).removed()
    const e = world.spawnWith(Position)
    expect(q.count).toBe(1)
    world.frameReset()
    world.despawn(e)
    expect(q.count).toBe(0)
    const removedIdx: number[] = []
    const removedHandles: number[] = []
    q.eachRemoved((index, handle) => {
      removedIdx.push(index)
      removedHandles.push(handle as number)
    })
    // The despawned entity (the only one, the first allocated -> index 0) is reported exactly once.
    expect(removedIdx).toEqual([0])
    // eachRemoved surfaces the handle of the entity that was actually removed — captured at removal
    // time, NOT re-derived after despawn bumped the slot's generation.
    expect(removedHandles).toEqual([e as number])
  })

  test('write surfaces in eachChanged after the explicit drain (declared, write happens)', () => {
    const { world, Position } = kit()
    const q = world.query(write(Position)).changed()
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 7
    const seen: number[] = []
    q.eachChanged((el) => seen.push((el as unknown as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([e as number])
  })
})
