// Edge-case coverage for the entity layer's owned files: codec layout/handle guards, the
// index-allocator post-grow capacity throw + handleOfIndex dead-index sentinel, the pooled EntityRef
// no-resolver throws + the public `handle` getter, and the EntityStore range guards / lenient
// resolution / dead-handle isAlive shortcuts / the dev-mode generation-wrap console.warn.
// Every assertion pins a concrete observable outcome so a regression in the branch would fail.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { CapacityExceeded, makeHandle, makeHandleLayout, NO_ENTITY } from '@ecsia/core'
import type { EntityHandle, HandleLayout } from '@ecsia/core'
import { EntityIndex } from '../src/entity/index-allocator.js'
import { EntityRecord } from '../src/entity/record.js'
import { EntityRef } from '../src/entity/ref.js'
import { EntityStore } from '../src/entity/store.js'

const L10 = makeHandleLayout(10)

function makeAllocator(layout: HandleLayout, capacity = layout.capacity): EntityIndex {
  return new EntityIndex(layout, {
    sparse: new Uint32Array(capacity),
    dense: new Uint32Array(capacity),
    generation: new Uint32Array(capacity),
  })
}

describe('codec — makeHandleLayout / makeHandle guards (entity-model.md §2.2-§2.3)', () => {
  test('makeHandleLayout rejects out-of-range / non-integer generationBits', () => {
    expect(() => makeHandleLayout(-1)).toThrow(RangeError)
    expect(() => makeHandleLayout(32)).toThrow(/integer in \[0, 31\]/)
    expect(() => makeHandleLayout(3.5)).toThrow(RangeError)
    // The branch's happy edge stays valid.
    expect(makeHandleLayout(0).generationBits).toBe(0)
    expect(makeHandleLayout(31).generationBits).toBe(31)
  })

  test('makeHandle throws (dev-mode) when generation exceeds maxGeneration', () => {
    const L2 = makeHandleLayout(2) // maxGeneration === 3
    expect(() => makeHandle(1, 4, L2)).toThrow(/generation 4 exceeds maxGeneration 3/)
    // Exactly maxGeneration is fine — the guard is strictly `>`.
    expect(() => makeHandle(1, 3, L2)).not.toThrow()
  })
})

describe('index-allocator — post-grow exhaustion + handleOfIndex sentinel', () => {
  test('a GrowHook that cannot grow makes allocEntity throw CapacityExceeded', () => {
    // addressable 2, ceiling 4 (room to mint past addressable), but the grow hook refuses to widen.
    const arrays = {
      sparse: new Uint32Array(4),
      dense: new Uint32Array(4),
      generation: new Uint32Array(4),
    }
    const grow = vi.fn((_need: number) => 2) // never returns > denseLen, so growth "fails"
    const idx = new EntityIndex(L10, arrays, { addressable: 2, ceiling: 4 }, grow)
    idx.allocEntity()
    idx.allocEntity()
    // The 3rd mint is past addressable(2) but below ceiling(4): it asks the hook, which refuses.
    expect(() => idx.allocEntity()).toThrow(CapacityExceeded)
    expect(grow).toHaveBeenCalledWith(3)
    expect(idx.denseLen).toBe(2)
  })

  test('handleOfIndex returns the NO_ENTITY-equivalent sentinel for an index past denseLen', () => {
    const idx = makeAllocator(L10)
    const h = idx.allocEntity()
    // index 0 is minted → resolvable to its live handle.
    expect(idx.handleOfIndex(0)).toBe(h)
    // index 1 was never minted (denseLen === 1) → the all-ones sentinel, not a fabricated handle.
    expect(idx.handleOfIndex(1)).toBe(0xffffffff as unknown as EntityHandle)
  })
})

describe('EntityRef — no-resolver throws + the public handle getter (ref.ts)', () => {
  function makeRecord(): EntityRecord {
    return new EntityRecord(L10, {
      recordArchetypeId: new Uint32Array(L10.capacity),
      recordArchetypeRow: new Uint32Array(L10.capacity),
    })
  }

  test('read()/write() throw when no accessor resolver is installed', () => {
    const ref = new EntityRef(makeRecord())
    const fakeDef = { name: 'X' } as unknown as Parameters<EntityRef['read']>[0]
    expect(() => ref.read(fakeDef)).toThrow(/no accessor resolver installed/)
    expect(() => ref.write(fakeDef)).toThrow(/no accessor resolver installed/)
  })

  test('the public `handle` getter mirrors the bound __handle', () => {
    const ref = new EntityRef(makeRecord())
    // Unbound: the NO_ENTITY sentinel.
    expect(ref.handle).toBe(NO_ENTITY)
    const h = makeHandle(3, 0, L10)
    ref.__bind(h)
    expect(ref.handle).toBe(h)
    expect(ref.handle).toBe(ref.__handle)
  })
})

describe('EntityStore — range guards / lenient resolution / dead isAlive / wrap warning', () => {
  const cfg = { layout: L10, maxEntities: 16, shared: false }

  test('encodeHandle rejects an out-of-range index and generation', () => {
    const store = new EntityStore(cfg)
    expect(() => store.encodeHandle(-1, 0)).toThrow(/index out of range/)
    expect(() => store.encodeHandle(L10.maxIndex + 1, 0)).toThrow(/index out of range/)
    expect(() => store.encodeHandle(0, -1)).toThrow(/generation out of range/)
    expect(() => store.encodeHandle(0, L10.maxGeneration + 1)).toThrow(/generation out of range/)
    // A valid pair round-trips.
    const h = store.encodeHandle(5, 2)
    expect(store.decodeHandle(h)).toEqual({ index: 5, generation: 2 })
  })

  test('entity() on a dead handle throws unless lenient, which binds the stale handle', () => {
    const store = new EntityStore(cfg)
    const h = store.spawn()
    store.despawn(h)
    expect(() => store.entity(h)).toThrow(/is not alive/)
    // Lenient binds the stale handle anyway (the ref carries the dead handle).
    const ref = store.entity(h, { lenient: true })
    expect(ref.handle).toBe(h)
  })

  test('isAlive shortcuts: index past denseLen and a stale (recycled) handle are both dead', () => {
    const store = new EntityStore(cfg)
    // A never-minted handle: its index exceeds denseLen → the 163 shortcut.
    expect(store.isAlive(makeHandle(7, 0, L10))).toBe(false)
    // Mint, free, re-mint the same slot: the OLD handle's generation no longer matches dense (166).
    const a = store.spawn()
    store.despawn(a)
    const b = store.spawn() // recycles slot of `a` with a bumped generation
    expect(store.isAlive(a)).toBe(false)
    expect(store.isAlive(b)).toBe(true)
  })

  test('the generation wrap emits exactly one dev-mode console.warn', () => {
    // maxGeneration === 3 (wrap period 4): recycle one slot 4 times to wrap its generation to 0.
    const store = new EntityStore({ layout: makeHandleLayout(2), maxEntities: 4, shared: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let h = store.spawn()
    for (let i = 0; i < 4; i++) {
      store.despawn(h)
      h = store.spawn()
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/generation wrapped/)
    // The warn is one-shot: further recycles do not re-warn.
    store.despawn(h)
    store.spawn()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
