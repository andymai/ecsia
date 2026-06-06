// Cold-archetype residents are part of "the whole world at one tick": the snapshot writer reads
// them through a materialized per-archetype view (their data lives in shared per-TYPE blocks, not
// per-archetype columns), clearAll despawns them (a 'replace' load must not mix stale entities
// into the loaded state), the delta scan enumerates them in the same ascending-index order as the
// view, and the receiver-side write resolver (columnsOf) reaches cold rows so loads/deltas can
// land on entities that are cold in the DESTINATION world too.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta } from '../src/index.js'

const mk = () => {
  const A = defineComponent({ x: 'f32' }, { name: 'A' })
  const B = defineComponent({ y: 'f32' }, { name: 'B' })
  const C = defineComponent({ z: 'f32' }, { name: 'C' })
  return { A, B, C, world: createWorld({ components: [A, B, C], maxHotArchetypes: 2 }) }
}

describe('cold-archetype serialization coverage', () => {
  test('snapshot round-trips cold residents with bit-exact values', () => {
    const src = mk()
    const h1 = src.world.spawnWith(src.A)
    src.world.entity(h1).write(src.A).x = 1.5
    const h2 = src.world.spawnWith(src.A, src.B) // cold in src
    src.world.entity(h2).write(src.A).x = 2.5
    src.world.entity(h2).write(src.B).y = 7.25
    expect(src.world.handleStats().aliveCount).toBe(2)

    const dst = mk()
    const { remap } = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshot(), 'replace')
    expect(dst.world.handleStats().aliveCount).toBe(2)
    const m2 = remap.get(h2) as EntityHandle
    expect(dst.world.entity(m2).read(dst.A).x).toBe(2.5)
    expect(dst.world.entity(m2).read(dst.B).y).toBe(7.25)
  })

  test("replace-mode load clears the destination's cold residents", () => {
    const src = mk()
    src.world.spawnWith(src.A)
    const bytes = createSnapshotSerializer(src.world).snapshot()

    const dst = mk()
    dst.world.spawnWith(dst.A, dst.B)         // cold in dst
    dst.world.spawnWith(dst.A, dst.B, dst.C)  // cold in dst
    createSnapshotDeserializer(dst.world).load(bytes, 'replace')
    expect(dst.world.handleStats().aliveCount).toBe(1)
  })

  test('delta carries writes to cold residents (cold on both sides)', () => {
    const src = mk()
    src.world.spawnWith(src.A)
    const cold = src.world.spawnWith(src.A, src.B)
    const dst = mk()
    const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshot(), 'replace')

    const delta = createDeltaSerializer(src.world, src.world.currentTick())
    src.world.advanceTick()
    src.world.entity(cold).write(src.B).y = 42
    applyDelta(dst.world, delta.delta(), res.remap)

    const mirrored = res.remap.get(cold) as EntityHandle
    expect(dst.world.entity(mirrored).read(dst.B).y).toBe(42)
  })
})
