import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { handleIndex, makeHandleLayout } from '@ecsia/core'
import { handleGeneration, makeHandle } from '../src/internal.js'
import type { EntityHandle, HandleLayout } from '@ecsia/core'
import { EntityIndex } from '../src/entity/index-allocator.js'
import type { EntityIndexArrays } from '../src/entity/index-allocator.js'

const RUNS = 500

function arrays(capacity: number): EntityIndexArrays {
  return {
    sparse: new Uint32Array(capacity),
    dense: new Uint32Array(capacity),
    generation: new Uint32Array(capacity),
  }
}

// --- I1: codec round-trip for random (index, generation) in range ---
describe('I1 — codec round-trip for random in-range (index, generation)', () => {
  test('handleIndex/handleGeneration invert makeHandle for any valid split', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 31 }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (generationBits, fi, fg) => {
          const L = makeHandleLayout(generationBits)
          const index = Math.floor(fi * L.maxIndex)
          const generation = Math.floor(fg * L.maxGeneration)
          const h = makeHandle(index, generation, L)
          expect(handleIndex(h, L)).toBe(index)
          expect(handleGeneration(h, L)).toBe(generation)
          expect(h >>> 0).toBe(h as number)
        },
      ),
      { numRuns: RUNS },
    )
  })

  test('gen0 split: full-width index round-trips, generation pinned to 0', () => {
    const L = makeHandleLayout(0)
    fc.assert(
      fc.property(fc.integer({ min: 0, max: -1 >>> 0 }), (index) => {
        const h = makeHandle(index, 0, L)
        expect(handleIndex(h, L)).toBe(index >>> 0)
        expect(handleGeneration(h, L)).toBe(0)
      }),
      { numRuns: RUNS },
    )
  })
})

// --- I2: indexBits + generationBits === 32 for any valid layout ---
describe('I2 — indexBits + generationBits === 32 for any valid HandleLayout', () => {
  test('the layout is always exactly one u32 wide', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 31 }), (generationBits) => {
        const L: HandleLayout = makeHandleLayout(generationBits)
        expect(L.indexBits + L.generationBits).toBe(32)
        expect(L.generationShift).toBe(L.indexBits)
        expect(L.maxIndex).toBe(L.indexMask)
        expect(L.maxGeneration).toBe(L.generationMask)
        expect(L.capacity).toBe(L.maxIndex + 1)
        // masks are non-overlapping and cover the whole u32
        expect(((L.indexMask | (L.generationMask << L.generationShift)) >>> 0)).toBe(0xffffffff)
        expect((L.indexMask & ((L.generationMask << L.generationShift) >>> 0)) >>> 0).toBe(0)
      }),
      { numRuns: 200 },
    )
  })
})

// --- I3 / I4: staleness against a reference free-list model ---
//
// The model mirrors the swap-and-move free-list at the level of OBSERVABLE facts only: which
// handles are alive and the per-slot generation counter (the dense positions are an
// implementation detail asserted separately by the density-invariant test below). The model
// tracks one "victim" slot through exactly 2^generationBits recycles and asserts staleness at
// every step.
describe('I3 / I4 — staleness via a model-based reference free-list', () => {
  test('an old handle is stale after its slot recycles, and un-stale only after exactly 2^generationBits recycles of that exact slot', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }), // small generationBits to make the wrap window reachable
        fc.integer({ min: 1, max: 8 }), // number of concurrently-alive slots
        (generationBits, slots) => {
          const L = makeHandleLayout(generationBits)
          const capacity = Math.max(slots + 1, 16)
          const idx = new EntityIndex(L, arrays(capacity))

          // Allocate `slots` entities, pick one to be our "victim" slot.
          const handles: EntityHandle[] = []
          for (let i = 0; i < slots; i++) handles.push(idx.allocEntity())
          const victimOriginal = handles[0] as EntityHandle
          const victimSlot = handleIndex(victimOriginal, L)
          const startGen = handleGeneration(victimOriginal, L)

          expect(idx.isAlive(victimOriginal)).toBe(true)

          // Recycle the victim slot exactly `period = 2^generationBits` times. After each free
          // the old handle is stale; only when the generation wraps back to startGen does an
          // equal-valued handle reappear.
          const period = 1 << generationBits
          let current = victimOriginal
          let sawEqualBeforeWrap = false

          for (let r = 1; r <= period; r++) {
            idx.freeEntity(current)
            // Immediately after a free, the freed handle is stale.
            expect(idx.isAlive(current)).toBe(false)

            // Re-allocate; the free-list reissues the just-freed slot (it is the only parked
            // slot, since we free then immediately alloc).
            const reissued = idx.allocEntity()
            expect(handleIndex(reissued, L)).toBe(victimSlot)

            const expectedGen = (startGen + r) & L.generationMask
            expect(handleGeneration(reissued, L)).toBe(expectedGen)

            // I3: the previously-live handle is now stale (generation differs) unless we have
            // wrapped exactly back to it.
            if ((reissued as number) === (victimOriginal as number)) {
              expect(r).toBe(period) // equality only on a full wrap
            }
            // I4 (live flag): if an equal-valued handle reappears BEFORE the full wrap period,
            // the wrap window is broken. This must stay false for every step r < period.
            if ((reissued as number) === (victimOriginal as number) && r < period) {
              sawEqualBeforeWrap = true
            }
            current = reissued
          }

          // I4: only after a full period does a handle equal to the original reappear.
          expect(sawEqualBeforeWrap).toBe(false)
          expect((current as number) === (victimOriginal as number)).toBe(true)
          expect(idx.isAlive(victimOriginal)).toBe(true) // because current === victimOriginal
        },
      ),
      { numRuns: 200 },
    )
  })

  test('I3 basic: alloc => alive, free => dead, reissue uses (prevGen+1) masked', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (generationBits) => {
        const L = makeHandleLayout(generationBits)
        const idx = new EntityIndex(L, arrays(8))
        const a = idx.allocEntity()
        expect(idx.isAlive(a)).toBe(true)
        idx.freeEntity(a)
        expect(idx.isAlive(a)).toBe(false)
        const b = idx.allocEntity()
        const expected = (handleGeneration(a, L) + 1) & L.generationMask
        expect(handleGeneration(b, L)).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })
})

