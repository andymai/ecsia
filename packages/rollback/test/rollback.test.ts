// createRollbackSurface: handle-stable whole-world capture/restore. The properties under test are
// (a) restore is byte-identical to the checkpoint, (b) it preserves entity IDENTITY (original
// handles, live eid references, query results), (c) archetypes created after the checkpoint are
// emptied, and (d) the v1 guards fail fast instead of restoring a partial world.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object, onRemove, read, write } from '@ecsia/core'
import type { EntityHandle, SerializeRelationProvider, World } from '@ecsia/core'
import { createRollbackSurface } from '../src/index.js'
import type { RollbackImage, RollbackSurface } from '../src/index.js'

// A ComponentDef binds to ONE world, so every test mints its own set.
let seq = 0
function defs() {
  seq += 1
  return {
    Pos: defineComponent({ x: 'f32', y: 'f32' }, { name: `rb_pos_${seq}` }),
    Vel: defineComponent({ dx: 'f32' }, { name: `rb_vel_${seq}` }),
    Link: defineComponent({ target: 'eid' }, { name: `rb_link_${seq}` }),
  }
}

/** The image's private shape, read only to prove a restore is byte-identical. */
interface ImageInternals {
  seq: number
  tick: number
  identity: {
    sparse: Uint32Array
    dense: Uint32Array
    generation: Uint32Array
    recordArchetypeId: Uint32Array
    recordArchetypeRow: Uint32Array
    aliveCount: number
    denseLen: number
    spawned: number
    despawned: number
  }
  bitmaskWords: Uint32Array
  bitmaskWordCount: number
  changeVersion: Uint32Array
  changeVersionCount: number
  bitmaskSparse: Map<number, Set<number>>
  archetypes: Map<number, { seq: number; count: number; held: number; rows: Uint32Array; cells: { data: ArrayLike<number>; length: number }[] }>
}

const prefix = (a: ArrayLike<number>, n: number): number[] => Array.from(a).slice(0, n)

/** Every meaningful byte + cursor + cloned map of an image, as plain comparable data. */
function digest(image: RollbackImage): unknown {
  const img = image as unknown as ImageInternals
  const n = img.identity.denseLen
  return {
    tick: img.tick,
    cursors: [img.identity.aliveCount, n, img.identity.spawned, img.identity.despawned],
    sparse: prefix(img.identity.sparse, n),
    dense: prefix(img.identity.dense, n),
    generation: prefix(img.identity.generation, n),
    recordArchetypeId: prefix(img.identity.recordArchetypeId, n),
    recordArchetypeRow: prefix(img.identity.recordArchetypeRow, n),
    bitmask: prefix(img.bitmaskWords, img.bitmaskWordCount),
    bitmaskSparse: [...img.bitmaskSparse].map(([k, s]) => [k, [...s].sort((a, b) => a - b)]),
    changeVersion: prefix(img.changeVersion, img.changeVersionCount),
    // Empty archetypes are dropped: an archetype absent from an image restores to count 0, so an
    // entry for one created after an earlier capture carries no state the other image lacks.
    archetypes: [...img.archetypes.entries()]
      .filter(([, a]) => a.seq === img.seq && (a.count > 0 || a.held > 0))
      .map(([id, a]) => [
        id,
        a.count,
        a.held,
        prefix(a.rows, a.count + a.held), // the held (deferred-dead) range is part of the image
        a.cells.map((c) => prefix(c.data, c.length)),
      ]),
  }
}

/** Capture a second image and compare it byte-for-byte with the first. */
function expectIdentical(rb: RollbackSurface, first: RollbackImage): void {
  const second = rb.newImage()
  rb.captureImage(second)
  expect(digest(second)).toEqual(digest(first))
}

