// The read-only __inspect seam (P5 / @ecsia/devtools): the FULL archetype census (cold + empty) + the
// live-query enumeration that __serialize does not reach.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write } from '@ecsia/core'

describe('world.__inspect', () => {
  test('archetypes() returns the FULL census including the empty archetype', () => {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const B = defineComponent({ v: 'i32' }, { name: 'b' })
    const world = createWorld({ components: [A, B], maxEntities: 256 })

    for (let i = 0; i < 3; i++) world.spawnWith(A)
    world.spawnWith(A, B)

    const archs = world.__inspect.archetypes()
    // id 0 is the empty archetype — present in the inspect census (unlike __serialize.archetypes()).
    const empty = archs.find((a) => a.signature.length === 0)
    expect(empty).toBeDefined()
    expect(empty!.count).toBe(0)

    const onlyA = archs.find((a) => a.signature.length === 1)!
    expect(onlyA.count).toBe(3)
    expect(onlyA.cold).toBe(false)

    // ids are ascending.
    const ids = archs.map((a) => a.id)
    expect([...ids].sort((x, y) => x - y)).toEqual(ids)
  })

  test('archetypes() signature is a COPY — mutating it cannot corrupt the live archetype', () => {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const B = defineComponent({ v: 'i32' }, { name: 'b' })
    const world = createWorld({ components: [A, B], maxEntities: 256 })
    world.spawnWith(A, B)

    const before = world.__inspect.archetypes().find((a) => a.signature.length === 2)!
    // Hand the consumer a mutable array? The seam is documented read-only — clobber what we got back.
    ;(before.signature as unknown as number[])[0] = 999999

    // A fresh census must be unaffected: the live archetype's signature was not handed out by reference.
    const after = world.__inspect.archetypes().find((a) => a.signature.length === 2)!
    expect(after.signature).not.toContain(999999)
  })

  test('queries() enumerates live (cached) queries with terms, matchedArchetypes and size', () => {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const world = createWorld({ components: [A], maxEntities: 256 })
    for (let i = 0; i < 4; i++) world.spawnWith(A)

    expect(world.__inspect.queries()).toEqual([]) // no query compiled yet

    const q = world.query(write(A))
    void q.count

    const qs = world.__inspect.queries()
    expect(qs.length).toBe(1)
    expect(qs[0]!.size).toBe(4)
    expect(qs[0]!.matchedArchetypes).toBeGreaterThanOrEqual(1)
    expect(qs[0]!.terms.length).toBe(1)
  })

  test('queries() dedups identical term sets by canonical hash', () => {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const B = defineComponent({ v: 'i32' }, { name: 'b' })
    const world = createWorld({ components: [A, B] })
    world.query(read(A), read(B))
    world.query(read(B), read(A)) // same canonical query
    expect(world.__inspect.queries().length).toBe(1)
  })
})
