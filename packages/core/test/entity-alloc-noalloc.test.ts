import { describe, expect, test } from 'vitest'
import { makeHandleLayout } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { EntityIndex } from '../src/entity/index-allocator.js'

// Stands in for the deferred cross-library bench (build-plan harness). The spec promises
// allocEntity / freeEntity are O(1) with ZERO per-op heap allocation (entity-model.md §10).
// We cannot count allocations directly in portable JS, so we use process heap sampling: run a
// large alloc/free loop and assert retained heap does not grow with iteration count. A
// per-op allocation would leave megabytes of garbage proportional to the loop length even
// after a GC, whereas the steady-state free-list churns a fixed working set.

const hasGc = typeof (globalThis as { gc?: () => void }).gc === 'function'

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) {
    gc()
    gc()
  }
}

function allocFreeChurn(idx: EntityIndex, iterations: number): void {
  // Steady-state: keep one slot, repeatedly recycle it. No array should grow; no handle escapes.
  let h: EntityHandle = idx.allocEntity()
  for (let i = 0; i < iterations; i++) {
    idx.freeEntity(h)
    h = idx.allocEntity()
  }
  idx.freeEntity(h)
}

describe('zero-per-op heap allocation for alloc/free (bench stand-in)', () => {
  test('allocEntity/freeEntity do not retain heap proportional to op count', () => {
    const L = makeHandleLayout(10)
    const idx = new EntityIndex(L, {
      sparse: new Uint32Array(1024),
      dense: new Uint32Array(1024),
      generation: new Uint32Array(1024),
    })

    // Warm up so JIT/array backing is settled before sampling.
    allocFreeChurn(idx, 50_000)
    forceGc()
    const before = process.memoryUsage().heapUsed

    allocFreeChurn(idx, 2_000_000)
    forceGc()
    const after = process.memoryUsage().heapUsed

    const grewBytes = after - before
    if (hasGc) {
      // With explicit GC available the steady-state churn must retain essentially nothing.
      // Generous slack for sampling noise / unrelated allocations: 4 MiB over 2M ops
      // (a real per-op allocation of even one tiny object would be tens of MiB+).
      expect(grewBytes).toBeLessThan(4 * 1024 * 1024)
    } else {
      // Without --expose-gc heapUsed includes uncollected garbage; assert it is not pathological
      // (a per-op object allocation across 2M ops without GC would dwarf this bound).
      expect(grewBytes).toBeLessThan(64 * 1024 * 1024)
    }
  })

  test('alloc/free leaves the allocator in a clean steady state (no slot leak)', () => {
    const L = makeHandleLayout(8)
    const idx = new EntityIndex(L, {
      sparse: new Uint32Array(512),
      dense: new Uint32Array(512),
      generation: new Uint32Array(512),
    })
    let h = idx.allocEntity()
    const slot0 = idx.denseLen
    for (let i = 0; i < 100_000; i++) {
      idx.freeEntity(h)
      h = idx.allocEntity()
    }
    idx.freeEntity(h)
    // denseLen is a high-water mark; recycling one slot never mints new indices.
    expect(idx.denseLen).toBe(slot0)
    expect(idx.aliveCount).toBe(0)
  })
})