describe('@ecsia/rollback — capture / restore', () => {
  test('RB-6: capture → restore on an unchanged world is a byte-identical no-op', () => {
    const { Pos, Vel, Link } = defs()
    const world = createWorld({ components: [Pos, Vel, Link], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    const handles: EntityHandle[] = []
    for (let i = 0; i < 6; i++) handles.push(world.spawnWith([Pos, { x: i, y: -i }], Vel))
    world.despawn(handles[2] as EntityHandle) // swap-pop, so rows are not in mint order
    world.add(handles[4] as EntityHandle, Link)
    world.advanceTick()

    const img = rb.newImage()
    rb.captureImage(img)
    rb.restoreImage(img)

    expectIdentical(rb, img)
  })

  test('RB-6: a capture taken with deferred-dead (held) rows round-trips byte-identically', () => {
    const { Pos, Vel } = defs()
    const world = createWorld({ components: [Pos, Vel], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    world.observe(onRemove(Pos), () => {}) // arms the deferred-dead row hold
    const handles: EntityHandle[] = []
    for (let i = 0; i < 4; i++) handles.push(world.spawnWith([Pos, { x: i, y: -i }], Vel))

    // Despawn WITHOUT draining: the dying rows are held above [0, count) — `phase` is still 'serial',
    // so this is a legal capture point.
    world.despawn(handles[1] as EntityHandle)
    world.despawn(handles[3] as EntityHandle)

    const img = rb.newImage()
    rb.captureImage(img)
    const heldInImage = [...(img as unknown as ImageInternals).archetypes.values()].reduce((n, a) => n + a.held, 0)
    expect(heldInImage).toBe(2)

    rb.restoreImage(img)
    expectIdentical(rb, img)
  })

  test('held rows keep their AT-CAPTURE values: onRemove reads the checkpoint, not post-capture bytes', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    const removed: number[] = []
    world.observe(onRemove(Pos), (ref) => void removed.push((ref.read(Pos) as { x: number }).x))

    const doomed = world.spawnWith([Pos, { x: 11, y: 0 }])
    const keeper = world.spawnWith([Pos, { x: 22, y: 0 }])
    world.frameReset()
    world.despawn(doomed) // deferred: the row is HELD until the drain releases it

    const img = rb.newImage()
    rb.captureImage(img)

    // Post-capture churn: the spawn evicts the held row and drops a NEW tenant's bytes into the slot
    // the checkpoint's dead row occupied.
    const late = world.spawnWith([Pos, { x: 99, y: 0 }])
    world.entity(keeper).write(Pos).x = 77

    rb.restoreImage(img)
    expect(world.isAlive(late)).toBe(false)
    expect(world.entity(keeper).read(Pos).x).toBe(22)

    // Re-simulating past the restore evicts the held row again, propagating whatever the image put
    // back into the observer's read location — post-capture bytes if the held range were not captured.
    // (The rewound allocator re-mints `late`'s exact handle here; deterministic re-simulation is the point.)
    world.spawnWith([Pos, { x: 55, y: 0 }])
    world.observerDrain()

    expect(removed).toEqual([11])
  })

  test('RB-1: restore is handle-stable — original handles, eid references and values survive', () => {
    const { Pos, Vel, Link } = defs()
    const world = createWorld({ components: [Pos, Vel, Link], maxEntities: 256 })
    const rb = createRollbackSurface(world)

    // Churn first, so A and B sit at relocated rows rather than their mint rows.
    const churn: EntityHandle[] = []
    for (let i = 0; i < 5; i++) churn.push(world.spawnWith([Pos, { x: 100 + i, y: 0 }]))
    world.despawn(churn[1] as EntityHandle)
    world.despawn(churn[3] as EntityHandle)
    world.add(churn[0] as EntityHandle, Vel) // archetype migration

    const a = world.spawnWith([Pos, { x: 7, y: 8 }], Vel)
    const b = world.spawnWith(Link)
    world.entity(b).write(Link).target = a

    const before = world.query(read(Pos)).count
    const img = rb.newImage()
    rb.captureImage(img)

    // Mutate heavily: despawn A, re-mint into its index (bumping the generation), restructure others.
    world.despawn(a)
    const reminted = world.spawnWith([Pos, { x: -1, y: -1 }])
    expect(world.decodeHandle(reminted).index).toBe(world.decodeHandle(a).index)
    expect(reminted).not.toBe(a)
    world.remove(churn[0] as EntityHandle, Vel)
    world.add(churn[2] as EntityHandle, Link)
    world.entity(churn[2] as EntityHandle).write(Pos).x = 999
    world.despawn(b)

    rb.restoreImage(img)

    // Identity: A is alive at its ORIGINAL handle; the post-capture re-mint is gone.
    expect(world.isAlive(a)).toBe(true)
    expect(world.isAlive(reminted)).toBe(false)
    expect(world.isAlive(b)).toBe(true)
    // The eid reference stored in B's column still resolves to A.
    const target = (world.entity(b).read(Link).target as number) >>> 0
    expect(target).toBe(a as number)
    expect(world.isAlive(target as EntityHandle)).toBe(true)
    // Values are the pre-capture ones.
    expect(world.entity(a).read(Pos).x).toBe(7)
    expect(world.entity(a).read(Pos).y).toBe(8)
    expect(world.entity(churn[2] as EntityHandle).read(Pos).x).toBe(102)
    // Shape is the pre-capture one.
    expect(world.has(churn[0] as EntityHandle, Vel)).toBe(true)
    expect(world.has(churn[2] as EntityHandle, Link)).toBe(false)

    // Queries agree with the restored tables, by iteration AND by membership count.
    const q = world.query(read(Pos))
    expect(q.count).toBe(before)
    const seen: number[] = []
    q.each((e) => void seen.push(e.handle as number))
    expect(seen.length).toBe(before)
    expect(seen).toContain(a as number)
    expect(seen).not.toContain(reminted as number)
    expect(world.query(read(Link)).count).toBe(1)

    expectIdentical(rb, img)
  })

  test('an archetype created AFTER the checkpoint is emptied by the restore', () => {
    const { Pos, Vel, Link } = defs()
    const world = createWorld({ components: [Pos, Vel, Link], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    for (let i = 0; i < 3; i++) world.spawnWith([Pos, { x: i, y: 0 }])

    const img = rb.newImage()
    rb.captureImage(img)

    // A combination that did not exist at capture time — a brand-new archetype.
    const late = world.spawnWith(Pos, Vel, Link)
    const lateSig = world.__inspect.archetypes().find((arch) => arch.signature.length === 3)
    expect(lateSig?.count).toBe(1)

    rb.restoreImage(img)

    expect(world.isAlive(late)).toBe(false)
    expect(world.__inspect.archetypes().find((arch) => arch.signature.length === 3)?.count).toBe(0)
    expect(world.query(read(Pos), read(Vel), read(Link)).count).toBe(0)
    let visited = 0
    world.query(read(Pos), read(Vel), read(Link)).each(() => void (visited += 1))
    expect(visited).toBe(0)
    expect(world.query(read(Pos)).count).toBe(3)

    expectIdentical(rb, img)
  })

  test('restore after column growth reverts the grown tables correctly', () => {
    const { Pos, Vel } = defs()
    const world = createWorld({ components: [Pos, Vel], maxEntities: 4096 })
    const rb = createRollbackSurface(world)
    const kept: EntityHandle[] = []
    for (let i = 0; i < 4; i++) kept.push(world.spawnWith([Pos, { x: i, y: i * 2 }]))

    const img = rb.newImage()
    rb.captureImage(img)

    // Well past the 64-row initial column capacity: forces growth (and a possible view rebind).
    for (let i = 0; i < 500; i++) world.spawnWith([Pos, { x: 1000 + i, y: 0 }], Vel)
    expect(world.query(read(Pos)).count).toBe(504)

    rb.restoreImage(img)

    expect(world.query(read(Pos)).count).toBe(4)
    expect(world.handleStats().aliveCount).toBe(4)
    for (let i = 0; i < 4; i++) {
      const h = kept[i] as EntityHandle
      expect(world.isAlive(h)).toBe(true)
      expect(world.entity(h).read(Pos).x).toBe(i)
      expect(world.entity(h).read(Pos).y).toBe(i * 2)
    }
    expectIdentical(rb, img)

    // The next spawn re-mints from the rewound cursors, not from where the re-sim left off.
    const next = world.spawn()
    expect(world.decodeHandle(next).index).toBe(4)
  })

  test('capture/restore assert the serial phase', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    const img = rb.newImage()
    rb.captureImage(img)
    world.__setPhase('wave')
    expect(() => rb.captureImage(img)).toThrow(/serial phase/)
    expect(() => rb.restoreImage(img)).toThrow(/serial phase/)
    expect(() => rb.setTick(3)).toThrow(/serial phase/)
    world.__setPhase('serial')
  })

  test('setTick is the restore-only tick assignment; a restore rewinds the tick', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    world.advanceTick()
    world.advanceTick()
    const img = rb.newImage()
    rb.captureImage(img)
    world.advanceTick()
    expect(world.tick).toBe(3)
    rb.restoreImage(img)
    expect(world.tick).toBe(2)
    rb.setTick(41)
    expect(world.tick).toBe(41)
  })

  test(`an image minted by another surface is rejected (it holds that world's columns)`, () => {
    const first = createWorld({ components: [defs().Pos], maxEntities: 64 })
    const second = createWorld({ components: [defs().Pos], maxEntities: 64 })
    const firstRb = createRollbackSurface(first)
    const secondRb = createRollbackSurface(second)
    const img = firstRb.newImage()
    firstRb.captureImage(img)
    expect(() => secondRb.captureImage(img)).toThrow(/different rollback surface/)
    expect(() => secondRb.restoreImage(img)).toThrow(/different rollback surface/)
  })

  test('restoring an image that was never captured into throws', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    expect(() => rb.restoreImage(rb.newImage())).toThrow(/never been captured/)
  })

  describe('v1 guards', () => {
    test('a world with a relation defined refuses to capture', () => {
      const { Pos } = defs()
      const world = createWorld({ components: [Pos], maxEntities: 64 })
      const rb = createRollbackSurface(world)
      // The relations runtime installs its provider through this seam; one defined relation is enough.
      world.__installRelations().setSerializationProvider({
        relations: () => [{ name: 'ChildOf', id: 0, exclusive: true, hasPayload: false, presenceId: 0, payloadSchema: null }],
      } as unknown as SerializeRelationProvider)

      const img = rb.newImage()
      expect(() => rb.captureImage(img)).toThrow(/relation state/)
      expect(() => rb.captureImage(img)).toThrow(/pair-id/)
    })

    test('cold-archetype residents refuse to capture', () => {
      // maxHotArchetypes: 1 leaves only the EMPTY archetype hot, so any spawnWith lands cold.
      const { Pos, Vel } = defs()
      const world = createWorld({ components: [Pos, Vel], maxEntities: 64, maxHotArchetypes: 1 })
      const rb = createRollbackSurface(world)
      const img = rb.newImage()
      rb.captureImage(img) // no cold residents yet: fine

      world.spawnWith([Pos, { x: 1, y: 2 }])
      expect(() => rb.captureImage(img)).toThrow(/cold-archetype overflow store/)
    })

    test('rich (string / object) fields refuse to capture', () => {
      const { Pos } = defs()
      const Mesh = defineComponent({ handle: object<{ id: number }>() }, { name: `rb_mesh_${seq}` })
      const world = createWorld({ components: [Pos, Mesh], maxEntities: 64 })
      const rb = createRollbackSurface(world)
      expect(() => rb.captureImage(rb.newImage())).toThrow(/rich/)
    })
  })

  test('changeVersion stamps are captured and restored when stamping is enabled', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 64 })
    const rb = createRollbackSurface(world)
    const h = world.spawnWith([Pos, { x: 1, y: 1 }])
    world.advanceTick()
    world.entity(h).write(Pos).x = 2
    // Enabling is lazy: the first changedSince consumer turns stamping on.
    expect(world.changedSince(h, 0)).toBe(false) // stamping was off for the write above
    world.entity(h).write(Pos).x = 3
    expect(world.changedSince(h, 0)).toBe(true)

    const img = rb.newImage()
    rb.captureImage(img)
    world.advanceTick()
    world.advanceTick()
    world.entity(h).write(Pos).x = 4
    expect(world.changedSince(h, 1)).toBe(true)

    rb.restoreImage(img)
    expect(world.entity(h).read(Pos).x).toBe(3)
    expect(world.changedSince(h, 1)).toBe(false) // the stamp is back at the checkpoint tick
    expectIdentical(rb, img)
  })

  test('images are reusable: a second capture overwrites the first without reallocating', () => {
    const { Pos } = defs()
    const world = createWorld({ components: [Pos], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    const handles: EntityHandle[] = []
    for (let i = 0; i < 4; i++) handles.push(world.spawnWith([Pos, { x: i, y: 0 }]))
    const img = rb.newImage()
    rb.captureImage(img)
    const internals = img as unknown as ImageInternals
    const denseBuffer = internals.identity.dense
    const wordBuffer = internals.bitmaskWords

    // Recycling an index leaves denseLen unchanged, so the recapture reuses every image buffer.
    world.despawn(handles[0] as EntityHandle)
    const reused = world.spawnWith([Pos, { x: 9, y: 9 }])
    rb.captureImage(img)
    expect(internals.identity.dense).toBe(denseBuffer)
    expect(internals.bitmaskWords).toBe(wordBuffer)

    world.despawn(reused)
    rb.restoreImage(img)
    expect(world.isAlive(reused)).toBe(true)
    expect(world.isAlive(handles[0] as EntityHandle)).toBe(false)
    expect(world.query(read(Pos)).count).toBe(4)
  })

  test('writes through a restored world stay coherent (no stale row bindings)', () => {
    const { Pos, Vel } = defs()
    const world = createWorld({ components: [Pos, Vel], maxEntities: 256 })
    const rb = createRollbackSurface(world)
    const a = world.spawnWith([Pos, { x: 1, y: 1 }], Vel)
    const b = world.spawnWith([Pos, { x: 2, y: 2 }], Vel)
    const img = rb.newImage()
    rb.captureImage(img)

    world.despawn(a)
    rb.restoreImage(img)

    world.query(write(Pos)).each((e) => {
      const el = e as unknown as Record<string, { x: number }>
      ;(el[Pos.name] as { x: number }).x += 10
    })
    expect(world.entity(a).read(Pos).x).toBe(11)
    expect(world.entity(b).read(Pos).x).toBe(12)
  })
})
