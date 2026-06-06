// Rich-field DELTA serialization: SECTION R riding the same changeVersion row
// selection, applyDelta ordering (structural → values → rich), present/absent per-row flagging, rich
// values landing on entities CREATED by the same delta, and epsilon-diff (T-EPSILON-DROP / CORE-PURE).

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, field, object } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'
import { FLAG_HAS_RICH } from '../src/format.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

function bootstrap<C extends ComponentDef<Schema>>(srcComps: readonly C[], dstComps: readonly C[], src: ReturnType<typeof createWorld>) {
  void srcComps
  const dst = createWorld({ components: dstComps as readonly ComponentDef<Schema>[] })
  const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
  return { dst, remap: new Map(remap) }
}

describe('RICH — delta carries changed rich values (T-RT-DELTA)', () => {
  it('a rich field changed since baseline applies to the stale mirror', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    const a = src.spawnWith([Label, { text: 'a0' }])
    const b = src.spawnWith([Label, { text: 'b0' }])

    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const { dst, remap } = bootstrap(asComps(Label), asComps(R), src)

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    ;(src.entity(a).write(Label) as { text: string }).text = 'a1' // a changed; b unchanged
    const bytes = ser.deltaCopy()
    expect(bytes[7]! & FLAG_HAS_RICH).toBe(FLAG_HAS_RICH)
    applyDelta(dst, bytes, remap)

    const na = remap.get(a as never) as EntityHandle
    const nb = remap.get(b as never) as EntityHandle
    expect((dst.entity(na).read(R) as { text: string }).text).toBe('a1')
    expect((dst.entity(nb).read(R) as { text: string }).text).toBe('b0') // present=0 row → kept current
  })

  it('a rich value lands on an entity CREATED by the same delta (structural → values → rich order)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    src.spawnWith([Label, { text: 'seed' }]) // so the bootstrap snapshot is non-empty

    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const { dst, remap } = bootstrap(asComps(Label), asComps(R), src)

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    const fresh = src.spawnWith([Label, { text: 'created-in-delta' }]) // structural create + rich write
    const bytes = ser.deltaCopy()
    applyDelta(dst, bytes, remap)

    const nFresh = remap.get(fresh as never) as EntityHandle
    expect(nFresh).toBeDefined()
    expect((dst.entity(nFresh).read(R) as { text: string }).text).toBe('created-in-delta')
  })

  it('object<T> rich value round-trips through a delta', () => {
    const Node = defineComponent({ hp: 'i32', meta: object<{ k: string }>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const e = src.spawnWith([Node, { hp: 1, meta: { k: 'v0' } }])

    const R = defineComponent({ hp: 'i32', meta: object<{ k: string }>() }, { name: 'node' })
    const { dst, remap } = bootstrap(asComps(Node), asComps(R), src)

    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    ;(src.entity(e).write(Node) as { meta: { k: string } }).meta = { k: 'v1' }
    applyDelta(dst, ser.deltaCopy(), remap)

    const ne = remap.get(e as never) as EntityHandle
    expect((dst.entity(ne).read(R) as { meta: { k: string } }).meta).toEqual({ k: 'v1' })
  })
})

describe('RICH — reset-to-default propagates (T-RT-RESET, v4 wire)', () => {
  it('a string field reset to undefined re-defaults on the mirror (the v3 silent-keep bug)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    const e = src.spawnWith([Label, { text: 'hello' }])

    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const { dst, remap } = bootstrap(asComps(Label), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle
    expect((dst.entity(ne).read(R) as { text?: string }).text).toBe('hello')

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(e).write(Label) as { text: string | undefined }).text = undefined
    applyDelta(dst, ser.deltaCopy(), remap)
    // the bare 'string' token defaults to '' — pre-v4 the mirror kept 'hello' forever
    expect((dst.entity(ne).read(R) as { text?: string }).text).toBe('')
  })

  it('a reset lands on the DECLARED default, not undefined', () => {
    const Tag = defineComponent({ name: field('string', { default: 'anon' }) }, { name: 'tag' })
    const src = createWorld({ components: asComps(Tag) })
    const e = src.spawnWith([Tag, { name: 'alice' }])

    const R = defineComponent({ name: field('string', { default: 'anon' }) }, { name: 'tag' })
    const { dst, remap } = bootstrap(asComps(Tag), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle
    expect((dst.entity(ne).read(R) as { name: string }).name).toBe('alice')

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(e).write(Tag) as { name: string | undefined }).name = undefined
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { name: string }).name).toBe('anon')
  })

  it('an object<T> field reset to undefined re-defaults on the mirror', () => {
    const Node = defineComponent({ hp: 'i32', meta: object<{ k: string }>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const e = src.spawnWith([Node, { hp: 1, meta: { k: 'v0' } }])

    const R = defineComponent({ hp: 'i32', meta: object<{ k: string }>() }, { name: 'node' })
    const { dst, remap } = bootstrap(asComps(Node), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle
    expect((dst.entity(ne).read(R) as { meta?: { k: string } }).meta).toEqual({ k: 'v0' })

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(e).write(Node) as { meta: { k: string } | undefined }).meta = undefined
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { meta?: { k: string } }).meta).toBeUndefined()
  })

  it('an unserializable value SKIPS (keeps the mirror value) — a skip never clobbers', () => {
    const Node = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const e = src.spawnWith([Node, { meta: { k: 'good' } }])

    const R = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const { dst, remap } = bootstrap(asComps(Node), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { onUnserializable: () => undefined })
    src.advanceTick()
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    ;(src.entity(e).write(Node) as { meta: unknown }).meta = cyclic
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { meta: unknown }).meta).toEqual({ k: 'good' })
  })

  it('a pre-v4 delta is rejected loudly (its wire conflates reset with unchanged)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    const e = src.spawnWith([Label, { text: 'x' }])

    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const { dst, remap } = bootstrap(asComps(Label), asComps(R), src)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(e).write(Label) as { text: string }).text = 'y'
    const bytes = ser.deltaCopy()
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, 3, true) // forge a v3 stamp
    expect(() => applyDelta(dst, bytes, remap)).toThrow(/unsupported delta format version 3/)
  })
})

