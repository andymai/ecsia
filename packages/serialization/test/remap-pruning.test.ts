// The receiver's stream-lifetime remap (replication G4) must forget destroyed entities — without
// pruning it grows without bound under entity churn, and applyDelta's per-message copy of it grows
// with it. A reused producer u32 handle is re-set on its EntityCreate, so pruning is safe.

import { expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta } from '../src/index.js'

test('applyDelta prunes destroyed entities from a mutable caller remap', () => {
  const mk = () => {
    const P = defineComponent({ x: 'f32' }, { name: 'P' })
    return { P: P as ComponentDef<Schema>, world: createWorld({ components: [P] }) }
  }
  const src = mk()
  const a = src.world.spawnWith(src.P)
  const b = src.world.spawnWith(src.P)

  const dst = mk()
  const { remap } = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshot(), 'replace')
  const live = remap as Map<EntityHandle, EntityHandle>
  expect(live.size).toBe(2)

  const ser = createDeltaSerializer(src.world, src.world.currentTick())
  src.world.advanceTick()
  src.world.despawn(a)
  applyDelta(dst.world, ser.delta(), live)

  expect(live.has(a)).toBe(false)   // pruned
  expect(live.has(b)).toBe(true)    // untouched
  expect(dst.world.handleStats().aliveCount).toBe(1)
})
