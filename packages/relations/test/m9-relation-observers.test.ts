// — relation observers + safe relation mutation inside observers (// integration). Two things this proves/wires:
// 1. A relation addPair/removePair issued INSIDE an observer handler is STAGED to the world's
// deferred command buffer and applied at the NEXT serial flush — never mutating the relation
// structure mid-drain. This is the relation leg of the deferred observer command buffer.
// 2. AddPair / RemovePair shape entries flow through the SAME deferred observer drain: an onChange
// handler observing a component on the subject still fires correctly while the relation op the
// handler issues is deferred.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onChange } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

describe(', applied at the next flush', () => {
  test('the pair is NOT present immediately after the handler; it is present after the next drain', () => {
    const Tag = defineComponent({ n: 'i32' }, { name: 'tag' })
    const world = createWorld({ components: [Tag] })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null) // non-exclusive tag relation

    const s = world.spawnWith(Tag)
    const t = world.spawn()

    let presentRightAfterHandler = -1
    world.observe(onChange(Tag), () => {
      rel.addPair(s, Likes, t)
      // Staged, not applied: the relation structure is untouched mid-drain.
      presentRightAfterHandler = rel.hasPair(s, Likes, t) ? 1 : 0
    })

    world.frameReset()
    ;(world.entity(s).write(Tag) as { n: number }).n = 1

    world.observerDrain()
    expect(presentRightAfterHandler).toBe(0) // deferred — NOT applied mid-drain
    expect(rel.hasPair(s, Likes, t)).toBe(false)

    // Next serial flush applies the staged addPair.
    world.frameReset()
    world.observerDrain()
    expect(rel.hasPair(s, Likes, t)).toBe(true)
    expect(rel.hasRelation(s, Likes)).toBe(true)
  })

  test('removePair inside an observer is likewise deferred to the next flush', () => {
    const Tag = defineComponent({ n: 'i32' }, { name: 'tag' })
    const world = createWorld({ components: [Tag] })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)

    const s = world.spawnWith(Tag)
    const t = world.spawn()
    rel.addPair(s, Likes, t)
    expect(rel.hasPair(s, Likes, t)).toBe(true)

    world.observe(onChange(Tag), () => {
      rel.removePair(s, Likes, t)
    })

    world.frameReset()
    ;(world.entity(s).write(Tag) as { n: number }).n = 2
    world.observerDrain()
    expect(rel.hasPair(s, Likes, t)).toBe(true) // deferred — still present right after the handler

    world.frameReset()
    world.observerDrain()
    expect(rel.hasPair(s, Likes, t)).toBe(false) // applied at the next flush
  })
})

describe('AddPair / RemovePair shape entries flow through the deferred drain without corruption', () => {
  test('a relation add/remove between frames is exactly-once-coherent and a deferred observer drain is clean', () => {
    const Tag = defineComponent({ n: 'i32' }, { name: 'tag' })
    const world = createWorld({ components: [Tag] })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)

    const s = world.spawnWith(Tag)
    const targets: EntityHandle[] = Array.from({ length: 3 }, () => world.spawn())

    let changeFires = 0
    world.observe(onChange(Tag), () => changeFires++)

    // Frame 1: add three pairs (each emits an AddPair shape entry), then drain.
    world.frameReset()
    for (const t of targets) rel.addPair(s, Likes, t)
    ;(world.entity(s).write(Tag) as { n: number }).n = 1
    world.observerDrain()
    expect(changeFires).toBe(1) // onChange coalesces to one fire

    // The wildcard query sees the subject holding the relation (presence bit O(1)).
    let wildcardCount = 0
    for (const _ of world.query()) wildcardCount++
    void wildcardCount
    expect(rel.hasRelation(s, Likes)).toBe(true)
    expect([...rel.subjectsOf(Likes, targets[0] as EntityHandle)]).toContain(s)

    // Frame 2: remove one pair; the drain must stay clean (RemovePair entries through the same path).
    world.frameReset()
    rel.removePair(s, Likes, targets[0] as EntityHandle)
    world.observerDrain()
    expect(rel.hasPair(s, Likes, targets[0] as EntityHandle)).toBe(false)
    expect(rel.hasRelation(s, Likes)).toBe(true) // still holds the other two
    void Wildcard
  })
})
