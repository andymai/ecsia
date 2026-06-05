// Structural-delta + observer-log edge coverage (serialization.md §6.2/§6.4, §7). Drives the since-T
// structural journal through every op kind (Create/Destroy/ComponentAdd/ComponentRemove/PairAdd/
// PairRemove) end-to-end: a delta carries them, applyDelta replays them via applyStructuralOps, and the
// stale mirror converges on the producer. Also exercises the observer-log decoder's per-op branches.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
  encodeStructuralOps,
  applyStructuralOps,
  createObserverLog,
  DeltaOp,
} from '../src/index.js'

describe('structural ops — serial-phase guards (§7.3)', () => {
  it('encodeStructuralOps and applyStructuralOps both throw off the serial slot', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>] })
    world.spawnWith(P as ComponentDef<Schema>)
    const stream = encodeStructuralOps(world)
    world.__setPhase('wave')
    expect(() => encodeStructuralOps(world)).toThrow(/serial phase/)
    expect(() => applyStructuralOps(world, stream, new Map())).toThrow(/serial phase/)
    world.__setPhase('serial')
  })
})

describe('since-T delta carries every structural op kind and the mirror converges (§6.4)', () => {
  function setup() {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const B = defineComponent({ y: 'f32' }, { name: 'b' })
    const src = createWorld({ components: [A as ComponentDef<Schema>, B as ComponentDef<Schema>] })
    const relS = createRelations(src)
    const Likes = relS.defineRelation(null) // non-exclusive tag

    const ra = defineComponent({ x: 'f32' }, { name: 'a' })
    const rb = defineComponent({ y: 'f32' }, { name: 'b' })
    const dst = createWorld({ components: [ra as ComponentDef<Schema>, rb as ComponentDef<Schema>] })
    const relD = createRelations(dst)
    const LikesD = relD.defineRelation(null)
    return { A, B, src, relS, Likes, ra, rb, dst, relD, LikesD }
  }

  it('Create/Destroy/ComponentAdd/ComponentRemove/PairAdd/PairRemove replay onto a stale mirror', () => {
    const { A, B, src, relS, Likes, ra, rb, dst, relD, LikesD } = setup()

    // Baseline world: e0 with A, e1 with A; mirror via snapshot.
    const e0 = src.spawnWith(A as ComponentDef<Schema>)
    const e1 = src.spawnWith(A as ComponentDef<Schema>)
    ;(src.entity(e0).write(A) as { x: number }).x = 1
    const keep = src.spawnWith(A as ComponentDef<Schema>) // pair target that survives

    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T) // includeStructural defaults true

    // --- mutate structure since T ---
    src.advanceTick()
    const e2 = src.spawnWith(A as ComponentDef<Schema>) // Create
    ;(src.entity(e2).write(A) as { x: number }).x = 5
    src.add(e0, B as ComponentDef<Schema>) // ComponentAdd (B) with current values
    ;(src.entity(e0).write(B) as { y: number }).y = 9
    relS.addPair(e1, Likes, keep) // PairAdd
    relS.addPair(e2, Likes, keep)
    relS.removePair(e2, Likes, keep) // PairRemove (after add, same delta)
    src.despawn(e1) // Destroy
    src.remove(e0, A as ComponentDef<Schema>) // ComponentRemove (A)

    applyDelta(dst, ser.deltaCopy(), remap as Map<EntityHandle, EntityHandle>)

    const ne0 = remap.get(e0 as never) as EntityHandle
    const ne2 = remap.get(e2 as never) as EntityHandle
    const ne1 = remap.get(e1 as never) as EntityHandle | undefined
    const nKeep = remap.get(keep as never) as EntityHandle

    // Create: e2 exists on the mirror with its value.
    expect(ne2).toBeDefined()
    expect(dst.isAlive(ne2)).toBe(true)
    expect((dst.entity(ne2).read(ra as ComponentDef<Schema>) as { x: number }).x).toBeCloseTo(5)
    // ComponentRemove: e0 no longer holds A; ComponentAdd: e0 now holds B with y=9.
    expect(dst.has(ne0, ra as ComponentDef<Schema>)).toBe(false)
    expect(dst.has(ne0, rb as ComponentDef<Schema>)).toBe(true)
    expect((dst.entity(ne0).read(rb as ComponentDef<Schema>) as { y: number }).y).toBeCloseTo(9)
    // Destroy: e1 despawned on the mirror.
    expect(ne1 === undefined || !dst.isAlive(ne1)).toBe(true)
    // PairAdd then PairRemove net to no pair for e2.
    expect(relD.hasPair(ne2, LikesD, nKeep)).toBe(false)
  })
})

