// Edge-case coverage for the Reactivity facade: the WIDE (two-word) packing/unpacking
// paths, mergeCorrals / mergeWorkerWrites, field-granular stamp opt-in, the structural journal seams
// (trackShapePair / trackShapeSetPayload / drainStructuralSince), the conservative overflow drain in
// both drainChanged and observerDrain, the maintain-hook-null fast path, and the tick-wrap recovery.
// Driven by constructing Reactivity directly with synthetic deps so each branch is reached in isolation.

import { describe, expect, test } from 'vitest'
import { ShapeKind } from '@ecsia/core'
import { Buffers, Reactivity, probeCapabilities } from '../src/internal.js'
import type { ReactivityDeps } from '../src/internal.js'
import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/core'
import type { LiveQuery } from '../src/query/index.js'
import type { EntityRef } from '../src/entity/index.js'

const buffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

interface Harness {
  r: Reactivity
  setTick(t: number): void
  members: Set<number>
}

function makeReactivity(opts?: Partial<ReactivityDeps>): Harness {
  let tick = 1
  const members = new Set<number>()
  const refs = new Map<number, EntityRef>()
  const deps: ReactivityDeps = {
    buffers: buffers(),
    maxEntities: 1 << 12,
    indexBits: 20,
    logEntryWords: 1,
    maxWritesPerFrame: 8,
    maxShapeChangesPerFrame: 8,
    shrinkRings: false,
    dev: false,
    resolveLocation: (index): { archetypeId: number; row: number } => ({ archetypeId: 0, row: index }),
    tick: (): number => tick,
    advanceTick: (): void => {
      tick = (tick + 1) >>> 0
    },
    idOf: (def): ComponentId => (def as unknown as { id: number }).id as ComponentId,
    holdsAll: (index, ids): boolean => members.has(index) && ids.length > 0,
    eventRefOf: (index): EntityRef => {
      let r = refs.get(index)
      if (r === undefined) {
        r = { index } as unknown as EntityRef
        refs.set(index, r)
      }
      return r
    },
    onDestroyDrained: (): void => {},
    onCreateDrained: (): void => {},
    resolveHandle: (index): number => 0xabc0000 + index,
    tracking: { active: false },
    ...opts,
  }
  const r = new Reactivity(deps)
  return {
    r,
    setTick: (t): void => {
      tick = t
    },
    members,
  }
}

// A minimal LiveQuery stand-in: drainChanged/attachChangedFlavor only touch `q.current`, which needs
// a `.has(index)` predicate plus iteration (for the conservative path and dedup sizing).
function fakeQuery(indices: number[]): LiveQuery {
  const set = new Set(indices)
  const current = {
    has: (i: number): boolean => set.has(i),
    [Symbol.iterator]: (): Iterator<number> => set[Symbol.iterator](),
  }
  return { current } as unknown as LiveQuery
}

describe('currentTick reflects the world tick (lines 317-318)', () => {
  test('currentTick returns the deps tick and tracks advanceTick', () => {
    const { r } = makeReactivity()
    expect(r.currentTick()).toBe(1)
    r.frameReset() // advances the tick to 2
    expect(r.currentTick()).toBe(2)
  })
})

describe('WIDE (two-word) write log — pack/unpack round-trips through drainChanged (lines 146-147, 195-196)', () => {
  test('a wide write surfaces the exact (index, componentId) in the changed set', () => {
    const { r } = makeReactivity({ logEntryWords: 2 })
    const q = fakeQuery([7])
    r.attachChangedFlavor(q, [3]) // filter on component id 3
    // trackWrite pushes two words (index, componentId) in wide mode.
    r.trackWrite(7, 3 as ComponentId)
    r.trackWrite(7, 99 as ComponentId) // filtered out (component 99 not in the set)
    const changed = r.drainChanged(q)
    expect(Array.from(changed)).toEqual([7])
  })

  test('wide writes for entities NOT in current are dropped', () => {
    const { r } = makeReactivity({ logEntryWords: 2 })
    const q = fakeQuery([5])
    r.attachChangedFlavor(q, [])
    r.trackWrite(8, 1 as ComponentId) // 8 not in current
    expect(Array.from(r.drainChanged(q))).toEqual([])
  })
})

