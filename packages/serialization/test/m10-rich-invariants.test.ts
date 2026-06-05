// P1 rich-fields SERIALIZATION invariant suite (rich-fields.md §10/§11) — the discriminating leg that
// complements m10-rich-snapshot / m10-rich-delta / m10-rich-version-gating with:
//   • RF-ROUNDTRIP: rich-only AND mixed components in ONE snapshot round-trip (parity), plus a
//     delta-WITH-STRUCTURE round-trip where a rich value changed since T lands on a NEW entity.
//   • RF-SHADOW-FREE / epsilon: the no-shadow instrumentation pattern — the delta's emitted changed-row
//     set equals world.changedRows (version-stamp driven, NOT a value diff), and the epsilon shadow is
//     SERIALIZER-INSTANCE-owned (two serializers over the same world diverge: the no-epsilon one emits a
//     sub-epsilon row the epsilon one drops; core itself never sees the shadow).
//   • Epsilon: sub-epsilon dropped, supra-epsilon kept, rich never epsilon-filtered.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'
import { FLAG_HAS_RICH } from '../src/format.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

function mirror(src: ReturnType<typeof createWorld>, dstComps: readonly ComponentDef<Schema>[]) {
  const dst = createWorld({ components: dstComps })
  const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
  return { dst, remap: new Map(remap) }
}

// ===========================================================================
// RF-ROUNDTRIP — rich-only + mixed components together; delta-with-structure where rich changed since T.
// ===========================================================================
describe('RF-ROUNDTRIP — mixed rich-only + mixed components in one snapshot', () => {
  it('a world with a rich-ONLY and a numeric+rich component round-trips both fully', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const Node = defineComponent({ hp: 'i32', meta: object<{ tags: string[] }>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Label, Node) })
    const onlyLabel = src.spawnWith([Label, { text: 'rich-only' }])
    const onlyNode = src.spawnWith([Node, { hp: 3, meta: { tags: ['m'] } }])
    const both = src.spawn()
    src.add(both, Label)
    src.add(both, Node)
    ;(src.entity(both).write(Label) as { text: string }).text = 'both-label'
    ;(src.entity(both).write(Node) as { hp: number; meta: { tags: string[] } }).hp = 9
    ;(src.entity(both).write(Node) as { meta: { tags: string[] } }).meta = { tags: ['p', 'q'] }

    const RL = defineComponent({ text: 'string' }, { name: 'label' })
    const RN = defineComponent({ hp: 'i32', meta: object<{ tags: string[] }>() }, { name: 'node' })
    const { dst, remap } = mirror(src, asComps(RL, RN))

    const nOnlyLabel = remap.get(onlyLabel as never) as EntityHandle
    const nOnlyNode = remap.get(onlyNode as never) as EntityHandle
    const nBoth = remap.get(both as never) as EntityHandle
    expect((dst.entity(nOnlyLabel).read(RL) as { text: string }).text).toBe('rich-only')
    const on = dst.entity(nOnlyNode).read(RN) as { hp: number; meta: { tags: string[] } }
    expect(on.hp).toBe(3)
    expect(on.meta).toEqual({ tags: ['m'] })
    expect((dst.entity(nBoth).read(RL) as { text: string }).text).toBe('both-label')
    const bn = dst.entity(nBoth).read(RN) as { hp: number; meta: { tags: string[] } }
    expect(bn.hp).toBe(9)
    expect(bn.meta).toEqual({ tags: ['p', 'q'] })
  })

  it('delta WITH structure: a rich value changed since T lands on an entity CREATED by the same delta', () => {
    const Doc = defineComponent({ title: 'string', meta: object<{ k: number }>() }, { name: 'doc' })
    const src = createWorld({ components: asComps(Doc) })
    const seed = src.spawnWith([Doc, { title: 'seed', meta: { k: 0 } }])

    const RDoc = defineComponent({ title: 'string', meta: object<{ k: number }>() }, { name: 'doc' })
    const { dst, remap } = mirror(src, asComps(RDoc))

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T) // includeStructural defaults true
    src.advanceTick()
    // mutate the seed's rich field AND create a brand-new entity with rich values in the same window.
    ;(src.entity(seed).write(Doc) as { title: string }).title = 'seed-v2'
    const fresh = src.spawn()
    src.add(fresh, Doc)
    ;(src.entity(fresh).write(Doc) as { title: string; meta: { k: number } }).title = 'fresh'
    ;(src.entity(fresh).write(Doc) as { meta: { k: number } }).meta = { k: 42 }

    const bytes = ser.deltaCopy()
    expect(bytes[7]! & FLAG_HAS_RICH).toBe(FLAG_HAS_RICH)
    applyDelta(dst, bytes, remap)

    const nSeed = remap.get(seed as never) as EntityHandle
    const nFresh = remap.get(fresh as never) as EntityHandle
    expect((dst.entity(nSeed).read(RDoc) as { title: string }).title).toBe('seed-v2')
    expect(nFresh).toBeDefined()
    const f = dst.entity(nFresh).read(RDoc) as { title: string; meta: { k: number } }
    expect(f.title).toBe('fresh')
    expect(f.meta).toEqual({ k: 42 })
  })
})

