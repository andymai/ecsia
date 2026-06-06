// Edge-case coverage for the smaller reactivity stores: ChangeVersionStore (disabled no-ops, lazy
// column, wrap-recovery resetAll), the ObserverRegistry (multi-component "all present" gating,
// dispose, conservative overflow fan-out), and the ObserverCommandBuffer (drain/defer flags, FIFO
// flush with drop-if-dead). Each assertion pins a behavioral outcome that a regression would break.

import { describe, expect, test, vi } from 'vitest'
import { onAdd, onRemove, onChange } from '@ecsia/core'
import { Buffers, ChangeVersionStore, ObserverRegistry, probeCapabilities } from '../src/internal.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/core'
import { ObserverCommandBuffer } from '../src/reactivity/observer-commands.js'
import type { ObserverCommandApply } from '../src/reactivity/observer-commands.js'
import type { EntityRef } from '../src/entity/index.js'

const buffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

describe('ChangeVersionStore — disabled no-ops and lazy column (branches 56/64)', () => {
  test('while disabled, stamp records nothing and versionAt/changedSince read 0 (no column allocated)', () => {
    const cv = new ChangeVersionStore(buffers(), 8)
    cv.stamp(3, 99) // disabled → no-op (branch 56 early return)
    expect(cv.versionAt(3)).toBe(0) // disabled → 0 (branch 64 early return)
    expect(cv.changedSince(3, 0)).toBe(false)
    // resetAll with no column allocated is a safe no-op.
    cv.resetAll()
    expect(cv.versionAt(3)).toBe(0)
  })

  test('once enabled, stamp lazily allocates the column and the tick is observable', () => {
    const cv = new ChangeVersionStore(buffers(), 8)
    cv.enabled = true
    expect(cv.versionAt(0)).toBe(0) // column null until first stamp
    cv.stamp(2, 7)
    expect(cv.versionAt(2)).toBe(7)
    expect(cv.changedSince(2, 6)).toBe(true)
    expect(cv.changedSince(2, 7)).toBe(false) // strict >
  })

  test('stamp self-grows the column when the index exceeds initial capacity', () => {
    const cv = new ChangeVersionStore(buffers(), 2)
    cv.enabled = true
    cv.stamp(0, 1)
    cv.stamp(50, 9) // index past initial cap → buffers.grow inside stamp
    expect(cv.versionAt(50)).toBe(9)
    expect(cv.versionAt(0)).toBe(1) // earlier data preserved across grow
  })

  test('versionAt of an index beyond the allocated column returns 0 (no OOB read)', () => {
    const cv = new ChangeVersionStore(buffers(), 4)
    cv.enabled = true
    cv.stamp(0, 5)
    expect(cv.versionAt(1000)).toBe(0)
  })

  test('resetAll clears every stamp (lines 78-79)', () => {
    const cv = new ChangeVersionStore(buffers(), 8)
    cv.enabled = true
    cv.stamp(1, 100)
    cv.stamp(2, 200)
    expect(cv.versionAt(1)).toBe(100)
    cv.resetAll()
    expect(cv.versionAt(1)).toBe(0)
    expect(cv.versionAt(2)).toBe(0)
  })
})

// --- ObserverRegistry --------------------------------------------------------

function makeRegistry(): { reg: ObserverRegistry; refs: Map<number, EntityRef>; held: Map<number, Set<number>> } {
  let nextId = 1
  const idMap = new WeakMap<ComponentDef<Schema>, number>()
  const refs = new Map<number, EntityRef>()
  const held = new Map<number, Set<number>>()
  const ref = (index: number): EntityRef => {
    let r = refs.get(index)
    if (r === undefined) {
      r = { index } as unknown as EntityRef
      refs.set(index, r)
    }
    return r
  }
  const reg = new ObserverRegistry({
    idOf: (def): ComponentId => {
      let id = idMap.get(def)
      if (id === undefined) {
        id = nextId++
        idMap.set(def, id)
      }
      return id as ComponentId
    },
    holdsAll: (index, componentIds): boolean => {
      const set = held.get(index)
      if (set === undefined) return false
      return componentIds.every((c) => set.has(c as number))
    },
    eventRefOf: ref,
    tick: (): number => 42,
  })
  return { reg, refs, held }
}

