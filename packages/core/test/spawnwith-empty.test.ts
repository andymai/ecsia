// Zero-spec spawnWith is legal under the variadic type and must behave exactly like spawn().
// The empty→empty self-migration it used to run duplicated the entity's row in the empty
// archetype and left its record pointing outside the live range — the next spawn aliased the
// slot, so queries yielded despawned entities and dropped live ones.

import { describe, expect, test } from 'vitest'
import { createWorld } from '../src/index.js'

describe('spawnWith() with no components', () => {
  test('behaves like spawn(): no duplicate row, no record corruption', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawnWith()
    const c = world.spawn()
    world.despawn(b)
    const seen = []
    for (const e of world.query()) seen.push(e.handle)
    expect(seen).toContain(a)
    expect(seen).toContain(c)
    expect(seen).not.toContain(b)
    expect(world.isAlive(a)).toBe(true)
    expect(world.isAlive(b)).toBe(false)
    expect(world.isAlive(c)).toBe(true)
  })
})
