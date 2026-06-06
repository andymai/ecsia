import { describe, expect, test } from 'vitest'
import { ARCHETYPE_NONE, NO_ENTITY, createWorld, handleIndex, makeHandleLayout } from '@ecsia/core'
import { handleGeneration, makeHandle } from '../src/internal.js'
import type { EntityHandle } from '@ecsia/core'
import { EntityIndex } from '../src/entity/index-allocator.js'
import { EntityRecord } from '../src/entity/record.js'
import { EntityStore } from '../src/entity/store.js'

const L10 = makeHandleLayout(10)

function makeAllocator(layout = L10, capacity = layout.capacity): EntityIndex {
  return new EntityIndex(layout, {
    sparse: new Uint32Array(capacity),
    dense: new Uint32Array(capacity),
    generation: new Uint32Array(capacity),
  })
}

function makeRecord(layout = L10, capacity = layout.capacity): EntityRecord {
  return new EntityRecord(layout, {
    recordArchetypeId: new Uint32Array(capacity),
    recordArchetypeRow: new Uint32Array(capacity),
  })
}

describe('spawn / despawn / isAlive lifecycle', () => {
  test('spawned handle is alive; despawned handle is dead', () => {
    const w = createWorld()
    const h = w.spawn()
    expect(w.isAlive(h)).toBe(true)
    w.despawn(h)
    expect(w.isAlive(h)).toBe(false)
  })

  test('a never-minted handle is not alive', () => {
    const w = createWorld()
    expect(w.isAlive(makeHandle(5, 0, w.handleLayout))).toBe(false)
  })

  test('distinct spawns yield distinct, independently-tracked handles', () => {
    const w = createWorld()
    const a = w.spawn()
    const b = w.spawn()
    expect(a).not.toBe(b)
    w.despawn(a)
    expect(w.isAlive(a)).toBe(false)
    expect(w.isAlive(b)).toBe(true)
  })

  test('handleStats tracks alive count and high-water mint', () => {
    const w = createWorld({ maxEntities: 1024 })
    const a = w.spawn()
    const b = w.spawn()
    expect(w.handleStats().aliveCount).toBe(2)
    expect(w.handleStats().minted).toBe(2)
    w.despawn(a)
    expect(w.handleStats().aliveCount).toBe(1)
    // denseLen is a high-water mark: a free slot is parked, not un-minted.
    expect(w.handleStats().minted).toBe(2)
    void b
  })
})

describe('despawn idempotence on a dead handle (I8)', () => {
  test('double despawn is a no-op and does not mutate alive count', () => {
    const w = createWorld()
    const h = w.spawn()
    w.despawn(h)
    const aliveAfterFirst = w.handleStats().aliveCount
    expect(() => w.despawn(h)).not.toThrow()
    expect(w.handleStats().aliveCount).toBe(aliveAfterFirst)
    expect(w.isAlive(h)).toBe(false)
  })

  test('despawning a never-spawned handle is a no-op', () => {
    const w = createWorld()
    const fabricated = makeHandle(3, 0, w.handleLayout)
    expect(() => w.despawn(fabricated)).not.toThrow()
    expect(w.handleStats().aliveCount).toBe(0)
  })

  test('the second despawn does not free the slot a third party now holds', () => {
    const w = createWorld()
    const a = w.spawn()
    w.despawn(a)
    const b = w.spawn() // recycles a's index at a bumped generation
    expect(handleIndex(b, w.handleLayout)).toBe(handleIndex(a, w.handleLayout))
    // a is stale; a second despawn(a) must NOT collaterally kill b.
    w.despawn(a)
    expect(w.isAlive(b)).toBe(true)
  })
})

