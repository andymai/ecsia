// relations runtime invariants. Exercises the full createRelations(world) seam
// end-to-end: tag/exclusive/overflow storage kinds, presence bit, idempotent index-keyed mint
// zero-migration exclusive re-target, cascade ordering, wildcard O(1) match,
// overflow payload, back-ref bucket reclaim, and lazy depth.

import { describe, it, expect } from 'vitest'
import { createWorld } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

describe(' relations — storage-kind resolution & structural ops', () => {
  it('tag relation: addPair sets the pair + presence bits; hasPair / hasRelation track them ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null) // payload-free → tag
    const parent = world.spawn()
    const child = world.spawn()

    expect(rel.hasRelation(child, ChildOf)).toBe(false)
    rel.addPair(child, ChildOf, parent)
    expect(rel.hasPair(child, ChildOf, parent)).toBe(true)
    expect(rel.hasRelation(child, ChildOf)).toBe(true)

    rel.removePair(child, ChildOf, parent)
    expect(rel.hasPair(child, ChildOf, parent)).toBe(false)
    expect(rel.hasRelation(child, ChildOf)).toBe(false) // presence dropped at the last R-pair
  })

  it('mintPair is idempotent and keyed by target index: re-add is stable, no double presence', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Likes, b)
    rel.addPair(a, Likes, b) // idempotent
    expect(rel.hasPair(a, Likes, b)).toBe(true)
    expect([...rel.subjectsOf(Likes, b)]).toEqual([a])
  })

  it('exclusive re-target is a field write, no archetype churn after the first attach ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
    const child = world.spawn()
    const p1 = world.spawn()
    const p2 = world.spawn()
    const p3 = world.spawn()

    rel.addPair(child, ChildOf, p1, { weight: 1 }) // first attach: one migration
    expect(rel.hasPair(child, ChildOf, p1)).toBe(true)
    const archAfterAttach = archOf(world, child)

    // Re-target repeatedly. The T1 valve rewrites the eid column in place — NO archetype move, so the
    // child's archetype id is invariant across every re-parent.
    rel.addPair(child, ChildOf, p2, { weight: 2 })
    expect(archOf(world, child)).toBe(archAfterAttach)
    rel.addPair(child, ChildOf, p3, { weight: 3 })
    expect(archOf(world, child)).toBe(archAfterAttach)

    expect(rel.hasPair(child, ChildOf, p1)).toBe(false)
    expect(rel.hasPair(child, ChildOf, p3)).toBe(true)
    expect(rel.getPair(child, ChildOf, p3).read()['weight']).toBeCloseTo(3)
    expect([...rel.subjectsOf(ChildOf, p1)]).toEqual([])
    expect([...rel.subjectsOf(ChildOf, p3)]).toEqual([child])
  })

  it('overflow-table relation: payload lives off-archetype, readable via getPair ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ amount: 'u32' }, { exclusive: false })
    const attacker = world.spawn()
    const b = world.spawn()
    const c = world.spawn()

    rel.addPair(attacker, Damage, b, { amount: 50 })
    rel.addPair(attacker, Damage, c, { amount: 30 })
    expect(rel.getPair(attacker, Damage, b).read()['amount']).toBe(50)
    expect(rel.getPair(attacker, Damage, c).read()['amount']).toBe(30)
    expect(rel.hasRelation(attacker, Damage)).toBe(true)

    rel.getPair(attacker, Damage, b).write()['amount'] = 99
    expect(rel.getPair(attacker, Damage, b).read()['amount']).toBe(99)
  })
})

describe(' relations — wildcard query, cascade, back-ref, depth', () => {
  it('Pair(R, Wildcard) matches via the presence bit; Pair(R, target) matches the specific pair ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const a = world.spawn()
    const b1 = world.spawn()
    const b2 = world.spawn()
    rel.addPair(a, Likes, b1)
    rel.addPair(a, Likes, b2)

    const wild = world.query(rel.Pair(Likes, Wildcard) as never)
    expect(wild.count).toBe(1) // a holds at least one Likes pair, counted once (O(1) presence)

    const specific = world.query(rel.Pair(Likes, b1) as never)
    expect(specific.count).toBe(1)

    const c = world.spawn()
    const neverMinted = world.query(rel.Pair(Likes, c) as never)
    expect(neverMinted.count).toBe(0) // querying a never-minted pair matches nothing & does not mint
  })

  it('exclusive Pair(R, specificParent) row-filters by the eid column', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
    const p1 = world.spawn()
    const p2 = world.spawn()
    const c1 = world.spawn()
    const c2 = world.spawn()
    rel.addPair(c1, ChildOf, p1, { weight: 1 })
    rel.addPair(c2, ChildOf, p2, { weight: 1 })

    expect(world.query(rel.Pair(ChildOf, p1) as never).count).toBe(1)
    expect(world.query(rel.Pair(ChildOf, p2) as never).count).toBe(1)
    expect(world.query(rel.Pair(ChildOf, Wildcard) as never).count).toBe(2)
  })

  it('cascade deleteSubject deletes children iteratively; none mode just drops dangling pairs', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const root = world.spawn()
    const child = world.spawn()
    const grandchild = world.spawn()
    rel.addPair(child, ChildOf, root)
    rel.addPair(grandchild, ChildOf, child)

    world.despawn(root)
    expect(world.isAlive(child)).toBe(false) // cascaded
    expect(world.isAlive(grandchild)).toBe(false) // iterative BFS reached the grandchild
  })

  it("cascade 'none': deleting the target removes the dangling pair, subject survives ", () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null) // default cascade none
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Likes, b)
    world.despawn(b)
    expect(world.isAlive(a)).toBe(true)
    expect(rel.hasRelation(a, Likes)).toBe(false) // dangling pair removed before b's slot recycles
  })

  it('back-ref buckets are reclaimed when empty ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Likes, b)
    expect([...rel.subjectsOf(Likes, b)]).toEqual([a])
    rel.removePair(a, Likes, b)
    expect([...rel.subjectsOf(Likes, b)]).toEqual([]) // empty bucket, no leak
  })

  it('lazy depthOf walks the exclusive parent chain; throws on non-exclusive ', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const root = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, ChildOf, root)
    rel.addPair(b, ChildOf, a)
    expect(rel.depthOf(root, ChildOf)).toBe(0)
    expect(rel.depthOf(a, ChildOf)).toBe(1)
    expect(rel.depthOf(b, ChildOf)).toBe(2)

    const NonExcl = rel.defineRelation(null)
    expect(() => rel.depthOf(root, NonExcl)).toThrow()
  })

  it('drop-if-dead: addPair to a dead subject or target is a no-op', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const a = world.spawn()
    const b = world.spawn()
    world.despawn(b)
    rel.addPair(a, Likes, b) // dead target → dropped
    expect(rel.hasRelation(a, Likes)).toBe(false)
  })
})

function archOf(world: ReturnType<typeof createWorld>, handle: number): number {
  return (world.entity(handle as never) as unknown as { __archetypeId: number }).__archetypeId
}
