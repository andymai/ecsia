// maxEntities is the mint ceiling, not just a region-sizing hint. Every fixed flat structure
// (bitmask, query sparse sets, reactivity rings) is sized by it, so an allocator that grows past it
// corrupts silently: bitmask writes become OOB no-ops and query sparse-set growth used to spin
// forever. The allocator must throw CapacityExceeded at the cap (world.md §6.2, entity-model.md §3.4).

import { expect, test } from 'vitest'
import { createWorld, defineComponent } from '../src/index.js'

test('spawning past maxEntities throws instead of corrupting', () => {
  const P = defineComponent({ x: 'f32' }, { name: 'P' })
  const world = createWorld({ maxEntities: 8, components: [P] })
  const spawned = []
  let threw = false
  try {
    for (let i = 0; i < 12; i++) spawned.push(world.spawn())
  } catch { threw = true }
  expect(threw).toBe(true)
  expect(spawned.length).toBeLessThanOrEqual(8)
})

test('has() stays truthful at the cap boundary', () => {
  const P = defineComponent({ x: 'f32' }, { name: 'P' })
  const world = createWorld({ maxEntities: 8, components: [P] })
  for (let i = 0; i < 7; i++) world.spawn()
  const h = world.spawn()
  world.add(h, P)
  expect(world.has(h, P)).toBe(true)
})
