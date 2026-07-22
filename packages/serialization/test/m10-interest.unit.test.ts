// Interest management (per-client filtered replication): StateView entity visibility, component
// concealment, enter/leave transitions, and the compute-once shared changeset. Mirrors the shape of
// m10-replication.unit.test.ts — a producer world + a per-view mirror world synced through the view's
// own baseline/delta messages.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, defineTag, has } from '@ecsia/core'
import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { createReplicationStream, createReplicationReceiver } from '../src/index.js'
import { FLAG_IS_FILTERED, FLAG_HAS_STRUCTURAL, DELTA_OP_CONCEAL, DeltaOp } from '../src/format.js'

function containsSubsequence(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

const defP = () => defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
const defHand = () => defineComponent({ secret: 'f32' }, { name: 'hand' }) as ComponentDef<Schema>

interface Header {
  flags: number
  baselineTick: number
  targetTick: number
  structOff: number
  valueOff: number
  richOff: number
}
function header(bytes: Uint8Array): Header {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    flags: dv.getUint8(7),
    baselineTick: dv.getUint32(12, true),
    targetTick: dv.getUint32(16, true),
    structOff: dv.getUint32(20, true),
    valueOff: dv.getUint32(24, true),
    richOff: dv.getUint32(28, true),
  }
}
function x(w: ReturnType<typeof createWorld>, h: EntityHandle, P: ComponentDef<Schema>): number {
  return (w.entity(h).read(P) as { x: number }).x
}

describe('interest — entity visibility: enter carries CURRENT state', () => {
  it('an entity mutated while invisible, then entering the view, mirrors its current values (not stale)', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const P2 = defP()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)) })

    const a = src.spawnWith(P) // no V ⇒ invisible
    ;(src.entity(a).write(P) as { x: number }).x = 5
    receiver.apply(view.baseline())
    expect(dst.query(has(P2)).count).toBe(0) // invisible entity absent from the filtered baseline

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 99 // mutate WHILE invisible
    src.add(a, V) // now visible ⇒ enters

    const d = view.delta()
    expect(header(d.bytes).flags & FLAG_IS_FILTERED).toBe(FLAG_IS_FILTERED)
    expect(header(d.bytes).flags & FLAG_HAS_STRUCTURAL).toBe(FLAG_HAS_STRUCTURAL)
    expect(receiver.apply(d).applied).toBe(true)

    const localA = receiver.remap.get(a) as EntityHandle
    expect(x(dst, localA, P2)).toBeCloseTo(99) // CURRENT value, not the last-changed 5
  })
})

describe('interest — leave: a conceal-flagged destroy despawns the mirror and drops the remap', () => {
  it('removing the visibility tag emits EntityDestroy | CONCEAL; the mirror despawns; the remap forgets the producer handle', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const P2 = defP()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)) })

    const a = src.spawnWith(P, V)
    receiver.apply(view.baseline())
    const localA = receiver.remap.get(a) as EntityHandle
    expect(dst.isAlive(localA)).toBe(true)

    src.advanceTick()
    src.remove(a, V) // leaves the view, still alive on the host

    const d = view.delta()
    const h = header(d.bytes)
    expect(h.flags & FLAG_HAS_STRUCTURAL).toBe(FLAG_HAS_STRUCTURAL)
    // The single leave op is a conceal-flagged EntityDestroy.
    expect(d.bytes[h.structOff]).toBe(DeltaOp.EntityDestroy | DELTA_OP_CONCEAL)
    expect(h.valueOff - h.structOff).toBe(5) // exactly one [op u8][handle u32] record

    expect(receiver.apply(d).applied).toBe(true)
    expect(dst.isAlive(localA)).toBe(false)
    expect(receiver.remap.get(a)).toBeUndefined()
  })
})

describe('interest — a real destroy of a visible entity is a SINGLE plain destroy (no duplicate conceal)', () => {
  it('despawning a visible entity emits exactly one EntityDestroy with reason=destroy', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const P2 = defP()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)) })

    const a = src.spawnWith(P, V)
    receiver.apply(view.baseline())
    const localA = receiver.remap.get(a) as EntityHandle

    src.advanceTick()
    src.despawn(a) // real removal AND a view-leave in one tick

    const d = view.delta()
    const h = header(d.bytes)
    // One real destroy (bit clear), no conceal twin: a single 5-byte record.
    expect(d.bytes[h.structOff]).toBe(DeltaOp.EntityDestroy)
    expect((d.bytes[h.structOff] as number) & DELTA_OP_CONCEAL).toBe(0)
    expect(h.valueOff - h.structOff).toBe(5)

    expect(receiver.apply(d).applied).toBe(true)
    expect(dst.isAlive(localA)).toBe(false)
  })
})

