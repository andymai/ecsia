// A mid-chain re-target must invalidate memoized depths for the whole moved subtree, not just
// the re-targeted subject — hierarchy-ordered iteration (parents before children) silently
// breaks if a descendant keeps a depth computed through the old parent chain.

import { describe, expect, test } from 'vitest'
import { createWorld } from '@ecsia/core'
import { createRelations } from '../src/index.js'

describe('depthOf after exclusive re-target', () => {
  test('descendants of a re-targeted subject see their new depth', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const root = world.spawn()
    const c = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(c, ChildOf, root)     // c -> root        (depth 1)
    rel.addPair(a, ChildOf, root)     // a -> root        (depth 1)
    rel.addPair(b, ChildOf, a)        // b -> a -> root   (depth 2)
    expect(rel.depthOf(root, ChildOf)).toBe(0)
    expect(rel.depthOf(a, ChildOf)).toBe(1)
    expect(rel.depthOf(b, ChildOf)).toBe(2)   // warm the cache through the old chain
    rel.addPair(a, ChildOf, c)        // re-target: a -> c -> root
    expect(rel.depthOf(a, ChildOf)).toBe(2)
    expect(rel.depthOf(b, ChildOf)).toBe(3)   // stale cache returned 2
  })

  test('depths recompute after removePair detaches a mid-chain subject', () => {
    const world = createWorld()
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const root = world.spawn()
    const a = world.spawn()
    const b = world.spawn()
    rel.addPair(a, ChildOf, root)
    rel.addPair(b, ChildOf, a)
    expect(rel.depthOf(b, ChildOf)).toBe(2)
    rel.removePair(a, ChildOf, root)  // a becomes a root
    expect(rel.depthOf(a, ChildOf)).toBe(0)
    expect(rel.depthOf(b, ChildOf)).toBe(1)
  })
})
