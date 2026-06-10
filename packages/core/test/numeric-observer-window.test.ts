// Generation-aware NUMERIC reads in the observer window (the numeric twin of RF-REMOVE-READ ×
// RF-HYGIENE). A dying tenant's onRemove ref reading a NUMERIC field it held must see ITS OWN last
// value, never a same-window re-mint's — the field-kind-agnostic deferred-despawn location stash +
// the world's per-read resolver shim close this for every case where the dying dense row survives.
//
// The one remaining boundary (a same-archetype re-mint that reuses the freed dense row before the
// drain — the load(…, 'replace') shape) is asserted explicitly here so a future per-archetype
// deferred-dead-row hold (PR2) flips exactly that case and nothing else.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onRemove, onAdd, read } from '@ecsia/core'
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

  test('same-archetype re-mint before the drain: the deferred-dead-row HOLD preserves the dying value', () => {
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
    // SAME archetype, BEFORE the drain (the load('replace') shape): without the hold, allocRow would
    // reuse t1's freed dense row and overwrite x=11. The hold keeps t1's row above the live region
    // (relocating it on the collision) until flushPending, so the dying ref reads its own value.
    world.spawnWith([Pos, { x: 99 }])
    world.observerDrain()
    expect(saw).toBe(11)
  })

  test('held rows are excluded from iteration MID-window (the [0,count) invariant snapshot relies on)', () => {
    const { world, Pos } = rig()
    world.observe(onRemove(Pos), () => {})
    const t1 = world.spawnWith([Pos, { x: 11 }])
    const t2 = world.spawnWith([Pos, { x: 22 }])
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    world.despawn(t1) // deferred → t1's row held above count (a dead row physically present)
    world.spawnWith([Pos, { x: 33 }]) // collision relocates the held row upward; still above count
    // BEFORE the drain: a query must see exactly the LIVE entities (t2 + the x=33 spawn), never the
    // held dead t1. If the held row leaked into [0,count), this census would over-count.
    const xs: number[] = []
    world.query(read(Pos)).each((e) => {
      xs.push((world.entity((e as { handle: EntityHandle }).handle).read(Pos) as { x: number }).x)
    })
    expect(xs.sort((a, b) => a - b)).toEqual([22, 33])
  })

  test('migration OUT of a held archetype keeps the held region intact (no cross-tenant corruption)', () => {
    // The critical case: a live entity migrates out of an archetype that holds a deferred-dead row.
    // A non-deferred removeRow lowers count without adding a held row, so the held region must slide
    // down to stay abutting count — else the next allocRow eviction clobbers the dying tenant's data.
    const { world, Pos, Vel } = rig()
    let saw = -999
    world.observe(onRemove(Pos), (ref) => {
      saw = (ref.read(Pos) as { x: number }).x
    })
    const t1 = world.spawnWith([Pos, { x: 11 }])
    const t2 = world.spawnWith([Pos, { x: 22 }])
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    world.despawn(t1) // Pos-arch held = 1 (t1 held with x=11)
    world.add(t2, Vel) // migrate t2 OUT of Pos-arch — non-deferred removeRow, must slide held down
    world.spawnWith([Pos, { x: 44 }]) // allocRow eviction — must NOT clobber t1's held row
    world.observerDrain()
    expect(saw).toBe(11) // t1's own value, not 44
  })

  test('held >= 2: a multi-despawn replace-load preserves every dying tenant (eviction chain)', () => {
    const { world, Pos } = rig()
    const seen: number[] = []
    world.observe(onRemove(Pos), (ref) => {
      seen.push((ref.read(Pos) as { x: number }).x)
    })
    const e = [
      world.spawnWith([Pos, { x: 1 }]),
      world.spawnWith([Pos, { x: 2 }]),
      world.spawnWith([Pos, { x: 3 }]),
    ]
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    for (const h of e) world.despawn(h) // held grows to 3
    world.spawnWith([Pos, { x: 91 }]) // three evictions across these spawns
    world.spawnWith([Pos, { x: 92 }])
    world.spawnWith([Pos, { x: 93 }])
    world.observerDrain()
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]) // each dying tenant read its own value
  })

  test('a column GROW during held-row eviction preserves the dying value (grow copies rows above count)', () => {
    // The one held-row cell the other tests miss: an allocRow eviction that ALSO re-backs the column.
    // The held dead row sits above count; if buffers.grow copied only [0,count) it would be lost and
    // the divert would read freed memory. Force it: despawn a held victim, then spawn far past the
    // column's initial capacity so allocRow keeps evicting the held row upward across one+ grows.
    const { world, Pos } = rig()
    let saw = -999
    world.observe(onRemove(Pos), (ref) => {
      saw = (ref.read(Pos) as { x: number }).x
    })
    const h: EntityHandle[] = []
    for (let i = 0; i < 6; i++) h.push(world.spawnWith([Pos, { x: 100 + i }]))
    world.frameReset()
    world.observerDrain()

    world.frameReset()
    world.despawn(h[0] as EntityHandle) // not the last row → swap-popped + HELD above count (x=100)
    for (let i = 0; i < 300; i++) world.spawnWith([Pos, { x: 5000 + i }]) // crosses grow boundaries while held
    world.observerDrain() // fires onRemove(h[0]) with the window still open
    expect(saw).toBe(100) // the dying value survived every grow-during-eviction
  })

  test('the hold releases at flushPending: the next frame reuses the row normally (no leak)', () => {
    const { world, Pos } = rig()
    world.observe(onRemove(Pos), () => {})
    const t1 = world.spawnWith([Pos, { x: 11 }])
    world.frameReset()
    world.observerDrain()
    world.frameReset()
    world.despawn(t1)
    world.spawnWith([Pos, { x: 99 }]) // collision → t1's row held above count this window
    world.observerDrain() // flushPending releases the held row
    // Next frame: a fresh spawn reuses the released region — the live set is exactly the two live
    // entities, no held rows linger (the dense count is back to its natural high-water).
    const a = world.spawnWith([Pos, { x: 1 }])
    world.frameReset()
    world.observerDrain()
    let n = 0
    world.query(read(Pos)).each(() => {
      n += 1
    })
    expect(n).toBe(2) // the x=99 entity + a; t1 is gone
    expect(world.isAlive(a)).toBe(true)
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
