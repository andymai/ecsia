// The relations leg of an image, close up: pair-id stability across a rewind, the back-ref /
// forward indices a wildcard query and a despawn cascade read, the non-exclusive overflow payload
// table (values AND row mapping), and the exclusive eid-column valve. Plus the guard census — the
// relations refusal is gone, the cold-archetype and rich-field ones are not.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createRelations, Wildcard } from '@ecsia/relations'
import { createRollbackSurface } from '../src/index.js'
import type { RollbackImage, RollbackSurface } from '../src/index.js'
import { digest } from './image-digest.js'

let seq = 0

function fixture(opts?: { maxHotArchetypes?: number }) {
  seq += 1
  const Pos = defineComponent({ x: 'i32' }, { name: `rbrel_pos_${seq}` })
  const world = createWorld({ components: [Pos], maxEntities: 256, ...opts })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true })
  const Likes = rel.defineRelation({ weight: 'i32' })
  const Tags = rel.defineRelation(null)
  return {
    world,
    rel,
    rb: createRollbackSurface(world),
    Pos,
    ChildOf,
    Likes,
    Tags,
    spawn: (x: number): EntityHandle => world.spawnWith([Pos, { x }]),
  }
}

/** The entity's live archetype signature — the component ids a pair mint adds to. */
function signatureOf(world: World, handle: EntityHandle): number[] {
  return [...world.__installRelations().componentIdsOf(handle)].sort((a, b) => a - b)
}

/** The synthetic-id high-water mark every pair id is minted from. */
function idMark(world: World): number {
  return world.__installRollback().registry.nextComponentId
}

/** How many defs the world's registry resolves — one entry per interned pair def. */
function defCount(world: World): number {
  return world.__installRollback().registry.registeredDefCount
}

function captured(rb: RollbackSurface): RollbackImage {
  const img = rb.newImage()
  rb.captureImage(img)
  return img
}

