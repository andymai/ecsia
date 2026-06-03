// M10 DISCRIMINATING property suite for the STRUCTURAL-since-T delta (serialization.md §6.2 / §6.4 / §9).
// Each property is built to FAIL if the locked design regresses — they are not tautologies:
//
//   P-SOUND  delta-with-structure SOUNDNESS: for a RANDOM interleaving of value writes AND structural
//            ops (spawn / despawn / add / remove / addPair) in (T, now], applying the delta to a
//            mirror taken at T reproduces the LIVE world — entity set + values + relations — by deep
//            compare. This FAILS if the structural section is dropped: a spawn-since-T would be
//            missing from the mirror (proven by the includeStructural:false control below, which is
//            EXPECTED to diverge precisely on the structural ops).
//
//   P-NOALLOC  the delta GATHER path performs NO per-tick / per-row heap allocation (§9): repeated
//            delta() over a stable topology reuses the hoisted output buffer and allocates ZERO
//            per-row Float64Array (the §6.2 native-width raw-copy path, NOT an f64-widening gather).
//            Instrumented by counting Float64Array / ArrayBuffer constructions across many ticks.
//
//   P-WIRE   the value field WIRE round-trips through the §6.2 element-ordinal + native-element-width
//            encoding for EVERY ElementKind (u8/u8c/i8/u16/i16/u32/i32/f32/f64): a value written on
//            the producer arrives bit-faithful on the receiver after a value-only delta.

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, ElementKind, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta } from '../src/index.js'

// ---------------------------------------------------------------------------------------------------
// P-SOUND — random value + structural ops in (T, now]; apply(delta) deep-equals the live world.
// ---------------------------------------------------------------------------------------------------

// A structural/value op the fuzzer applies on the producer between T and now. Indices are taken modulo
// the live-handle list so they always resolve to a real entity. The fuzz exercises the GENERAL case the
// spec mandates: a single population where any entity may be written, migrated (add/remove Q), despawned,
// or made the subject/target of a non-exclusive relation pair — value writes and structural mutations
// freely interleave on the SAME entities and archetypes (no disjoint-population or archetype isolation).
type Op =
  | { t: 'spawn'; x: number }
  | { t: 'despawn'; i: number }
  | { t: 'addQ'; i: number }
  | { t: 'removeQ'; i: number }
  | { t: 'writeP'; i: number; x: number }
  | { t: 'addPair'; i: number; j: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('spawn' as const), x: fc.integer({ min: -1000, max: 1000 }) }),
  fc.record({ t: fc.constant('despawn' as const), i: fc.nat() }),
  fc.record({ t: fc.constant('addQ' as const), i: fc.nat() }),
  fc.record({ t: fc.constant('removeQ' as const), i: fc.nat() }),
  fc.record({ t: fc.constant('writeP' as const), i: fc.nat(), x: fc.integer({ min: -1000, max: 1000 }) }),
  fc.record({ t: fc.constant('addPair' as const), i: fc.nat(), j: fc.nat() }),
)

interface Kit {
  world: ReturnType<typeof createWorld>
  rel: ReturnType<typeof createRelations>
  P: ComponentDef<Schema>
  Q: ComponentDef<Schema>
  M: ComponentDef<Schema>
  Likes: ReturnType<ReturnType<typeof createRelations>['defineRelation']>
}

function makeKit(): Kit {
  const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
  const Q = defineComponent({}, { name: 'q' }) as ComponentDef<Schema> // tag
  const M = defineComponent({}, { name: 'm' }) as ComponentDef<Schema> // tag: marks the struct population
  const world = createWorld({ components: [P, Q, M], maxEntities: 256 })
  const rel = createRelations(world)
  const Likes = rel.defineRelation(null, { exclusive: false })
  return { world, rel, P, Q, M, Likes }
}