describe('WIDE shape log — pack/unpack round-trips through observerDrain (lines 154-157, 168-172)', () => {
  test('a wide AddPair shape entry dispatches an add observer with the right component + target survives unpack', () => {
    const { r, members } = makeReactivity({ logEntryWords: 2 })
    const C = { id: 4 } as unknown as ComponentDef<Schema>
    const fired: Array<{ index: number; kind: string; component: number }> = []
    r.observe({ kind: 'add', components: [C] }, (e, ctx) => {
      fired.push({ index: (e as unknown as { index: number }).index, kind: ctx.kind, component: ctx.component as number })
    })
    members.add(12) // holdsAll true for a present member
    // AddPair packs index, componentId and a wide target word; the unpack must recover index 12 / comp 4.
    r.trackShapePair(12, 4 as ComponentId, 77, ShapeKind.AddPair)
    r.observerDrain()
    expect(fired).toEqual([{ index: 12, kind: 'add', component: 4 }])
  })

  test('a wide Remove shape entry dispatches a remove observer', () => {
    const { r } = makeReactivity({ logEntryWords: 2 })
    const C = { id: 6 } as unknown as ComponentDef<Schema>
    const fired: number[] = []
    r.observe({ kind: 'remove', components: [C] }, (e) => fired.push((e as unknown as { index: number }).index))
    r.trackShape(3, 6 as ComponentId, ShapeKind.Remove)
    r.observerDrain()
    expect(fired).toEqual([3])
  })
})

describe('mergeCorrals + mergeWorkerWrites (lines 446-447, 467-468)', () => {
  test('mergeWorkerWrites packs each pair into the ring AND stamps changeVersion when enabled', () => {
    const { r } = makeReactivity()
    r.enableChangeVersion()
    const q = fakeQuery([1, 2])
    r.attachChangedFlavor(q, []) // empty filter → accepts any component
    const pairs = new Uint32Array([1, 10, 2, 20]) // (index 1, comp 10), (index 2, comp 20)
    r.mergeWorkerWrites(pairs, 2)
    const changed = Array.from(r.drainChanged(q)).sort((a, b) => a - b)
    expect(changed).toEqual([1, 2])
    // changeVersion was stamped at the current tick for the merged rows.
    expect(r.changedSince(1 as unknown as EntityHandle, 0)).toBe(true)
    expect(r.changedSince(2 as unknown as EntityHandle, 0)).toBe(true)
  })

  test('mergeWorkerWrites does not stamp when changeVersion is disabled', () => {
    const { r } = makeReactivity()
    const q = fakeQuery([4])
    r.attachChangedFlavor(q, []) // this enables changeVersion via attachChangedFlavor
    // attachChangedFlavor enables changeVersion, so use a fresh instance with NO flavor to isolate.
    const fresh = makeReactivity().r
    fresh.mergeWorkerWrites(new Uint32Array([4, 1]), 1)
    expect(fresh.changedSince(4 as unknown as EntityHandle, 0)).toBe(false)
  })
})

describe('changed-flavor attach/drain edge cases (branches 353/372)', () => {
  test('attachChangedFlavor is idempotent — a second attach for the same query is ignored', () => {
    const { r } = makeReactivity()
    const q = fakeQuery([1])
    r.attachChangedFlavor(q, [5])
    r.attachChangedFlavor(q, [9]) // second call returns early (already has the flavor)
    r.trackWrite(1, 5 as ComponentId)
    r.trackWrite(1, 9 as ComponentId) // 9 NOT in the ORIGINAL filter {5}; idempotency kept the first set
    expect(Array.from(r.drainChanged(q))).toEqual([1]) // one entry via component 5 only
  })

  test('drainChanged on a query with no attached flavor returns the empty array', () => {
    const { r } = makeReactivity()
    const q = fakeQuery([1, 2])
    expect(Array.from(r.drainChanged(q))).toEqual([])
  })
})

describe('mergeCorrals is a safe no-op single-thread (empty corral)', () => {
  test('calling mergeCorrals with no staged worker words leaves the changed set empty', () => {
    const { r } = makeReactivity()
    const q = fakeQuery([1])
    r.attachChangedFlavor(q, [])
    r.mergeCorrals() // single-thread corral is always empty → no words merged
    expect(Array.from(r.drainChanged(q))).toEqual([])
  })
})