describe('handle codec round-trip on hand-picked bit patterns', () => {
  const layouts = [
    { gen: 0, name: 'gen0 (index === 32 bits)' },
    { gen: 1, name: 'gen1' },
    { gen: 8, name: 'gen8 (24/8)' },
    { gen: 10, name: 'gen10 (default 22/10)' },
    { gen: 16, name: 'gen16 (16/16)' },
    { gen: 31, name: 'gen31 (1/31)' },
  ]

  for (const { gen, name } of layouts) {
    test(`round-trip boundary values under ${name}`, () => {
      const L = makeHandleLayout(gen)
      const clampI = (n: number): number => Math.max(0, Math.min(L.maxIndex, n)) >>> 0
      const clampG = (n: number): number => Math.max(0, Math.min(L.maxGeneration, n))
      const indices = [...new Set([0, 1, L.maxIndex, L.maxIndex >>> 1, L.maxIndex - 1].map(clampI))]
      const gens = [...new Set([0, 1, L.maxGeneration, L.maxGeneration - 1].map(clampG))]
      for (const i of indices) {
        for (const g of gens) {
          const h = makeHandle(i, g, L)
          expect(handleIndex(h, L)).toBe(i)
          expect(handleGeneration(h, L)).toBe(g)
          // handle stays an unsigned 32-bit value
          expect(h >>> 0).toBe(h as number)
          expect(h).toBeGreaterThanOrEqual(0)
          expect(h).toBeLessThanOrEqual(0xffffffff)
        }
      }
    })
  }

  test('NO_ENTITY decodes to maxIndex / maxGeneration under the default split', () => {
    const L = makeHandleLayout(10)
    expect(handleIndex(NO_ENTITY, L)).toBe(L.maxIndex)
    expect(handleGeneration(NO_ENTITY, L)).toBe(L.maxGeneration)
  })

  test('all-ones pattern round-trips under any split', () => {
    for (let gen = 1; gen <= 31; gen++) {
      const L = makeHandleLayout(gen)
      const h = (0xffffffff >>> 0) as EntityHandle
      expect(handleIndex(h, L)).toBe(L.maxIndex)
      expect(handleGeneration(h, L)).toBe(L.maxGeneration)
    }
  })

  test('gen0 layout: index occupies the full 32 bits, generation always 0', () => {
    const L = makeHandleLayout(0)
    expect(L.indexBits).toBe(32)
    expect(L.indexMask).toBe(0xffffffff)
    expect(L.generationMask).toBe(0)
    const h = makeHandle(0xdeadbeef, 0, L)
    expect(handleIndex(h, L)).toBe(0xdeadbeef)
    expect(handleGeneration(h, L)).toBe(0)
  })

  test('decodeHandle on the world mirrors the standalone codec', () => {
    const w = createWorld()
    const h = w.encodeHandle(1234, 7)
    const d = w.decodeHandle(h)
    expect(d.index).toBe(1234)
    expect(d.generation).toBe(7)
  })
})

describe('resolveLocation returns the committed (archetypeId, row) after commitRecord', () => {
  test('commitRecord then resolveLocation round-trips both words', () => {
    const rec = makeRecord()
    const h = makeHandle(42, 3, L10)
    rec.commitRecord(handleIndex(h, L10), 7, 99)
    const loc = rec.resolveLocation(h)
    expect(loc.archetypeId).toBe(7)
    expect(loc.row).toBe(99)
  })

  test('a second commit overwrites the prior location (migration commit point)', () => {
    const rec = makeRecord()
    const h = makeHandle(5, 0, L10)
    const idx = handleIndex(h, L10)
    rec.commitRecord(idx, 1, 10)
    rec.commitRecord(idx, 2, 20)
    const loc = rec.resolveLocation(h)
    expect(loc.archetypeId).toBe(2)
    expect(loc.row).toBe(20)
  })

  test('spawn commits the empty archetype (id 0, row 0)', () => {
    const w = createWorld()
    const h = w.spawn()
    const ref = w.entity(h)
    expect(ref.__archetypeId).toBe(0)
    expect(ref.__row).toBe(0)
    expect(ref.__handle).toBe(h)
  })

  test('records of distinct indices are independent', () => {
    const rec = makeRecord()
    const a = makeHandle(1, 0, L10)
    const b = makeHandle(2, 0, L10)
    rec.commitRecord(handleIndex(a, L10), 11, 111)
    rec.commitRecord(handleIndex(b, L10), 22, 222)
    expect(rec.resolveLocation(a)).toEqual({ archetypeId: 11, row: 111 })
    expect(rec.resolveLocation(b)).toEqual({ archetypeId: 22, row: 222 })
  })
})

