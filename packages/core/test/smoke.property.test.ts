import fc from 'fast-check'
import { expect, test } from 'vitest'
import { createWorld } from '@ecsia/core'

// Proves the fast-check runner is wired into CI and shrinking works (build-plan.md M0).
test('fast-check property runner is wired', () => {
  fc.assert(fc.property(fc.integer(), (n) => Number.isInteger(n)))
})

// A real M0 invariant: any valid maxEntities within the index space resolves and round-trips.
test('maxEntities within the index width always resolves', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2 ** 22 }), (maxEntities) => {
      expect(createWorld({ maxEntities }).options.maxEntities).toBe(maxEntities)
    }),
  )
})
