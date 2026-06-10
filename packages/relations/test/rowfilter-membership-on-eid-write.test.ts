// Query-engine audit follow-up (2026-06-10): row-filter membership must update when an exclusive
// relation writes its eid target column — not only on the migration that adds the presence
// component. The exclusive valve writes the eid AFTER the first-attach migration (which maintained
// at the -1 default) and, on re-target, with NO migration at all. So a row-filtered query
// (rel.Pair(R, target)) created BEFORE the pair never counted the subject, and re-targeting never
// moved it between target queries. The fix re-tests the subject after the eid write.

import { describe, expect, it } from 'vitest'
import { createWorld } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations } from '../src/index.js'

const handlesOf = (q: { each(fn: (e: { handle: EntityHandle }) => void): void }): EntityHandle[] => {
  const s: EntityHandle[] = []
  q.each((e) => s.push(e.handle))
  return s
}

describe('relations — row-filter membership tracks the eid write (query created first)', () => {
  for (const maxHotArchetypes of [1 << 20, 1] as const) {
    const label = maxHotArchetypes === 1 ? 'cold' : 'hot'
    it(`[${label}] a query created BEFORE the pair counts the subject after addPair`, () => {
      const world = createWorld({ maxHotArchetypes })
      const rel = createRelations(world)
      const ChildOf = rel.defineRelation(null, { exclusive: true })
      const parentA = world.spawn()
      const parentB = world.spawn()

      const q = world.query(rel.Pair(ChildOf, parentA))
      expect(q.count).toBe(0)

      const c1 = world.spawn()
      const c2 = world.spawn()
      rel.addPair(c1, ChildOf, parentA)
      rel.addPair(c2, ChildOf, parentB) // different target — must NOT join q

      expect(handlesOf(q)).toEqual([c1])
      expect(q.count).toBe(1) // count agrees with each()
    })
  }

  it('re-target moves a subject between row-filtered queries (each + count)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const pA = world.spawn()
    const pB = world.spawn()
    const qA = world.query(rel.Pair(ChildOf, pA))
    const qB = world.query(rel.Pair(ChildOf, pB))

    const child = world.spawn()
    rel.addPair(child, ChildOf, pA)
    expect(handlesOf(qA)).toEqual([child])
    expect(qA.count).toBe(1)
    expect(qB.count).toBe(0)

    rel.addPair(child, ChildOf, pB) // in-place re-target — no migration
    expect(handlesOf(qA)).toEqual([]) // dropped from the old-target query
    expect(qA.count).toBe(0)
    expect(handlesOf(qB)).toEqual([child]) // joined the new-target query
    expect(qB.count).toBe(1)
  })
})