describe('interest — dual membership (an entity both changes AND enters in one tick)', () => {
  it('emits one full add and NO redundant value-section row', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const P2 = defP()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)) })

    const a = src.spawnWith(P) // invisible
    ;(src.entity(a).write(P) as { x: number }).x = 1
    receiver.apply(view.baseline())

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 7 // value change
    src.add(a, V) // AND enters this same tick

    const d = view.delta()
    const h = header(d.bytes)
    // The synth-add carried full values, so the value section contributes ZERO archetypes for it.
    const valueArchCount = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength).getUint32(h.valueOff, true)
    expect(valueArchCount).toBe(0)
    // Exactly one entity created on the mirror, with the current value.
    expect(receiver.apply(d).applied).toBe(true)
    expect(dst.query(has(P2)).count).toBe(1)
    const localA = receiver.remap.get(a) as EntityHandle
    expect(x(dst, localA, P2)).toBeCloseTo(7)
  })
})

describe('interest — two disjoint views over one world yield disjoint mirrors', () => {
  it('each view mirrors only its own members; value updates route to the correct mirror', () => {
    const P = defP()
    const A = defineTag('a') as unknown as ComponentDef<Schema>
    const B = defineTag('b') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, A, B] })
    const mk = () => {
      const P2 = defP()
      const A2 = defineTag('a') as unknown as ComponentDef<Schema>
      const B2 = defineTag('b') as unknown as ComponentDef<Schema>
      const w = createWorld({ components: [P2, A2, B2] })
      return { w, P2 }
    }
    const m1 = mk()
    const m2 = mk()
    const stream = createReplicationStream(src)
    const r1 = createReplicationReceiver(m1.w)
    const r2 = createReplicationReceiver(m2.w)
    const v1 = stream.view({ visible: src.query(has(A)) })
    const v2 = stream.view({ visible: src.query(has(B)) })

    const e1 = src.spawnWith(P, A)
    const e2 = src.spawnWith(P, B)
    ;(src.entity(e1).write(P) as { x: number }).x = 11
    ;(src.entity(e2).write(P) as { x: number }).x = 22

    r1.apply(v1.baseline())
    r2.apply(v2.baseline())
    expect(m1.w.query(has(m1.P2)).count).toBe(1)
    expect(m2.w.query(has(m2.P2)).count).toBe(1)
    expect(x(m1.w, r1.remap.get(e1) as EntityHandle, m1.P2)).toBeCloseTo(11)
    expect(x(m2.w, r2.remap.get(e2) as EntityHandle, m2.P2)).toBeCloseTo(22)
    // e2 is invisible to v1 and vice-versa.
    expect(r1.remap.get(e2)).toBeUndefined()
    expect(r2.remap.get(e1)).toBeUndefined()

    src.advanceTick()
    ;(src.entity(e1).write(P) as { x: number }).x = 111
    ;(src.entity(e2).write(P) as { x: number }).x = 222
    r1.apply(v1.delta())
    r2.apply(v2.delta())
    expect(x(m1.w, r1.remap.get(e1) as EntityHandle, m1.P2)).toBeCloseTo(111)
    expect(x(m2.w, r2.remap.get(e2) as EntityHandle, m2.P2)).toBeCloseTo(222)
  })
})

describe('interest — component concealment strips a hidden component from a visible entity', () => {
  it('Position replicates but a concealed Hand never materializes on the mirror (baseline + delta)', () => {
    const P = defP()
    const H = defHand()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, H, V] })
    const P2 = defP()
    const H2 = defHand()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, H2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)), hideComponents: [H.id as ComponentId] })

    const a = src.spawnWith(P, H, V)
    ;(src.entity(a).write(P) as { x: number }).x = 3
    ;(src.entity(a).write(H) as { secret: number }).secret = 42

    receiver.apply(view.baseline())
    const localA = receiver.remap.get(a) as EntityHandle
    expect(x(dst, localA, P2)).toBeCloseTo(3)
    expect(dst.has(localA, P2)).toBe(true)
    expect(dst.has(localA, H2)).toBe(false) // concealed — never on the mirror

    // A subsequent change to the concealed component produces no visible effect on the mirror.
    src.advanceTick()
    ;(src.entity(a).write(H) as { secret: number }).secret = 4242
    ;(src.entity(a).write(P) as { x: number }).x = 30
    receiver.apply(view.delta())
    expect(x(dst, localA, P2)).toBeCloseTo(30)
    expect(dst.has(localA, H2)).toBe(false)
  })
})

