import { describe, expect, test } from 'vitest'
import { CapacityExceeded, createWorld, handleGeneration, handleIndex, makeHandleLayout } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { EntityIndex } from '../src/entity/index-allocator.js'
import { reserveEntityBlock, returnReservedIds } from '../src/entity/reservation.js'

const L10 = makeHandleLayout(10)

function makeAllocator(capacity: number): EntityIndex {
  return new EntityIndex(L10, {
    sparse: new Uint32Array(capacity),
    dense: new Uint32Array(capacity),
    generation: new Uint32Array(capacity),
  })
}

describe('reserveEntityBlock / returnReservedIds (entity-model.md §5)', () => {
  test('reserved handles are all alive the instant they are reserved', () => {
    const idx = makeAllocator(64)
    const res = reserveEntityBlock(idx, 0, 8)
    expect(res.handles).toHaveLength(8)
    expect(res.workerIndex).toBe(0)
    for (const h of res.handles) expect(idx.isAlive(h)).toBe(true)
    expect(idx.aliveCount).toBe(8)
  })

  test('returnReservedIds reclaims the unconsumed tail (LIFO) and keeps consumed handles alive', () => {
    const idx = makeAllocator(64)
    const res = reserveEntityBlock(idx, 1, 6)
    // Consume the first 4; the last 2 are the unconsumed tail.
    returnReservedIds(idx, res, 4)
    expect(idx.aliveCount).toBe(4)
    for (let i = 0; i < 4; i++) expect(idx.isAlive(res.handles[i] as EntityHandle)).toBe(true)
    for (let i = 4; i < 6; i++) expect(idx.isAlive(res.handles[i] as EntityHandle)).toBe(false)
  })

  test('reclaimed slots are re-issued at a bumped generation', () => {
    const idx = makeAllocator(64)
    const res = reserveEntityBlock(idx, 0, 3)
    const original = res.handles.map((h) => ({ slot: handleIndex(h, L10), gen: handleGeneration(h, L10) }))
    // Reclaim the entire block (consumedCount 0): the unconsumed tail is the whole block.
    returnReservedIds(idx, res, 0)
    expect(idx.aliveCount).toBe(0)
    // Every reclaimed slot reissues at exactly its previous generation + 1.
    for (let i = 0; i < 3; i++) {
      const reissued = idx.allocEntity()
      const slot = handleIndex(reissued, L10)
      const o = original.find((x) => x.slot === slot)
      expect(o).toBeDefined()
      expect(handleGeneration(reissued, L10)).toBe(((o as { gen: number }).gen + 1) & L10.generationMask)
    }
  })

  test('returnReservedIds with a now-dead handle in the tail is a no-op (idempotent)', () => {
    const idx = makeAllocator(64)
    const res = reserveEntityBlock(idx, 0, 4)
    // Independently free the tail handle, then ask the reservation to reclaim consumed=2.
    idx.freeEntity(res.handles[3] as EntityHandle)
    expect(() => returnReservedIds(idx, res, 2)).not.toThrow()
    expect(idx.isAlive(res.handles[0] as EntityHandle)).toBe(true)
    expect(idx.isAlive(res.handles[1] as EntityHandle)).toBe(true)
  })

  test('rejects an out-of-range count / consumedCount', () => {
    const idx = makeAllocator(64)
    expect(() => reserveEntityBlock(idx, 0, -1)).toThrow(RangeError)
    const res = reserveEntityBlock(idx, 0, 2)
    expect(() => returnReservedIds(idx, res, 3)).toThrow(RangeError)
  })

  test('reserveEntityBlock throws CapacityExceeded when the block exceeds the index space', () => {
    // ceiling defaults to the array length (no grow hook); reserving past it must throw.
    const idx = makeAllocator(4)
    expect(() => reserveEntityBlock(idx, 0, 5)).toThrow(CapacityExceeded)
  })

  test('exposed on the World facade, reserving live handles', () => {
    const w = createWorld({ maxEntities: 64 })
    const res = w.reserveEntityBlock(2, 3)
    expect(res.workerIndex).toBe(2)
    for (const h of res.handles) expect(w.isAlive(h)).toBe(true)
    w.returnReservedIds(res, 1)
    expect(w.isAlive(res.handles[0] as EntityHandle)).toBe(true)
    expect(w.isAlive(res.handles[1] as EntityHandle)).toBe(false)
    expect(w.isAlive(res.handles[2] as EntityHandle)).toBe(false)
  })
})
