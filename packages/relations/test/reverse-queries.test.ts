// Reverse queries — subjectsOf in both forms: the typed per-relation walk and the
// Wildcard-relation walk ("who points at this entity via ANYTHING?"). Both read the same
// back-ref index the despawn cascade unwinds, so the assertions pin the public contract:
// empty results for unrelated/dead/recycled targets, dedup across relations, the exclusive
// re-target hand-off, and agreement with cascade teardown in every mode.

import { describe, it, expect } from 'vitest'
import { createWorld } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

describe('subjectsOf(Wildcard, target) — reverse query across ALL relations', () => {
  it('unions subjects across relations: different pointers via different relations all appear', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const Damage = rel.defineRelation({ amount: 'u32' })

    const target = world.spawn()
    const fan = world.spawn()
    const child = world.spawn()
    const attacker = world.spawn()
    rel.addPair(fan, Likes, target)
    rel.addPair(child, ChildOf, target)
    rel.addPair(attacker, Damage, target, { amount: 5 })

    expect(new Set([...rel.subjectsOf(Wildcard, target)])).toEqual(new Set([fan, child, attacker]))
  })

  it('yields a subject ONCE even when it points at the target through several relations', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const Follows = rel.defineRelation(null)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    const target = world.spawn()
    const s = world.spawn()
    rel.addPair(s, Likes, target)
    rel.addPair(s, Follows, target)
    rel.addPair(s, ChildOf, target)

    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([s]) // deduped, not three entries
  })

  it('empty result: a target nobody points at yields nothing (live world, zero pairs)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    rel.defineRelation(null) // a registered relation with no pairs at all
    const lonely = world.spawn()
    expect([...rel.subjectsOf(Wildcard, lonely)]).toEqual([])
  })

  it('empty result after teardown: removing every incoming pair empties the walk', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const Follows = rel.defineRelation(null)
    const target = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Likes, target)
    rel.addPair(b, Follows, target)

    rel.removePair(a, Likes, target)
    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([b])
    rel.removePair(b, Follows, target)
    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([])
  })

  it('post-despawn: a dead target has no subjects, and a recycled slot does not alias the old one', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const target = world.spawn()
    const s = world.spawn()
    rel.addPair(s, Likes, target)
    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([s])

    world.despawn(target)
    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([]) // dead handle → nothing

    // The next spawn reuses the slot at a bumped generation — it must start with zero subjects.
    const recycled = world.spawn()
    expect([...rel.subjectsOf(Wildcard, recycled)]).toEqual([])
  })

  it('post-despawn: a dead SUBJECT is dropped from the walk', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const target = world.spawn()
    const survivor = world.spawn()
    const goner = world.spawn()
    rel.addPair(survivor, Likes, target)
    rel.addPair(goner, Likes, target)

    world.despawn(goner)
    expect([...rel.subjectsOf(Wildcard, target)]).toEqual([survivor])
  })

  it('exclusive re-target: the old parent loses the subject, the new parent gains it', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const p1 = world.spawn()
    const p2 = world.spawn()
    const child = world.spawn()

    rel.addPair(child, ChildOf, p1)
    expect([...rel.subjectsOf(Wildcard, p1)]).toEqual([child])
    expect([...rel.subjectsOf(Wildcard, p2)]).toEqual([])

    rel.addPair(child, ChildOf, p2) // the in-place re-target valve must move the back-ref too
    expect([...rel.subjectsOf(Wildcard, p1)]).toEqual([])
    expect([...rel.subjectsOf(Wildcard, p2)]).toEqual([child])
  })

  it("cascade deleteSubject: despawning the target unwinds the whole subtree's incoming links", () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const Likes = rel.defineRelation(null)
    const root = world.spawn()
    const child = world.spawn()
    const grandchild = world.spawn()
    const bystander = world.spawn()
    rel.addPair(child, ChildOf, root)
    rel.addPair(grandchild, ChildOf, child)
    rel.addPair(bystander, Likes, child) // a non-cascading link INTO the doomed subtree

    world.despawn(root)
    expect(world.isAlive(child)).toBe(false)
    expect(world.isAlive(grandchild)).toBe(false)
    expect(world.isAlive(bystander)).toBe(true) // Likes does not cascade
    // Every reverse walk over the dead subtree is empty; the bystander has no dangling pair left.
    expect([...rel.subjectsOf(Wildcard, root)]).toEqual([])
    expect([...rel.subjectsOf(Wildcard, child)]).toEqual([])
    expect(rel.hasRelation(bystander, Likes)).toBe(false)
  })

  it("cascade 'none': despawning the target drops only the pairs; surviving subjects keep their other links", () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const doomed = world.spawn()
    const other = world.spawn()
    const s = world.spawn()
    rel.addPair(s, Likes, doomed)
    rel.addPair(s, Likes, other)

    world.despawn(doomed)
    expect(world.isAlive(s)).toBe(true)
    expect([...rel.subjectsOf(Wildcard, doomed)]).toEqual([])
    expect([...rel.subjectsOf(Wildcard, other)]).toEqual([s]) // untouched by the neighbour's despawn
  })

  it('pre-despawn audit: the walk enumerates every direct pointer a despawn would resolve', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const Targets = rel.defineRelation(null)
    const hub = world.spawn()
    const child = world.spawn()
    const turret = world.spawn()
    rel.addPair(child, ChildOf, hub)
    rel.addPair(turret, Targets, hub)

    // The audit BEFORE the despawn sees both pointers; the despawn then resolves each per its
    // relation's cascade mode (child dies with the hub, the turret merely loses its pair).
    expect(new Set([...rel.subjectsOf(Wildcard, hub)])).toEqual(new Set([child, turret]))
    world.despawn(hub)
    expect(world.isAlive(child)).toBe(false)
    expect(world.isAlive(turret)).toBe(true)
    expect(rel.hasRelation(turret, Targets)).toBe(false)
  })
})

describe('subjectsOf(relation, target) — typed per-relation form stays scoped', () => {
  it('a specific relation never leaks subjects that point via a DIFFERENT relation', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const Follows = rel.defineRelation(null)
    const target = world.spawn()
    const liker = world.spawn()
    const follower = world.spawn()
    rel.addPair(liker, Likes, target)
    rel.addPair(follower, Follows, target)

    expect([...rel.subjectsOf(Likes, target)]).toEqual([liker])
    expect([...rel.subjectsOf(Follows, target)]).toEqual([follower])
  })

  it('empty result: a relation with no pairs to this target yields nothing', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const Follows = rel.defineRelation(null)
    const target = world.spawn()
    const s = world.spawn()
    rel.addPair(s, Likes, target)
    expect([...rel.subjectsOf(Follows, target)]).toEqual([])
  })

  it('post-despawn: a dead target yields nothing for the typed form too', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const target = world.spawn()
    const s = world.spawn()
    rel.addPair(s, Likes, target)
    world.despawn(target)
    expect([...rel.subjectsOf(Likes, target)]).toEqual([])
  })

  it('many subjects: the walk yields every live pointer exactly once', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const target = world.spawn()
    const subjects: EntityHandle[] = []
    for (let i = 0; i < 32; i++) {
      const s = world.spawn()
      rel.addPair(s, Likes, target)
      subjects.push(s)
    }
    expect(new Set([...rel.subjectsOf(Likes, target)])).toEqual(new Set(subjects))
    expect([...rel.subjectsOf(Likes, target)]).toHaveLength(subjects.length)
  })
})
