// HIGH gap — the STRUCTURAL-since-T delta. A delta taken at tick T
// and applied to a stale receiver copy must reconstruct SHAPE changes that happened in (T, now], not
// just value writes:
// - entities SPAWNED since T appear on the receiver (remapped, with their values),
// - entities DESPAWNED since T are gone,
// - components ADDED / REMOVED since T are reflected,
// - relations ADDED / REMOVED since T are reflected,
// - every eid field and pair target is remapped across the structural delta.
// `DeltaOptions.includeStructural` defaults TRUE; setting it false yields a value-only delta (the
// structural section is suppressed, so a spawn-since-T is NOT reconstructed).
//
// All assertions read through the PUBLIC surface (has / read / isAlive / hasPair). The delta is applied
// at the world's default serial phase (no scheduler — this is the serialization layer, worker-free).

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

// A producer/receiver pair sharing the SAME defineComponent source (the cross-process invariant: both
// sides run identical schema code so the schemaHash matches). Returns a baseline-synced mirror plus a
// MUTABLE remap the delta apply extends with newly-spawned handles.
interface Mirror {
  dst: ReturnType<typeof createWorld>
  R: Record<string, ComponentDef<Schema>>
  work: Map<EntityHandle, EntityHandle>
}

function mirror(src: ReturnType<typeof createWorld>, makeReceiverDefs: () => Record<string, ComponentDef<Schema>>): Mirror {
  const R = makeReceiverDefs()
  const dst = createWorld({ components: Object.values(R) })
  const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
  return { dst, R, work: new Map(remap) }
}

describe('delta — entities SPAWNED since T appear on the stale mirror', () => {
  it('a spawn-with-values since T is reconstructed and remapped', () => {
    const P = defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    src.spawnWith(P) // a pre-existing entity captured by the baseline snapshot

    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const spawned = src.spawnWith(P)
    const w = src.entity(spawned).write(P) as { x: number; y: number }
    w.x = 11
    w.y = 22

    applyDelta(m.dst, ser.deltaCopy(), m.work)

    const local = m.work.get(spawned as never) as EntityHandle
    expect(local).toBeDefined()
    expect(m.dst.isAlive(local)).toBe(true)
    const r = m.dst.entity(local).read(m.R.P) as { x: number; y: number }
    expect(r.x).toBeCloseTo(11)
    expect(r.y).toBeCloseTo(22)
  })

  it('multiple spawns since T all appear, each remapped to a distinct receiver handle', () => {
    const P = defineComponent({ x: 'i32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const m = mirror(src, () => ({ P: defineComponent({ x: 'i32' }, { name: 'p' }) as ComponentDef<Schema> }))

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const spawned: EntityHandle[] = []
    for (let i = 0; i < 5; i++) {
      const h = src.spawnWith(P)
      ;(src.entity(h).write(P) as { x: number }).x = 100 + i
      spawned.push(h)
    }

    applyDelta(m.dst, ser.deltaCopy(), m.work)

    const locals = new Set<number>()
    for (let i = 0; i < spawned.length; i++) {
      const local = m.work.get(spawned[i] as never) as EntityHandle
      expect(m.dst.isAlive(local)).toBe(true)
      expect((m.dst.entity(local).read(m.R.P) as { x: number }).x).toBe(100 + i)
      locals.add(local as number)
    }
    expect(locals.size).toBe(spawned.length) // distinct receiver handles
  })
})

describe('delta — entities DESPAWNED since T are gone on the stale mirror', () => {
  it('a despawn since T removes the entity but leaves siblings alive', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const keep = src.spawnWith(P)
    const drop = src.spawnWith(P)

    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))
    const nKeep = m.work.get(keep as never) as EntityHandle
    const nDrop = m.work.get(drop as never) as EntityHandle
    expect(m.dst.isAlive(nKeep)).toBe(true)
    expect(m.dst.isAlive(nDrop)).toBe(true)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.despawn(drop)

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    expect(m.dst.isAlive(nDrop)).toBe(false)
    expect(m.dst.isAlive(nKeep)).toBe(true)
  })

  it('a spawn-then-despawn within the SAME window nets to absent on the receiver', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const ephemeral = src.spawnWith(P)
    src.despawn(ephemeral)

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    const local = m.work.get(ephemeral as never)
    // It may have been spawned-then-despawned on the receiver, or never materialized — either way it
    // is NOT alive on the mirror.
    if (local !== undefined) expect(m.dst.isAlive(local)).toBe(false)
  })
})

