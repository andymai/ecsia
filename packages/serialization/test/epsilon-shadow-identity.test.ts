// The epsilon shadow must follow ENTITY identity, not row position: swap-pop, archetype migration,
// and despawn/respawn all hand a shadow row to a new tenant, and comparing the new tenant's values
// against the previous tenant's emissions lets the receiver drift unboundedly — the documented
// contract is convergence to within epsilon. A tenant change makes the row fresh: emit + reseed.

import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta } from '../src/index.js'
import { computeRowFieldMasks, newArchShadow } from '../src/delta.js'
import { SERIALIZATION_FORMAT_VERSION } from '../src/format.js'
import type { EpsilonCol } from '../src/delta.js'
import { scenarioFrames } from './epsilon-byte-identity.fixture.js'

const mk = () => {
  const P = defineComponent({ x: 'f32' }, { name: 'P' })
  return { P: P as ComponentDef<Schema>, world: createWorld({ components: [P] }) }
}

const mirror = (src: ReturnType<typeof mk>) => {
  const dst = mk()
  const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshot(), 'replace')
  return { dst, remap: res.remap as Map<EntityHandle, EntityHandle> }
}

describe('epsilon shadow follows entity identity', () => {
  test('swap-pop row reuse: the moved survivor converges within epsilon', () => {
    const src = mk()
    const a = src.world.spawnWith(src.P)
    const b = src.world.spawnWith(src.P)

    const { dst, remap } = mirror(src)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { epsilon: 0.5 })

    // Warm the shadow: emit a(x=0) and b(x=100) once, so their rows hold last-emitted values.
    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 0
    src.world.entity(b).write(src.P).x = 100
    applyDelta(dst.world, ser.delta(), remap)

    src.world.advanceTick()
    src.world.despawn(a)                       // swap-pop: b moves into a's row (shadow holds a's 0)
    src.world.entity(b).write(src.P).x = 0.25  // a 99.75 change for b — but only 0.25 from a's cell
    applyDelta(dst.world, ser.delta(), remap)

    const mb = remap.get(b) as EntityHandle
    expect(dst.world.entity(mb).read(dst.P).x).toBeCloseTo(0.25, 5)
  })

  test('despawn + respawn reusing the row: the new entity is emitted, not dropped', () => {
    const src = mk()
    const a = src.world.spawnWith(src.P)

    const { dst, remap } = mirror(src)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { epsilon: 0.5 })

    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 7     // warm: emit a(x=7)
    applyDelta(dst.world, ser.delta(), remap)

    src.world.advanceTick()
    src.world.despawn(a)
    const c = src.world.spawnWith(src.P)       // reuses a's index/row (shadow holds a's 7)
    src.world.entity(c).write(src.P).x = 7.2   // within epsilon of the DEAD tenant's 7
    applyDelta(dst.world, ser.delta(), remap)

    const mc = remap.get(c) as EntityHandle
    expect(mc).toBeDefined()
    expect(dst.world.entity(mc).read(dst.P).x).toBeCloseTo(7.2, 4)
  })

  // Growing an archetype reallocates the shadow column, and `fresh` is COLUMN-scoped: the call that
  // observes the growth reports every candidate row as changed, not just the appended one. The
  // consequence is an over-send (a within-tolerance row emits once), never a drop — which is what
  // makes the change masks safe to drive a field-granular wire, where a wrongly-CLEAR bit would
  // strand a stale value on the receiver forever.
  test('an entity entering the archetype re-emits within-tolerance rows (over-send, never a drop)', () => {
    const src = mk()
    const a = src.world.spawnWith(src.P)

    const { dst, remap } = mirror(src)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { epsilon: 0.5 })
    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 1
    applyDelta(dst.world, ser.delta(), remap)
    const ma = remap.get(a) as EntityHandle

    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 1.2 // sub-epsilon: dropped, receiver lags
    applyDelta(dst.world, ser.delta(), remap)
    expect(dst.world.entity(ma).read(dst.P).x).toBeCloseTo(1, 4)

    src.world.advanceTick()
    src.world.spawnWith(src.P) // grows the column ⇒ FRESH ⇒ every candidate row emits
    src.world.entity(a).write(src.P).x = 1.3 // still sub-epsilon vs the last emitted 1
    applyDelta(dst.world, ser.delta(), remap)
    expect(dst.world.entity(ma).read(dst.P).x).toBeCloseTo(1.3, 4)
  })

  test('a sub-epsilon change on an UNMOVED entity is still dropped (the optimization survives)', () => {
    const src = mk()
    const a = src.world.spawnWith(src.P)
    src.world.entity(a).write(src.P).x = 10

    const { dst, remap } = mirror(src)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { epsilon: 0.5 })
    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 10.1  // first delta emits (fresh shadow seeds)
    applyDelta(dst.world, ser.delta(), remap)

    src.world.advanceTick()
    src.world.entity(a).write(src.P).x = 10.2  // sub-epsilon vs last emitted
    const wire = ser.delta()
    applyDelta(dst.world, wire, remap)
    const ma = remap.get(a) as EntityHandle
    expect(dst.world.entity(ma).read(dst.P).x).toBeCloseTo(10.1, 4) // receiver keeps last emitted
  })
})