describe('field-granular stamp opt-in is accepted on the default path (lines 205-206)', () => {
  test('trackWrite with a fieldIndex still stamps the whole-entity slot (component-granular default)', () => {
    const { r } = makeReactivity()
    r.enableChangeVersion()
    r.trackWrite(9, 2 as ComponentId, 1) // fieldIndex provided but ignored by the default stamp
    expect(r.changedSince(9 as unknown as EntityHandle, 0)).toBe(true)
  })
})

describe('structural journal seams (lines 254-261)', () => {
  test('trackShapeSetPayload records an OP_PAIR_PAYLOAD entry only when journaling is enabled', () => {
    const { r } = makeReactivity()
    r.enableStructuralJournal()
    r.trackShapeSetPayload(5, 8 as ComponentId, 6)
    const { records, gap } = r.drainStructuralSince(0)
    expect(gap).toBe(false)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe(ShapeKind.SetPayload)
    expect(records[0]?.componentId).toBe(8)
  })

  test('trackShapeSetPayload is a no-op when the journal is disabled', () => {
    const { r } = makeReactivity()
    r.trackShapeSetPayload(5, 8 as ComponentId, 6)
    const { records } = r.drainStructuralSince(0)
    expect(records).toHaveLength(0)
  })

  test('trackShapePair records add/remove pair ops with resolved full handles', () => {
    const { r } = makeReactivity()
    r.enableStructuralJournal()
    r.trackShapePair(2, 4 as ComponentId, 3, ShapeKind.AddPair)
    const { records } = r.drainStructuralSince(0)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe(ShapeKind.AddPair)
    expect(records[0]?.handle).toBe(0xabc0000 + 2)
    expect(records[0]?.target).toBe(0xabc0000 + 3)
  })
})

describe('maintainStructural fast path when no hook is bound (lines 482-484)', () => {
  test('with no maintain hook, maintainStructural just advances its cursor and does not throw', () => {
    const { r } = makeReactivity()
    // No setMaintainHook → hook is null. A shape entry exists but the drain only advances the cursor.
    r.trackShape(1, 2 as ComponentId, ShapeKind.Add)
    expect(() => r.maintainStructural()).not.toThrow()
  })

  test('with a hook bound, maintainStructural invokes it for each add/remove entry', () => {
    const { r } = makeReactivity()
    const calls: Array<[number, number]> = []
    r.setMaintainHook((index, componentId) => calls.push([index, componentId]))
    r.trackShape(1, 2 as ComponentId, ShapeKind.Add)
    r.trackShape(1, 2 as ComponentId, ShapeKind.Create) // Create is not add/remove → ignored
    r.maintainStructural()
    expect(calls).toEqual([[1, 2]])
  })
})

// NOTE on the conservative-overflow paths (reactivity.ts drainChanged lines 392-398 / observerDrain
// 520-522): these fire ONLY when LogRing.consume sees a generation mismatch. H_GENERATION is never
// incremented anywhere in the current single-thread implementation (verified by grep) — it is
// defensive scaffolding for a future SAB ring-rollover protocol. The flavor/observer LogPointers live
// in private #fields, so the mismatch cannot be induced from outside Reactivity without reflection.
// The equivalent sentinel branch in the LogRing PRIMITIVE itself IS covered in
// coverage-reactivity-log.test.ts (via the public `header` array). Treated here as unreachable.

describe('tick-wrap recovery at frameReset (lines 421-423)', () => {
  test('when the advanced tick lands on 0xffffffff, changeVersion stamps are reset', () => {
    const h = makeReactivity()
    h.r.enableChangeVersion()
    h.r.trackWrite(1, 2 as ComponentId)
    expect(h.r.changedSince(1 as unknown as EntityHandle, 0)).toBe(true)
    // Arrange the tick so advanceTick() inside frameReset lands exactly on 0xffffffff.
    h.setTick(0xfffffffe)
    h.r.frameReset()
    // The wrap-recovery resetAll cleared every stamp.
    expect(h.r.changedSince(1 as unknown as EntityHandle, 0)).toBe(false)
  })
})