describe('observer-log decoder — every op branch yields the right record shape (§7.4)', () => {
  it('decodes Create, ComponentAdd(+fields), ComponentRemove, PairAdd, and PairRemove records', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const world = createWorld({ components: [A as ComponentDef<Schema>] })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawnWith(A as ComponentDef<Schema>)
    ;(world.entity(s).write(A) as { x: number }).x = 3
    const t = world.spawnWith(A as ComponentDef<Schema>)
    rel.addPair(s, Likes, t)

    // encodeStructuralOps emits Create + ComponentAdd(values) + PairAdd; decode them all.
    const stream = encodeStructuralOps(world)
    const recs = [...createObserverLog(world).drain(stream)]
    const kinds = new Set(recs.map((r) => r.op))
    expect(kinds.has(DeltaOp.EntityCreate)).toBe(true)
    expect(kinds.has(DeltaOp.ComponentAdd)).toBe(true)
    expect(kinds.has(DeltaOp.PairAdd)).toBe(true)
    const adds = recs.filter((r) => r.op === DeltaOp.ComponentAdd)
    expect(adds.some((r) => Math.abs((r.fields?.['x.0'] ?? NaN) - 3) < 1e-3)).toBe(true)
    const pair = recs.find((r) => r.op === DeltaOp.PairAdd)
    expect(pair?.handle).toBeDefined()
    expect(typeof pair?.relationId).toBe('number')
  })

  it('decodes ComponentRemove and PairRemove records from a hand-built op stream', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const world = createWorld({ components: [A as ComponentDef<Schema>] })
    // Build a stream: ComponentRemove(handle=7, cid=2) then PairRemove(handle=8, rel=1, target=9).
    const buf = new Uint8Array(1 + 4 + 4 + 1 + 4 + 2 + 4)
    const dv = new DataView(buf.buffer)
    let p = 0
    buf[p++] = DeltaOp.ComponentRemove
    dv.setUint32(p, 7, true); p += 4
    dv.setUint32(p, 2, true); p += 4
    buf[p++] = DeltaOp.PairRemove
    dv.setUint32(p, 8, true); p += 4
    dv.setUint16(p, 1, true); p += 2
    dv.setUint32(p, 9, true); p += 4

    const recs = [...createObserverLog(world).drain(buf)]
    expect(recs).toEqual([
      { op: DeltaOp.ComponentRemove, handle: 7, componentId: 2 },
      { op: DeltaOp.PairRemove, handle: 8, relationId: 1, target: 9 },
    ])
  })
})

describe('delta — sinceTick advances; eid value changes remap on apply (§6.3/§6.4)', () => {
  it('the sinceTick baseline advances to the target tick after each delta()', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const src = createWorld({ components: [A as ComponentDef<Schema>] })
    src.spawnWith(A as ComponentDef<Schema>)
    const startTick = src.currentTick()
    const ser = createDeltaSerializer(src, startTick)
    expect(ser.sinceTick).toBe(startTick)
    src.advanceTick()
    src.advanceTick()
    const target = src.currentTick()
    ser.deltaCopy()
    expect(ser.sinceTick).toBe(target) // baseline advanced to the target tick
  })

  it('an eid field changed since T is rewritten to the REMAPPED receiver handle by the delta', () => {
    const Tgt = defineComponent({ who: 'eid' }, { name: 'tgt' })
    const src = createWorld({ components: [Tgt as ComponentDef<Schema>] })
    const a = src.spawnWith(Tgt as ComponentDef<Schema>)
    const p1 = src.spawnWith(Tgt as ComponentDef<Schema>)
    const p2 = src.spawnWith(Tgt as ComponentDef<Schema>)
    ;(src.entity(a).write(Tgt) as { who: number }).who = p1 as number

    const R = defineComponent({ who: 'eid' }, { name: 'tgt' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    ;(src.entity(a).write(Tgt) as { who: number }).who = p2 as number // eid field change since T

    applyDelta(dst, ser.deltaCopy(), remap as Map<EntityHandle, EntityHandle>)

    const na = remap.get(a as never) as EntityHandle
    const nP2 = remap.get(p2 as never) as EntityHandle
    // The delta's eid path must rewrite the producer handle to the receiver-local p2 handle.
    expect((dst.entity(na).read(R as ComponentDef<Schema>) as { who: number }).who).toBe(nP2 as number)
  })
})

describe('delta structural section — overflow-payload PairAdd / SetPayload carry the payload (§6.5)', () => {
  it('a since-T overflow PairAdd then a payload change reconstruct the payload on the mirror', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const src = createWorld({ components: [A as ComponentDef<Schema>] })
    const relS = createRelations(src)
    const Damage = relS.defineRelation({ weight: 'u32' }) // overflow-table payload
    const s = src.spawnWith(A as ComponentDef<Schema>)
    const t = src.spawnWith(A as ComponentDef<Schema>)

    const R = defineComponent({ x: 'f32' }, { name: 'a' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const relD = createRelations(dst)
    const DamageD = relD.defineRelation({ weight: 'u32' })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    relS.addPair(s, Damage, t, { weight: 7 }) // PairAdd (overflow) since T
    relS.addPair(s, Damage, t, { weight: 21 }) // SetPayload refresh since T

    applyDelta(dst, ser.deltaCopy(), remap as Map<EntityHandle, EntityHandle>)

    const ns = remap.get(s as never) as EntityHandle
    const nt = remap.get(t as never) as EntityHandle
    expect(relD.hasPair(ns, DamageD, nt)).toBe(true)
    // Values-on-add read the CURRENT payload at emit time → the mirror sees the post-refresh weight.
    expect(relD.getPair(ns, DamageD, nt).read()['weight']).toBe(21)
  })
})
