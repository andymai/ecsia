// the null-handle sentinel + its predicate must be reachable from the ecsia
// umbrella so a user can discriminate an absent handle without reaching into @ecsia/core or
// hand-rolling the 0xffffffff cast.

import { describe, expect, test } from 'vitest'
import { NO_ENTITY, NULL_ENTITY, isNoEntity, createWorld, defineComponent } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'

describe('sentinel surface (umbrella)', () => {
  test('NO_ENTITY / NULL_ENTITY are exported and alias the same value', () => {
    expect(NO_ENTITY).toBe(0xffffffff)
    expect(NULL_ENTITY).toBe(NO_ENTITY)
  })

  test('isNoEntity discriminates the sentinel from a live handle', () => {
    expect(isNoEntity(NO_ENTITY)).toBe(true)
    expect(isNoEntity(NULL_ENTITY)).toBe(true)

    const world = createWorld({ components: [defineComponent({ x: 'f32' }, { name: 'p' })], maxEntities: 64 })
    const h = world.spawn()
    expect(isNoEntity(h)).toBe(false)
  })

  test('sentinel comparison is writable against the public EntityHandle type', () => {
    // Compile-time: NO_ENTITY is a branded EntityHandle, so this comparison needs no cast.
    const maybe: EntityHandle = NO_ENTITY
    expect(maybe === NO_ENTITY).toBe(true)
    expect(isNoEntity(maybe)).toBe(true)
  })
})