describe('@ecsia/rollback — relations', () => {
  test('a world with relations defined captures and restores', () => {
    const f = fixture()
    const a = f.spawn(1)
    const b = f.spawn(2)
    f.rel.addPair(a, f.Tags, b)

    const img = captured(f.rb)
    f.rb.restoreImage(img)

    const after = f.rb.newImage()
    f.rb.captureImage(after)
    expect(digest(after)).toEqual(digest(img))
    expect(f.rel.hasPair(a, f.Tags, b)).toBe(true)
  })

  test('a rollback ACROSS a pair mint re-mints the SAME synthetic pair id', () => {
    const f = fixture()
    const a = f.spawn(1)
    const b = f.spawn(2)
    const c = f.spawn(3)

    const before = captured(f.rb)
    const markBefore = idMark(f.world)

    f.rel.addPair(a, f.Tags, b) // mints pair(Tags, b)
    f.rel.addPair(a, f.Tags, c) // mints pair(Tags, c)
    const forwardSignature = signatureOf(f.world, a)
    const forwardMark = idMark(f.world)
    expect(forwardMark).toBeGreaterThan(markBefore)

    f.rb.restoreImage(before)
    expect(idMark(f.world)).toBe(markBefore)
    expect(f.rel.hasPair(a, f.Tags, b)).toBe(false)

    f.rel.addPair(a, f.Tags, b)
    f.rel.addPair(a, f.Tags, c)
    expect(signatureOf(f.world, a)).toEqual(forwardSignature)
    expect(idMark(f.world)).toBe(forwardMark)
    // Handles are stable across the rewind, so the pairs resolve to the same entities.
    expect(f.rel.hasPair(a, f.Tags, b)).toBe(true)
    expect(f.rel.hasPair(a, f.Tags, c)).toBe(true)
    expect([...f.rel.targetsOf(a, f.Tags)].sort()).toEqual([b, c].sort())
  })

  test('repeated rollbacks over the same pairs do not grow the component registry', () => {
    const f = fixture()
    const a = f.spawn(1)
    const targets = [f.spawn(2), f.spawn(3), f.spawn(4)]

    const img = captured(f.rb)
    const churn = (): void => {
      for (const t of targets) f.rel.addPair(a, f.Tags, t)
      for (const t of targets) f.rel.addPair(a, f.Likes, t, { weight: 1 })
    }

    churn() // first mint: the registry legitimately grows by one def per (relation, target)
    const settled = defCount(f.world)
    f.rb.restoreImage(img)

    // Every cycle re-mints the SAME pairs from a rewound counter. A canonical def per pair means the
    // registry census is flat; a fresh def per re-mint would climb by 6 per iteration.
    for (let i = 0; i < 25; i++) {
      churn()
      expect(defCount(f.world)).toBe(settled)
      f.rb.restoreImage(img)
    }

    // The rewind still works after all that churn: the pairs re-resolve at their original ids.
    churn()
    expect(f.rel.hasPair(a, f.Tags, targets[0] as EntityHandle)).toBe(true)
    expect((f.rel.getPair(a, f.Likes, targets[2] as EntityHandle).read() as { weight: number }).weight).toBe(1)
  })

  test('a restore re-points a canonical pair def a divergent re-simulation re-bound', () => {
    const f = fixture()
    const a = f.spawn(1)
    const b = f.spawn(2)
    const t1 = f.spawn(3)
    const t2 = f.spawn(4)

    const empty = captured(f.rb)
    f.rel.addPair(a, f.Tags, t1) // pair(Tags, t1) takes the first free id
    const withT1 = captured(f.rb)

    // Diverge: replay the same counter position on a DIFFERENT pair, so pair(Tags, t1) is forced to
    // re-bind its canonical def to a later id — the situation real netcode hits whenever a corrected
    // input changes which pairs get minted first.
    f.rb.restoreImage(empty)
    f.rel.addPair(a, f.Tags, t2)
    f.rel.addPair(a, f.Tags, t1)

    f.rb.restoreImage(withT1)
    // `b` never held the pair, so this takes addPair's already-minted path: it reuses the image's
    // pair id AND its def, which must still agree on that id or the migration lands elsewhere.
    f.rel.addPair(b, f.Tags, t1)
    expect(f.rel.hasPair(b, f.Tags, t1)).toBe(true)
    expect(signatureOf(f.world, b)).toEqual(signatureOf(f.world, a))
  })

  test('the back-ref and forward indices are the checkpoint’s after a restore', () => {
    const f = fixture()
    const hub = f.spawn(0)
    const s1 = f.spawn(1)
    const s2 = f.spawn(2)
    f.rel.addPair(s1, f.Tags, hub)
    f.rel.addPair(s1, f.Likes, hub, { weight: 4 })
    // Activate the forward index before the checkpoint so its ACTIVE state is part of the image.
    expect([...f.rel.targetsOf(s1, f.Tags)]).toEqual([hub])

    const img = captured(f.rb)
    const subjects = (): number[] => [...f.rel.subjectsOf(Wildcard, hub)].map((h) => h as number).sort((a, b) => a - b)
    const forwardSubjects = subjects()
    expect(forwardSubjects).toEqual([s1 as number])

    f.rel.addPair(s2, f.Tags, hub)
    expect(subjects()).toEqual([s1 as number, s2 as number].sort((a, b) => a - b))

    f.rb.restoreImage(img)
    expect(subjects()).toEqual(forwardSubjects)
    expect([...f.rel.targetsOf(s1, f.Tags)]).toEqual([hub])
    expect([...f.rel.targetsOf(s2, f.Tags)]).toEqual([])
  })

  test('the despawn cascade behaves as it did at the checkpoint', () => {
    const f = fixture()
    const hub = f.spawn(0)
    const s1 = f.spawn(1)
    f.rel.addPair(s1, f.Tags, hub)

    const img = captured(f.rb)

    // Post-checkpoint churn the restore must revoke: a second subject and a re-target.
    const s2 = f.spawn(2)
    f.rel.addPair(s2, f.Tags, hub)

    f.rb.restoreImage(img)
    expect(f.world.isAlive(s2)).toBe(false)

    f.world.despawn(hub)
    // The cascade read the RESTORED back-ref bucket: s1 lost its pair, and the revoked s2 never
    // resurfaced as a phantom subject.
    expect(f.rel.hasRelation(s1, f.Tags)).toBe(false)
    expect(f.world.isAlive(s1)).toBe(true)
  })

  test('non-exclusive overflow payloads and their row mapping survive a rollback', () => {
    const f = fixture()
    const a = f.spawn(1)
    const b = f.spawn(2)
    const c = f.spawn(3)
    f.rel.addPair(a, f.Likes, b, { weight: 11 })
    f.rel.addPair(a, f.Likes, c, { weight: 22 })

    const img = captured(f.rb)

    f.rel.removePair(a, f.Likes, b) // frees b's overflow row onto the free list
    f.rel.addPair(a, f.Likes, c, { weight: 99 }) // overwrite c's payload in place
    expect((f.rel.getPair(a, f.Likes, c).read() as { weight: number }).weight).toBe(99)

    f.rb.restoreImage(img)
    expect((f.rel.getPair(a, f.Likes, b).read() as { weight: number }).weight).toBe(11)
    expect((f.rel.getPair(a, f.Likes, c).read() as { weight: number }).weight).toBe(22)

    // The row mapping came back too: a NEW pair takes the row the post-checkpoint remove would have
    // recycled, not one that collides with b's or c's.
    const d = f.spawn(4)
    f.rel.addPair(a, f.Likes, d, { weight: 33 })
    expect((f.rel.getPair(a, f.Likes, b).read() as { weight: number }).weight).toBe(11)
    expect((f.rel.getPair(a, f.Likes, c).read() as { weight: number }).weight).toBe(22)
    expect((f.rel.getPair(a, f.Likes, d).read() as { weight: number }).weight).toBe(33)
  })

  test('an exclusive re-target rolls back to the checkpoint parent', () => {
    const f = fixture()
    const child = f.spawn(1)
    const p1 = f.spawn(2)
    const p2 = f.spawn(3)
    f.rel.addPair(child, f.ChildOf, p1)

    const img = captured(f.rb)

    f.rel.addPair(child, f.ChildOf, p2)
    expect(f.rel.targetOf(child, f.ChildOf)).toBe(p2)
    expect([...f.rel.subjectsOf(f.ChildOf, p1)]).toEqual([])

    f.rb.restoreImage(img)
    expect(f.rel.targetOf(child, f.ChildOf)).toBe(p1)
    expect([...f.rel.subjectsOf(f.ChildOf, p1)]).toEqual([child])
    expect([...f.rel.subjectsOf(f.ChildOf, p2)]).toEqual([])
    expect(f.rel.depthOf(child, f.ChildOf)).toBe(1)
  })

  test('a surface created BEFORE createRelations still picks the leg up on a later capture', () => {
    seq += 1
    const Pos = defineComponent({ x: 'i32' }, { name: `rbrel_pos_${seq}` })
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    // Capture while NO leg exists, so the surface probes for one and comes up empty. Resolution has
    // to stay retryable: caching that miss would silently drop the topology from every later capture.
    rb.captureImage(rb.newImage())

    const rel = createRelations(world)
    const Tags = rel.defineRelation(null)

    const a = world.spawnWith([Pos, { x: 1 }])
    const t = world.spawnWith([Pos, { x: 2 }])
    rel.addPair(a, Tags, t)

    const img = rb.newImage()
    rb.captureImage(img)
    rel.removePair(a, Tags, t)
    expect([...rel.subjectsOf(Tags, t)]).toEqual([])

    rb.restoreImage(img)
    // The back-ref index lives ONLY in the leg's blob — the bitmask/column restore cannot repair it,
    // so this is what proves the late-installed leg was actually found and captured through.
    expect([...rel.subjectsOf(Tags, t)]).toEqual([a])
    expect(rel.hasPair(a, Tags, t)).toBe(true)
  })

  test('an image captured before the relations install refuses to restore', () => {
    seq += 1
    const Pos = defineComponent({ x: 'i32' }, { name: `rbrel_pos_${seq}` })
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    world.spawnWith([Pos, { x: 1 }])

    const stale = rb.newImage()
    rb.captureImage(stale) // no relations runtime yet: the image holds no topology

    createRelations(world).defineRelation(null)
    expect(() => rb.restoreImage(stale)).toThrow(/captured before the relations runtime was installed/)
    expect(() => rb.restoreImage(stale)).toThrow(/Capture a fresh checkpoint after createRelations/)
  })

  test('the cold-archetype and rich-field guards still throw with relations present', () => {
    const cold = fixture({ maxHotArchetypes: 1 })
    cold.spawn(1)
    expect(() => cold.rb.captureImage(cold.rb.newImage())).toThrow(/cold-archetype overflow store/)

    seq += 1
    const Mesh = defineComponent({ handle: object<{ id: number }>() }, { name: `rbrel_mesh_${seq}` })
    const world = createWorld({ components: [Mesh], maxEntities: 64 })
    createRelations(world).defineRelation(null)
    const rb = createRollbackSurface(world)
    expect(() => rb.captureImage(rb.newImage())).toThrow(/rich/)
  })
})
