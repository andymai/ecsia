// Two relations-subsystem audit findings (2026-06-10), each a fixed bug pinned here:
//
//  1. Structural mutation during query iteration must throw the dev iteration-mutation guard. The
//     single-id world.add/remove/despawn guarded it, but rel.addPair/removePair reach storage via
//     the migrateAddingMany/migrateRemovingMany seams, which used to skip the guard — so a pair
//     mutation mid-iteration silently swap-popped rows under the cursor instead of throwing.
//
//  2. A reused overflow payload row must be re-defaulted. The overflow free-list handed back a
//     released row still holding the previous tenant's bytes; a partial-payload addPair onto it read
//     the prior pair's values in the fields it didn't write.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, field, read, vec } from '@ecsia/core'
import { createRelations } from '../src/index.js'

describe('relations — iteration-mutation guard on pair ops', () => {
  // Fresh def per test: a component def registers to exactly one world for its lifetime.
  const mkPos = () => defineComponent({ x: 'i32' }, { name: 'pos' })

  it('addPair during a live query iteration throws (not silent corruption)', () => {
    const Pos = mkPos()
    const world = createWorld({ components: [Pos] })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null)
    const parent = world.spawn()
    for (let i = 0; i < 5; i++) world.spawnWith([Pos, { x: i }])

    let visits = 0
    let threw = false
    try {
      world.query(read(Pos)).each((e) => {
        visits++
        rel.addPair(e.handle, ChildOf, parent)
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // It threw on the FIRST attempted mutation (one visit recorded), never running the body the 10
    // times a swap-pop would.
    expect(visits).toBe(1)
  })

  it('removePair during a live query iteration throws', () => {
    const Pos = mkPos()
    const world = createWorld({ components: [Pos] })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null)
    const parent = world.spawn()
    const kids = Array.from({ length: 4 }, () => world.spawnWith([Pos, { x: 0 }]))
    for (const k of kids) rel.addPair(k, ChildOf, parent)

    let threw = false
    try {
      world.query(read(Pos)).each((e) => {
        rel.removePair(e.handle, ChildOf, parent)
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('control: the same pair op OUTSIDE iteration is fine', () => {
    const Pos = mkPos()
    const world = createWorld({ components: [Pos] })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null)
    const parent = world.spawn()
    const child = world.spawnWith([Pos, { x: 1 }])
    expect(() => rel.addPair(child, ChildOf, parent)).not.toThrow()
    expect(() => rel.removePair(child, ChildOf, parent)).not.toThrow()
  })
})

describe('relations — overflow payload row reuse re-defaults', () => {
  it('a partial-payload addPair onto a recycled row reads defaults, not the prior tenant', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ weight: 'u32', kind: 'u8' }) // non-exclusive payload → overflow
    const s1 = world.spawn()
    const s2 = world.spawn()
    const a = world.spawn()
    const b = world.spawn()

    rel.addPair(s1, Damage, a, { weight: 777, kind: 3 })
    rel.removePair(s1, Damage, a) // releases the overflow row to the free-list

    // Reuses the freed row, writing only `weight` — `kind` must come back to its 0 default.
    rel.addPair(s2, Damage, b, { weight: 1 })
    const p = rel.getPair(s2, Damage, b).read() as { weight: number; kind: number }
    expect(p.weight).toBe(1)
    expect(p.kind).toBe(0) // re-defaulted, NOT the leaked 3
  })

  it('multiple released rows recycle cleanly (no cross-tenant bleed across the free-list)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Damage = rel.defineRelation({ weight: 'u32', kind: 'u8' })
    const subs = Array.from({ length: 3 }, () => world.spawn())
    const tgt = world.spawn()

    for (const [i, s] of subs.entries()) rel.addPair(s, Damage, tgt, { weight: 10 + i, kind: 9 })
    for (const s of subs) rel.removePair(s, Damage, tgt) // all three rows to the free-list

    const fresh = Array.from({ length: 3 }, () => world.spawn())
    for (const f of fresh) rel.addPair(f, Damage, tgt, { weight: 5 }) // partial: omit kind
    for (const f of fresh) {
      const p = rel.getPair(f, Damage, tgt).read() as { weight: number; kind: number }
      expect(p.weight).toBe(5)
      expect(p.kind).toBe(0)
    }
  })

  it('a vec payload field honors its NON-UNIFORM default (fresh + reused row)', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const Aim = rel.defineRelation({ dir: field(vec('f32', 3), { default: [1, 2, 3] }), kind: 'u8' })
    const t = world.spawn()

    // Fresh row, partial payload (omit dir): a uniform fillOnInit would give [0,0,0] — the per-lane
    // init gives the real default.
    const s1 = world.spawn()
    rel.addPair(s1, Aim, t, { kind: 7 })
    const p1 = rel.getPair(s1, Aim, t).read() as { dir: { x: number; y: number; z: number } }
    expect([p1.dir.x, p1.dir.y, p1.dir.z]).toEqual([1, 2, 3])

    // Reused row: free it, then a new partial-payload pair reuses it — still the per-lane default.
    rel.removePair(s1, Aim, t)
    const s2 = world.spawn()
    rel.addPair(s2, Aim, t, { kind: 9 })
    const p2 = rel.getPair(s2, Aim, t).read() as { dir: { x: number; y: number; z: number } }
    expect([p2.dir.x, p2.dir.y, p2.dir.z]).toEqual([1, 2, 3])
  })
})
