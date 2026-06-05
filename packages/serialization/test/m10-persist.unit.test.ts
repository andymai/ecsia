// Field-level serialization control (persist: false). Snapshot: skipped fields
// are never written and re-default on load while persisted fields stay bit-exact; the wire-position
// mapping survives a skipped column between persisted ones. Delta: skipped values never reach the
// wire (the changeVersion stamp is shared with reactivity, so the filter is emission-time — a write
// to a skipped field still stamps the row for `.changed`); an archetype with no persisted columns
// contributes nothing to SECTION V. Mismatched persist flags change the schemaHash and are rejected
// on load. Relation payloads are name-keyed, so a skipped payload field is simply omitted.

import fc from 'fast-check'
import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, field, object, vec3 } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
  encodeStructuralOps,
  createObserverLog,
  DeltaOp,
} from '../src/index.js'

function containsF32(bytes: Uint8Array, value: number): boolean {
  const probe = new Uint8Array(new Float32Array([value]).buffer)
  outer: for (let i = 0; i + 4 <= bytes.length; i++) {
    for (let j = 0; j < 4; j++) {
      if (bytes[i + j] !== probe[j]) continue outer
    }
    return true
  }
  return false
}

// A schema with a skipped column BETWEEN persisted ones, so the wire-position → local-column
// mapping is exercised (a naive positional read would land `v`/`tail` one column early).
function mixedDefs() {
  return {
    Mixed: defineComponent(
      {
        a: 'f32',
        cache: field('f32', { persist: false }),
        v: vec3(),
        tail: field('u8', { default: 3, persist: false }),
        b: 'i32',
      },
      { name: 'mixed' },
    ),
  }
}

