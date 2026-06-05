// HIGH gap: the delta carries an INTERLEAVED structural section sourced
// from the persistent since-T structural journal. A delta since T applied to a stale mirror must
// reconstruct STRUCTURAL changes — spawn, despawn, component add/remove, relation add — not just values.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'

describe('delta — interleaved STRUCTURAL-since-T section', () => {
  it('reconstructs a SPAWN since T on the stale mirror', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const a = src.spawnWith(P as ComponentDef<Schema>)
    ;(src.entity(a).write(P) as { x: number }).x = 1

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    const b = src.spawnWith(P as ComponentDef<Schema>) // SPAWN since T
    ;(src.entity(b).write(P) as { x: number }).x = 42

    applyDelta(dst, ser.deltaCopy(), work)

    // b was created on the receiver via the structural section and remapped; its value applied too.
    const nb = work.get(b as never) as EntityHandle
    expect(nb).toBeDefined()
    expect((dst.entity(nb).read(R) as { x: number }).x).toBeCloseTo(42)
  })

  it('reconstructs a DESPAWN since T on the stale mirror', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const a = src.spawnWith(P as ComponentDef<Schema>)
    const b = src.spawnWith(P as ComponentDef<Schema>)

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)
    const nb = work.get(b as never) as EntityHandle
    expect(dst.isAlive(nb)).toBe(true)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.despawn(b) // DESTROY since T

    applyDelta(dst, ser.deltaCopy(), work)
    expect(dst.isAlive(nb)).toBe(false)
    expect(dst.isAlive(work.get(a as never) as EntityHandle)).toBe(true)
  })

  it('reconstructs a component ADD then REMOVE since T', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const Q = defineComponent({ y: 'f32' }, { name: 'q' })
    const src = createWorld({ components: [P as ComponentDef<Schema>, Q as ComponentDef<Schema>] })
    const a = src.spawnWith(P as ComponentDef<Schema>)

    const R1 = defineComponent({ x: 'f32' }, { name: 'p' })
    const R2 = defineComponent({ y: 'f32' }, { name: 'q' })
    const dst = createWorld({ components: [R1 as ComponentDef<Schema>, R2 as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)
    const na = work.get(a as never) as EntityHandle

    // delta 1: ADD Q with a value.
    const ser1 = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.add(a, Q as ComponentDef<Schema>)
    ;(src.entity(a).write(Q) as { y: number }).y = 7
    applyDelta(dst, ser1.deltaCopy(), work)
    expect(dst.has(na, R2)).toBe(true)
    expect((dst.entity(na).read(R2) as { y: number }).y).toBeCloseTo(7)

    // delta 2: REMOVE Q.
    const ser2 = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    src.remove(a, Q as ComponentDef<Schema>)
    applyDelta(dst, ser2.deltaCopy(), work)
    expect(dst.has(na, R2)).toBe(false)
  })

  it('reconstructs a relation ADD_PAIR since T with remapped eids', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: [P as ComponentDef<Schema>] })
    const rel = createRelations(src)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parent = src.spawnWith(P as ComponentDef<Schema>)
    const child = src.spawnWith(P as ComponentDef<Schema>)

    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: [R as ComponentDef<Schema>] })
    const relDst = createRelations(dst)
    const ChildOfDst = relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    const work = new Map(remap)

    const ser = createDeltaSerializer(src, src.currentTick())
    src.advanceTick()
    rel.addPair(child, ChildOf, parent) // ADD_PAIR since T

    applyDelta(dst, ser.deltaCopy(), work)
    const nChild = work.get(child as never) as EntityHandle
    const nParent = work.get(parent as never) as EntityHandle
    expect(relDst.hasPair(nChild, ChildOfDst, nParent)).toBe(true)
  })
})