// Apply the op stream on the producer over a SINGLE general population `live`: any entity may be written,
// migrated (add/remove Q), despawned, or related — value writes and structural mutations freely
// interleave on the same entities and archetypes. This is the general case §6.3/§6.4 mandate (the delta
// must survive write-then-migrate and a non-exclusive addPair regardless of subject index).
function applyOps(kit: Kit, ops: readonly Op[], live: EntityHandle[]): void {
  const aliveList = (): EntityHandle[] => live.filter((h) => kit.world.isAlive(h))
  for (const op of ops) {
    switch (op.t) {
      case 'spawn': {
        const h = kit.world.spawnWith(kit.P)
        ;(kit.world.entity(h).write(kit.P) as { x: number }).x = op.x
        live.push(h)
        break
      }
      case 'despawn': {
        const alive = aliveList()
        if (alive.length === 0) break
        kit.world.despawn(alive[op.i % alive.length] as EntityHandle)
        break
      }
      case 'addQ': {
        const alive = aliveList()
        if (alive.length === 0) break
        const h = alive[op.i % alive.length] as EntityHandle
        if (!kit.world.has(h, kit.Q)) kit.world.add(h, kit.Q) // Q is a tag — membership only
        break
      }
      case 'removeQ': {
        const alive = aliveList()
        if (alive.length === 0) break
        const h = alive[op.i % alive.length] as EntityHandle
        if (kit.world.has(h, kit.Q)) kit.world.remove(h, kit.Q)
        break
      }
      case 'writeP': {
        const alive = aliveList()
        if (alive.length === 0) break
        ;(kit.world.entity(alive[op.i % alive.length] as EntityHandle).write(kit.P) as { x: number }).x = op.x
        break
      }
      case 'addPair': {
        const alive = aliveList()
        if (alive.length < 2) break
        const a = alive[op.i % alive.length] as EntityHandle
        const b = alive[op.j % alive.length] as EntityHandle
        if (a === b) break
        if (!kit.rel.hasPair(a, kit.Likes, b)) kit.rel.addPair(a, kit.Likes, b) // non-exclusive
        break
      }
    }
  }
}

// A canonical, handle-independent digest of the live world, read through the PUBLIC surface and keyed
// by a cross-world token so producer and receiver compare on the same id space.
interface Canon {
  rows: string[]
  pairs: string[]
}
function canon(
  world: ReturnType<typeof createWorld>,
  rel: ReturnType<typeof createRelations>,
  P: ComponentDef<Schema>,
  Q: ComponentDef<Schema>,
  M: ComponentDef<Schema>,
  Likes: ReturnType<ReturnType<typeof createRelations>['defineRelation']>,
  handles: EntityHandle[],
  tokenOf: Map<number, number>,
): Canon {
  const rows: string[] = []
  for (const h of handles) {
    if (!world.isAlive(h)) continue
    const parts: string[] = [`@${tokenOf.get(h as number) ?? '?'}`]
    if (world.has(h, P)) parts.push(`p:${(world.entity(h).read(P) as { x: number }).x}`)
    if (world.has(h, Q)) parts.push('q') // tag membership
    if (world.has(h, M)) parts.push('m') // tag membership
    rows.push(parts.join(','))
  }
  rows.sort()
  const pairs: string[] = []
  for (const a of handles) {
    if (!world.isAlive(a)) continue
    for (const b of handles) {
      if (!world.isAlive(b) || a === b) continue
      if (rel.hasPair(a, Likes, b)) pairs.push(`${tokenOf.get(a as number) ?? '?'}->${tokenOf.get(b as number) ?? '?'}`)
    }
  }
  pairs.sort()
  return { rows, pairs }
}

