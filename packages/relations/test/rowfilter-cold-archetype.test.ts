// Query-engine audit finding (2026-06-10): a row-filtered query (an exclusive specific-target pair
// term, rel.Pair(R, target)) must honor the filter even when the matching archetype is COLD. Cold
// status is a hot-budget decision (maxHotArchetypes), independent of relations — so a row-filtered
// archetype can be cold. The cold iteration + seeding paths used to skip the row filter, so each()
// leaked wrong-target subjects and `count` disagreed with `each()`.

import { describe, expect, it } from 'vitest'
import { createWorld } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

describe('relations — row filter honored on a COLD archetype', () => {
  it('rel.Pair(R, target) filters cold residents by their target, not just presence', () => {
    // maxHotArchetypes: 1 forces the ChildOf-presence archetype cold once the empty archetype takes
    // the single hot slot.
    const world = createWorld({ maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    const parentA = world.spawn()
    const parentB = world.spawn()
    const c1 = world.spawn()
    const c2 = world.spawn()
    rel.addPair(c1, ChildOf, parentA)
    rel.addPair(c2, ChildOf, parentB)

    const q = world.query(rel.Pair(ChildOf, parentA))

    const seen: EntityHandle[] = []
    q.each((e) => seen.push(e.handle))
    expect(seen).toEqual([c1]) // only the ChildOf→parentA subject, not c2
    expect(q.count).toBe(1) // count agrees with each()

    // The iterator twin (#eachColdGen) is a separately-fixed cold site — exercise it too.
    const seenIter: EntityHandle[] = []
    for (const e of q) seenIter.push(e.handle)
    expect(seenIter).toEqual([c1])
  })

  it('the wildcard pair term still returns all subjects on a cold archetype', () => {
    const world = createWorld({ maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    const pA = world.spawn()
    const pB = world.spawn()
    const c1 = world.spawn()
    const c2 = world.spawn()
    rel.addPair(c1, ChildOf, pA)
    rel.addPair(c2, ChildOf, pB)

    const all = world.query(rel.Pair(ChildOf, Wildcard))
    expect(all.count).toBe(2) // both subjects (no target filter)
  })
})
