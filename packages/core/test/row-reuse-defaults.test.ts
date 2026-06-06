// Reused rows must read as defaults, not the previous tenant's bytes. removeRow swap-pop leaves
// stale column data at/above `count`; the next allocRow hands that slot out, so add-time init must
// write every field's default unconditionally (archetype-storage.md §5.7) — zero-init of a fresh
// column only covers never-used rows.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, field, vec } from '../src/index.js'

describe('row reuse re-defaults every field', () => {
  test('despawn → spawn → add reads zero, not the previous tenant', () => {
    const P = defineComponent({ x: 'f32', y: 'f32' }, { name: 'P' })
    const world = createWorld({ components: [P] })
    const a = world.spawn()
    world.add(a, P)
    world.entity(a).write(P).x = 5
    world.entity(a).write(P).y = 7
    world.despawn(a)
    const b = world.spawn()
    world.add(b, P)
    expect(world.entity(b).read(P).x).toBe(0)
    expect(world.entity(b).read(P).y).toBe(0)
  })

  test('remove → re-add on the same entity re-defaults', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'P' })
    const world = createWorld({ components: [P] })
    const a = world.spawn()
    world.add(a, P)
    world.entity(a).write(P).x = 7
    world.remove(a, P)
    world.add(a, P)
    expect(world.entity(a).read(P).x).toBe(0)
  })

  test('declared (non-zero) defaults also re-apply on reuse', () => {
    const P = defineComponent({ hp: field('f32', { default: 100 }) }, { name: 'P' })
    const world = createWorld({ components: [P] })
    const a = world.spawn()
    world.add(a, P)
    world.entity(a).write(P).hp = 1
    world.despawn(a)
    const b = world.spawn()
    world.add(b, P)
    expect(world.entity(b).read(P).hp).toBe(100)
  })

  test('non-uniform vec defaults encode per lane (not a whole-array coercion)', () => {
    // The cast bridges a known type/runtime mismatch: FieldValue<vec> is the VecView VIEW type
    // (.x/.y/.z), but the descriptor runtime reads vec defaults as plain arrays.
    const vecDefault = [0, 1, 2] as unknown as { x: number; y: number; z: number; w: never; length: 3; [i: number]: number }
    const P = defineComponent({ v: field(vec('f32', 3), { default: vecDefault }) }, { name: 'P' })
    const world = createWorld({ components: [P] })
    const a = world.spawn()
    world.add(a, P)
    const r = world.entity(a).read(P).v
    expect([r.x, r.y, r.z]).toEqual([0, 1, 2])
  })
})
