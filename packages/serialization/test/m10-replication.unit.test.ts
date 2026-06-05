// The replication envelope: schema gate on every message (G1), tick-chaining enforcement (G2),
// journal-gap auto-degrade to baseline (G3), receiver-owned stream-lifetime remap (G4), and the
// binary envelope codec (G5). Plus the echo-asymmetry pin — the peer-flow constraint: applying a
// delta does NOT re-stamp the written values (raw column writes bypass version stamping, so the
// receiver's own delta serializer never re-emits them), but applied STRUCTURAL ops DO journal, so
// a receiver's own delta stream re-broadcasts creates it merely applied. Until per-stream interest
// filtering lands, symmetric whole-world bidirectional streams therefore duplicate entities — the
// supported P2P topology is host-elected.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import {
  createReplicationStream,
  createReplicationReceiver,
  createDeltaSerializer,
  encodeReplicationMessage,
  decodeReplicationMessage,
  REPLICATION_HEADER_BYTES,
} from '../src/index.js'
import { FLAG_HAS_STRUCTURAL } from '../src/format.js'

const defP = () => defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema>

// A producer/receiver pair sharing the SAME defineComponent source (identical schema code on both
// sides, so the schemaHash matches), synced through the stream's own join baseline.
function pair() {
  const P = defP()
  const src = createWorld({ components: [P] })
  const R = defP()
  const dst = createWorld({ components: [R] })
  const stream = createReplicationStream(src)
  const receiver = createReplicationReceiver(dst)
  return { P, src, R, dst, stream, receiver }
}

describe('replication — baseline + chained deltas (the happy path)', () => {
  it('a joiner applies the baseline, then deltas chain tick-to-tick', () => {
    const { P, src, R, dst, stream, receiver } = pair()
    const a = src.spawnWith(P)
    ;(src.entity(a).write(P) as { x: number }).x = 1

    const join = receiver.apply(stream.baseline())
    expect(join).toEqual({ applied: true, needBaseline: false, tick: src.currentTick() })
    const localA = receiver.remap.get(a) as EntityHandle
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(1)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 2
    const d1 = stream.tick()
    expect(d1.kind).toBe('delta')
    expect(receiver.apply(d1)).toEqual({ applied: true, needBaseline: false, tick: d1.tick })

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 3
    const d2 = stream.tick()
    expect(d2.baselineTick).toBe(d1.tick)
    expect(receiver.apply(d2).applied).toBe(true)
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(3)
  })

  it('the same-flush delta arriving after a join baseline is skipped idempotently (no needBaseline)', () => {
    const { P, src, stream, receiver } = pair()
    const a = src.spawnWith(P)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 5
    // The broadcast recipe: tick() and the joiner's baseline() at the SAME serial flush.
    const d = stream.tick()
    const b = stream.baseline()
    expect(b.tick).toBe(d.tick)

    expect(receiver.apply(b).applied).toBe(true)
    // The delta's window is already covered by the baseline — applying would replay its structural ops.
    expect(receiver.apply(d)).toEqual({ applied: false, needBaseline: false, tick: b.tick })

    // The NEXT delta chains onto the join tick.
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 6
    expect(receiver.apply(stream.tick()).applied).toBe(true)
  })
})

describe('replication — schemaHash validation (G1)', () => {
  it('a DELTA message from a different schema throws loudly, never partially applies', () => {
    const P = defP()
    const src = createWorld({ components: [P] })
    const stream = createReplicationStream(src)
    const Other = defineComponent({ hp: 'i32' }, { name: 'other' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [Other] })
    const receiver = createReplicationReceiver(dst)

    src.advanceTick()
    src.spawnWith(P)
    const d = stream.tick()
    expect(d.kind).toBe('delta')
    expect(() => receiver.apply(d)).toThrow(/schemaHash mismatch/)
  })
})