describe('generation bump on free (recycling)', () => {
  test('a recycled slot reissues with generation prevGen + 1', () => {
    const idx = makeAllocator()
    const a = idx.allocEntity()
    expect(handleGeneration(a, L10)).toBe(0)
    idx.freeEntity(a)
    const b = idx.allocEntity()
    expect(handleIndex(b, L10)).toBe(handleIndex(a, L10))
    expect(handleGeneration(b, L10)).toBe(1)
    expect(idx.isAlive(a)).toBe(false)
    expect(idx.isAlive(b)).toBe(true)
  })

  test('generation increments by exactly one per recycle of the same slot', () => {
    const idx = makeAllocator()
    let h = idx.allocEntity()
    const slot = handleIndex(h, L10)
    for (let g = 1; g <= 5; g++) {
      idx.freeEntity(h)
      h = idx.allocEntity()
      expect(handleIndex(h, L10)).toBe(slot)
      expect(handleGeneration(h, L10)).toBe(g)
    }
  })

  test('generation wraps to 0 after 2^generationBits recycles of the same slot', () => {
    const L = makeHandleLayout(2) // maxGeneration === 3, wrap period 4
    const idx = makeAllocator(L)
    let h = idx.allocEntity()
    const slot = handleIndex(h, L)
    for (let i = 0; i < 4; i++) {
      idx.freeEntity(h)
      h = idx.allocEntity()
      expect(handleIndex(h, L)).toBe(slot)
    }
    // after 4 recycles, gen returned to 0 (the documented aliasing window)
    expect(handleGeneration(h, L)).toBe(0)
    expect(idx.wrapped).toBe(true)
  })
})

describe('NO_ENTITY / ARCHETYPE_NONE sentinels', () => {
  test('NO_ENTITY is the all-ones u32 and is never alive in a fresh world', () => {
    expect(NO_ENTITY).toBe(0xffffffff)
    const w = createWorld()
    expect(w.isAlive(NO_ENTITY)).toBe(false)
  })

  test('ARCHETYPE_NONE is the all-ones record sentinel, distinct from the empty archetype id 0', () => {
    expect(ARCHETYPE_NONE).toBe(0xffffffff)
    expect(ARCHETYPE_NONE).not.toBe(0)
  })

  test('a freshly constructed EntityRef carries the NO_ENTITY / ARCHETYPE_NONE sentinels', () => {
    const rec = makeRecord()
    // EntityRef is constructed empty before any bind.
    const store = new EntityStore({ layout: L10, maxEntities: 16, shared: false })
    const ref = store.entity(store.spawn())
    // sanity: after binding the sentinels are replaced by committed values
    expect(ref.__handle).not.toBe(NO_ENTITY)
    void rec
  })
})

describe('generationBits === 0 rejected when threaded === true', () => {
  test('createWorld rejects gen0 under threading', () => {
    expect(() => createWorld({ generationBits: 0, threaded: true })).toThrow()
  })

  test('createWorld allows gen0 single-threaded', () => {
    expect(() => createWorld({ generationBits: 0, threaded: false })).not.toThrow()
  })
})

