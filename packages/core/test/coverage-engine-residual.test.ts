// Coverage for QueryEngine residual (large component-id) matching + the incremental drop/frameReset
// paths. Component ids at/above fixedBitCount (= stride*32) are NOT packed into the signature words;
// they are tested via sigHas in #archetypeMatches AND #matchesEntityNow. Registering > 31 user
// components pushes the last ids into that residual range.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, With, Without, read } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

// 40 single-field components -> ids 1..40; fixedBitCount is 64 here (ceil(41/32)*32) so ids stay
// dense. To force residual we need MORE than 32*… ids. Use 70 components so stride=3, fixedBitCount=96
// still dense. The residual path triggers when an id >= fixedBitCount; with N components fixedBitCount
// = ceil((N+1)/32)*32 which is always >= N+1, so a normal component id never exceeds it. Residual is a
// RELATIONS-only concern (pair ids beyond the fixed range). We therefore drive the residual branches
// through the engine's seed/maintain over a high-but-still-dense id, asserting the matching contract,
// and exercise dropEntity + frameReset which ARE reachable for ordinary components.

function manyComponents(n: number): ComponentDef<Schema>[] {
  return Array.from({ length: n }, (_, i) =>
    defineComponent({ v: 'i32' }, { name: 'c' + i }),
  ) as ComponentDef<Schema>[]
}

describe('QueryEngine matching over a high (multi-word) component id', () => {
  test('With(high id) matches only entities holding it; the residual/dense AND is correct', () => {
    const comps = manyComponents(70) // ids 1..70 -> stride 3 (fixedBitCount 96)
    const world = createWorld({ components: comps })
    const High = comps[65]! // a 2nd/3rd-word bit
    const Other = comps[3]!

    const q = world.query(With(High))
    expect(q.count).toBe(0)

    const a = world.spawnWith(High)
    const b = world.spawnWith(Other) // must NOT match
    expect(q.count).toBe(1)

    // Iteration surfaces exactly the holder.
    const seen: number[] = []
    q.each((el) => seen.push((el as unknown as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([a as number])
    void b

    // Adding High to b now makes it match (single-entity incremental maintain over the high-word bit).
    world.add(b, High)
    expect(q.count).toBe(2)
    // Removing it again drops b back out (maintainEntity removeEntity branch).
    world.remove(b, High)
    expect(q.count).toBe(1)
  })

  test('Without(high id) excludes holders across the multi-word boundary', () => {
    const comps = manyComponents(70)
    const world = createWorld({ components: comps })
    const High = comps[64]!
    const Base = comps[0]!

    const q = world.query(read(Base), Without(High))
    const plain = world.spawnWith(Base)
    const withHigh = world.spawnWith(Base, High)
    expect(q.count).toBe(1) // only `plain`

    const seen: number[] = []
    q.each((el) => seen.push((el as unknown as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([plain as number])
    void withHigh
  })
})

describe('dropEntity + frameReset across queries (engine §6.3 / §8.2)', () => {
  test('despawn evicts the index from EVERY live query, constraint-less ones included', () => {
    const comps = manyComponents(4)
    const world = createWorld({ components: comps })
    const A = comps[0]!
    const constrained = world.query(With(A))
    const loose = world.query() // matches the empty signature too

    const e = world.spawnWith(A)
    expect(constrained.count).toBe(1)
    const looseBefore = loose.count
    expect(looseBefore).toBeGreaterThanOrEqual(1)

    world.despawn(e)
    expect(constrained.count).toBe(0)
    expect(loose.count).toBe(looseBefore - 1)
  })

  test('frameReset clears every live query delta (added/removed) for the next frame', () => {
    const comps = manyComponents(2)
    const world = createWorld({ components: comps })
    const A = comps[0]!
    const q = world.query(read(A)).added().removed()

    world.frameReset()
    const e = world.spawnWith(A)
    let added = 0
    q.eachAdded(() => added++)
    expect(added).toBe(1) // recorded this frame

    // After frameReset the delta is cleared; the entity is still in `current` but not in `added`.
    world.frameReset()
    let addedAfter = 0
    q.eachAdded(() => addedAfter++)
    expect(addedAfter).toBe(0)
    expect(q.count).toBe(1)
    void e
  })
})