describe('replication — tick-chaining enforcement (G2)', () => {
  it('a delta before any baseline → { applied: false, needBaseline: true }', () => {
    const { P, src, stream, receiver } = pair()
    src.advanceTick()
    src.spawnWith(P)
    expect(receiver.apply(stream.tick())).toEqual({ applied: false, needBaseline: true, tick: -1 })
  })

  it('a skipped delta breaks the chain → needBaseline; a fresh baseline resyncs', () => {
    const { P, src, R, dst, stream, receiver } = pair()
    const a = src.spawnWith(P)
    receiver.apply(stream.baseline())
    const localA = receiver.remap.get(a) as EntityHandle

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 10
    stream.tick() // emitted but LOST in transport

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 20
    const afterLoss = stream.tick()
    const r = receiver.apply(afterLoss)
    expect(r.applied).toBe(false)
    expect(r.needBaseline).toBe(true)
    // No partial apply: the receiver still holds its pre-loss state.
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(0)

    // In-band resync: a baseline at the current flush rebases the receiver and the chain resumes.
    const rebase = receiver.apply(stream.baseline())
    expect(rebase.applied).toBe(true)
    const localA2 = receiver.remap.get(a) as EntityHandle
    expect((dst.entity(localA2).read(R) as { x: number }).x).toBeCloseTo(20)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 30
    expect(receiver.apply(stream.tick()).applied).toBe(true)
    expect((dst.entity(localA2).read(R) as { x: number }).x).toBeCloseTo(30)
  })
})

describe('replication — a corrupt delta poisons the receiver until a baseline heals it', () => {
  it('a truncated payload → needBaseline; every later delta refused; a baseline restores convergence', () => {
    const { P, src, R, dst, stream, receiver } = pair()
    const a = src.spawnWith(P)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 1
    const covered = stream.tick() // same-flush delta, normally skipped idempotently after the join
    const join = stream.baseline()
    expect(receiver.apply(join).applied).toBe(true)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 2
    const b = src.spawnWith(P) // structural op — lands BEFORE the corrupt value bytes are hit
    const d = stream.tick()
    // Valid envelope fields, corrupt payload: the value section's tail is cut off mid-row, so
    // applyDelta throws AFTER the structural section already applied — partially-applied state.
    const truncated: typeof d = { ...d, bytes: d.bytes.subarray(0, d.bytes.byteLength - 4) }
    expect(receiver.apply(truncated)).toEqual({ applied: false, needBaseline: true, tick: join.tick })

    // Poisoned: even an already-covered message must NOT take the idempotent-skip path — the
    // world no longer matches what "covered" meant.
    expect(receiver.apply(covered)).toEqual({ applied: false, needBaseline: true, tick: join.tick })

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 3
    const afterPoison = receiver.apply(stream.tick())
    expect(afterPoison.applied).toBe(false)
    expect(afterPoison.needBaseline).toBe(true)

    // A baseline's replace-load heals the partial state; the chain and convergence resume.
    expect(receiver.apply(stream.baseline()).applied).toBe(true)
    const localA = receiver.remap.get(a) as EntityHandle
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(3)
    expect(dst.isAlive(receiver.remap.get(b) as EntityHandle)).toBe(true)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 4
    expect(receiver.apply(stream.tick()).applied).toBe(true)
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(4)
  })
})

describe('replication — journal gap forces a baseline (G3)', () => {
  it('structural churn beyond the journal window degrades tick() to kind "baseline", and the next delta chains', () => {
    const P = defP()
    // maxEntities 512 ⇒ maxShapeChangesPerFrame defaults to 1024 ⇒ journal capacity 1024.
    const src = createWorld({ components: [P], maxEntities: 512 })
    const R = defP()
    const dst = createWorld({ components: [R] })
    const stream = createReplicationStream(src)
    const receiver = createReplicationReceiver(dst)
    const keeper = src.spawnWith(P)
    receiver.apply(stream.baseline())

    src.advanceTick()
    // Each spawn+despawn cycle journals ≥3 records (Create, ComponentAdd, Destroy); 600 cycles
    // overflow the 1024-record ring, evicting records inside the (sinceTick, now] window.
    for (let i = 0; i < 600; i++) src.despawn(src.spawnWith(P))
    ;(src.entity(keeper).write(P) as { x: number }).x = 7

    const degraded = stream.tick()
    expect(degraded.kind).toBe('baseline')
    expect(receiver.apply(degraded).applied).toBe(true)
    const localKeeper = receiver.remap.get(keeper) as EntityHandle
    expect((dst.entity(localKeeper).read(R) as { x: number }).x).toBeCloseTo(7)

    // The degraded emission advanced the delta cursor: the next tick() is a delta chaining from it.
    src.advanceTick()
    ;(src.entity(keeper).write(P) as { x: number }).x = 8
    const next = stream.tick()
    expect(next.kind).toBe('delta')
    expect(next.baselineTick).toBe(degraded.tick)
    expect(receiver.apply(next).applied).toBe(true)
    expect((dst.entity(localKeeper).read(R) as { x: number }).x).toBeCloseTo(8)
  })
})