describe('P-SOUND — delta-with-structure soundness over random value + structural ops (§6.4)', () => {
  test('apply(delta) deep-equals the live world (entity set + values + relations)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.array(opArb, { minLength: 1, maxLength: 24 }), (n0, ops) => {
        const kit = makeKit()
        // A SINGLE general population: every baseline entity may be written AND structurally mutated.
        const live: EntityHandle[] = []
        for (let i = 0; i < n0; i++) live.push(kit.world.spawnWith(kit.P))

        // Receiver mirror at T (the baseline snapshot builds the remap).
        const RP = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
        const RQ = defineComponent({}, { name: 'q' }) as ComponentDef<Schema>
        const RM = defineComponent({}, { name: 'm' }) as ComponentDef<Schema>
        const dst = createWorld({ components: [RP, RQ, RM], maxEntities: 256 })
        const relDst = createRelations(dst)
        const LikesDst = relDst.defineRelation(null, { exclusive: false })
        const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(kit.world).snapshotCopy())
        const work = new Map(remap)

        // Open the delta at T, advance, run the fuzzed op stream, then apply.
        const ser = createDeltaSerializer(kit.world, kit.world.currentTick())
        kit.world.advanceTick()
        applyOps(kit, ops, live)
        applyDelta(dst, ser.deltaCopy(), work)

        // Cross-world tokens: each producer handle and its remapped receiver handle share a token index.
        const srcToken = new Map<number, number>()
        const dstToken = new Map<number, number>()
        live.forEach((h, i) => {
          srcToken.set(h as number, i)
          const nh = work.get(h as never)
          if (nh !== undefined) dstToken.set(nh as number, i)
        })
        const dstHandles = live.map((h) => work.get(h as never)).filter((h): h is EntityHandle => h !== undefined)

        const before = canon(kit.world, kit.rel, kit.P, kit.Q, kit.M, kit.Likes, live, srcToken)
        const after = canon(dst, relDst, RP, RQ, RM, LikesDst, dstHandles, dstToken)
        expect(after).toEqual(before)
      }),
      { numRuns: 250 },
    )
  })

  test('DISCRIMINATION: includeStructural:false diverges precisely on the structural ops (spawns missing)', () => {
    // A single deterministic case proving the structural section is load-bearing: with it dropped, a
    // spawn-since-T is absent on the mirror, so the deep compare must FAIL.
    const kit = makeKit()
    const live: EntityHandle[] = [kit.world.spawnWith(kit.P)]
    const RP = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const RQ = defineComponent({}, { name: 'q' }) as ComponentDef<Schema>
    const RM = defineComponent({}, { name: 'm' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [RP, RQ, RM], maxEntities: 256 })
    const relDst = createRelations(dst)
    const LikesDst = relDst.defineRelation(null, { exclusive: false })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(kit.world).snapshotCopy())
    const work = new Map(remap)

    const ser = createDeltaSerializer(kit.world, kit.world.currentTick(), { includeStructural: false })
    kit.world.advanceTick()
    applyOps(kit, [{ t: 'spawn', x: 42 }], live)
    applyDelta(dst, ser.deltaCopy(), work)

    const srcToken = new Map<number, number>()
    const dstToken = new Map<number, number>()
    live.forEach((h, i) => {
      srcToken.set(h as number, i)
      const nh = work.get(h as never)
      if (nh !== undefined) dstToken.set(nh as number, i)
    })
    const dstHandles = live.map((h) => work.get(h as never)).filter((h): h is EntityHandle => h !== undefined)

    const before = canon(kit.world, kit.rel, kit.P, kit.Q, kit.M, kit.Likes, live, srcToken)
    const after = canon(dst, relDst, RP, RQ, RM, LikesDst, dstHandles, dstToken)
    // The spawned entity exists on the producer but NOT on the value-only mirror → digests differ.
    expect(after).not.toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------------------
// P-NOALLOC — the delta gather path performs no per-tick / per-row heap allocation (§9).
// ---------------------------------------------------------------------------------------------------

describe('P-NOALLOC — repeated delta() reuses the hoisted buffer; zero per-row Float64Array (§9 / §6.2)', () => {
  test('no per-row Float64Array allocation across many value-write ticks', () => {
    const P = defineComponent({ pos: 'f64' }, { name: 'p' }) as ComponentDef<Schema>
    const world = createWorld({ components: [P], maxEntities: 256 })
    const ents: EntityHandle[] = []
    for (let i = 0; i < 64; i++) ents.push(world.spawnWith(P))

    // A value-ONLY delta so the gather path is exercised in isolation (no structural journal walk).
    const ser = createDeltaSerializer(world, world.currentTick(), { includeStructural: false })

    // Warm up one delta so any lazy one-time allocations are paid BEFORE we start counting.
    world.advanceTick()
    for (const h of ents) (world.entity(h).write(P) as { pos: number }).pos = 1
    ser.delta()

    // Instrument: count Float64Array and ArrayBuffer constructions during the measured ticks.
    const RealF64 = globalThis.Float64Array
    const RealAB = globalThis.ArrayBuffer
    let f64Count = 0
    let abCount = 0
    class CountingF64 extends RealF64 {
      constructor(...args: ConstructorParameters<typeof RealF64>) {
        super(...(args as []))
        f64Count++
      }
    }
    class CountingAB extends RealAB {
      constructor(...args: ConstructorParameters<typeof RealAB>) {
        super(...(args as []))
        abCount++
      }
    }
    ;(globalThis as { Float64Array: typeof RealF64 }).Float64Array = CountingF64 as unknown as typeof RealF64
    ;(globalThis as { ArrayBuffer: typeof RealAB }).ArrayBuffer = CountingAB as unknown as typeof RealAB
    try {
      const TICKS = 50
      for (let t = 0; t < TICKS; t++) {
        world.advanceTick()
        for (const h of ents) (world.entity(h).write(P) as { pos: number }).pos = t
        ser.delta() // returns a view onto the REUSED buffer — no copy, no per-row gather alloc
      }
      // The §6.2 gather is a raw byte copy at native width — it must NOT widen each row into a fresh
      // Float64Array. Zero per-row f64 allocations across all measured ticks.
      expect(f64Count).toBe(0)
      // The hoisted output buffer is reused (it only doubles on overflow); a stable-size delta over 50
      // ticks must allocate NO new ArrayBuffer on the hot path.
      expect(abCount).toBe(0)
    } finally {
      ;(globalThis as { Float64Array: typeof RealF64 }).Float64Array = RealF64
      ;(globalThis as { ArrayBuffer: typeof RealAB }).ArrayBuffer = RealAB
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// P-WIRE — a value field round-trips through element-ordinal + native-element-width for EVERY kind.
// ---------------------------------------------------------------------------------------------------

const ALL_KINDS: readonly ElementKind[] = ['u8', 'u8c', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64']

// A representative, in-range value for each ElementKind (round-trip must be bit-faithful).
function valueArbFor(kind: ElementKind): fc.Arbitrary<number> {
  switch (kind) {
    case 'u8':
    case 'u8c':
      return fc.integer({ min: 0, max: 255 })
    case 'i8':
      return fc.integer({ min: -128, max: 127 })
    case 'u16':
      return fc.integer({ min: 0, max: 65535 })
    case 'i16':
      return fc.integer({ min: -32768, max: 32767 })
    case 'u32':
      return fc.integer({ min: 0, max: 0xffffffff }).map((v) => v >>> 0)
    case 'i32':
      return fc.integer({ min: -2147483648, max: 2147483647 })
    case 'f32':
      // Exactly representable f32 values (small integers) so the round-trip is bit-exact.
      return fc.integer({ min: -100000, max: 100000 })
    case 'f64':
      return fc.double({ min: -1e9, max: 1e9, noNaN: true })
    default:
      return fc.integer()
  }
}

describe('P-WIRE — value field round-trips through element-ordinal + native width for every ElementKind (§6.2)', () => {
  for (const kind of ALL_KINDS) {
    test(`kind ${kind}: producer value arrives bit-faithful through a value-only delta`, () => {
      fc.assert(
        fc.property(fc.array(valueArbFor(kind), { minLength: 1, maxLength: 8 }), (values) => {
          const P = defineComponent({ v: kind }, { name: 'p' }) as ComponentDef<Schema>
          const src = createWorld({ components: [P], maxEntities: 64 })
          const ents: EntityHandle[] = []
          for (let i = 0; i < values.length; i++) ents.push(src.spawnWith(P))

          const R = defineComponent({ v: kind }, { name: 'p' }) as ComponentDef<Schema>
          const dst = createWorld({ components: [R], maxEntities: 64 })
          const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
          const work = new Map(remap)

          // Value-only delta: every row gets a fresh value, encoded at the kind's NATIVE width.
          const ser = createDeltaSerializer(src, src.currentTick(), { includeStructural: false })
          src.advanceTick()
          for (let i = 0; i < values.length; i++) {
            ;(src.entity(ents[i] as EntityHandle).write(P) as { v: number }).v = values[i] as number
          }
          applyDelta(dst, ser.deltaCopy(), work)

          for (let i = 0; i < values.length; i++) {
            const na = work.get(ents[i] as never) as EntityHandle
            const got = (dst.entity(na).read(R) as { v: number }).v
            const want = (src.entity(ents[i] as EntityHandle).read(P) as { v: number }).v
            expect(got).toBe(want) // bit-faithful: producer-read === receiver-read at native width
          }
        }),
        { numRuns: 60 },
      )
    })
  }
})

// ---------------------------------------------------------------------------------------------------
// REGRESSION: a non-exclusive ADD_PAIR since T whose subject is entity INDEX 0 must NOT despawn its
// subject on the mirror. This guards the one-line argument-order bug previously in the world.ts
// trackShapePair adapter (kind/targetIndex swapped), which journaled a spurious Destroy(target=0xffff)
// for any non-exclusive addPair on index 0 — applyStructuralOps then despawned the remapped subject.
// ---------------------------------------------------------------------------------------------------

describe('non-exclusive ADD_PAIR-since-T must not despawn its index-0 subject', () => {
  test('subject stays alive on the mirror after a non-exclusive addPair delta', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P], maxEntities: 64 })
    const rel = createRelations(src)
    const Likes = rel.defineRelation(null, { exclusive: false })
    const a = src.spawnWith(P) // entity index 0 — the trigger condition
    const b = src.spawnWith(P)

    const R = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [R], maxEntities: 64 })
    const relDst = createRelations(dst)
    relDst.defineRelation(null, { exclusive: false })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)
    const na = work.get(a as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    rel.addPair(a, Likes, b)
    applyDelta(dst, ser.deltaCopy(), work)

    expect(dst.isAlive(na)).toBe(true) // the addPair must NOT destroy its own subject
  })
})

// ---------------------------------------------------------------------------------------------------
// REGRESSION: a VALUE write to an entity that is THEN relocated by a structural op (its own migration,
// or a SIBLING's swap-remove within the same archetype) must survive in the delta. The changeVersion
// stamp is keyed by ENTITY INDEX (change-version.ts), so it follows the entity across the relocation and
// `world.changedRows(arch, since)` (the §6.3 scan) still sees the moved-but-written row.
// ---------------------------------------------------------------------------------------------------

describe('a value write followed by the entity migrating must survive in the delta', () => {
  test('write-then-migrate value reaches the mirror (stamp follows the entity across relocation)', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const Q = defineComponent({}, { name: 'q' }) as ComponentDef<Schema>
    const src = createWorld({ components: [P, Q], maxEntities: 64 })
    const a = src.spawnWith(P)

    const R = defineComponent({ x: 'f32' }, { name: 'p' }) as ComponentDef<Schema>
    const RQ = defineComponent({}, { name: 'q' }) as ComponentDef<Schema>
    const dst = createWorld({ components: [R, RQ], maxEntities: 64 })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)
    const na = work.get(a as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = -1 // write BEFORE the migration
    src.add(a, Q) // a migrates [P] → [P,Q]; the changeVersion stamp follows the entity index
    applyDelta(dst, ser.deltaCopy(), work)

    expect((dst.entity(na).read(R) as { x: number }).x).toBeCloseTo(-1) // mirror reflects the write
  })
})
