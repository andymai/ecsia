// P0.5 Wave-1: user-facing throw messages must not leak internal ticket refs ('Must-Fix #1', 'PA-2',
// spec section numbers) and should be actionable. This locks in the scrubbed messages.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTag } from '@ecsia/core'

describe('P0.5 scrubbed, actionable error messages', () => {
  test('unregistered-component error hints at createWorld({ components })', () => {
    const Registered = defineComponent({ x: 'f32' }, { name: 'registered' })
    const Unregistered = defineComponent({ y: 'f32' }, { name: 'unregistered' })
    const world = createWorld({ components: [Registered], maxEntities: 64 })
    const h = world.spawn()
    let message = ''
    try {
      world.add(h, Unregistered)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/not registered/)
    expect(message).toMatch(/createWorld\(\{ components/)
    // no internal ticket leakage
    expect(message).not.toMatch(/Must-Fix|PA-\d|§\d|\bS-\d/)
  })

  test('bitmask phase-violation message is user-actionable and ticket-free', () => {
    const Registered = defineComponent({ x: 'f32' }, { name: 'registered' })
    const world = createWorld({ components: [Registered], maxEntities: 64 })
    const h = world.spawnWith(Registered)
    world.__setPhase('wave')
    let message = ''
    try {
      world.has(h, Registered)
    } catch (e) {
      message = (e as Error).message
    }
    world.__setPhase('serial')
    expect(message).toMatch(/serial-phase only/)
    expect(message).toMatch(/worker wave/)
    expect(message).not.toMatch(/Must-Fix|PA-\d|§\d/)
  })

  test('defineComponent without a name (or brand) throws a clear, actionable error (Item 6)', () => {
    // Anonymous defs used to silently default to the name 'Component' and collide on the element key.
    expect(() => (defineComponent as (s: unknown) => unknown)({ x: 'f32' })).toThrow(/name.*required/)
    // A brand satisfies the requirement (this is the internal/relations path).
    expect(() => defineComponent({ x: 'f32' }, { brand: 'branded' })).not.toThrow()
  })

  test('defineTag without a name throws a clear, actionable error (Item 6)', () => {
    expect(() => (defineTag as (n?: unknown) => unknown)()).toThrow(/name.*required/)
    expect(() => defineTag('frozen')).not.toThrow()
  })
})