describe('replication — receiver-owned remap grows across deltas (G4)', () => {
  it('an entity created by delta N resolves for a value written in delta N+1', () => {
    const { P, src, R, dst, stream, receiver } = pair()
    src.spawnWith(P)
    receiver.apply(stream.baseline())

    src.advanceTick()
    const b = src.spawnWith(P)
    receiver.apply(stream.tick())
    const localB = receiver.remap.get(b) as EntityHandle
    expect(localB).toBeDefined()
    expect(dst.isAlive(localB)).toBe(true)

    src.advanceTick()
    ;(src.entity(b).write(P) as { x: number }).x = 77
    receiver.apply(stream.tick())
    expect((dst.entity(localB).read(R) as { x: number }).x).toBeCloseTo(77)
  })

  it('a baseline rebases the remap in place — same Map reference, fresh entries', () => {
    const { P, src, stream, receiver } = pair()
    const a = src.spawnWith(P)
    const remapRef = receiver.remap
    receiver.apply(stream.baseline())
    const before = remapRef.get(a)
    expect(before).toBeDefined()

    receiver.apply(stream.baseline())
    expect(receiver.remap).toBe(remapRef)
    const after = remapRef.get(a)
    expect(after).toBeDefined()
    expect(after).not.toBe(before) // the reload minted new receiver handles
  })
})

describe('replication — envelope codec round-trip (G5)', () => {
  it('encode → decode preserves every field and the payload bytes', () => {
    const { P, src, stream } = pair()
    src.spawnWith(P)
    src.advanceTick()
    src.spawnWith(P)
    for (const msg of [stream.baseline(), stream.tick()]) {
      const wire = encodeReplicationMessage(msg)
      expect(wire.byteLength).toBe(REPLICATION_HEADER_BYTES + msg.bytes.byteLength)
      const decoded = decodeReplicationMessage(wire)
      expect(decoded.seq).toBe(msg.seq)
      expect(decoded.kind).toBe(msg.kind)
      expect(decoded.schemaHash).toBe(msg.schemaHash)
      expect(decoded.baselineTick).toBe(msg.baselineTick)
      expect(decoded.tick).toBe(msg.tick)
      expect(Array.from(decoded.bytes)).toEqual(Array.from(msg.bytes))
    }
  })

  it('rejects truncated input, bad magic, an unknown version, and an unknown kind', () => {
    const { P, src, stream } = pair()
    src.spawnWith(P)
    const wire = encodeReplicationMessage(stream.baseline())

    expect(() => decodeReplicationMessage(wire.subarray(0, 8))).toThrow(/truncated/)

    const badMagic = wire.slice()
    badMagic[0] = 0
    expect(() => decodeReplicationMessage(badMagic)).toThrow(/bad magic/)

    const badVersion = wire.slice()
    badVersion[4] = 99
    expect(() => decodeReplicationMessage(badVersion)).toThrow(/envelope version/)

    const badKind = wire.slice()
    badKind[6] = 7
    expect(() => decodeReplicationMessage(badKind)).toThrow(/message kind/)
  })
})

