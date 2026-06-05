// Direct unit coverage for SparseSetU32 edge corners the query-driven suites do not reach:
// clear(), denseView() over a non-trivial prefix, remove of an absent index, has() of an
// out-of-capacity index, and the lazy capacity grow path (growRegion doubling + view re-publish).

import { describe, expect, test } from 'vitest'
import { Buffers, SparseSetU32, probeCapabilities } from '@ecsia/core'
import type { RegionKey } from '@ecsia/core'

const newBuffers = (max = 1 << 16): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: max })

let seq = 0
function makeSet(initialCapacity: number, maxEntities = 1 << 16): SparseSetU32 {
  const buffers = newBuffers(maxEntities)
  const n = seq++
  return new SparseSetU32(
    buffers,
    `sset.${n}.dense` as RegionKey,
    `sset.${n}.sparse` as RegionKey,
    initialCapacity,
    maxEntities,
  )
}

describe('SparseSetU32 edge corners', () => {
  test('clear() empties the set and invalidates membership', () => {
    const s = makeSet(8)
    s.add(1)
    s.add(3)
    s.add(5)
    expect(s.size).toBe(3)
    expect(s.has(3)).toBe(true)

    s.clear()
    expect(s.size).toBe(0)
    // After clear the slots are logically gone: has() must report false (pos < size guard).
    expect(s.has(1)).toBe(false)
    expect(s.has(3)).toBe(false)
    expect([...s]).toEqual([])

    // Re-add after clear works and reindexes from zero.
    s.add(9)
    expect(s.size).toBe(1)
    expect(s.has(9)).toBe(true)
    expect([...s]).toEqual([9])
  })

  test('denseView() returns a live zero-copy prefix of exactly [0..size)', () => {
    const s = makeSet(8)
    s.add(4)
    s.add(2)
    s.add(7)
    const view = s.denseView()
    expect(view.length).toBe(3)
    // Insertion order is preserved in the dense prefix.
    expect([...view]).toEqual([4, 2, 7])

    // It is a live subarray: a swap-pop removal must shrink what denseView() exposes.
    s.remove(2) // moves last (7) into 2's slot
    const after = s.denseView()
    expect(after.length).toBe(2)
    expect([...after].sort((a, b) => a - b)).toEqual([4, 7])
  })

  test('remove() of an absent index is a silent no-op (size unchanged)', () => {
    const s = makeSet(8)
    s.add(1)
    expect(s.size).toBe(1)
    s.remove(99) // never added
    expect(s.size).toBe(1)
    s.remove(0) // in capacity but never added
    expect(s.size).toBe(1)
    expect(s.has(1)).toBe(true)
  })

  test('has() of an index at/above current capacity returns false without touching sparse', () => {
    const s = makeSet(4)
    // index 100 is far beyond the initial capacity of 4; the >= capacity guard short-circuits.
    expect(s.has(100)).toBe(false)
  })

  test('add() beyond capacity grows lazily and preserves all prior members', () => {
    // initialCapacity 2 forces a grow as soon as we add an index >= 2.
    const s = makeSet(2)
    s.add(0)
    s.add(1)
    // Adding index 50 needs capacity 51 — drives growRegion's doubling loop and view re-publish.
    s.add(50)
    expect(s.size).toBe(3)
    expect(s.has(0)).toBe(true)
    expect(s.has(1)).toBe(true)
    expect(s.has(50)).toBe(true)
    // The grown backing must still read the originally-stored dense values.
    expect([...s].sort((a, b) => a - b)).toEqual([0, 1, 50])
  })

  test('repeated grows across multiple high indices keep every member addressable', () => {
    const s = makeSet(1)
    const ids = [3, 17, 64, 200, 1000]
    for (const id of ids) s.add(id)
    expect(s.size).toBe(ids.length)
    for (const id of ids) expect(s.has(id)).toBe(true)
    // A grow must not resurrect a never-added neighbor.
    expect(s.has(999)).toBe(false)
    expect([...s].sort((a, b) => a - b)).toEqual(ids)
  })

  test('idempotent add does not duplicate or grow spuriously', () => {
    const s = makeSet(4)
    s.add(2)
    s.add(2)
    s.add(2)
    expect(s.size).toBe(1)
    expect([...s]).toEqual([2])
  })
})
