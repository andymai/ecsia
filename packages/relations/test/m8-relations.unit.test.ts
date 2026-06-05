// relations — INSTRUMENTED unit tests (Exit criteria). These go beyond the
// behavioural smoke tests in m8-relations.test.ts: each asserts a STRUCTURAL property via an
// instrumented core seam (a migration counter wrapped around the RelationsHost) so the assertion
// discriminates the implementation choice, not just the observable result.
//
// - exclusive ChildOf re-parent is a FIELD WRITE → ZERO migrations after the first attach.
// - cascade deleteSubject removes a whole subtree ( ordering, iterative BFS).
// - getPair(s, Damage, t).weight reads/writes the OVERFLOW row (off-archetype payload).
// - Pair(R, Wildcard) matches every holder of ANY R-pair, exactly once each.
//
// createRelations(world) drives the core surface ONLY through world.__installRelations(); we wrap
// that single seam to count migrations without touching @ecsia/core source.

import { describe, it, expect } from 'vitest'
import { createWorld } from '@ecsia/core'
import type { ComponentDef, EntityHandle, RelationsHost, Schema, World } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

/** A migration counter wrapped around the RelationsHost — the ONLY way addPair/removePair move an
 * entity between archetypes (storage.addMany/removeMany via migrateAddingMany/migrateRemovingMany).
 * Counting them is how asserts "exclusive re-target performs ZERO migrations". */
interface Instrumented {
  world: World
  rel: ReturnType<typeof createRelations>
  counters: { adds: number; removes: number }
  reset(): void
}