describe('replication — epsilon stream converges to within epsilon', () => {
  it('a sub-tolerance change is held back; the receiver stays within epsilon of the producer', () => {
    const P = defP()
    const src = createWorld({ components: [P] })
    const R = defP()
    const dst = createWorld({ components: [R] })
    const epsilon = 0.5
    const stream = createReplicationStream(src, { epsilon })
    const receiver = createReplicationReceiver(dst)
    const a = src.spawnWith(P)
    receiver.apply(stream.baseline())
    const localA = receiver.remap.get(a) as EntityHandle

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 10 // beyond tolerance — emitted
    receiver.apply(stream.tick())
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(10)

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 10.2 // within tolerance — held back
    receiver.apply(stream.tick())
    const clientX = (dst.entity(localA).read(R) as { x: number }).x
    const serverX = (src.entity(a).read(P) as { x: number }).x
    expect(clientX).toBeCloseTo(10)
    expect(Math.abs(serverX - clientX)).toBeLessThanOrEqual(epsilon)
  })

  it('a baseline snaps the shadow: a post-rebaseline change between ε and 2ε reaches the receiver', () => {
    const P = defP()
    const src = createWorld({ components: [P] })
    const R = defP()
    const dst = createWorld({ components: [R] })
    const epsilon = 0.5
    const stream = createReplicationStream(src, { epsilon })
    const receiver = createReplicationReceiver(dst)
    const a = src.spawnWith(P)
    receiver.apply(stream.baseline())

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 10 // emitted — the shadow holds 10
    receiver.apply(stream.tick())

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 10.4 // within ε of the shadow — held back
    receiver.apply(stream.tick())

    // The rebasing baseline delivers the EXACT 10.4 …
    expect(receiver.apply(stream.baseline()).applied).toBe(true)
    const localA = receiver.remap.get(a) as EntityHandle
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(10.4)

    // … so a change of magnitude between ε and 2ε vs the receiver's state must be emitted.
    // Without the shadow snap it is within ε of the stale last-EMITTED 10 and held back,
    // leaving the rebased receiver 0.8 (> ε) adrift.
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 9.6
    expect(receiver.apply(stream.tick()).applied).toBe(true)
    const clientX = (dst.entity(localA).read(R) as { x: number }).x
    expect(clientX).toBeCloseTo(9.6)
    expect(Math.abs((src.entity(a).read(P) as { x: number }).x - clientX)).toBeLessThanOrEqual(epsilon)
  })
})

describe('replication — echo asymmetry (the peer-flow constraint)', () => {
  it('applied VALUES do not re-stamp; applied STRUCTURAL ops do journal', () => {
    const { P, src, R, dst, stream, receiver } = pair()
    const a = src.spawnWith(P)
    // The receiver runs its OWN delta serializer (the peer scenario): constructing it registers
    // the changeVersion + structural-journal consumers on dst BEFORE the incoming delta applies.
    const dstSer = createDeltaSerializer(dst, dst.currentTick())
    receiver.apply(stream.baseline())
    const localA = receiver.remap.get(a) as EntityHandle
    const mark = dst.currentTick()
    dst.advanceTick()

    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 42
    const b = src.spawnWith(P)
    receiver.apply(stream.tick())

    // VALUE side: the write landed (x = 42) but bypassed version stamping — dst's own delta
    // serializer will NOT re-emit it back to the producer.
    expect((dst.entity(localA).read(R) as { x: number }).x).toBeCloseTo(42)
    expect(dst.changedSince(localA, mark)).toBe(false)

    // STRUCTURAL side: the applied create went through spawn, which JOURNALS — dst's own delta
    // re-broadcasts it as a create of a dst-local handle. This is why symmetric whole-world
    // bidirectional streams duplicate entities (host-elected topology until interest filtering).
    const localB = receiver.remap.get(b) as EntityHandle
    expect(dst.isAlive(localB)).toBe(true)
    const journaled = dst.__serialize.drainStructuralSince(mark)
    expect(journaled.records.length).toBeGreaterThan(0)
    const echo = dstSer.deltaCopy()
    expect((echo[7] as number) & FLAG_HAS_STRUCTURAL).toBe(FLAG_HAS_STRUCTURAL)
  })
})
