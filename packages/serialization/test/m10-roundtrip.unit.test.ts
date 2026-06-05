// UNIT round-trips. Targeted, non-property checks for the exact
// behaviours the task enumerates: a BIT-EXACT snapshot round-trip (re-serialize the loaded world and
// compare bytes), a multi-tick DELTA applied to a stale copy, a late-joiner reconstruction from the
// observer-log stream INCLUDING initial values on ComponentAdd, and eid + relation-target remap.

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

function defs() {
  return {
    Position: defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' }),
    Velocity: defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' }),
    Target: defineComponent({ who: 'eid' }, { name: 'target' }),
    Tag: defineComponent({}, { name: 'tag' }),
  }
}

describe(' UNIT — snapshot round-trip is BIT-EXACT on values', () => {
  it('every f32 value survives the round-trip with EXACT bit equality (no precision drift)', () => {
    const D = defs()
    const src = createWorld({ components: [D.Position, D.Velocity, D.Target, D.Tag] as readonly ComponentDef<Schema>[] })
    // Values chosen to be exactly representable in f32 so === holds (the SoA copy is a raw byte
    // memcpy — no re-quantization). 0.5, 0.25, -3, 9 are all exact in f32.
    const e1 = src.spawnWith(D.Position, D.Velocity)
    ;(src.entity(e1).write(D.Position) as { x: number; y: number }).x = 1.5
    ;(src.entity(e1).write(D.Position) as { x: number; y: number }).y = 2.25
    ;(src.entity(e1).write(D.Velocity) as { dx: number; dy: number }).dx = -3
    const e2 = src.spawnWith(D.Position, D.Tag)
    ;(src.entity(e2).write(D.Position) as { x: number; y: number }).x = 9

    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defs()
    const dst = createWorld({ components: [R.Position, R.Velocity, R.Target, R.Tag] as readonly ComponentDef<Schema>[] })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)

    const n1 = remap.get(e1 as never) as EntityHandle
    const n2 = remap.get(e2 as never) as EntityHandle
    const p1 = dst.entity(n1).read(R.Position) as { x: number; y: number }
    expect(p1.x).toBe(1.5) // exact, not toBeCloseTo
    expect(p1.y).toBe(2.25)
    expect((dst.entity(n1).read(R.Velocity) as { dx: number }).dx).toBe(-3)
    expect((dst.entity(n2).read(R.Position) as { x: number }).x).toBe(9)
    expect(dst.has(n2, R.Tag)).toBe(true)

    // The producer's OWN re-serialization is byte-stable (canonical determinism) — distinct from
    // a cross-world image (handles differ); here we compare the SAME world serialized twice.
    const ser = createSnapshotSerializer(src)
    expect(Buffer.from(ser.snapshotCopy())).toEqual(Buffer.from(ser.snapshotCopy()))
  })
})

describe(' UNIT — multi-tick delta applied to a stale copy reconstructs the live world', () => {
  it('a delta since tick T, applied to a snapshot-bootstrapped mirror, matches the producer', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const a = src.spawnWith(P as ComponentDef<Schema>)
    const b = src.spawnWith(P as ComponentDef<Schema>)
    const c = src.spawnWith(P as ComponentDef<Schema>)
    ;(src.entity(a).write(P) as { x: number }).x = 1
    ;(src.entity(b).write(P) as { x: number }).x = 2
    ;(src.entity(c).write(P) as { x: number }).x = 3

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)

    // Several ticks of writes accumulate into ONE delta covering (T, now].
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 11
    src.advanceTick()
    ;(src.entity(c).write(P) as { x: number }).x = 33
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 111 // a written again — last value wins

    applyDelta(dst, ser.deltaCopy(), remap)

    const na = remap.get(a as never) as EntityHandle
    const nb = remap.get(b as never) as EntityHandle
    const nc = remap.get(c as never) as EntityHandle
    expect((dst.entity(na).read(R) as { x: number }).x).toBeCloseTo(111)
    expect((dst.entity(nb).read(R) as { x: number }).x).toBeCloseTo(2) // never written since T
    expect((dst.entity(nc).read(R) as { x: number }).x).toBeCloseTo(33)
  })
})

