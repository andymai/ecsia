import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
  encodeStructuralOps,
  applyStructuralOps,
  createObserverLog,
  bootstrapForWorker,
  DeltaOp,
} from '../src/index.js'

describe('M10 delta — version-stamp driven (§6 / S-3)', () => {
  it('carries only rows changed since the baseline tick, and applies them on the receiver', () => {
    const P = defineComponent({ x: 'f32' }, { brand: 'P' })
    const src = createWorld({ components: [P] })
    const a = src.spawnWith(P)
    const b = src.spawnWith(P)
    ;(src.entity(a).write(P) as { x: number }).x = 1
    ;(src.entity(b).write(P) as { x: number }).x = 2

    // Establish a receiver mirror via a snapshot first (builds the remap table).
    const R = defineComponent({ x: 'f32' }, { brand: 'P' })
    const dst = createWorld({ components: [R] })
    const baseBytes = createSnapshotSerializer(src).snapshotCopy()
    const { remap } = createSnapshotDeserializer(dst).load(baseBytes)

    const ser = createDeltaSerializer(src, src.currentTick())
    // Advance the tick and mutate ONLY entity a.
    src.advanceTick()
    ;(src.entity(a).write(P) as { x: number }).x = 99

    const deltaBytes = ser.deltaCopy()
    applyDelta(dst, deltaBytes, remap)

    const na = remap.get(a as never) as never
    const nb = remap.get(b as never) as never
    expect((dst.entity(na).read(R) as { x: number }).x).toBeCloseTo(99)
    expect((dst.entity(nb).read(R) as { x: number }).x).toBeCloseTo(2) // unchanged
  })
})

describe('M10 structural stream — values on add (§7 / S-7)', () => {
  it('a late joiner reconstructs full state from the stream alone', () => {
    const P = defineComponent({ x: 'f32', y: 'f32' }, { brand: 'P' })
    const src = createWorld({ components: [P] })
    const e = src.spawnWith(P)
    ;(src.entity(e).write(P) as { x: number; y: number }).x = 3
    ;(src.entity(e).write(P) as { x: number; y: number }).y = 4

    const stream = encodeStructuralOps(src)

    // The observer-log decoder exposes the ComponentAdd record WITH field values (S-7).
    const records = [...createObserverLog(src).drain(stream)]
    const add = records.find((r) => r.op === DeltaOp.ComponentAdd)
    expect(add).toBeDefined()
    expect(add?.fields?.['x.0']).toBeCloseTo(3)
    expect(add?.fields?.['y.0']).toBeCloseTo(4)

    // Replay into a fresh world reconstructs the entity + values.
    const R = defineComponent({ x: 'f32', y: 'f32' }, { brand: 'P' })
    const dst = createWorld({ components: [R] })
    const remap = new Map()
    applyStructuralOps(dst, stream, remap)
    expect(remap.size).toBe(1)
    const nh = remap.get(e as never) as never
    const view = dst.entity(nh).read(R) as { x: number; y: number }
    expect(view.x).toBeCloseTo(3)
    expect(view.y).toBeCloseTo(4)
  })

  it('replays relations from the structural stream with remapped eids', () => {
    const P = defineComponent({ x: 'f32' }, { brand: 'P' })
    const src = createWorld({ components: [P] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parent = src.spawnWith(P)
    const child = src.spawnWith(P)
    rel.addPair(child, ChildOf, parent)

    const stream = encodeStructuralOps(src)

    const R = defineComponent({ x: 'f32' }, { brand: 'P' })
    const dst = createWorld({ components: [R] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const remap = new Map()
    applyStructuralOps(dst, stream, remap)
    const nChild = remap.get(child as never) as never
    const nParent = remap.get(parent as never) as never
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
  })
})

describe('M10 bootstrap — transport separation (§3 / S-1)', () => {
  it('bootstrapForWorker returns a manifest + registry, never component value bytes', () => {
    const P = defineComponent({ x: 'f32' }, { brand: 'P' })
    const src = createWorld({ components: [P] })
    src.spawnWith(P)
    const boot = bootstrapForWorker(src)
    expect(boot.registry.components.some((c) => c.name === 'P')).toBe(true)
    expect(boot.registry.schemaHash).toBe(src.__serialize.schemaHash())
    // Single-thread world → not shared (no SAB buffer set); the worker path degrades to the copy snapshot.
    expect(boot.shared).toBe(false)
    expect(typeof boot.tick).toBe('number')
  })
})
