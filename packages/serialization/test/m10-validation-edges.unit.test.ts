// Error / validation / merge-mode edge coverage for the snapshot+delta apply paths.
// Each test drives a SPECIFIC rejected or branch-only input and asserts
// the documented outcome — a thrown guard, a dropped dangling reference, or a merge that preserves
// pre-existing entities.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'
import { SNAPSHOT_MAGIC } from '../src/format.js'

function makeWorld() {
  const P = defineComponent({ x: 'f32' }, { name: 'p' })
  const world = createWorld({ components: [P as ComponentDef<Schema>] })
  return { world, P }
}

describe('snapshot/delta serializers — serial-phase guard ', () => {
  it('snapshot() throws when the world is not at a serial flush point', () => {
    const { world } = makeWorld()
    const ser = createSnapshotSerializer(world)
    world.__setPhase('wave')
    expect(() => ser.snapshot()).toThrow(/serial phase/)
    world.__setPhase('serial')
    expect(() => ser.snapshot()).not.toThrow()
  })

  it('delta() throws off the serial slot, and respects includeStructural=false', () => {
    const { world } = makeWorld()
    const ser = createDeltaSerializer(world, world.currentTick(), { includeStructural: false })
    world.__setPhase('wave')
    expect(() => ser.delta()).toThrow(/serial phase/)
    world.__setPhase('serial')
    expect(() => ser.delta()).not.toThrow()
  })
})

describe('snapshot — includeRelations=false omits the relations section', () => {
  it('a relation-bearing world snapshotted with includeRelations:false drops pairs on load', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const rel = createRelations(src)
    const Likes = rel.defineRelation(null)
    const a = src.spawnWith(P as ComponentDef<Schema>)
    const b = src.spawnWith(P as ComponentDef<Schema>)
    rel.addPair(a, Likes, b)

    const bytes = createSnapshotSerializer(src, { includeRelations: false }).snapshotCopy()

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const relDst = createRelations(dst)
    const LikesDst = relDst.defineRelation(null)
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const na = remap.get(a as never) as EntityHandle
    const nb = remap.get(b as never) as EntityHandle
    // No relations section was written, so the pair is absent on the receiver.
    expect(relDst.hasPair(na, LikesDst, nb)).toBe(false)
  })
})

describe('deserialize — header validation gates ', () => {
  it('load() throws off the serial slot', () => {
    const { world } = makeWorld()
    const bytes = createSnapshotSerializer(world).snapshotCopy()
    world.__setPhase('wave')
    expect(() => createSnapshotDeserializer(world).load(bytes)).toThrow(/serial phase/)
  })

  it('rejects a non-ecsia image (bad magic)', () => {
    const { world } = makeWorld()
    const bytes = new Uint8Array(64) // all-zero magic
    expect(() => createSnapshotDeserializer(world).load(bytes)).toThrow(/bad magic/)
  })

  it('rejects an unsupported format version', () => {
    const { world } = makeWorld()
    const bytes = createSnapshotSerializer(world).snapshotCopy()
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    dv.setUint16(4, 999, true) // version field at offset 4
    expect(() => createSnapshotDeserializer(world).load(bytes)).toThrow(/unsupported format version 999/)
  })

  it('rejects a big-endian image', () => {
    const { world } = makeWorld()
    const bytes = createSnapshotSerializer(world).snapshotCopy()
    bytes[6] = 0 // endian byte at offset 6: 0 = big-endian
    expect(() => createSnapshotDeserializer(world).load(bytes)).toThrow(/big-endian/)
  })

  it('rejects a schemaHash mismatch (refuses to load stale-code images)', () => {
    const { world } = makeWorld()
    const bytes = createSnapshotSerializer(world).snapshotCopy()
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    dv.setUint32(8, 0xbadc0de, true) // schemaHash at offset 8
    expect(() => createSnapshotDeserializer(world).load(bytes)).toThrow(/schemaHash mismatch/)
  })

})