// Two distinct component defs (the registry assigns ids 1 and 2 in idOf-call order).
const A = { __k: 'A' } as unknown as ComponentDef<Schema>
const B = { __k: 'B' } as unknown as ComponentDef<Schema>

describe('ObserverRegistry — multi-component add fires only when the entity holds the WHOLE term (line 126-128)', () => {
  test('a 2-component onAdd does NOT fire until both components are present, then fires once', () => {
    const { reg, held } = makeRegistry()
    const fired: number[] = []
    reg.observe(onAdd(A, B), (e, ctx) => {
      fired.push((e as unknown as { index: number }).index)
      expect(ctx.tick).toBe(42)
      expect(ctx.kind).toBe('add')
    })
    // The term spans component ids 1 (A) and 2 (B). Adding A alone: entity does not yet hold all → skip.
    held.set(5, new Set([1])) // holds only A
    reg.dispatchStructural('add', 5, 1)
    expect(fired).toEqual([]) // gated off — not all present (branch 126 true → continue)

    // Now B lands too: dispatching the B add satisfies the whole term → fire.
    held.set(5, new Set([1, 2]))
    reg.dispatchStructural('add', 5, 2)
    expect(fired).toEqual([5])
  })

  test('a single-component term fires immediately (the length>1 guard is not taken)', () => {
    const { reg } = makeRegistry()
    const fired: number[] = []
    reg.observe(onAdd(A), (e) => fired.push((e as unknown as { index: number }).index))
    reg.dispatchStructural('add', 9, 1)
    expect(fired).toEqual([9])
  })

  test('dispatchStructural is a no-op when no observer is registered for (kind, componentId)', () => {
    const { reg } = makeRegistry()
    expect(() => reg.dispatchStructural('remove', 1, 999)).not.toThrow()
  })
})

describe('ObserverRegistry — change dedup, conservative fan-out, dispose (lines 149-162, branch 108)', () => {
  test('dispatchChange dedups per frame until resetChangeDedup is called', () => {
    const { reg } = makeRegistry()
    let count = 0
    reg.observe(onChange(A), () => count++)
    reg.dispatchChange(7, 1)
    reg.dispatchChange(7, 1) // deduped within the frame
    expect(count).toBe(1)
    reg.resetChangeDedup()
    reg.dispatchChange(7, 1)
    expect(count).toBe(2)
  })

  test('fireAllChangeConservatively fires every change observer for every current member, deduped', () => {
    const { reg } = makeRegistry()
    const seen: number[] = []
    reg.observe(onChange(A), (e) => seen.push((e as unknown as { index: number }).index))
    // A non-change observer must be IGNORED by the conservative scan (key prefix filter, line 151).
    reg.observe(onAdd(B), () => seen.push(-1))
    reg.fireAllChangeConservatively([4, 5, 4]) // 4 appears twice → dedup keeps it once
    expect(seen.sort((a, b) => a - b)).toEqual([4, 5])
  })

  test('dispose removes the observer so it no longer fires; counts drop', () => {
    const { reg } = makeRegistry()
    let count = 0
    const h = reg.observe(onChange(A), () => count++)
    expect(reg.hasObservers).toBe(true)
    expect(reg.hasChangeObservers).toBe(true)
    h.dispose()
    expect(reg.hasObservers).toBe(false)
    expect(reg.hasChangeObservers).toBe(false)
    reg.dispatchChange(1, 1)
    expect(count).toBe(0)
  })

  test('dispose tolerates a bucket already emptied for one of its component ids (branch 108)', () => {
    const { reg } = makeRegistry()
    // A multi-component change observer registers in buckets change:1 and change:2.
    const h = reg.observe(onChange(A, B), () => {})
    // hasKindFor confirms both buckets exist.
    expect(reg.hasKindFor('change', 1)).toBe(true)
    expect(reg.hasKindFor('change', 2)).toBe(true)
    // Disposing walks both buckets; neither lookup is undefined here, but dispose must be idempotent
    // and never throw even if called twice (second pass finds emptied/absent buckets → branch 108).
    h.dispose()
    expect(() => h.dispose()).not.toThrow()
    expect(reg.hasKindFor('change', 1)).toBe(false)
  })

  test('hasKindFor is false for a kind/component with no subscriber', () => {
    const { reg } = makeRegistry()
    reg.observe(onRemove(A), () => {})
    expect(reg.hasKindFor('add', 1)).toBe(false)
    expect(reg.hasKindFor('remove', 1)).toBe(true)
  })
})

