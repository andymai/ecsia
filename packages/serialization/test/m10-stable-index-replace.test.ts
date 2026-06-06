// load(…, 'replace') × the rich observer window. A replace-load frees EVERY live index and re-mints
// it before the next observer drain, so the dead tenants' rich pending-clear stashes coexist with the
// new tenants' values at the SAME indices in ONE drain. An onAdd handler must read the NEW tenant's
// rich value (never a pre-load stash), and an onRemove handler must read the PRE-load value — across
// REPEATED replace-loads (every replication rebase/resync is one). createStableIndex is built on
// exactly these reads, so its uid map across two replace-loads is the end-to-end check.

import { describe, expect, it } from 'vitest'
import { createWorld, createStableIndex, defineComponent, onAdd, onRemove } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer } from '../src/index.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

const Id = (): ComponentDef<Schema> => defineComponent({ uid: 'string' }, { name: 'identity' })

function snapshotOf(uids: readonly string[]): Uint8Array {
  const C = Id()
  const src = createWorld({ components: asComps(C) })
  for (const uid of uids) src.spawnWith([C, { uid }])
  return createSnapshotSerializer(src).snapshotCopy()
}

describe('double load(replace) — rich observer reads stay tenant-correct', () => {
  it('onAdd reads the loaded uid and onRemove the pre-load uid, on every rebase', () => {
    const C = Id()
    const world = createWorld({ components: asComps(C) })
    const removed: string[] = []
    const seenAtAdd = new Map<string, EntityHandle>()
    world.observe(onRemove(C), (ref) => {
      removed.push((ref.read(C) as { uid: string }).uid)
    })
    world.observe(onAdd(C), (ref) => {
      seenAtAdd.set((ref.read(C) as { uid: string }).uid, ref.handle)
    })
    const uids = ['u0', 'u1', 'u2']
    const des = createSnapshotDeserializer(world)

    des.load(snapshotOf(uids), 'replace')
    world.frameReset()
    world.observerDrain()
    expect([...seenAtAdd.keys()].sort()).toEqual(uids)
    seenAtAdd.clear()

    // The second replace frees the first load's indices and re-mints them (LIFO ⇒ the uid↔index
    // assignment swaps). Each onAdd must read its OWN tenant's uid, each onRemove the pre-load one.
    des.load(snapshotOf(uids), 'replace')
    world.frameReset()
    world.observerDrain()

    expect(removed.sort()).toEqual(uids)
    for (const uid of uids) {
      const h = seenAtAdd.get(uid)
      expect(h).toBeDefined()
      expect((world.entity(h as EntityHandle).read(C) as { uid: string }).uid).toBe(uid)
    }
  })
})

describe('createStableIndex — survives repeated load(replace) rebases (T-STABLE-INDEX × replace)', () => {
  it('the uid map resolves every loaded entity after two replace-loads', () => {
    const C = Id()
    const world = createWorld({ components: asComps(C) })
    const idx = createStableIndex(world, C, 'uid')
    const des = createSnapshotDeserializer(world)
    const uids = ['u0', 'u1', 'u2']

    des.load(snapshotOf(uids), 'replace')
    world.frameReset()
    world.observerDrain()
    des.load(snapshotOf(uids), 'replace')
    world.frameReset()
    world.observerDrain()

    for (const uid of uids) {
      const h = idx.get(uid)
      expect(h).toBeDefined()
      expect(world.isAlive(h as EntityHandle)).toBe(true)
      expect((world.entity(h as EntityHandle).read(C) as { uid: string }).uid).toBe(uid)
    }
    idx.dispose()
  })

  it('a uid absent from the rebase snapshot drops out of the map', () => {
    const C = Id()
    const world = createWorld({ components: asComps(C) })
    const idx = createStableIndex(world, C, 'uid')
    const des = createSnapshotDeserializer(world)

    des.load(snapshotOf(['u0', 'u1', 'u2']), 'replace')
    world.frameReset()
    world.observerDrain()
    des.load(snapshotOf(['u0', 'u2']), 'replace')
    world.frameReset()
    world.observerDrain()

    expect(idx.has('u1')).toBe(false)
    for (const uid of ['u0', 'u2']) {
      const h = idx.get(uid)
      expect(h).toBeDefined()
      expect((world.entity(h as EntityHandle).read(C) as { uid: string }).uid).toBe(uid)
    }
    idx.dispose()
  })
})