describe('persist — snapshot round-trip', () => {
  it('persisted fields are bit-exact; skipped fields re-default (zero or declared default)', () => {
    const D = mixedDefs()
    const src = createWorld({ components: [D.Mixed as ComponentDef<Schema>] })
    const e = src.spawnWith(D.Mixed as ComponentDef<Schema>)
    const w = src.entity(e).write(D.Mixed) as { a: number; cache: number; v: { x: number; y: number; z: number }; tail: number; b: number }
    w.a = 1.5
    w.cache = 777.25
    w.v.x = 2.5
    w.v.y = -4
    w.v.z = 8.25
    w.tail = 9
    w.b = -12345

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(containsF32(bytes, 777.25)).toBe(false) // the skipped value never reaches the wire

    const R = mixedDefs()
    const dst = createWorld({ components: [R.Mixed as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const n = remap.get(e as never) as EntityHandle
    const r = dst.entity(n).read(R.Mixed) as { a: number; cache: number; v: { x: number; y: number; z: number }; tail: number; b: number }
    expect(r.a).toBe(1.5) // exact, not toBeCloseTo
    expect(r.v.x).toBe(2.5)
    expect(r.v.y).toBe(-4)
    expect(r.v.z).toBe(8.25)
    expect(r.b).toBe(-12345)
    expect(r.cache).toBe(0) // skipped → zero default
    expect(r.tail).toBe(3) // skipped → declared default
  })

  it('a persist:false COMPONENT keeps its membership but every value re-defaults', () => {
    const make = () => ({
      Pos: defineComponent({ x: 'f32' }, { name: 'pos' }),
      Cache: defineComponent({ n: 'i32' }, { name: 'cache', persist: false }),
      Flag: defineComponent({}, { name: 'flag', persist: false }),
    })
    const D = make()
    const src = createWorld({ components: [D.Pos, D.Cache, D.Flag] as readonly ComponentDef<Schema>[] })
    const e = src.spawnWith(D.Pos as ComponentDef<Schema>, D.Cache as ComponentDef<Schema>, D.Flag as ComponentDef<Schema>)
    ;(src.entity(e).write(D.Pos) as { x: number }).x = 4
    ;(src.entity(e).write(D.Cache) as { n: number }).n = 42

    const R = make()
    const dst = createWorld({ components: [R.Pos, R.Cache, R.Flag] as readonly ComponentDef<Schema>[] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const n = remap.get(e as never) as EntityHandle
    expect(dst.has(n, R.Cache)).toBe(true) // membership persists — persist controls VALUES only
    expect(dst.has(n, R.Flag)).toBe(true) // a persist:false tag round-trips as pure membership
    expect((dst.entity(n).read(R.Pos) as { x: number }).x).toBe(4)
    expect((dst.entity(n).read(R.Cache) as { n: number }).n).toBe(0)
  })

  it('a persist:false rich field (object<T>) is skipped by the JSON sidecar section', () => {
    const make = () => ({
      C: defineComponent({ x: 'f32', scratch: field(object<{ big: string }>(), { persist: false }) }, { name: 'c' }),
    })
    const D = make()
    const src = createWorld({ components: [D.C as ComponentDef<Schema>] })
    const e = src.spawnWith(D.C as ComponentDef<Schema>)
    const w = src.entity(e).write(D.C) as { x: number; scratch: { big: string } }
    w.x = 6
    w.scratch = { big: 'transient' }

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    const R = make()
    const dst = createWorld({ components: [R.C as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const n = remap.get(e as never) as EntityHandle
    const r = dst.entity(n).read(R.C) as { x: number; scratch: { big: string } | undefined }
    expect(r.x).toBe(6)
    expect(r.scratch).toBeUndefined()
  })
})

describe('persist — delta', () => {
  function mirror(srcComponents: readonly ComponentDef<Schema>[], dstComponents: readonly ComponentDef<Schema>[]) {
    const src = createWorld({ components: srcComponents })
    const dst = createWorld({ components: dstComponents })
    return { src, dst }
  }

  it('skipped-field values never reach the wire; the receiver keeps its default', () => {
    const D = mixedDefs()
    const R = mixedDefs()
    const { src, dst } = mirror([D.Mixed as ComponentDef<Schema>], [R.Mixed as ComponentDef<Schema>])
    const e = src.spawnWith(D.Mixed as ComponentDef<Schema>)
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const w = src.entity(e).write(D.Mixed) as { a: number; cache: number }
    w.a = 11.5
    w.cache = 999.75

    const patch = ser.deltaCopy()
    expect(containsF32(patch, 999.75)).toBe(false)
    applyDelta(dst, patch, remap)

    const n = remap.get(e as never) as EntityHandle
    const r = dst.entity(n).read(R.Mixed) as { a: number; cache: number; tail: number }
    expect(r.a).toBe(11.5)
    expect(r.cache).toBe(0)
    expect(r.tail).toBe(3)
  })

  it('a write to ONLY a skipped field still stamps the row for reactivity (emission-time filter)', () => {
    const D = mixedDefs()
    const src = createWorld({ components: [D.Mixed as ComponentDef<Schema>] })
    const e = src.spawnWith(D.Mixed as ComponentDef<Schema>)
    createDeltaSerializer(src, src.currentTick()) // turns on changeVersion stamping
    const since = src.currentTick()
    src.advanceTick()
    ;(src.entity(e).write(D.Mixed) as { cache: number }).cache = 5

    // Reactivity is a SEPARATE consumer of the shared stamp: it must still see the row.
    let stamped = 0
    for (const a of src.__serialize.archetypes()) stamped += [...src.changedRows(a.id, since)].length
    expect(stamped).toBe(1)
  })

  it('an archetype whose every column is skipped contributes nothing to the value section', () => {
    const make = () => defineComponent({ n: 'i32' }, { name: 'cacheOnly', persist: false })
    const C = make()
    const src = createWorld({ components: [C as ComponentDef<Schema>] })
    const e = src.spawnWith(C as ComponentDef<Schema>)
    const ser = createDeltaSerializer(src, src.currentTick())
    const emptyLen = ser.deltaCopy().byteLength // baseline: nothing changed
    src.advanceTick()
    ;(src.entity(e).write(C) as { n: number }).n = 1234
    expect(ser.deltaCopy().byteLength).toBe(emptyLen) // the write produced zero wire growth
  })
})

describe('persist — schemaHash gate', () => {
  it('rejects a snapshot whose producer persist flags differ (per-field)', () => {
    const P = defineComponent({ x: 'f32', s: field('f32', { persist: false }) }, { name: 'c' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    src.spawnWith(P as ComponentDef<Schema>)
    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defineComponent({ x: 'f32', s: 'f32' }, { name: 'c' }) // same shape, s persisted
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    expect(() => createSnapshotDeserializer(dst).load(bytes)).toThrow(/schemaHash mismatch/)
  })

  it('rejects a snapshot whose producer persist flags differ (component-level)', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'c', persist: false })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    src.spawnWith(P as ComponentDef<Schema>)
    const bytes = createSnapshotSerializer(src).snapshotCopy()

    const R = defineComponent({ x: 'f32' }, { name: 'c' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    expect(() => createSnapshotDeserializer(dst).load(bytes)).toThrow(/schemaHash mismatch/)
  })

  it('an all-persisted schema keeps its hash (flag only folds in when false)', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'c' })
    const B = defineComponent({ x: field('f32', { persist: true }) }, { name: 'c' })
    const wa = createWorld({ components: [A as ComponentDef<Schema>] })
    const wb = createWorld({ components: [B as ComponentDef<Schema>] })
    expect(wa.__serialize.schemaHash()).toBe(wb.__serialize.schemaHash())
  })
})

describe('persist — relation payloads (name-keyed, self-describing)', () => {
  it('a skipped payload field is omitted from the pair payload and re-defaults on load', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation({ w: 'f32', secret: field('f32', { persist: false }) }, { exclusive: true })
    const Likes = rel.defineRelation({ w: 'f32', secret: field('f32', { persist: false }) }, { exclusive: false })
    const a = src.spawnWith(P as ComponentDef<Schema>)
    const b = src.spawnWith(P as ComponentDef<Schema>)
    rel.addPair(a, ChildOf, b, { w: 1, secret: 50.5 })
    rel.addPair(a, Likes, b, { w: 2, secret: 60.5 })

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(containsF32(bytes, 50.5)).toBe(false)
    expect(containsF32(bytes, 60.5)).toBe(false)

    const P2 = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [P2 as ComponentDef<Schema>] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation({ w: 'f32', secret: field('f32', { persist: false }) }, { exclusive: true })
    const LikesDst = relDst.defineRelation({ w: 'f32', secret: field('f32', { persist: false }) }, { exclusive: false })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const na = remap.get(a as never) as EntityHandle
    const nb = remap.get(b as never) as EntityHandle
    expect(relDst.hasPair(na, ChildOfDst, nb)).toBe(true)
    expect((relDst.getPair(na, ChildOfDst, nb).read() as { w: number; secret: number }).w).toBe(1)
    expect((relDst.getPair(na, ChildOfDst, nb).read() as { w: number; secret: number }).secret).toBe(0)
    expect((relDst.getPair(na, LikesDst, nb).read() as { w: number; secret: number }).w).toBe(2)
    expect((relDst.getPair(na, LikesDst, nb).read() as { w: number; secret: number }).secret).toBe(0)
  })
})

describe('persist — structural stream values-on-add', () => {
  it('ComponentAdd records omit skipped field words', () => {
    const D = mixedDefs()
    const src = createWorld({ components: [D.Mixed as ComponentDef<Schema>] })
    const e = src.spawnWith(D.Mixed as ComponentDef<Schema>)
    const w = src.entity(e).write(D.Mixed) as { a: number; cache: number }
    w.a = 3
    w.cache = 4

    const stream = encodeStructuralOps(src)
    const adds = [...createObserverLog(src).drain(stream)].filter((r) => r.op === DeltaOp.ComponentAdd)
    expect(adds.length).toBe(1)
    const keys = Object.keys(adds[0]?.fields ?? {})
    expect(keys).toContain('a.0')
    expect(keys.some((k) => k.startsWith('cache.') || k.startsWith('tail.'))).toBe(false)
  })
})

describe('persist — property: round-trip is bit-exact for persisted fields, default for skipped', () => {
  it('random worlds round-trip persisted values exactly while skipped values re-default', () => {
    const make = () => defineComponent({ keep: 'i32', drop: field('i32', { persist: false }) }, { name: 'c' })
    fc.assert(
      fc.property(
        fc.array(fc.record({ keep: fc.integer({ min: -100000, max: 100000 }), drop: fc.integer({ min: 1, max: 100000 }) }), {
          minLength: 0,
          maxLength: 32,
        }),
        (specs) => {
          const C = make()
          const src = createWorld({ components: [C as ComponentDef<Schema>], maxEntities: 64 })
          const handles: EntityHandle[] = []
          for (const s of specs) {
            const h = src.spawnWith(C as ComponentDef<Schema>)
            const w = src.entity(h).write(C) as { keep: number; drop: number }
            w.keep = s.keep
            w.drop = s.drop
            handles.push(h)
          }

          const R = make()
          const dst = createWorld({ components: [R as ComponentDef<Schema>], maxEntities: 64 })
          const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())

          for (let i = 0; i < specs.length; i++) {
            const n = remap.get(handles[i] as never) as EntityHandle
            const r = dst.entity(n).read(R) as { keep: number; drop: number }
            expect(r.keep).toBe(specs[i]?.keep)
            expect(r.drop).toBe(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