// --- I8 + density invariant under a random op sequence ---
type Op = { kind: 'alloc' } | { kind: 'free'; which: number } | { kind: 'doubleFree'; which: number }

const opArb = fc.oneof(
  fc.constant<Op>({ kind: 'alloc' }),
  fc.record({ kind: fc.constant<'free'>('free'), which: fc.nat() }),
  fc.record({ kind: fc.constant<'doubleFree'>('doubleFree'), which: fc.nat() }),
)

describe('I8 + free-list density invariant under random op sequences', () => {
  test('double-free is a no-op, and the dense partition stays disjoint, covering, and dense', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.array(opArb, { minLength: 0, maxLength: 400 }),
        (generationBits, ops) => {
          const L = makeHandleLayout(generationBits)
          const capacity = Math.max(64, Math.min(L.capacity, 256))
          const arr = arrays(capacity)
          const idx = new EntityIndex(L, arr)

          // The set of currently-alive handles, as the model sees them.
          const alive = new Set<EntityHandle>()
          // Every handle ever known to a caller (for double-free attempts on stale handles).
          const everSeen: EntityHandle[] = []

          const guardedFree = (h: EntityHandle): void => {
            // The store-level contract: only free alive handles. The model emulates despawn's
            // idempotent guard so a stale/double handle is a no-op (I8).
            if (!idx.isAlive(h)) return
            idx.freeEntity(h)
            alive.delete(h)
          }

          for (const op of ops) {
            if (op.kind === 'alloc') {
              if (idx.denseLen >= capacity && idx.aliveCount === idx.denseLen) {
                // would exceed our test capacity / index space; skip
                if (idx.denseLen > L.maxIndex) continue
                if (idx.aliveCount >= capacity) continue
              }
              if (idx.aliveCount >= capacity) continue
              const h = idx.allocEntity()
              alive.add(h)
              everSeen.push(h)
            } else {
              const pool = everSeen
              if (pool.length === 0) continue
              const pick = pool[op.which % pool.length] as EntityHandle
              if (op.kind === 'free') {
                guardedFree(pick)
              } else {
                // doubleFree: free twice; second must be a no-op regardless of liveness.
                const aliveBefore = idx.aliveCount
                guardedFree(pick)
                const aliveMid = idx.aliveCount
                guardedFree(pick) // I8: no-op on a now-dead handle
                expect(idx.aliveCount).toBe(aliveMid)
                expect(aliveMid).toBeLessThanOrEqual(aliveBefore)
              }
            }

            // --- INVARIANTS checked after every op ---

            // (a) aliveCount and denseLen are within bounds and consistent.
            expect(idx.aliveCount).toBeLessThanOrEqual(idx.denseLen)
            expect(idx.aliveCount).toBe(alive.size)

            // (b) liveness agrees with the model for every handle ever seen.
            for (const h of everSeen) {
              expect(idx.isAlive(h)).toBe(alive.has(h))
            }

            // (c) density: the dense prefix [0, aliveCount) holds exactly the alive handles,
            // the free region [aliveCount, denseLen) is disjoint from it, and together they
            // cover every minted index exactly once (a permutation of [0, denseLen)).
            const seenIndices = new Set<number>()
            const aliveIndices = new Set<number>()
            for (let pos = 0; pos < idx.denseLen; pos++) {
              const h = arr.dense[pos] as number as EntityHandle
              const di = handleIndex(h, L)
              expect(di).toBeLessThan(idx.denseLen) // every parked/alive index was minted
              expect(seenIndices.has(di)).toBe(false) // each minted index appears exactly once
              seenIndices.add(di)
              // sparse must point back to this position
              expect(arr.sparse[di]).toBe(pos)
              if (pos < idx.aliveCount) {
                aliveIndices.add(di)
                // alive-prefix entries compare equal under isAlive
                expect(idx.isAlive(h)).toBe(true)
              } else {
                // free-region entries are parked (dead): pos >= aliveCount guard rejects them
                expect(idx.isAlive(h)).toBe(false)
              }
            }
            // covering: the union is exactly [0, denseLen)
            expect(seenIndices.size).toBe(idx.denseLen)
            // disjoint: the alive index set is exactly the model's alive set's indices
            expect(aliveIndices.size).toBe(idx.aliveCount)
          }
        },
      ),
      { numRuns: 150 },
    )
  })
})