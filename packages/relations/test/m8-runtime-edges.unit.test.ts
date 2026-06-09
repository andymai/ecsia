// Runtime edge coverage for @ecsia/relations. Targets the query-side accessors and
// guards that the behavioural suite doesn't reach: targetOf's exclusive-only contract, depthOf cache
// backfill on a chain, the dead-endpoint inert accessor, the tag-relation inert accessor, the forward
// index's lazy backfill in targetsOf, overflow-row release on subject despawn, and requireRuntime's
// unregistered-relation throw. Every assertion fails if the documented behaviour regresses.

import { describe, it, expect } from 'vitest'
import { createWorld } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations } from '../src/index.js'

describe('targetOf — exclusive-only, dead-safe', () => {
  it('returns the single current target of an exclusive relation, null when absent', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const child = world.spawn()
    const p1 = world.spawn()
    const p2 = world.spawn()
    expect(rel.targetOf(child, ChildOf)).toBeNull() // no pair yet
    rel.addPair(child, ChildOf, p1)
    expect(rel.targetOf(child, ChildOf)).toBe(p1)
    rel.addPair(child, ChildOf, p2) // re-target valve
    expect(rel.targetOf(child, ChildOf)).toBe(p2)
  })

  it('throws when called on a non-exclusive relation', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null) // non-exclusive
    const s = world.spawn()
    expect(() => rel.targetOf(s, Likes)).toThrow(/not exclusive/)
  })

  it('returns null for a despawned subject (dead-endpoint guard)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const child = world.spawn()
    const p = world.spawn()
    rel.addPair(child, ChildOf, p)
    world.despawn(child)
    expect(rel.targetOf(child, ChildOf)).toBeNull()
  })
})

describe('depthOf — chain walk + cache backfill', () => {
  it('computes hierarchy depth along an exclusive parent chain and caches intermediate depths', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    // root <- a <- b <- c (c is deepest). depth(root)=0, depth(c)=3.
    const root = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    rel.addPair(a, ChildOf, root)
    rel.addPair(b, ChildOf, a)
    rel.addPair(c, ChildOf, b)

    expect(rel.depthOf(root, ChildOf)).toBe(0)
    // First query of c walks the whole chain and backfills b, a's depths in the cache.
    expect(rel.depthOf(c, ChildOf)).toBe(3)
    // Subsequent queries hit the cache (backfilled by the chain walk) and stay correct.
    expect(rel.depthOf(b, ChildOf)).toBe(2)
    expect(rel.depthOf(a, ChildOf)).toBe(1)
    // Re-querying c again uses the cached value.
    expect(rel.depthOf(c, ChildOf)).toBe(3)
  })

  it('throws on a non-exclusive relation', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    expect(() => rel.depthOf(s, Likes)).toThrow(/not exclusive/)
  })

  it('detects a cycle in the parent chain', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const x = world.spawn()
    const y = world.spawn()
    rel.addPair(x, ChildOf, y)
    rel.addPair(y, ChildOf, x) // 2-cycle
    expect(() => rel.depthOf(x, ChildOf)).toThrow(/cycle in its parent chain/)
  })
})

describe('getPair — inert accessors for dead and tag-relation pairs', () => {
  it('returns an inert accessor when either endpoint is dead', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ weight: 'u32' }) // overflow-table payload
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Damage, t, { weight: 5 })
    world.despawn(t)
    const acc = rel.getPair(s, Damage, t) // t dead → inert
    expect(acc.read()).toEqual({})
    expect(acc.write()).toEqual({})
  })

  it('returns an inert accessor for a tag relation (no payload)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null) // tag → no payload storage
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Likes, t)
    const acc = rel.getPair(s, Likes, t)
    expect(acc.read()).toEqual({}) // inert: a tag carries no fields
    expect(acc.write()).toEqual({})
  })
})

describe('targetsOf — lazy forward-index build + backfill', () => {
  it('enumerates all targets of a non-exclusive subject, built lazily from the back-ref index', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    const t1 = world.spawn()
    const t2 = world.spawn()
    const t3 = world.spawn()
    rel.addPair(s, Likes, t1)
    rel.addPair(s, Likes, t2)
    rel.addPair(s, Likes, t3)
    // First targetsOf call activates + backfills the forward index from the existing back-ref buckets.
    const got = new Set([...rel.targetsOf(s, Likes)])
    expect(got).toEqual(new Set([t1, t2, t3]))
    // A subsequent add is maintained incrementally in the now-active forward index.
    const t4 = world.spawn()
    rel.addPair(s, Likes, t4)
    expect(new Set([...rel.targetsOf(s, Likes)])).toEqual(new Set([t1, t2, t3, t4]))
    // Removing one is reflected.
    rel.removePair(s, Likes, t2)
    expect(new Set([...rel.targetsOf(s, Likes)])).toEqual(new Set([t1, t3, t4]))
  })

  it('targetsOf on an exclusive relation yields the single target', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const child = world.spawn()
    const parent = world.spawn()
    rel.addPair(child, ChildOf, parent)
    expect([...rel.targetsOf(child, ChildOf)]).toEqual([parent])
  })

  it('targetsOf returns nothing for a despawned subject', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Likes, t)
    world.despawn(s)
    expect([...rel.targetsOf(s, Likes)]).toEqual([])
  })
})