describe('delta — components ADDED / REMOVED since T are reflected', () => {
  it('a component ADD since T appears with its post-add values', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const Q = defineComponent({ hp: 'i32' }, { name: 'q' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P, Q] })
    const a = src.spawnWith(P)

    const m = mirror(src, () => ({
      P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>,
      Q: defineComponent({ hp: 'i32' }, { name: 'q' }) as ComponentDef<Schema>,
    }))
    const na = m.work.get(a as never) as EntityHandle
    expect(m.dst.has(na, m.R.Q)).toBe(false)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.add(a, Q)
    ;(src.entity(a).write(Q) as { hp: number }).hp = 99

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    expect(m.dst.has(na, m.R.Q)).toBe(true)
    expect((m.dst.entity(na).read(m.R.Q) as { hp: number }).hp).toBe(99)
  })

  it('a component REMOVE since T strips membership on the mirror', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const Q = defineComponent({ hp: 'i32' }, { name: 'q' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P, Q] })
    const a = src.spawnWith(P, Q)
    ;(src.entity(a).write(Q) as { hp: number }).hp = 5

    const m = mirror(src, () => ({
      P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>,
      Q: defineComponent({ hp: 'i32' }, { name: 'q' }) as ComponentDef<Schema>,
    }))
    const na = m.work.get(a as never) as EntityHandle
    expect(m.dst.has(na, m.R.Q)).toBe(true)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.remove(a, Q)

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    expect(m.dst.has(na, m.R.Q)).toBe(false)
    expect(m.dst.has(na, m.R.P)).toBe(true) // the unaffected component survives
  })
})

describe('delta — relations ADDED / REMOVED since T are reflected with remapped eids', () => {
  it('an ADD_PAIR since T reconstructs the pair on remapped receiver handles', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parent = src.spawnWith(P)
    const child = src.spawnWith(P)

    const R = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [R] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    rel.addPair(child, ChildOf, parent)

    applyDelta(dst, ser.deltaCopy(), work)
    const nChild = work.get(child as never) as EntityHandle
    const nParent = work.get(parent as never) as EntityHandle
    // The pair exists on the handles obtained THROUGH the remap (the boundary-stable resolution).
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
  })

  it('a REMOVE_PAIR since T tears the pair down on the mirror', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const rel = createRelations(src)
    const Likes = rel.defineRelation(null, { exclusive: false })
    const a = src.spawnWith(P)
    const b = src.spawnWith(P)
    rel.addPair(a, Likes, b) // established BEFORE the baseline snapshot

    const R = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [R] })
    const relDst = createRelations(dst)
    const LikesDst = relDst.defineRelation(null, { exclusive: false })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)
    const na = work.get(a as never) as EntityHandle
    const nb = work.get(b as never) as EntityHandle
    expect(relDst.hasPair(na, LikesDst, nb)).toBe(true)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    rel.removePair(a, Likes, b)

    applyDelta(dst, ser.deltaCopy(), work)
    expect(relDst.hasPair(na, LikesDst, nb)).toBe(false)
  })

  it('a pair whose TARGET was spawned since T remaps both eids correctly', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const child = src.spawnWith(P) // exists at baseline

    const R = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [R] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const parent = src.spawnWith(P) // SPAWNED since T — must be created on the receiver first
    rel.addPair(child, ChildOf, parent)

    applyDelta(dst, ser.deltaCopy(), work)
    const nChild = work.get(child as never) as EntityHandle
    const nParent = work.get(parent as never) as EntityHandle
    expect(nParent).toBeDefined()
    expect(dst.isAlive(nParent)).toBe(true)
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
  })
})

describe('delta — includeStructural defaults TRUE; false yields a value-only delta', () => {
  it('default (no opts): a spawn-since-T IS reconstructed', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))

    const ser = createDeltaSerializer(src, src.currentTick()) // default includeStructural
    src.advanceTick()
    const spawned = src.spawnWith(P)
    ;(src.entity(spawned).write(P) as { x: number }).x = 3

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    const local = m.work.get(spawned as never) as EntityHandle
    expect(local).toBeDefined()
    expect(m.dst.isAlive(local)).toBe(true)
  })

  it('includeStructural:false suppresses the structural section — a spawn-since-T is NOT reconstructed', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))
    const aliveBefore = m.dst.__serialize.aliveCount()

    const ser = createDeltaSerializer(src, src.currentTick(), { includeStructural: false })
    src.advanceTick()
    const spawned = src.spawnWith(P)
    ;(src.entity(spawned).write(P) as { x: number }).x = 3

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    // No structural section ⇒ no new entity on the receiver, and no remap entry for the producer handle.
    expect(m.work.get(spawned as never)).toBeUndefined()
    expect(m.dst.__serialize.aliveCount()).toBe(aliveBefore)
  })

  it('value-only delta still carries VALUE writes to entities that existed at T', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P] })
    const a = src.spawnWith(P)
    ;(src.entity(a).write(P) as { x: number }).x = 1

    const m = mirror(src, () => ({ P: defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema> }))
    const na = m.work.get(a as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { includeStructural: false })
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 77

    applyDelta(m.dst, ser.deltaCopy(), m.work)
    expect((m.dst.entity(na).read(m.R.P) as { x: number }).x).toBeCloseTo(77)
  })
})