describe('interest — a relation pair to a HIDDEN entity does not leak the hidden handle', () => {
  it('a PairAdd from a visible subject to an invisible target is dropped from the view (no target handle on the wire)', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const rel = createRelations(src)
    const R = rel.defineRelation(null, { exclusive: false })

    // Pad the handle space so `secret`'s handle is a large, distinctive u32 that cannot collide with
    // tiny header fields (tick, offsets) or section counts — otherwise a byte scan false-positives.
    for (let i = 0; i < 500; i++) src.spawnWith(P)
    const seen = src.spawnWith(P, V)
    ;(src.entity(seen).write(P) as { x: number }).x = 7
    const secret = src.spawnWith(P) // no V ⇒ invisible to the view
    const stream = createReplicationStream(src)
    const view = stream.view({ visible: src.query(has(V)) })
    view.baseline() // seen visible, secret hidden — neither the secret entity nor any pair is in it

    src.advanceTick()
    rel.addPair(seen, R, secret) // a pair from the VISIBLE subject to the HIDDEN target

    const d = view.delta()
    const dv = new DataView(d.bytes.buffer, d.bytes.byteOffset, d.bytes.byteLength)
    const structOff = dv.getUint32(20, true) // skip the 32-byte header (tick/offset fields collide)
    const secretBytes = new Uint8Array(new Uint32Array([secret as unknown as number]).buffer)
    // The pair op would carry `secret`'s raw handle — it must be dropped, not filtered only by subject.
    expect(containsSubsequence(d.bytes.subarray(structOff), secretBytes)).toBe(false)
  })
})

const defLink = () => defineComponent({ who: 'eid' }, { name: 'link' }) as ComponentDef<Schema>
function handleBytes(h: EntityHandle): Uint8Array {
  return new Uint8Array(new Uint32Array([h as unknown as number]).buffer)
}

describe('interest — an eid field on a VISIBLE entity does not leak a HIDDEN target handle', () => {
  it('the hidden handle is absent from baseline+delta bytes and the mirror nulls the reference', () => {
    const P = defP()
    const Link = defLink()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, Link, V] })
    const P2 = defP()
    const Link2 = defLink()
    const V2 = defineTag('vis') as unknown as ComponentDef<Schema>
    const dst = createWorld({ components: [P2, Link2, V2] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const view = stream.view({ visible: src.query(has(V)) })

    for (let i = 0; i < 500; i++) src.spawnWith(P) // pad the handle space to a distinctive u32
    const secret = src.spawnWith(P) // hidden (no V)
    const seen = src.spawnWith(P, Link, V)
    ;(src.entity(seen).write(Link) as { who: number }).who = secret as number
    ;(src.entity(seen).write(P) as { x: number }).x = 7
    const secretBytes = handleBytes(secret)

    const base = view.baseline()
    // Skip the 36-byte snapshot header (tick/count/offset words could collide with the handle value).
    expect(containsSubsequence(base.bytes.subarray(36), secretBytes)).toBe(false)
    receiver.apply(base)
    const localSeen = receiver.remap.get(seen) as EntityHandle
    expect((dst.entity(localSeen).read(Link2) as { who: number | null }).who).toBe(null) // masked → null

    src.advanceTick()
    ;(src.entity(seen).write(Link) as { who: number }).who = secret as number // eid column re-stamped
    ;(src.entity(seen).write(P) as { x: number }).x = 8
    const d = view.delta()
    expect(containsSubsequence(d.bytes.subarray(32), secretBytes)).toBe(false) // skip the 32-byte delta header
    receiver.apply(d)
    expect((dst.entity(localSeen).read(Link2) as { who: number | null }).who).toBe(null)
  })
})

describe('interest — an exclusive relation to a HIDDEN target does not leak the target handle', () => {
  it('the hidden target handle (riding the eid column) is absent from baseline+delta bytes', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const src = createWorld({ components: [P, V] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    for (let i = 0; i < 500; i++) src.spawnWith(P)
    const secret = src.spawnWith(P) // hidden
    const seen = src.spawnWith(P, V)
    rel.addPair(seen, ChildOf, secret) // exclusive target rides seen's eid column
    const stream = createReplicationStream(src)
    const view = stream.view({ visible: src.query(has(V)) })

    const base = view.baseline()
    expect(containsSubsequence(base.bytes.subarray(36), handleBytes(secret))).toBe(false)

    src.advanceTick()
    const secret2 = src.spawnWith(P) // still hidden
    rel.addPair(seen, ChildOf, secret2) // retarget the exclusive relation to another hidden entity
    const d = view.delta()
    expect(containsSubsequence(d.bytes.subarray(32), handleBytes(secret2))).toBe(false)
  })
})