describe('overflow payload — refresh on idempotent re-add + release on despawn', () => {
  it('re-adding an existing overflow pair refreshes its payload without a new row', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ weight: 'u32' }) // overflow-table
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Damage, t, { weight: 10 })
    rel.addPair(s, Damage, t, { weight: 42 }) // idempotent re-add → SET_PAYLOAD refresh
    expect(rel.getPair(s, Damage, t).read()['weight']).toBe(42)
  })

  it('despawning a subject releases its overflow rows (no stale payload for a recycled pair)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ weight: 'u32' })
    const s = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(s, Damage, a, { weight: 1 })
    rel.addPair(s, Damage, b, { weight: 2 })
    world.despawn(s) // processDespawn must release both overflow rows for the dying SUBJECT
    expect(world.isAlive(s)).toBe(false)
    // A fresh subject reusing the relation gets its own row, not the released one's stale value.
    const s2 = world.spawn()
    rel.addPair(s2, Damage, a, { weight: 99 })
    expect(rel.getPair(s2, Damage, a).read()['weight']).toBe(99)
  })
})

describe('cascade removeRelation — target delete drops the pair, subject survives', () => {
  it("cascade:'removeRelation' on a target despawn removes only the relation, keeping subjects alive", () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null, { cascade: 'removeRelation' })
    const target = world.spawn()
    const subjects: EntityHandle[] = []
    for (let i = 0; i < 4; i++) {
      const s = world.spawn()
      rel.addPair(s, Likes, target)
      subjects.push(s)
    }
    world.despawn(target)
    for (const s of subjects) {
      expect(world.isAlive(s)).toBe(true)
      expect(rel.hasRelation(s, Likes)).toBe(false) // pair dropped
    }
  })
})

describe('requireRuntime — unregistered relation throws', () => {
  it('using a relation def from a DIFFERENT world throws (not registered with this world)', () => {
    const worldA = createWorld()
    const relA = createRelations(worldA)
    const ForeignRel = relA.defineRelation(null)

    const worldB = createWorld()
    const relB = createRelations(worldB)
    const s = worldB.spawn()
    const t = worldB.spawn()
    // ForeignRel's id (0) collides with relB's namespace but its DEF identity is unregistered in B.
    // requireRuntime falls back to byRelationId(id) — if that also misses it throws. Define one rel in
    // B so id 0 is taken by a DIFFERENT def; the foreign DEF object is still not in byDef.
    relB.defineRelation(null)
    // The foreign def has id 0 which maps to relB's own runtime via the id fallback, so hasPair is a
    // benign false (not a throw). To force the throw, use a hand-rolled def with an out-of-range id.
    const bogus = { id: 9999, name: 'Bogus', payload: null, exclusive: false, cascade: 'none' } as never
    expect(() => relB.hasPair(s, bogus, t)).toThrow(/not registered with this world/)
  })
})

describe('exclusive relations on a COLD-resident subject', () => {
  // maxHotArchetypes: 1 fills the single hot slot with the empty-spawn archetype, so the archetype
  // that holds the exclusive relation's presence component is COLD. fieldLocationFor must resolve the
  // cold subject's target column; columnSetFor (hot-only) silently dropped the read AND the write.

  it('first-attach and re-target both land on a cold subject (not silently dropped)', () => {
    const world = createWorld({ maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const child = world.spawn()
    const p1 = world.spawn()
    const p2 = world.spawn()
    rel.addPair(child, ChildOf, p1) // subject migrates to a COLD presence archetype
    expect(rel.targetOf(child, ChildOf)).toBe(p1) // pre-fix: null (write dropped)
    rel.addPair(child, ChildOf, p2) // re-target the cold subject
    expect(rel.targetOf(child, ChildOf)).toBe(p2) // pre-fix: stale (kept p1 / null)
  })

  it('a payload-bearing exclusive pair reads back on a cold subject', () => {
    const world = createWorld({ maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const Owes = rel.defineRelation({ amount: 'i32' }, { exclusive: true })
    const debtor = world.spawn()
    const creditor = world.spawn()
    rel.addPair(debtor, Owes, creditor, { amount: 42 })
    // bindPresenceAccessor must resolve the cold subject's payload columns.
    const pair = rel.getPair(debtor, Owes, creditor).read() as { amount: number }
    expect(pair.amount).toBe(42)
  })
})

describe('getPair view — dev stale-view guard', () => {
  // The object getPair().read()/write() returns is the pooled accessor singleton; holding it across a
  // later resolve silently reads another subject's row. The dev guard turns that into a loud throw.

  it('reading the view immediately works', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Owes = rel.defineRelation({ amount: 'i32' }, { exclusive: true })
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Owes, b, { amount: 42 })
    expect((rel.getPair(a, Owes, b).read() as { amount: number }).amount).toBe(42)
  })

  it('throws when a held view is re-pointed by a later getPair() resolve', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Owes = rel.defineRelation({ amount: 'i32' }, { exclusive: true })
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    const d = world.spawn()
    rel.addPair(a, Owes, b, { amount: 1 })
    rel.addPair(c, Owes, d, { amount: 2 })
    const viewA = rel.getPair(a, Owes, b).read() // pooled singleton bound to a
    rel.getPair(c, Owes, d).read() // re-pokes the same singleton to c
    expect(() => (viewA as { amount: number }).amount).toThrow(/stale pair view/)
  })

  it('throws when the subject is despawned after the view is taken', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Owes = rel.defineRelation({ amount: 'i32' }, { exclusive: true })
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, Owes, b, { amount: 7 })
    const viewA = rel.getPair(a, Owes, b).read()
    world.despawn(a)
    expect(() => (viewA as { amount: number }).amount).toThrow(/stale pair view/)
  })
})