function instrumentedRelations(options?: Parameters<typeof createWorld>[0]): Instrumented {
  const world = createWorld(options)
  const counters = { adds: 0, removes: 0 }
  // Wrap the world so createRelations sees a host whose migrate-many verbs are counted. createRelations
  // reads everything off the returned host (runtime.ts: `const host = world.__installRelations()`), so
  // intercepting this one seam fully instruments the structural path.
  const wrapped: World = Object.create(world) as World
  Object.defineProperty(wrapped, '__installRelations', {
    value(): RelationsHost {
      const host = world.__installRelations()
      const proxy: RelationsHost = Object.create(host) as RelationsHost
      proxy.migrateAddingMany = (handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void => {
        counters.adds += 1
        host.migrateAddingMany(handle, defs)
      }
      proxy.migrateRemovingMany = (handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void => {
        counters.removes += 1
        host.migrateRemovingMany(handle, defs)
      }
      return proxy
    },
  })
  const rel = createRelations(wrapped)
  return { world, rel, counters, reset: () => ((counters.adds = 0), (counters.removes = 0)) }
}

function archOf(world: World, handle: EntityHandle): number {
  return (world.entity(handle) as unknown as { __archetypeId: number }).__archetypeId
}

describe('unit — exclusive re-parent is a FIELD WRITE (ZERO migrations)', () => {
  it('the first attach migrates once; every subsequent re-target migrates ZERO times', () => {
    const { world, rel, counters, reset } = instrumentedRelations()
    const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
    const child = world.spawn()
    const parents: EntityHandle[] = []
    for (let i = 0; i < 50; i++) parents.push(world.spawn())

    reset()
    rel.addPair(child, ChildOf, parents[0]!, { weight: 0 }) // first attach
    expect(counters.adds).toBe(1) // exactly one migration to acquire the column-bearing presence id
    expect(counters.removes).toBe(0)
    const archAfterAttach = archOf(world, child)

    reset()
    // 49 re-parents. The T1 valve rewrites the eid target column in place — NO archetype move.
    for (let i = 1; i < parents.length; i++) rel.addPair(child, ChildOf, parents[i]!, { weight: i })
    expect(counters.adds).toBe(0) // <-- THE discriminator: zero migrations across every re-parent
    expect(counters.removes).toBe(0)
    expect(archOf(world, child)).toBe(archAfterAttach) // archetype invariant across all re-parents

    // The current target + payload reflect the LAST re-parent (the in-place column write is correct).
    const last = parents[parents.length - 1]!
    expect(rel.hasPair(child, ChildOf, last)).toBe(true)
    expect(rel.hasPair(child, ChildOf, parents[0]!)).toBe(false)
    expect(rel.getPair(child, ChildOf, last).read()['weight']).toBeCloseTo(parents.length - 1)
  })

  it('re-targeting to the SAME parent is a pure payload write — still zero migrations', () => {
    const { world, rel, counters, reset } = instrumentedRelations()
    const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
    const child = world.spawn()
    const p = world.spawn()
    rel.addPair(child, ChildOf, p, { weight: 1 })
    reset()
    rel.addPair(child, ChildOf, p, { weight: 9 }) // same target → no structural change at all
    expect(counters.adds).toBe(0)
    expect(counters.removes).toBe(0)
    expect(rel.getPair(child, ChildOf, p).read()['weight']).toBeCloseTo(9)
  })

  it('CONTRAST: a non-exclusive relation DOES migrate per distinct target (the fragmentation it valves)', () => {
    const { world, rel, counters, reset } = instrumentedRelations()
    const Likes = rel.defineRelation(null) // non-exclusive tag
    const a = world.spawn()
    const targets: EntityHandle[] = []
    for (let i = 0; i < 10; i++) targets.push(world.spawn())
    reset()
    for (const t of targets) rel.addPair(a, Likes, t)
    // Each distinct (R, target) is a distinct pair component → a real migration per target. This is
    // exactly the per-target churn the exclusive eid column eliminates ( contrast).
    expect(counters.adds).toBe(targets.length)
  })
})

describe('unit — cascade deleteSubject removes a SUBTREE', () => {
  it('despawning the root deletes every descendant in a deep tree (iterative BFS)', () => {
    const { world, rel } = instrumentedRelations()
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const root = world.spawn()
    // Build a fan-out tree: root → 3 children → 3 grandchildren each (13 entities total).
    const children: EntityHandle[] = []
    const grandchildren: EntityHandle[] = []
    for (let i = 0; i < 3; i++) {
      const c = world.spawn()
      rel.addPair(c, ChildOf, root)
      children.push(c)
      for (let j = 0; j < 3; j++) {
        const g = world.spawn()
        rel.addPair(g, ChildOf, c)
        grandchildren.push(g)
      }
    }
    expect(world.handleStats().aliveCount).toBe(13)

    world.despawn(root)
    expect(world.isAlive(root)).toBe(false)
    for (const c of children) expect(world.isAlive(c)).toBe(false)
    for (const g of grandchildren) expect(world.isAlive(g)).toBe(false)
    expect(world.handleStats().aliveCount).toBe(0) // the whole subtree is gone
  })

  it("cascade 'none' on a target delete removes only the dangling pair; subjects survive", () => {
    const { world, rel } = instrumentedRelations()
    const Likes = rel.defineRelation(null) // default cascade 'none'
    const target = world.spawn()
    const subjects: EntityHandle[] = []
    for (let i = 0; i < 5; i++) {
      const s = world.spawn()
      rel.addPair(s, Likes, target)
      subjects.push(s)
    }
    world.despawn(target)
    for (const s of subjects) {
      expect(world.isAlive(s)).toBe(true) // subject survives
      expect(rel.hasRelation(s, Likes)).toBe(false) // dangling pair dropped
    }
  })
})

describe('unit — getPair overflow row read/write', () => {
  it('Damage(s, t).weight lives in the overflow row, NOT a subject-archetype column', () => {
    const { world, rel, counters, reset } = instrumentedRelations()
    const Damage = rel.defineRelation({ weight: 'u32' }, { exclusive: false }) // → overflow-table
    const s = world.spawn()
    const a = world.spawn()
    const b = world.spawn()

    rel.addPair(s, Damage, a, { weight: 50 })
    rel.addPair(s, Damage, b, { weight: 30 })
    // Same subject holds DIFFERENT payloads to two targets — only an off-archetype overflow row can do
    // this (a subject column could hold one). Reading each back proves the per-(subject,target) row.
    expect(rel.getPair(s, Damage, a).read()['weight']).toBe(50)
    expect(rel.getPair(s, Damage, b).read()['weight']).toBe(30)

    // Writing through the accessor mutates the overflow row in place — no migration.
    reset()
    rel.getPair(s, Damage, a).write()['weight'] = 99
    expect(counters.adds).toBe(0)
    expect(counters.removes).toBe(0)
    expect(rel.getPair(s, Damage, a).read()['weight']).toBe(99)
    expect(rel.getPair(s, Damage, b).read()['weight']).toBe(30) // the other row is untouched

    // The subject still matches archetype-driven queries (the pair + presence bits ARE on the archetype).
    expect(rel.hasRelation(s, Damage)).toBe(true)
    expect(rel.hasPair(s, Damage, a)).toBe(true)
  })

  it('removing one overflow pair frees only its row; the other payload is intact', () => {
    const { world, rel } = instrumentedRelations()
    const Damage = rel.defineRelation({ weight: 'u32' }, { exclusive: false })
    const s = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(s, Damage, a, { weight: 7 })
    rel.addPair(s, Damage, b, { weight: 8 })
    rel.removePair(s, Damage, a)
    expect(rel.hasPair(s, Damage, a)).toBe(false)
    expect(rel.hasPair(s, Damage, b)).toBe(true)
    expect(rel.getPair(s, Damage, b).read()['weight']).toBe(8)
  })
})

describe('unit — Pair(R, Wildcard) matches every holder of ANY R-pair', () => {
  it('a wildcard query counts each holder once, regardless of how many pairs it holds', () => {
    const { world, rel } = instrumentedRelations()
    const Likes = rel.defineRelation(null)
    const holders: EntityHandle[] = []
    for (let i = 0; i < 6; i++) holders.push(world.spawn())
    const targets: EntityHandle[] = []
    for (let i = 0; i < 4; i++) targets.push(world.spawn())

    // Each holder likes ALL four targets (4 pairs each); a non-holder likes nothing.
    for (const h of holders) for (const t of targets) rel.addPair(h, Likes, t)
    const nonHolder = world.spawn()

    const wild = world.query(rel.Pair(Likes, Wildcard) as never)
    expect(wild.count).toBe(holders.length) // each of the 6 holders counted ONCE despite 4 pairs each

    // Adding a pair to the non-holder flips it into the wildcard set (presence bit appears).
    rel.addPair(nonHolder, Likes, targets[0]!)
    expect(world.query(rel.Pair(Likes, Wildcard) as never).count).toBe(holders.length + 1)

    // Removing all of a holder's pairs drops it from the wildcard set (presence bit removed at 0).
    for (const t of targets) rel.removePair(holders[0]!, Likes, t)
    expect(world.query(rel.Pair(Likes, Wildcard) as never).count).toBe(holders.length)
  })
})

describe('unit — Pair(R, specificTarget) honors the WORLD indexBits (non-default generationBits)', () => {
  it('a specific-target pair query resolves correctly when generationBits != 10', () => {
    // DISCRIMINATOR: with generationBits=14 the world's indexBits is 18, so the generation occupies
    // bits 18..31. A target whose slot has been recycled carries generation bits in 18..21 — exactly
    // the bits a HARDCODED 22-bit index mask would wrongly fold into the targetIndex. addPair keys via
    // host.handleIndex (correct 18-bit mask); resolvePair must use the SAME mask or the specific-target
    // query misses. We force a non-zero generation by recycling the target's slot, then assert the
    // query built from the recycled handle still matches its single subject.
    const world = createWorld({ maxEntities: 1 << 12, generationBits: 14 })
    expect(world.handleLayout.indexBits).toBe(18) // not the default 22 — the bug surfaces here
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)

    // Recycle a slot so the next spawn lands at the same index with a bumped generation (bits 18..21).
    const scratch = world.spawn()
    world.despawn(scratch)
    const target = world.spawn() // same index, generation now >= 1 → high bits set above indexBits 18
    expect(world.decodeHandle(target).generation).toBeGreaterThan(0)

    const subject = world.spawn()
    rel.addPair(subject, Likes, target)
    expect(rel.hasPair(subject, Likes, target)).toBe(true)

    // The specific-target query must resolve the SAME minted pair id addPair stored. A hardcoded 22-bit
    // mask would compute a targetIndex polluted by the generation bits, miss the mint, and count 0.
    const q = world.query(rel.Pair(Likes, target) as never)
    expect(q.count).toBe(1)
    expect([...rel.subjectsOf(Likes, target)]).toEqual([subject])
  })
})