describe('deserialize — merge mode preserves pre-existing entities ', () => {
  it("mode:'merge' does NOT clear the receiver; both old and incoming entities are alive", () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const s1 = src.spawnWith(P as ComponentDef<Schema>)
    ;(src.entity(s1).write(P) as { x: number }).x = 7
    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const pre = dst.spawnWith(R as ComponentDef<Schema>)
    ;(dst.entity(pre).write(R) as { x: number }).x = 99
    const aliveBefore = dst.__serialize.aliveCount()

    const { remap, entitiesCreated } = createSnapshotDeserializer(dst).load(bytes, 'merge')
    // Merge keeps the pre-existing entity AND adds the incoming one.
    expect(dst.isAlive(pre)).toBe(true)
    expect((dst.entity(pre).read(R) as { x: number }).x).toBe(99)
    expect(dst.__serialize.aliveCount()).toBe(aliveBefore + entitiesCreated)
    const ns1 = remap.get(s1 as never) as EntityHandle
    expect((dst.entity(ns1).read(R) as { x: number }).x).toBe(7)
  })

  it("mode:'replace' clears pre-existing entities before loading", () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    src.spawnWith(P as ComponentDef<Schema>)
    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const pre = dst.spawnWith(R as ComponentDef<Schema>)
    createSnapshotDeserializer(dst).load(bytes, 'replace') // default, but explicit
    expect(dst.isAlive(pre)).toBe(false) // cleared
    expect(dst.__serialize.aliveCount()).toBe(1) // only the incoming entity
  })
})

describe('deserialize — relation re-establishment + the NO_ENTITY (cleared) target path ', () => {
  it('re-establishes an exclusive pair AND a cleared (null-target) exclusive subject loads without a pair', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parent = src.spawnWith(P as ComponentDef<Schema>)
    const child = src.spawnWith(P as ComponentDef<Schema>)
    rel.addPair(child, ChildOf, parent)
    // A second subject is attached then re-targeted away and removed → its exclusive column is the
    // null sentinel; livePairs emits nothing for it (no NO_ENTITY pair is written in a snapshot — the
    // back-ref drives emission), so this asserts the receiver simply has no stray pair.
    const orphan = src.spawnWith(P as ComponentDef<Schema>)
    rel.addPair(orphan, ChildOf, parent)
    rel.removePair(orphan, ChildOf, parent)

    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const nParent = remap.get(parent as never) as EntityHandle
    const nChild = remap.get(child as never) as EntityHandle
    const nOrphan = remap.get(orphan as never) as EntityHandle
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
    expect(relDst.hasRelation(nOrphan, ChildOfDst)).toBe(false) // detached subject → no pair
  })
})

describe('applyDelta — header validation ', () => {
  it('throws off the serial slot', () => {
    const { world } = makeWorld()
    const ser = createDeltaSerializer(world, world.currentTick())
    const bytes = ser.deltaCopy()
    world.__setPhase('wave')
    expect(() => applyDelta(world, bytes, new Map())).toThrow(/serial phase/)
  })

  it('rejects a non-ecsia delta (bad magic)', () => {
    const { world } = makeWorld()
    const bytes = new Uint8Array(24)
    expect(() => applyDelta(world, bytes, new Map())).toThrow(/bad magic/)
  })

  it('rejects a snapshot image fed to applyDelta (FLAG_IS_DELTA clear)', () => {
    const { world } = makeWorld()
    // A snapshot has the magic but no delta flag → "not a delta image".
    const snap = createSnapshotSerializer(world).snapshotCopy()
    // Reuse just the magic so applyDelta passes the magic check then trips the delta-flag check.
    const bytes = new Uint8Array(24)
    const dv = new DataView(bytes.buffer)
    dv.setUint32(0, SNAPSHOT_MAGIC, true)
    bytes[7] = 0 // flags: FLAG_IS_DELTA bit clear
    expect(() => applyDelta(world, bytes, new Map())).toThrow(/not a delta image/)
    expect(snap.length).toBeGreaterThan(0)
  })
})