// --- ObserverCommandBuffer ---------------------------------------------------

function makeApply(): { apply: ObserverCommandApply & { log: string[] }; dead: Set<number> } {
  const dead = new Set<number>()
  const log: string[] = []
  const apply: ObserverCommandApply & { log: string[] } = {
    log,
    isAlive: (h): boolean => !dead.has(h as unknown as number),
    placeReserved: (h): void => void log.push(`place:${h as unknown as number}`),
    add: (h): void => void log.push(`add:${h as unknown as number}`),
    remove: (h): void => void log.push(`remove:${h as unknown as number}`),
    despawn: (h): void => void log.push(`despawn:${h as unknown as number}`),
    writePayload: () => {},
  }
  return { apply, dead }
}

describe('ObserverCommandBuffer — drain/defer flags and pendingCount (lines 62-67)', () => {
  test('beginDeferring/endDeferring toggle the deferring flag', () => {
    const buf = new ObserverCommandBuffer()
    expect(buf.deferring).toBe(false)
    buf.beginDeferring()
    expect(buf.deferring).toBe(true)
    buf.endDeferring()
    expect(buf.deferring).toBe(false)
  })

  test('enterDrain is a one-shot re-entrancy guard; isDraining reflects it (lines 62-63)', () => {
    const buf = new ObserverCommandBuffer()
    expect(buf.isDraining).toBe(false)
    expect(buf.enterDrain()).toBe(true)
    expect(buf.isDraining).toBe(true)
    expect(buf.enterDrain()).toBe(false) // already draining → guarded
    buf.exitDrain()
    expect(buf.isDraining).toBe(false)
    expect(buf.enterDrain()).toBe(true)
  })

  test('pendingCount tracks staged ops (lines 66-67)', () => {
    const buf = new ObserverCommandBuffer()
    expect(buf.pendingCount).toBe(0)
    buf.stageDespawn(1 as never)
    buf.stageRemove(2 as never, A)
    expect(buf.pendingCount).toBe(2)
  })
})

describe('ObserverCommandBuffer — flush replays FIFO and honors drop-if-dead (lines 94-95, 140-141, branch 139)', () => {
  test('staged ops apply in staging order; a dead subject is skipped', () => {
    const buf = new ObserverCommandBuffer()
    const { apply, dead } = makeApply()
    buf.stageSpawnWith(10 as never, [A])
    buf.stageAdd(11 as never, A)
    buf.stageRemove(12 as never, B) // stageRemove (lines 94-95)
    buf.stageDespawn(13 as never)
    dead.add(11) // 11 was despawned before flush → its add is dropped
    dead.add(12) // 12 dead → its remove dropped (branch 139 isAlive false)
    buf.flush(apply)
    expect(apply.log).toEqual(['place:10', 'despawn:13'])
  })

  test('a live remove op IS applied (branch 139 isAlive true → apply.remove)', () => {
    const buf = new ObserverCommandBuffer()
    const { apply } = makeApply()
    buf.stageRemove(20 as never, A)
    buf.flush(apply)
    expect(apply.log).toEqual(['remove:20'])
  })

  test('flush is a no-op when nothing is pending and clears the queue after applying', () => {
    const buf = new ObserverCommandBuffer()
    const { apply } = makeApply()
    const spy = vi.spyOn(apply, 'isAlive')
    buf.flush(apply) // empty → early return, never touches apply
    expect(spy).not.toHaveBeenCalled()
    buf.stageDespawn(1 as never)
    buf.flush(apply)
    expect(buf.pendingCount).toBe(0)
    buf.flush(apply) // second flush has nothing left
    expect(apply.log).toEqual(['despawn:1'])
  })

  test('pair ops are skipped when the relation seams are undefined (relation-free world)', () => {
    const buf = new ObserverCommandBuffer()
    const { apply } = makeApply() // no addPair/removePair seams
    buf.stageAddPair(1 as never, {} as never, 7 as never, 2 as never, undefined)
    buf.stageRemovePair(1 as never, {} as never, 7 as never, 2 as never)
    expect(() => buf.flush(apply)).not.toThrow()
    expect(apply.log).toEqual([])
  })
})