// Frozen wire golden. The epsilon row filter is expressed over per-field change masks, and the ONLY
// admissible observable of that machinery is "no observable at all" — the emitted bytes must not move.
// A failure here means SECTION V row selection (or the wire format itself) changed: re-derive the
// digests deliberately, never to make the test pass.
describe('epsilon filtering is byte-identical on the wire', () => {
  const digest = (frames: readonly Uint8Array[]): string => {
    const h = createHash('sha256')
    for (const f of frames) h.update(f)
    return h.digest('hex')
  }

  // The goldens are the v4 ones, frozen BEFORE the field-granular wire landed. v5 changes exactly two
  // bytes of a component-granularity image — the header's version word — so rewinding that word to 4
  // must reproduce them byte for byte. That is a far stronger regression guard than re-deriving them.
  const GOLDEN = [
    [undefined, '1e2e3e03cc87b4759a8ddeccf4daa21075975bf0ac87ddcfaf510d441b77e342', [238, 160, 80, 56, 93, 152, 92, 80, 80, 68, 40]],
    [0.5, 'b2f1696ad2136a7263759936c678915520b59c8d2c30bbc3013fcac26ad26829', [238, 80, 40, 56, 93, 152, 92, 80, 40, 68, 40]],
    [0.05, 'f8743bd91cc52bfa794c6ad89d8a30c00fa3102bb9963bb812f507926ee98246', [238, 120, 80, 56, 93, 152, 92, 80, 40, 68, 40]],
  ] as const

  const asVersion4 = (f: Uint8Array): Uint8Array => {
    const copy = f.slice()
    new DataView(copy.buffer).setUint16(4, 4, true)
    return copy
  }

  test.each(GOLDEN)('epsilon=%s reproduces the pre-v5 golden delta stream', (epsilon, sha256, lengths) => {
    const frames = scenarioFrames(epsilon)
    expect(frames.map((f) => f.byteLength)).toEqual(lengths) // fails first, and legibly
    for (const f of frames) expect(new DataView(f.buffer, f.byteOffset).getUint16(4, true)).toBe(SERIALIZATION_FORMAT_VERSION)
    expect(digest(frames.map(asVersion4))).toBe(sha256)
  })

  test('the three configurations really do diverge (the golden would otherwise prove nothing)', () => {
    const digests = new Set([undefined, 0.5, 0.05].map((e) => digest(scenarioFrames(e))))
    expect(digests.size).toBe(3)
  })
})

describe('computeRowFieldMasks', () => {
  const ROWS = [11, 22] as const
  const col = (view: readonly number[], stride: number, cells: readonly number[], fresh = false): EpsilonCol => ({
    key: 0,
    view,
    stride,
    fresh,
    cells: Float64Array.from(cells),
  })
  const arch = { count: ROWS.length, rows: ROWS }
  const warm = () => {
    const shadow = newArchShadow(ROWS.length)
    shadow.tenants.set(ROWS)
    return shadow
  }
  // c0: scalar, c1: 3-lane, c2: scalar. Two rows, so every buffer is 2 * stride long.
  const cols = (r0: readonly number[], r1: readonly number[], shadowR0: readonly number[], shadowR1: readonly number[]) => [
    col([r0[0] as number, r1[0] as number], 1, [shadowR0[0] as number, shadowR1[0] as number]),
    col([...r0.slice(1, 4), ...r1.slice(1, 4)], 3, [...shadowR0.slice(1, 4), ...shadowR1.slice(1, 4)]),
    col([r0[4] as number, r1[4] as number], 1, [shadowR0[4] as number, shadowR1[4] as number]),
  ]

  test('every lane within tolerance ⇒ no bits set', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1.04, 2, 3, 3.96, 5], [6, 7.05, 8, 9, 10])
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect(shadow.maskWords).toBe(1)
    expect([masks[0], masks[1]]).toEqual([0b000, 0b000])
  })

  test('every column out of tolerance ⇒ every bit set', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0])
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect([masks[0], masks[1]]).toEqual([0b111, 0b111])
  })

  test('only the LAST lane of the middle column moved ⇒ only that column bit', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1, 2, 3, 99, 5], [6, 7, 8, 9, 10])
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect([masks[0], masks[1]]).toEqual([0b010, 0b000])
  })

  test('only the last COLUMN moved ⇒ only the high bit', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1, 2, 3, 4, 5], [6, 7, 8, 9, 99])
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect([masks[0], masks[1]]).toEqual([0b000, 0b100])
  })

  test('a FRESH column sets its bit on every row regardless of the values', () => {
    const shadow = warm()
    const c = [col([1, 6], 1, [1, 6]), col([2, 7], 1, [2, 7], true)]
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect([masks[0], masks[1]]).toEqual([0b10, 0b10])
  })

  test('a tenant change sets every bit (the new occupant is wholly new to the receiver)', () => {
    const shadow = newArchShadow(ROWS.length) // NO_TENANT everywhere
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect([masks[0], masks[1]]).toEqual([0b111, 0b111])
  })

  test('only the requested rows are written', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0])
    const masks = computeRowFieldMasks(arch, [1], shadow, c, 0.05)
    expect(masks[1]).toBe(0b111)
    expect(masks[0]).toBe(0) // untouched — the buffer is scratch, not state
  })

  test('past 32 columns the mask spills into a second word', () => {
    const shadow = warm()
    const c = Array.from({ length: 33 }, (_, i) => col([i, i], 1, [i, i === 32 ? 99 : i]))
    const masks = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect(shadow.maskWords).toBe(2)
    expect([masks[0], masks[1]]).toEqual([0, 0]) // row 0: nothing moved, both words clear
    expect([masks[2], masks[3]]).toEqual([0, 1]) // row 1: only column 32 → bit 0 of word 1
  })

  test('no allocation per call: the scratch buffer is reused across calls', () => {
    const shadow = warm()
    const c = cols([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0])
    const first = computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)
    expect(computeRowFieldMasks(arch, [0, 1], shadow, c, 0.05)).toBe(first)
  })
})