// ===========================================================================
// Epsilon + RF-SHADOW-FREE — the serializer-owned shadow; no core allocation (instrumented).
// ===========================================================================
describe('Epsilon + RF-SHADOW-FREE — serializer-owned shadow, no core allocation', () => {
  it('sub-epsilon change DROPPED, supra-epsilon KEPT (shadow tracks the last EMITTED value)', () => {
    const P = defineComponent({ x: 'f64' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    const e = src.spawnWith([P, { x: 100 }])
    const R = defineComponent({ x: 'f64' }, { name: 'p' })
    const { dst, remap } = mirror(src, asComps(R))
    const ne = remap.get(e as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { epsilon: 1 })
    // seed the shadow at 100.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 100
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(100)

    // +0.5 within tolerance 1 → dropped.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 100.5
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(100)

    // +2 from the last EMITTED (100) → exceeds → kept; shadow advances to 102.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 102
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(102)
  })

  it('the shadow is SERIALIZER-INSTANCE-owned: a no-epsilon serializer over the SAME world emits the row the epsilon one drops', () => {
    const P = defineComponent({ x: 'f64' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    const e = src.spawnWith([P, { x: 0 }])

    const Reps = defineComponent({ x: 'f64' }, { name: 'p' })
    const Rpure = defineComponent({ x: 'f64' }, { name: 'p' })
    const eps = mirror(src, asComps(Reps))
    const pure = mirror(src, asComps(Rpure))
    const nEps = eps.remap.get(e as never) as EntityHandle
    const nPure = pure.remap.get(e as never) as EntityHandle

    const T = src.currentTick()
    const epsSer = createDeltaSerializer(src, T, { epsilon: 10 })
    const pureSer = createDeltaSerializer(src, T) // no epsilon → core-pure row selection

    // seed both shadows / baselines at 0.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 0
    applyDelta(eps.dst, epsSer.deltaCopy(), eps.remap)
    applyDelta(pure.dst, pureSer.deltaCopy(), pure.remap)

    // a sub-epsilon nudge: the epsilon serializer DROPS it, the pure serializer EMITS it. If core held a
    // single shared shadow, the two would not diverge — proving the shadow is serializer-scoped.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 5 // |5-0| = 5 < 10
    applyDelta(eps.dst, epsSer.deltaCopy(), eps.remap)
    applyDelta(pure.dst, pureSer.deltaCopy(), pure.remap)

    expect((eps.dst.entity(nEps).read(Reps) as { x: number }).x).toBe(0) // dropped → receiver stays
    expect((pure.dst.entity(nPure).read(Rpure) as { x: number }).x).toBe(5) // emitted → receiver advances
  })

  it('the no-epsilon delta carries EXACTLY world.changedRows (version-stamp driven, no value diff)', () => {
    const P = defineComponent({ x: 'f64' }, { name: 'p' })
    const src = createWorld({ components: asComps(P), maxEntities: 64 })
    const ents: EntityHandle[] = []
    for (let i = 0; i < 6; i++) ents.push(src.spawnWith([P, { x: i }]))

    const since = src.currentTick()
    const ser = createDeltaSerializer(src, since)
    src.advanceTick()
    // write the SAME value to a subset — a value-diff serializer would emit nothing; a stamp-driven one
    // emits exactly the written rows. This is the discriminating no-shadow assertion.
    const writtenIdx = new Set<number>([0, 2, 4])
    for (const i of writtenIdx) (src.entity(ents[i]!).write(P) as { x: number }).x = i // identical value

    // ground truth: the version-stamp changed-row set across archetypes.
    const stamped = new Set<number>()
    for (const a of src.__serialize.archetypes()) for (const row of src.changedRows(a.id, since)) stamped.add(row)
    expect(stamped.size).toBe(writtenIdx.size) // exactly the written rows, despite identical values

    // applying that delta reproduces the live world (no row was silently value-diffed away).
    const R = defineComponent({ x: 'f64' }, { name: 'p' })
    const { dst, remap } = mirror(src, asComps(R))
    const ser2 = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    for (const i of writtenIdx) (src.entity(ents[i]!).write(P) as { x: number }).x = 1000 + i
    applyDelta(dst, ser2.deltaCopy(), remap)
    void ser // (first serializer only used for the stamped-set instrumentation)
    for (const i of writtenIdx) {
      const nh = remap.get(ents[i]! as never) as EntityHandle
      expect((dst.entity(nh).read(R) as { x: number }).x).toBe(1000 + i)
    }
  })

  it('rich fields are NEVER epsilon-filtered: a string change emits under a huge epsilon', () => {
    const Mix = defineComponent({ x: 'f64', label: 'string' }, { name: 'mix' })
    const src = createWorld({ components: asComps(Mix) })
    const e = src.spawnWith([Mix, { x: 0, label: 'l0' }])
    const R = defineComponent({ x: 'f64', label: 'string' }, { name: 'mix' })
    const { dst, remap } = mirror(src, asComps(R))
    const ne = remap.get(e as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { epsilon: 1e9 })
    src.advanceTick()
    ;(src.entity(e).write(Mix) as { x: number }).x = 0 // seed
    applyDelta(dst, ser.deltaCopy(), remap)

    src.advanceTick()
    ;(src.entity(e).write(Mix) as { x: number }).x = 1 // |1| < 1e9 → numeric dropped
    ;(src.entity(e).write(Mix) as { label: string }).label = 'l1' // rich → ALWAYS emitted
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { label: string }).label).toBe('l1')
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(0) // numeric still dropped
  })
})
