// Generation-aware NUMERIC reads in the observer window (the numeric twin of RF-REMOVE-READ ×
// RF-HYGIENE). A dying tenant's onRemove ref reading a NUMERIC field it held must see ITS OWN last
// value, never a same-window re-mint's — the field-kind-agnostic deferred-despawn location stash +
// the world's per-read resolver shim close this for every case where the dying dense row survives.
//
// The one remaining boundary (a same-archetype re-mint that reuses the freed dense row before the
// drain — the load(…, 'replace') shape) is asserted explicitly here so a future per-archetype
// deferred-dead-row hold (PR2) flips exactly that case and nothing else.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onRemove, onAdd } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

function rig() {
  const Pos = defineComponent({ x: 'i32' }, { name: 'NPos' })
  const Vel = defineComponent({ v: 'i32' }, { name: 'NVel' })
  const world = createWorld({ components: asComps(Pos, Vel) })
  return { world, Pos, Vel }
}

describe('numeric observer-window reads — generation-aware, dying-tenant correct', () => {
  test('re-mint into a DIFFERENT archetype: the dying ref reads its own numeric value (was a false throw)', () => {
    const { world, Pos, Vel } = rig()
    let saw = -999
    let sawHandle = -1 as unknown as EntityHandle
    world.observe(onRemove(Pos), (ref) => {
      saw = (ref.read(Pos) as { x: number }).x
      sawHandle = ref.handle
    })
    const t1 = world.spawnWith([Pos, { x: 11 }])
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    world.despawn(t1)
    // Re-mint t1's index into the Vel archetype — t1's Pos row is left untouched (dense row survives).
    const t2 = world.spawnWith([Vel, { v: 5 }])
    expect(world.decodeHandle(t2).index).toBe(world.decodeHandle(t1).index)
    world.observerDrain()
    expect(saw).toBe(11)
    // The window arms in this rich-free world (a remove-observer exists), so the onRemove ref binds
    // the DYING handle — not the re-minted live one (t2). Pins that rich-free eventRefOf behavior.
    expect(sawHandle).toBe(t1)
    expect(sawHandle).not.toBe(t2)
  })

  test('non-last despawn whose row is swap-popped: the dying ref still reads its own value', () => {
    const { world, Pos } = rig()
    const seen: number[] = []
    world.observe(onRemove(Pos), (ref) => {
      seen.push((ref.read(Pos) as { x: number }).x)
    })
    const a = world.spawnWith([Pos, { x: 1 }])
    world.spawnWith([Pos, { x: 2 }]) // b is the LAST live row; despawning `a` swap-pops b into a's slot
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    world.despawn(a) // a is NOT last → removeRow swaps; a's data lands above count, survives the window
    world.observerDrain()
    expect(seen).toEqual([1]) // a's own value, not b's (2)
  })

  test('a dying ref reading a numeric component it NEVER held keeps the not-held behavior (throws)', () => {
    const { world, Pos, Vel } = rig()
    let threw = false
    world.observe(onRemove(Pos), (ref) => {
      try {
        ;(ref.read(Vel) as { v: number }).v // t1 held Pos, never Vel
      } catch {
        threw = true
      }
    })
    const t1 = world.spawnWith([Pos, { x: 7 }])
    world.frameReset()
    world.observerDrain()
    world.frameReset()
    world.despawn(t1)
    world.observerDrain()
    // The per-read shim declines (the dying archetype lacks Vel) → live resolve → not-held throw.
    expect(threw).toBe(true)
  })

  test('a re-minted index reads ITS OWN value via onAdd, not the dead tenant (no reverse alias)', () => {
    const { world, Pos, Vel } = rig()
    let addedSaw = -999
    world.observe(onRemove(Pos), () => {})
    world.observe(onAdd(Vel), (ref) => {
      addedSaw = (ref.read(Vel) as { v: number }).v
    })
    const t1 = world.spawnWith([Pos, { x: 11 }])
    world.frameReset()
    world.observerDrain()
    world.frameReset()
    world.despawn(t1)
    const t2 = world.spawnWith([Vel, { v: 42 }]) // same index, different arch
    expect(world.decodeHandle(t2).index).toBe(world.decodeHandle(t1).index)
    world.observerDrain()
    expect(addedSaw).toBe(42)
  })

  test('BOUNDARY (PR2): same-archetype re-mint reuses the dense row → the dying ref reads the successor', () => {
    const { world, Pos } = rig()
    let saw = -999
    world.observe(onRemove(Pos), (ref) => {
      saw = (ref.read(Pos) as { x: number }).x
    })
    const t1 = world.spawnWith([Pos, { x: 11 }])
    world.frameReset()
    world.observerDrain()
    world.frameReset()
    world.despawn(t1)
    world.spawnWith([Pos, { x: 99 }]) // SAME archetype: allocRow reuses t1's freed row, overwriting x=11
    world.observerDrain()
    // The dense row is physically gone; the row-survival guard declines the stash. This is the
    // documented remaining boundary — the per-archetype deferred-dead-row hold (PR2) flips it to 11.
    expect(saw).toBe(99)
  })

  test('rich-free world with no remove-observer: the window stays inert (no behavior change, no cost)', () => {
    const { world, Pos } = rig()
    let added = 0
    world.observe(onAdd(Pos), () => {
      added += 1
    })
    const a = world.spawnWith([Pos, { x: 1 }])
    world.frameReset()
    world.observerDrain()
    world.despawn(a) // no remove-observer → non-deferred despawn, window never arms
    world.frameReset()
    world.observerDrain()
    expect(added).toBe(1)
    expect(world.isAlive(a)).toBe(false)
  })
})
