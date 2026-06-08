// Relation-level pair observer terms (onPairAdded / onPairRemoved): one bucket per RELATION, any
// target — the deferred drain resolves each pair shape entry's synthetic ComponentId through the
// relations-installed resolver and dispatches here. Deferred like every observer: handlers fire at
// the drain, never mid-mutation, and see the subject ref (targets come from rel.targetsOf — the
// always-current truth, by design; the event carries no target identity).

import { describe, expect, test } from 'vitest'
import { createWorld, onPairAdded, onPairRemoved } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations } from '../src/index.js'

function drain(world: ReturnType<typeof createWorld>): void {
  world.frameReset()
  world.observerDrain()
}

describe('onPairAdded / onPairRemoved — relation-level, any target', () => {
  test('addPair fires the relation bucket at the drain; targets resolve via targetsOf', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    const t1 = world.spawn()
    const t2 = world.spawn()

    const events: Array<{ subject: EntityHandle; kind: string; targets: EntityHandle[] }> = []
    world.observe(onPairAdded(Likes), (e, ctx) => {
      events.push({ subject: e.handle, kind: ctx.kind, targets: [...rel.targetsOf(e.handle, Likes)] })
    })

    rel.addPair(s, Likes, t1)
    expect(events).toEqual([]) // deferred — nothing fires mid-mutation
    drain(world)
    expect(events).toEqual([{ subject: s, kind: 'pair-add', targets: [t1] }])

    rel.addPair(s, Likes, t2)
    drain(world)
    expect(events).toHaveLength(2)
    expect(new Set(events[1]!.targets)).toEqual(new Set([t1, t2]))
  })

  test('two relations never cross-fire (per-relation buckets)', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const Follows = rel.defineRelation(null)
    const s = world.spawn()
    const t = world.spawn()

    let likes = 0
    let follows = 0
    world.observe(onPairAdded(Likes), () => {
      likes += 1
    })
    world.observe(onPairAdded(Follows), () => {
      follows += 1
    })

    rel.addPair(s, Likes, t)
    drain(world)
    expect(likes).toBe(1)
    expect(follows).toBe(0)

    rel.addPair(s, Follows, t)
    drain(world)
    expect(likes).toBe(1)
    expect(follows).toBe(1)
  })

  test('an exclusive retarget fires pair-remove (old target) then pair-add (new target)', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const s = world.spawn()
    const p1 = world.spawn()
    const p2 = world.spawn()

    const order: string[] = []
    world.observe(onPairAdded(ChildOf), () => {
      order.push('add')
    })
    world.observe(onPairRemoved(ChildOf), () => {
      order.push('remove')
    })

    rel.addPair(s, ChildOf, p1)
    drain(world)
    expect(order).toEqual(['add'])

    rel.addPair(s, ChildOf, p2) // exclusive: implicitly removes (s, ChildOf, p1)
    drain(world)
    expect(order).toEqual(['add', 'remove', 'add'])
    expect(rel.targetOf(s, ChildOf)).toBe(p2)
  })

  test('despawning the target tears the pair down and fires pair-remove on the subject', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Likes, t)
    drain(world)

    const removedOn: EntityHandle[] = []
    world.observe(onPairRemoved(Likes), (e) => {
      removedOn.push(e.handle)
    })

    world.despawn(t)
    drain(world)
    expect(removedOn).toEqual([s])
    expect([...rel.targetsOf(s, Likes)]).toEqual([])
  })

  test('subject despawn fires pair-remove for its outgoing pairs — both relation kinds', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const s = world.spawn()
    const t = world.spawn()
    const p = world.spawn()
    rel.addPair(s, Likes, t)
    rel.addPair(s, ChildOf, p)
    drain(world)

    let likesRemoved = 0
    let childRemoved = 0
    world.observe(onPairRemoved(Likes), () => {
      likesRemoved += 1
    })
    world.observe(onPairRemoved(ChildOf), () => {
      childRemoved += 1
    })

    world.despawn(s)
    drain(world)
    expect(likesRemoved).toBe(1)
    expect(childRemoved).toBe(1)
  })

  test('exclusive target despawn cascades to pair-remove on the subject', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const s = world.spawn()
    const p = world.spawn()
    rel.addPair(s, ChildOf, p)
    drain(world)

    const removedOn: EntityHandle[] = []
    world.observe(onPairRemoved(ChildOf), (e) => {
      removedOn.push(e.handle)
    })

    world.despawn(p)
    drain(world)
    expect(removedOn).toEqual([s])
    expect(rel.targetOf(s, ChildOf)).toBe(null)
  })

  test('idempotent re-adds emit no events — both relation kinds', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Likes, t)
    rel.addPair(s, ChildOf, t)
    drain(world)

    let events = 0
    world.observe(onPairAdded(Likes), () => {
      events += 1
    })
    world.observe(onPairAdded(ChildOf), () => {
      events += 1
    })

    rel.addPair(s, Likes, t) // already present
    rel.addPair(s, ChildOf, t) // same target — the valve's early return
    drain(world)
    expect(events).toBe(0)
  })

  test('dispose stops delivery; other observers on the same relation keep firing', () => {
    const world = createWorld({})
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()

    let a = 0
    let b = 0
    const ha = world.observe(onPairAdded(Likes), () => {
      a += 1
    })
    world.observe(onPairAdded(Likes), () => {
      b += 1
    })

    rel.addPair(s, Likes, world.spawn())
    drain(world)
    expect([a, b]).toEqual([1, 1])

    ha.dispose()
    rel.addPair(s, Likes, world.spawn())
    drain(world)
    expect([a, b]).toEqual([1, 2])
  })
})