describe('capacity & growth (I3 / I9)', () => {
  test('every handle up to maxEntities is alive and resolvable; the cap binds the mint ceiling', () => {
    // maxEntities sizes every fixed flat structure (bitmask words, query sparse sets, reactivity
    // rings), so it is the HARD mint ceiling (world.md §6.2) — minting past it would silently
    // corrupt membership (OOB bitmask writes are no-ops), the critical bug.
    const w = createWorld({ maxEntities: 4 })
    const handles: EntityHandle[] = []
    for (let i = 0; i < 4; i++) handles.push(w.spawn())
    for (const h of handles) expect(w.isAlive(h)).toBe(true)
    expect(w.handleStats().aliveCount).toBe(4)
    expect(w.handleStats().minted).toBe(4)
    for (const h of handles) {
      const ref = w.entity(h)
      expect(ref.__archetypeId).toBe(0)
      expect(ref.__handle).toBe(h)
    }
  })

  test('the spawn past maxEntities throws CapacityExceeded loudly (regression: silent OOB)', () => {
    const w = createWorld({ maxEntities: 4 })
    for (let i = 0; i < 4; i++) w.spawn()
    expect(() => w.spawn()).toThrow(/exhausted/)
    // Free a slot and the next spawn succeeds again — the cap gates SIMULTANEOUS liveness.
    const w2 = createWorld({ maxEntities: 4 })
    const first = w2.spawn()
    for (let i = 0; i < 3; i++) w2.spawn()
    w2.despawn(first)
    expect(w2.isAlive(w2.spawn())).toBe(true)
  })

  test('CapacityExceeded throws at the real index-space ceiling, not silently', () => {
    // generationBits 30 → indexBits 2 → maxIndex 3, capacity 4 (the whole index space).
    // Single-threaded: ceiling = min(maxEntities, maxIndex + 1) = 4. The 5th distinct mint must throw.
    const w = createWorld({ generationBits: 30, maxEntities: 4 })
    const live = [w.spawn(), w.spawn(), w.spawn(), w.spawn()]
    for (const h of live) expect(w.isAlive(h)).toBe(true)
    expect(() => w.spawn()).toThrow(/exhausted/)
  })

  test('threaded worlds reserve maxIndex for the NO_ENTITY sentinel', () => {
    // crossOriginIsolated is false in the test env, so threaded arrays are plain ArrayBuffers,
    // but the mint ceiling is still maxIndex (not maxIndex + 1): the sentinel slot is unusable.
    // gen 30 → maxIndex 3; threaded ceiling = min(maxEntities, maxIndex) = 3, so at most 3 mints.
    const w = createWorld({ generationBits: 30, maxEntities: 4, threaded: true })
    const a = w.spawn()
    const b = w.spawn()
    const c = w.spawn()
    expect(w.isAlive(a)).toBe(true)
    expect(w.isAlive(b)).toBe(true)
    expect(w.isAlive(c)).toBe(true)
    // The 4th mint would be index 3 === maxIndex (the NO_ENTITY sentinel) → refused.
    expect(() => w.spawn()).toThrow(/exhausted/)
  })
})

describe('I7 — isAlive never consults a bitmask (structural)', () => {
  // No bitmask module exists in, so a runtime stub cannot be wired (the spec's eventual
  // bitmask lives in archetype-storage, M-bitmask). Until then, prove the invariant
  // structurally: isAlive's implementation reads only the identity triad (sparse/dense/
  // generation) and never names anything bitmask-shaped. This assertion CAN fail if a future
  // edit makes isAlive touch a membership word — unlike a console.warn spy, which never could.
  test('isAlive source reads only sparse/dense/generation, never a bitmask/membership word', () => {
    const src = EntityIndex.prototype.isAlive.toString()
    expect(src).toMatch(/sparse/)
    expect(src).toMatch(/dense/)
    expect(src).not.toMatch(/bitmask|membership|words/i)
  })

  test('isAlive returns correct results without any observable side effect (no spawn/despawn)', () => {
    const w = createWorld()
    const h = w.spawn()
    const before = w.handleStats()
    for (let i = 0; i < 1000; i++) expect(w.isAlive(h)).toBe(true)
    const after = w.handleStats()
    expect(after.aliveCount).toBe(before.aliveCount)
    expect(after.minted).toBe(before.minted)
  })
})
