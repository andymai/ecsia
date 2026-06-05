// Direct coverage for Bitmask's out-of-stride (sparse pair-bit) path and rebind(). Component ids at
// or above fixedBitCount (= stride*32) do not fit the dense words; they live in the per-entity sparse
// Set. These tests drive set (applyDelta added high id), membership (bitmaskHas sparse branch), and
// clear via both the symmetric-difference removal path and bitmaskClear.

import { describe, expect, test } from 'vitest'
import { Bitmask, Buffers, canonicalize, probeCapabilities } from '../src/internal.js'
import type { ComponentId } from '@ecsia/core'
import type { Signature } from '../src/internal.js'

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

// componentCount 4 → stride 1 → fixedBitCount 32. Any id >= 32 is an out-of-stride sparse pair bit.
const sig = (...ids: number[]): Signature => canonicalize(ids) as Signature

describe('Bitmask out-of-stride sparse pair bits', () => {
  test('applyDelta sets a high (>= fixedBitCount) id in the sparse vector; bitmaskHas reads it there', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    expect(bm.stride).toBe(1)
    // id 100 is far beyond fixedBitCount (32): it must go to the sparse Set, not the dense word.
    bm.bitmaskApplyDelta(7, sig(), sig(100))
    expect(bm.bitmaskHas(7, 100 as ComponentId)).toBe(true)
    // A different high id NOT set must report false through the sparse-miss branch.
    expect(bm.bitmaskHas(7, 101 as ComponentId)).toBe(false)
    // An entity with no sparse set at all also reports false (the ?? false fallback).
    expect(bm.bitmaskHas(8, 100 as ComponentId)).toBe(false)
  })

  test('applyDelta clears a high id present in `from` but absent in `to` (sparse delete path)', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    bm.bitmaskApplyDelta(3, sig(), sig(50, 80))
    expect(bm.bitmaskHas(3, 50 as ComponentId)).toBe(true)
    expect(bm.bitmaskHas(3, 80 as ComponentId)).toBe(true)
    // Migrate {50,80} -> {50}: 80 is dropped through the sparse .delete branch (id >= fixedBitCount).
    bm.bitmaskApplyDelta(3, sig(50, 80), sig(50))
    expect(bm.bitmaskHas(3, 80 as ComponentId)).toBe(false)
    expect(bm.bitmaskHas(3, 50 as ComponentId)).toBe(true)
  })

  test('a high id retained across a migration stays set (no spurious clear)', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    bm.bitmaskApplyDelta(2, sig(), sig(50))
    // {50} -> {50, 2}: 50 is in both signatures, so the removal loop must skip it (sigHas guard).
    bm.bitmaskApplyDelta(2, sig(50), sig(50, 2))
    expect(bm.bitmaskHas(2, 50 as ComponentId)).toBe(true)
    expect(bm.bitmaskHas(2, 2 as ComponentId)).toBe(true)
  })

  test('mixing dense and sparse ids: both addressing paths coexist for one entity', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    // 3 is dense (< 32); 99 is sparse (>= 32).
    bm.bitmaskApplyDelta(1, sig(), sig(3, 99))
    expect(bm.bitmaskHas(1, 3 as ComponentId)).toBe(true)
    expect(bm.bitmaskHas(1, 99 as ComponentId)).toBe(true)
    // Drop only the dense one; the sparse one is untouched.
    bm.bitmaskApplyDelta(1, sig(3, 99), sig(99))
    expect(bm.bitmaskHas(1, 3 as ComponentId)).toBe(false)
    expect(bm.bitmaskHas(1, 99 as ComponentId)).toBe(true)
  })

  test('bitmaskClear drops both dense words and the entity sparse set', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    bm.bitmaskApplyDelta(6, sig(), sig(5, 70))
    expect(bm.bitmaskHas(6, 5 as ComponentId)).toBe(true)
    expect(bm.bitmaskHas(6, 70 as ComponentId)).toBe(true)
    bm.bitmaskClear(6)
    expect(bm.bitmaskHas(6, 5 as ComponentId)).toBe(false)
    expect(bm.bitmaskHas(6, 70 as ComponentId)).toBe(false)
  })

  test('rebind() re-publishes the region view; membership survives it', () => {
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => 'serial')
    bm.bitmaskApplyDelta(0, sig(), sig(2))
    bm.rebind()
    // The dense membership must still be readable through the re-published view.
    expect(bm.bitmaskHas(0, 2 as ComponentId)).toBe(true)
  })

  test('entityShapeWords exposes the dense fixed-stride words for the single-entity matcher', () => {
    const bm = new Bitmask(newBuffers(), 64, 1 << 16, () => 'serial')
    // stride 2 here (64/32). id 2 -> word 0 bit 2; id 40 -> word 1 bit 8.
    bm.bitmaskApplyDelta(4, sig(), sig(2, 40))
    const words = bm.entityShapeWords(4)
    expect(words.length).toBe(2)
    expect((words[0]! & (1 << 2)) !== 0).toBe(true)
    expect((words[1]! & (1 << (40 & 31))) !== 0).toBe(true)
  })
})