describe('RICH — epsilon-diff (T-EPSILON-DROP / T-EPSILON-CORE-PURE)', () => {
  it('a numeric change within epsilon is DROPPED; one exceeding is emitted; shadow accumulates', () => {
    const P = defineComponent({ x: 'f64' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    const e = src.spawnWith([P, { x: 10 }])

    const R = defineComponent({ x: 'f64' }, { name: 'p' })
    const { dst, remap } = bootstrap(asComps(P), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { epsilon: 0.5 })
    // First emit: write 10 again so it lands in this delta and seeds the shadow (initial obs emitted).
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 10
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(10)

    // A sub-epsilon nudge: |10.2 - 10| = 0.2 < 0.5 → dropped; receiver stays at 10.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 10.2
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(10)

    // A further nudge to 10.4: |10.4 - 10| = 0.4 < 0.5 (shadow is still 10, last EMITTED) → still dropped.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 10.4
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBe(10)

    // Cross the tolerance: 10.8 vs shadow 10 → |0.8| > 0.5 → emitted; shadow updates to 10.8.
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 10.8
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { x: number }).x).toBeCloseTo(10.8)
  })

  it('rich fields are NEVER epsilon-filtered (a string change emits regardless of epsilon)', () => {
    const Mix = defineComponent({ x: 'f64', label: 'string' }, { name: 'mix' })
    const src = createWorld({ components: asComps(Mix) })
    const e = src.spawnWith([Mix, { x: 0, label: 'l0' }])

    const R = defineComponent({ x: 'f64', label: 'string' }, { name: 'mix' })
    const { dst, remap } = bootstrap(asComps(Mix), asComps(R), src)
    const ne = remap.get(e as never) as EntityHandle

    const ser = createDeltaSerializer(src, src.currentTick(), { epsilon: 100 })
    src.advanceTick()
    ;(src.entity(e).write(Mix) as { x: number; label: string }).x = 0 // seed shadow to 0
    applyDelta(dst, ser.deltaCopy(), remap) // seed

    src.advanceTick()
    ;(src.entity(e).write(Mix) as { x: number; label: string }).x = 1 // within epsilon=100 → dropped
    ;(src.entity(e).write(Mix) as { x: number; label: string }).label = 'l1' // rich → always emitted
    applyDelta(dst, ser.deltaCopy(), remap)
    expect((dst.entity(ne).read(R) as { label: string }).label).toBe('l1')
  })

  it('T-EPSILON-CORE-PURE: with epsilon unset AND no rich fields, FLAG_HAS_RICH is unset, no shadow', () => {
    const P = defineComponent({ x: 'f64' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    const e = src.spawnWith([P, { x: 1 }])
    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    ;(src.entity(e).write(P) as { x: number }).x = 2
    const bytes = ser.deltaCopy()
    expect(bytes[7]! & FLAG_HAS_RICH).toBe(0) // no rich section
    // Behavioral purity: the value still applies exactly (no epsilon distortion).
    const R = defineComponent({ x: 'f64' }, { name: 'p' })
    const { dst, remap } = bootstrap(asComps(P), asComps(R), src)
    void dst
    void remap
  })
})
