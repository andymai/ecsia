import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { createSnapshotSerializer, createSnapshotDeserializer, SNAPSHOT_MAGIC } from '../src/index.js'

// Component defs register to exactly one world, so a cross-world round-trip mirrors the real
// (cross-process) use-case: BOTH worlds run the same defineComponent source. We model that with a
// factory that builds a fresh def set per world.
function defs() {
  return {
    Position: defineComponent({ x: 'f32', y: 'f32' }, { brand: 'Position' }),
    Velocity: defineComponent({ dx: 'f32', dy: 'f32' }, { brand: 'Velocity' }),
    Target: defineComponent({ who: 'eid' }, { brand: 'Target' }),
    Tag: defineComponent({}, { brand: 'Tag' }),
  }
}

describe('snapshot — round-trip', () => {
  it('emits a valid header + reproduces component columns', () => {
    const D = defs()
    const src = createWorld({ components: [D.Position, D.Velocity, D.Target, D.Tag] })
    const e1 = src.spawnWith(D.Position, D.Velocity)
    ;(src.entity(e1).write(D.Position) as { x: number; y: number }).x = 1.5
    ;(src.entity(e1).write(D.Position) as { x: number; y: number }).y = 2.5
    ;(src.entity(e1).write(D.Velocity) as { dx: number; dy: number }).dx = -3
    const e2 = src.spawnWith(D.Position, D.Tag)
    ;(src.entity(e2).write(D.Position) as { x: number; y: number }).x = 9

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)).toBe(SNAPSHOT_MAGIC)

    const R = defs()
    const dst = createWorld({ components: [R.Position, R.Velocity, R.Target, R.Tag] })
    const result = createSnapshotDeserializer(dst).load(bytes)
    expect(result.entitiesCreated).toBe(2)

    const n1 = result.remap.get(e1 as never) as never
    const p1 = dst.entity(n1).read(R.Position) as { x: number; y: number }
    expect(p1.x).toBeCloseTo(1.5)
    expect(p1.y).toBeCloseTo(2.5)
    const v1 = dst.entity(n1).read(R.Velocity) as { dx: number }
    expect(v1.dx).toBeCloseTo(-3)
    expect(dst.has(result.remap.get(e2 as never) as never, R.Tag)).toBe(true)
  })

  it('remaps eid fields through the remap table', () => {
    const D = defs()
    const src = createWorld({ components: [D.Position, D.Target] })
    const a = src.spawnWith(D.Position)
    const b = src.spawnWith(D.Target)
    ;(src.entity(b).write(D.Target) as { who: number }).who = a as number

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    const R = defs()
    const dst = createWorld({ components: [R.Position, R.Target] })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const nb = remap.get(b as never) as never
    const na = remap.get(a as never)
    const who = (dst.entity(nb).read(R.Target) as { who: number }).who
    expect(who).toBe(na as number)
  })

  it('determinism: two snapshots of the same state are byte-identical', () => {
    const D = defs()
    const src = createWorld({ components: [D.Position] })
    const e = src.spawnWith(D.Position)
    ;(src.entity(e).write(D.Position) as { x: number }).x = 42
    const ser = createSnapshotSerializer(src)
    const a = ser.snapshotCopy()
    const b = ser.snapshotCopy()
    expect(Buffer.from(a)).toEqual(Buffer.from(b))
  })
})

describe('snapshot — relations', () => {
  it('round-trips exclusive + overflow relations with both eids remapped', () => {
    const P1 = defineComponent({ x: 'f32' }, { brand: 'P' })
    const src = createWorld({ components: [P1] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
    const Damage = rel.defineRelation({ amount: 'u32' }, { exclusive: false })
    const parent = src.spawnWith(P1)
    const child = src.spawnWith(P1)
    rel.addPair(child, ChildOf, parent, { weight: 7 })
    const atk = src.spawn()
    const v1 = src.spawn()
    rel.addPair(atk, Damage, v1, { amount: 50 })

    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const P2 = defineComponent({ x: 'f32' }, { brand: 'P' })
    const dst = createWorld({ components: [P2] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation({ weight: 'f32' }, { exclusive: true })
    const DamageDst = relDst.defineRelation({ amount: 'u32' }, { exclusive: false })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)

    const nChild = remap.get(child as never) as never
    const nParent = remap.get(parent as never) as never
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
    expect(relDst.getPair(nChild, ChildOfDst, nParent).read()['weight']).toBeCloseTo(7)

    const nAtk = remap.get(atk as never) as never
    const nV1 = remap.get(v1 as never) as never
    expect(relDst.hasPair(nAtk, DamageDst, nV1)).toBe(true)
    expect(relDst.getPair(nAtk, DamageDst, nV1).read()['amount']).toBe(50)
  })
})
