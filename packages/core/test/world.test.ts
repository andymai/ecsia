import { describe, expect, test } from 'vitest'
import { ConfigError, FIRST_USER_COMPONENT_ID, NO_COMPONENT, createWorld } from '@ecsia/core'

describe('createWorld — M0 keystone', () => {
  test('zero-arg resolves the CANON defaults', () => {
    const w = createWorld()
    expect(w.options.maxEntities).toBe(1 << 20)
    expect(w.options.generationBits).toBe(10)
    expect(w.options.indexBits).toBe(22)
    expect(w.options.threaded).toBe(false)
    expect(w.options.reactivity.observerCadence).toBe('frame-end')
    expect(w.options.reactivity.changeTrackingDefault).toBe('component')
  })

  test('phase and tick at construction (world.md §4, §8)', () => {
    const w = createWorld()
    expect(w.phase).toBe('serial')
    expect(w.tick).toBe(0)
    expect(w.currentTick()).toBe(0)
  })

  test('reserved component-id constants (CANON C3)', () => {
    expect(NO_COMPONENT).toBe(0)
    expect(FIRST_USER_COMPONENT_ID).toBe(1)
  })

  test('logEntryWords defaults to 1 with no relations, 2 with relations (CANON C2)', () => {
    expect(createWorld().options.reactivity.logEntryWords).toBe(1)
    expect(createWorld({ relations: [{}] }).options.reactivity.logEntryWords).toBe(2)
  })

  test('observerCadence is overridable under the nested reactivity key', () => {
    const w = createWorld({ reactivity: { observerCadence: 'per-system' } })
    expect(w.options.reactivity.observerCadence).toBe('per-system')
  })

  test('the World facade is frozen', () => {
    expect(Object.isFrozen(createWorld())).toBe(true)
  })

  describe('fail-fast ConfigError (world.md §7)', () => {
    test('generationBits out of range', () => {
      expect(() => createWorld({ generationBits: 33 })).toThrow(ConfigError)
      expect(() => createWorld({ generationBits: -1 })).toThrow(ConfigError)
      expect(() => createWorld({ generationBits: 3.5 })).toThrow(ConfigError)
    })

    test('generationBits 0 rejected when threaded', () => {
      expect(() => createWorld({ generationBits: 0, threaded: true })).toThrow(ConfigError)
      // ...but allowed single-threaded
      expect(() => createWorld({ generationBits: 0, threaded: false })).not.toThrow()
    })

    test('maxEntities exceeding the index width', () => {
      // default indexBits = 22 → max 2^22
      expect(() => createWorld({ maxEntities: 2 ** 22 + 1 })).toThrow(ConfigError)
      expect(() => createWorld({ maxEntities: 0 })).toThrow(ConfigError)
    })
  })
})
