// the relation-pair query-term constructor rel.Pair(R, target|Wildcard) is now typed as a
// PairDef<R> (a QueryTerm), so a user can write query(rel.Pair(...)) WITHOUT an `as never` cast. This
// file deliberately uses no cast — if the typing regresses to `unknown`, this test stops compiling.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'
import type { PairDef, RelationDef } from '@ecsia/schema'

describe('rel.Pair query-term constructor (typed, no cast)', () => {
  test('rel.Pair returns a typed PairDef usable directly in query()', () => {
    const Name = defineComponent({ v: 'f32' }, { name: 'name' })
    const world = createWorld({ components: [Name] })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)

    const a = world.spawn()
    const b1 = world.spawn()
    const b2 = world.spawn()
    rel.addPair(a, Likes, b1)
    rel.addPair(a, Likes, b2)

    // Typed term — assignable to PairDef with no cast.
    const term: PairDef<RelationDef<void>> = rel.Pair(Likes, b1)
    expect(term.id).toBe(-1) // query-only pair term: UNREGISTERED until the compiler resolves it

    // Writable directly into query(...) with no `as never`.
    const wild = world.query(rel.Pair(Likes, Wildcard))
    expect(wild.count).toBe(1)

    const specific = world.query(rel.Pair(Likes, b1))
    expect(specific.count).toBe(1)
  })

  test('pair term composes with ordinary component terms in a multi-term query', () => {
    const Name = defineComponent({ v: 'f32' }, { name: 'name' })
    const world = createWorld({ components: [Name] })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    const parent = world.spawn()
    const child = world.spawnWith(Name)
    rel.addPair(child, ChildOf, parent)

    // Mixed arity: a pair term + a read term, both inferred, no cast.
    const q = world.query(rel.Pair(ChildOf, Wildcard), Name)
    expect(q.count).toBe(1)
  })
})
