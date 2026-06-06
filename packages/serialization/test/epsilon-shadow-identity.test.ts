// The epsilon shadow must follow ENTITY identity, not row position: swap-pop, archetype migration,
// and despawn/respawn all hand a shadow row to a new tenant, and comparing the new tenant's values
// against the previous tenant's emissions lets the receiver drift unboundedly — the documented
// contract is convergence to within epsilon. A tenant change makes the row fresh: emit + reseed.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta } from '../src/index.js'

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