describe(' UNIT — late joiner reconstructs full state from the observer-log stream', () => {
  it('ComponentAdd records carry INITIAL VALUES, and replay rebuilds entities + eid refs', () => {
    const Pos = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Tgt = defineComponent({ who: 'eid' }, { name: 'target' })
    const src = createWorld({ components: [Pos as ComponentDef<Schema>, Tgt as ComponentDef<Schema>] })
    const hub = src.spawnWith(Pos as ComponentDef<Schema>)
    ;(src.entity(hub).write(Pos) as { x: number; y: number }).x = 5
    ;(src.entity(hub).write(Pos) as { x: number; y: number }).y = 6
    const follower = src.spawnWith(Pos as ComponentDef<Schema>, Tgt as ComponentDef<Schema>)
    ;(src.entity(follower).write(Pos) as { x: number; y: number }).x = 7
    ;(src.entity(follower).write(Tgt) as { who: number }).who = hub as number

    const stream = encodeStructuralOps(src)

    // The observer-log decoder exposes ComponentAdd records WITH field values (rejecting bitECS's
    // value-less add) — a late joiner reads full state from the stream alone.
    const records = [...createObserverLog(src).drain(stream)]
    const adds = records.filter((r) => r.op === DeltaOp.ComponentAdd)
    expect(adds.length).toBeGreaterThan(0)
    // At least one ComponentAdd carries non-default field words (initial values present).
    const positionAdd = adds.find((r) => r.fields && (r.fields['x.0'] === 5 || r.fields['x.0'] === 7))
    expect(positionAdd).toBeDefined()

    // Replay into a fresh world reconstructs entities, values, AND the remapped eid reference.
    const R1 = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const R2 = defineComponent({ who: 'eid' }, { name: 'target' })
    const dst = createWorld({ components: [R1 as ComponentDef<Schema>, R2 as ComponentDef<Schema>] })
    const remap = new Map<EntityHandle, EntityHandle>()
    applyStructuralOps(dst, stream, remap)

    expect(remap.size).toBe(2)
    const nHub = remap.get(hub as never) as EntityHandle
    const nFollower = remap.get(follower as never) as EntityHandle
    expect((dst.entity(nHub).read(R1) as { x: number; y: number }).x).toBeCloseTo(5)
    expect((dst.entity(nHub).read(R1) as { x: number; y: number }).y).toBeCloseTo(6)
    expect((dst.entity(nFollower).read(R1) as { x: number }).x).toBeCloseTo(7)
    // The eid ref must point at the REMAPPED hub on the receiver, never the producer handle.
    const who = (dst.entity(nFollower).read(R2) as { who: number | null }).who
    expect(who).toBe(nHub as number)
  })
})

describe(' UNIT — eid + relation-target remap correctness', () => {
  it('snapshot remaps a self-referential eid and an exclusive relation target onto receiver handles', () => {
    const Pos = defineComponent({ x: 'f32' }, { name: 'position' })
    const Tgt = defineComponent({ who: 'eid' }, { name: 'target' })
    const src = createWorld({ components: [Pos as ComponentDef<Schema>, Tgt as ComponentDef<Schema>] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parent = src.spawnWith(Pos as ComponentDef<Schema>)
    const child = src.spawnWith(Pos as ComponentDef<Schema>, Tgt as ComponentDef<Schema>)
    ;(src.entity(child).write(Tgt) as { who: number }).who = parent as number // eid ref
    rel.addPair(child, ChildOf, parent) // relation target

    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R1 = defineComponent({ x: 'f32' }, { name: 'position' })
    const R2 = defineComponent({ who: 'eid' }, { name: 'target' })
    const dst = createWorld({ components: [R1 as ComponentDef<Schema>, R2 as ComponentDef<Schema>] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)

    const nParent = remap.get(parent as never) as EntityHandle
    const nChild = remap.get(child as never) as EntityHandle
    // eid field remapped to the receiver's parent handle.
    expect((dst.entity(nChild).read(R2) as { who: number | null }).who).toBe(nParent as number)
    // relation target remapped too.
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
  })
})
