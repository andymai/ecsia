// M3 bitmask serial-only enforcement (BM-1) + edge-graph / multi-id migration unit tests, driven
// against the exported Bitmask and ArchetypeStore directly (no full world) so the phase gate and
// the edge cache can be observed in isolation.

import { describe, expect, test } from 'vitest'
import { defineComponent } from '@ecsia/core'
import { ArchetypeStore, Bitmask, Buffers, ComponentRegistry, canonicalize, probeCapabilities } from '../src/internal.js'
import type { ComponentId } from '@ecsia/core'
import type { RecordSurface, Signature } from '../src/internal.js'

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

describe('Bitmask BM-1: every access asserts world.phase === serial', () => {
  test('bitmaskHas / bitmaskApplyDelta / entityShapeWords throw during a wave', () => {
    let phase: 'serial' | 'wave' = 'serial'
    const bm = new Bitmask(newBuffers(), 4, 1 << 16, () => phase)
    const empty = canonicalize([]) as Signature
    const withC = canonicalize([1]) as Signature
    // serial: fine.
    bm.bitmaskApplyDelta(0, empty, withC)
    expect(bm.bitmaskHas(0, 1 as ComponentId)).toBe(true)
    // wave: every read/write throws (serial-phase-only access guard).
    phase = 'wave'
    expect(() => bm.bitmaskHas(0, 1 as ComponentId)).toThrow(/serial-phase only/)
    expect(() => bm.bitmaskApplyDelta(0, empty, withC)).toThrow(/serial-phase only/)
    expect(() => bm.entityShapeWords(0)).toThrow(/serial-phase only/)
    expect(() => bm.bitmaskClear(0)).toThrow(/serial-phase only/)
  })

  test('coherence: applyDelta sets added bits, clears removed bits', () => {
    const bm = new Bitmask(newBuffers(), 64, 1 << 16, () => 'serial')
    const a = canonicalize([2, 40]) as Signature // 40 is in the 2nd word (stride 2)
    bm.bitmaskApplyDelta(5, canonicalize([]) as Signature, a)
    expect(bm.bitmaskHas(5, 2 as ComponentId)).toBe(true)
    expect(bm.bitmaskHas(5, 40 as ComponentId)).toBe(true)
    bm.bitmaskApplyDelta(5, a, canonicalize([2]) as Signature) // drop 40
    expect(bm.bitmaskHas(5, 40 as ComponentId)).toBe(false)
    expect(bm.bitmaskHas(5, 2 as ComponentId)).toBe(true)
  })
})

function makeStore(componentCount: number, maxHotArchetypes = 1024): {
  store: ArchetypeStore
  recordArch: Map<number, number>
  recordRow: Map<number, number>
} {
  const buffers = newBuffers()
  const registry = new ComponentRegistry()
  // Register `componentCount` real one-field components so defOf resolves their columns.
  const defs = Array.from({ length: componentCount }, (_, i) => defineComponent({ ['f' + i]: 'i32' as const }, { name: 'f' + i }))
  registry.register(defs)
  const recordArch = new Map<number, number>()
  const recordRow = new Map<number, number>()
  const record: RecordSurface = {
    commitRecord: (index, archId, row) => {
      recordArch.set(index, archId)
      recordRow.set(index, row)
    },
    archetypeIdOf: (index) => recordArch.get(index) ?? 0,
    rowOf: (index) => recordRow.get(index) ?? 0,
  }
  const bitmask = new Bitmask(buffers, registry.nextComponentId, 1 << 16, () => 'serial')
  const store = new ArchetypeStore({
    buffers,
    accessorWorld: { tracking: { active: true }, trackWrite: () => {}, handleIndex: (h) => (h as number) & 0xffff },
    bitmask,
    record,
    maxHotArchetypes,
    stride: bitmask.stride,
    maxEntities: 1 << 16,
    enqueueRemoveLog: () => {},
    tick: () => 0,
    defOf: (c) => registry.defOf(c),
    handleIndex: (h) => h & 0xffff,
  })
  return { store, recordArch, recordRow }
}

describe('ArchetypeStore edge graph (AR-1, EDGE-1)', () => {
  test('AR-1: getOrCreateArchetype interns structurally-equal signatures', () => {
    const { store } = makeStore(3)
    const a = store.getOrCreateArchetype(canonicalize([1, 2]) as Signature)
    const b = store.getOrCreateArchetype(canonicalize([2, 1]) as Signature)
    expect(a).toBe(b)
  })

  test('EDGE-1: edgeAdd caches both the add edge and the reverse remove edge on first miss', () => {
    const { store } = makeStore(3)
    const empty = store.emptyArchetype
    const withC1 = store.edgeAdd(empty, 1 as ComponentId)
    // forward edge cached on empty:
    expect(empty.edges.get(1 as ComponentId)?.add).toBe(withC1)
    // reverse edge primed on the target — removing 1 returns empty with NO new archetype:
    expect(withC1.edges.get(1 as ComponentId)?.remove).toBe(empty)
    expect(store.edgeRemove(withC1, 1 as ComponentId)).toBe(empty)
    // second call is a pure cache hit (same object).
    expect(store.edgeAdd(empty, 1 as ComponentId)).toBe(withC1)
  })
})

describe('multi-id atomic migration (§5.6a)', () => {
  test('migrateAddingMany lands a pair of ids in ONE target archetype', () => {
    const { store, recordArch } = makeStore(4)
    const handle = 0x000a // index 10
    // Seat the entity in the empty archetype first (record points at EMPTY).
    store.allocRow(store.emptyArchetype, handle)
    recordArch.set(10, 0)
    const newRow = store.migrateAddingMany(handle, [2 as ComponentId, 3 as ComponentId])
    expect(newRow).toBeGreaterThanOrEqual(0)
    const arch = store.byId[recordArch.get(10) as number]!
    expect([...arch.signature]).toEqual([2, 3]) // single combined target, no intermediate
  })
})
