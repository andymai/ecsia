// query subsystem — cold-transparency and constraint-less spawn coherence.
// These tests DISCRIMINATE the two coherence gaps a reviewer found:
// - the [Symbol.iterator] surface must yield the SAME set as each() over a COLD matching archetype
// ( cold transparency on the iterator), and cold value props must resolve through the cold
// blocks (not surface as undefined);
// - a constraint-less query created BEFORE a plain world.spawn() must see the component-less entity,
// matching a query created AFTER the spawn (seed/incremental symmetry).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, optional, read, has } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import type { LiveQuery } from '../src/internal.js'

function coldKit(): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ x: 'f32', y: 'f32' }, { name: 'velocity' })
  // maxHotArchetypes: 1 keeps ONLY the empty archetype hot; any populated archetype lands cold.
  const world = createWorld({
    components: [Position, Velocity] as readonly ComponentDef<Schema>[],
    maxHotArchetypes: 1,
  })
  return { world, Position, Velocity }
}

describe('cold transparency on the iterator surface', () => {
  test('[...query] equals query.each() over a COLD matching archetype', () => {
    const { world, Position } = coldKit()
    const e0 = world.spawnWith(Position)
    const e1 = world.spawnWith(Position)
    const e2 = world.spawnWith(Position)

    // Precondition: the {Position} archetype is genuinely cold (else this would not discriminate).
    const q = world.query(read(Position))
    const arch = (q as unknown as LiveQuery).matchingArchetypes.find((a) => a.signature.length === 1)
    expect(arch?.cold).toBe(true)

    const eachSet: number[] = []
    q.each((e) => eachSet.push((e as { handle: EntityHandle }).handle as number))

    const iterSet: number[] = []
    for (const e of q) iterSet.push((e as { handle: EntityHandle }).handle as number)

    const sort = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)
    expect(sort(iterSet)).toEqual(sort(eachSet))
    expect(sort(iterSet)).toEqual(sort([e0, e1, e2].map((h) => h as number)))
    expect(q.count).toBe(3)
  })

  test('cold value props resolve through the cold blocks (not undefined)', () => {
    const { world, Position } = coldKit()
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position)
    world.entity(a).write(Position).x = 11
    world.entity(b).write(Position).x = 22

    const q = world.query(read(Position))
    expect((q as unknown as LiveQuery).matchingArchetypes.find((ar) => ar.signature.length === 1)?.cold).toBe(true)

    const byHandle = new Map<number, number>()
    q.each((e) => {
      const el = e as unknown as { handle: EntityHandle; position: { x: number } }
      byHandle.set(el.handle as number, el.position.x)
    })
    expect(byHandle.get(a as number)).toBe(11)
    expect(byHandle.get(b as number)).toBe(22)

    // The iterator surface reads the same cold values.
    const iterByHandle = new Map<number, number>()
    for (const e of q) {
      const el = e as unknown as { handle: EntityHandle; position: { x: number } }
      iterByHandle.set(el.handle as number, el.position.x)
    }
    expect(iterByHandle.get(a as number)).toBe(11)
    expect(iterByHandle.get(b as number)).toBe(22)
  })

  test('optional value over a cold archetype yields the cold value or undefined', () => {
    const { world, Position, Velocity } = coldKit()
    const withVel = world.spawnWith(Position, Velocity)
    const noVel = world.spawnWith(Position)
    world.entity(withVel).write(Velocity).x = 7

    const q = world.query(read(Position), optional(Velocity))
    // both matching archetypes ({P} and {P,V}) are cold under maxHotArchetypes: 1.
    expect((q as unknown as LiveQuery).matchingArchetypes.every((a) => a.cold)).toBe(true)

    const vel = new Map<number, number | undefined>()
    for (const e of q) {
      const el = e as unknown as { handle: EntityHandle; velocity: { x: number } | undefined }
      vel.set(el.handle as number, el.velocity?.x)
    }
    expect(vel.get(withVel as number)).toBe(7)
    expect(vel.get(noVel as number)).toBeUndefined()
  })
})

describe('constraint-less query before-spawn / after-spawn symmetry', () => {
  test('a pure-optional query created BEFORE a plain spawn sees the component-less entity', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const world = createWorld({ components: [Position] as readonly ComponentDef<Schema>[] })

    const before = world.query(optional(Position)) // constraint-less: matches everything
    const e = world.spawn() // component-less entity, lands in EMPTY

    expect(before.count).toBe(1)
    const seen: number[] = []
    before.each((el) => seen.push((el as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([e as number])

    // A query created AFTER the spawn must agree (seed/incremental symmetry).
    const after = world.query(optional(Position))
    expect(after.count).toBe(before.count)
  })

  test('despawn evicts the component-less entity from the constraint-less query', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const world = createWorld({ components: [Position] as readonly ComponentDef<Schema>[] })
    const q = world.query(optional(Position))
    const e = world.spawn()
    expect(q.count).toBe(1)
    world.despawn(e)
    expect(q.count).toBe(0)
  })

  test('a component-CONSTRAINED query does NOT pick up a plain spawn', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const world = createWorld({ components: [Position] as readonly ComponentDef<Schema>[] })
    const q = world.query(has(Position))
    world.spawn() // no Position → must NOT match
    expect(q.count).toBe(0)
  })
})
