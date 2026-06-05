// Direct-construction coverage for the row-filter + residual matching paths that are otherwise only
// reachable through the relations module (exclusive specific-target pairs -> column-value filters,
// and pair ids beyond the fixed bitmask stride -> residual sigHas terms). We build a real
// ArchetypeStore (for genuine hot columns) + a Bitmask, then drive QueryEngine / LiveQuery directly
// with hand-built CompiledQuery objects carrying rowFilters / residualWith.

import { describe, expect, test } from 'vitest'
import { defineComponent, encodeEid } from '@ecsia/core'
import { ArchetypeStore, Bitmask, Buffers, ComponentRegistry, LiveQuery, QueryEngine, SparseSetU32, canonicalize, probeCapabilities, sigHas } from '../src/internal.js'
import type { ComponentId, EntityHandle, RegionKey } from '@ecsia/core'
import type { Archetype, CompiledQuery, LiveQueryDeps, QueryEngineDeps, RecordSurface, Signature } from '../src/internal.js'

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

interface Harness {
  store: ArchetypeStore
  bitmask: Bitmask
  buffers: Buffers
  registry: ComponentRegistry
  recordArch: Map<number, number>
  recordRow: Map<number, number>
  deps: QueryEngineDeps
}

// Build a store with `componentCount` real components (an eid first field so a column exists for the
// row filter). All hot (huge hot budget).
function harness(componentCount: number): Harness {
  const buffers = newBuffers()
  const registry = new ComponentRegistry()
  // Each component's first field is `eid` so a column-bearing presence component holds a target column.
  const defs = Array.from({ length: componentCount }, (_, i) => defineComponent({ ref: 'eid' }, { name: 'rel' + i }))
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
    maxHotArchetypes: 1 << 20,
    stride: bitmask.stride,
    maxEntities: 1 << 16,
    enqueueRemoveLog: () => {},
    tick: () => 0,
    defOf: (c) => registry.defOf(c),
    handleIndex: (h) => h & 0xffff,
  })

  const deps: QueryEngineDeps = {
    buffers,
    bitmask,
    maxEntities: 1 << 16,
    byId: store.byId,
    onArchetypeCreated: (fn) => store.onArchetypeCreated(fn),
    compileContext: { idOf: (d) => registry.idOf(d as never) as never, fixedBitCount: bitmask.stride * 32 },
    signatureOf: (index) => store.byId[recordArch.get(index) ?? 0]!.signature,
    indexOfHandle: (h) => h & 0xffff,
    resolveLocation: (index) => ({ archetypeId: recordArch.get(index) ?? 0, row: recordRow.get(index) ?? 0 }),
    handleOf: (index) => (index & 0xffff) as unknown as EntityHandle,
    coldResidentsOf: function* () {},
    coldColumnSet: () => undefined,
    coldRowOf: () => -1,
  }
  return { store, bitmask, buffers, registry, recordArch, recordRow, deps }
}

let seq = 0
function sparse(h: Harness): SparseSetU32 {
  const n = seq++
  return new SparseSetU32(h.buffers, `rf.${n}.d` as RegionKey, `rf.${n}.s` as RegionKey, 64, 1 << 16)
}

/** Seat entity `index` into the archetype for `sig`, writing `targetEid` into component `c`'s eid column. */
function seat(h: Harness, index: number, sig: Signature, c: ComponentId, targetEid: number): Archetype {
  const handle = index & 0xffff
  const arch = h.store.getOrCreateArchetype(sig)
  const row = h.store.allocRow(arch, handle)
  h.recordArch.set(index, arch.id as number)
  h.recordRow.set(index, row)
  h.bitmask.bitmaskApplyDelta(index, canonicalize([]) as Signature, sig)
  const col = arch.columnSets.get(c)!.columns[0]!
  col.view[row * col.layout.stride] = encodeEid(targetEid)
  return arch
}

function compiled(over: Partial<CompiledQuery>): CompiledQuery {
  return {
    withWords: [],
    notWords: [],
    optionalIds: [],
    residualWith: [],
    valueTerms: [],
    referencedIds: [],
    rowFilters: [],
    hash: 'h' + seq++,
    unsatisfiable: false,
    ...over,
  } as CompiledQuery
}

describe('LiveQuery #passesRowFilters (exclusive specific-target column filter)', () => {
  test('each() yields only rows whose target column equals the filter target', () => {
    const h = harness(2)
    const R = 1 as ComponentId // presence component (its eid column carries the target)
    const sig = canonicalize([R]) as Signature
    const TARGET = 4242

    // Two entities in the SAME archetype with DIFFERENT target column values.
    seat(h, 1, sig, R, TARGET) // matches
    seat(h, 2, sig, R, 9999) // same presence bit, wrong target -> filtered out
    const arch = h.store.byId[h.recordArch.get(1)!]!

    const cq = compiled({
      withWords: [{ wordIndex: 0, mask: (1 << R) >>> 0 }],
      referencedIds: [R],
      rowFilters: [{ presenceId: R, targetEid: TARGET, targetFieldIndex: 0 }],
    })
    const lq = new LiveQuery(cq, [], sparse(h), h.store.byId, h.deps as LiveQueryDeps)
    lq.ensureValueSignature(cq)
    lq.addMatchingArchetype(arch)

    const seen: number[] = []
    lq.each((el) => seen.push((el as { handle: EntityHandle }).handle as number))
    // Only the row whose eid column == TARGET passes the row filter.
    expect(seen).toEqual([1])
  })

  test('the iterator surface applies the same row filter as each()', () => {
    const h = harness(2)
    const R = 1 as ComponentId
    const sig = canonicalize([R]) as Signature
    const TARGET = 77
    seat(h, 1, sig, R, 11) // wrong target
    seat(h, 2, sig, R, TARGET) // match
    const arch = h.store.byId[h.recordArch.get(1)!]!

    const cq = compiled({
      withWords: [{ wordIndex: 0, mask: (1 << R) >>> 0 }],
      referencedIds: [R],
      rowFilters: [{ presenceId: R, targetEid: TARGET, targetFieldIndex: 0 }],
    })
    const lq = new LiveQuery(cq, [], sparse(h), h.store.byId, h.deps as LiveQueryDeps)
    lq.ensureValueSignature(cq)
    lq.addMatchingArchetype(arch)

    const seen: number[] = []
    for (const el of lq) seen.push((el as { handle: EntityHandle }).handle as number)
    expect(seen).toEqual([2])
  })

  test('eachChunk skips an archetype where not all rows pass the filter (fast-path correctness)', () => {
    const h = harness(2)
    const R = 1 as ComponentId
    const sig = canonicalize([R]) as Signature
    const TARGET = 5
    seat(h, 1, sig, R, TARGET)
    seat(h, 2, sig, R, 6) // makes the archetype NOT all-pass
    const arch = h.store.byId[h.recordArch.get(1)!]!

    const cq = compiled({
      withWords: [{ wordIndex: 0, mask: (1 << R) >>> 0 }],
      referencedIds: [R],
      rowFilters: [{ presenceId: R, targetEid: TARGET, targetFieldIndex: 0 }],
    })
    const lq = new LiveQuery(cq, [], sparse(h), h.store.byId, h.deps as LiveQueryDeps)
    lq.ensureValueSignature(cq)
    lq.addMatchingArchetype(arch)

    let chunks = 0
    lq.eachChunk(() => chunks++)
    // The archetype has a non-passing row, so eachChunk does NOT visit it (caller falls back to each).
    expect(chunks).toBe(0)
  })

  test('eachChunk DOES visit an archetype where every row passes the filter', () => {
    const h = harness(2)
    const R = 1 as ComponentId
    const sig = canonicalize([R]) as Signature
    const TARGET = 8
    seat(h, 1, sig, R, TARGET)
    seat(h, 2, sig, R, TARGET) // both pass
    const arch = h.store.byId[h.recordArch.get(1)!]!

    const cq = compiled({
      withWords: [{ wordIndex: 0, mask: (1 << R) >>> 0 }],
      referencedIds: [R],
      rowFilters: [{ presenceId: R, targetEid: TARGET, targetFieldIndex: 0 }],
    })
    const lq = new LiveQuery(cq, [], sparse(h), h.store.byId, h.deps as LiveQueryDeps)
    lq.ensureValueSignature(cq)
    lq.addMatchingArchetype(arch)

    let chunkRows = 0
    lq.eachChunk((c) => {
      chunkRows += c.count
    })
    expect(chunkRows).toBe(2)
  })

  test('each() lazily builds the hot binding when ensureValueSignature was never called (#binding miss)', () => {
    const h = harness(2)
    const R = 1 as ComponentId
    const sig = canonicalize([R]) as Signature
    seat(h, 1, sig, R, 0)
    seat(h, 2, sig, R, 0)
    const arch = h.store.byId[h.recordArch.get(1)!]!

    // A value term so the binding has something to build; NO ensureValueSignature call, so #hotBinding
    // takes the #binding map-miss arm and constructs the binding on first each().
    const cq = compiled({
      withWords: [{ wordIndex: 0, mask: (1 << R) >>> 0 }],
      referencedIds: [R],
      valueTerms: [{ componentId: R, role: 'read', key: 'rel0' }],
    })
    const lq = new LiveQuery(cq, [], sparse(h), h.store.byId, h.deps as LiveQueryDeps)
    lq.addMatchingArchetype(arch)

    const seen: number[] = []
    lq.each((el) => {
      const e = el as { handle: EntityHandle; rel0: { ref: unknown } }
      seen.push(e.handle as number)
      // the bound value term resolves through the freshly-built binding's element/accessors
      expect(e.rel0).toBeDefined()
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2])
  })
})

describe('QueryEngine row-filter precision in current (seed + maintain via resolvePair)', () => {
  // A pair term resolved (by a stubbed resolvePair) to presence component R + a target-column row
  // filter exercises the engine's #seedCurrentFromArchetype rowFilter scan (#rowPasses) and the
  // per-entity #passesRowFilters path.
  const pairTerm = (relationId: number, target: number): unknown =>
    ({ relation: { name: 'rel', id: relationId }, target, id: 9000 + target })

  function rowFilterEngine(target: number): { engine: QueryEngine; h: Harness; R: ComponentId } {
    const h = harness(2)
    const R = 1 as ComponentId
    h.deps.compileContext.resolvePair = () => ({
      componentId: R,
      unsatisfiable: false,
      rowFilter: { presenceId: R, targetEid: target, targetFieldIndex: 0 },
    })
    return { engine: new QueryEngine(h.deps), h, R }
  }

  test('seed admits only rows whose target column equals the filter target', () => {
    const TARGET = 321
    const { engine, h, R } = rowFilterEngine(TARGET)
    const sig = canonicalize([R]) as Signature
    seat(h, 1, sig, R, TARGET) // passes
    seat(h, 2, sig, R, 654) // wrong target -> excluded by #rowPasses during seed

    const q = engine.query([pairTerm(1, TARGET)] as never)
    expect(q.count).toBe(1)
    const seen: number[] = []
    q.each((el) => seen.push((el as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([1])
  })

  test('per-entity maintain re-tests the row filter (#passesRowFilters)', () => {
    const TARGET = 50
    const { engine, h, R } = rowFilterEngine(TARGET)
    const q = engine.query([pairTerm(1, TARGET)] as never)
    expect(q.count).toBe(0)

    const sig = canonicalize([R]) as Signature
    seat(h, 7, sig, R, TARGET) // matches the filter
    engine.maintainEntity(7, R)
    expect(q.count).toBe(1)

    // A second entity with the presence bit but a NON-matching target must stay out (#passesRowFilters false).
    seat(h, 8, sig, R, 999)
    engine.maintainEntity(8, R)
    expect(q.count).toBe(1)
  })

  test('liveQueries getter yields every registered query', () => {
    const { engine } = rowFilterEngine(1)
    engine.query([pairTerm(1, 1)] as never)
    engine.query([] as never)
    const all = [...engine.liveQueries]
    expect(all.length).toBe(2)
  })
})

describe('QueryEngine residual (out-of-stride) sigHas matching', () => {
  // Force EVERY component id into the RESIDUAL range by giving the engine's compile context a
  // fixedBitCount of 0. Then compileQuery puts the has term into residualWith, and the engine's
  // #archetypeMatches / #matchesEntityNow exercise their residual sigHas loops end-to-end.
  function residualHarness(): Harness {
    const h = harness(2)
    h.deps.compileContext.fixedBitCount = 0 as never
    return h
  }

  const term = (h: Harness, id: number): unknown => ({ __term: 'has', c: h.registry.defOf(id as ComponentId) })

  test('a residual has term seeds only signature-holders into current', () => {
    const h = residualHarness()
    const R = 1 as ComponentId
    const sig = canonicalize([R]) as Signature
    const other = canonicalize([2]) as Signature
    seat(h, 1, sig, R, 0) // holds R
    // entity 2 in a different archetype (no R)
    const archOther = h.store.getOrCreateArchetype(other)
    const row = h.store.allocRow(archOther, 2)
    h.recordArch.set(2, archOther.id as number)
    h.recordRow.set(2, row)
    h.bitmask.bitmaskApplyDelta(2, canonicalize([]) as Signature, other)

    const engine = new QueryEngine(h.deps)
    const q = engine.query([term(h, R as number)] as never)
    // The residual #archetypeMatches loop (sigHas) admits the R-holder, excludes the other.
    expect(q.count).toBe(1)
    const seen: number[] = []
    q.each((el) => seen.push((el as { handle: EntityHandle }).handle as number))
    expect(seen).toEqual([1])
  })

  test('residual #matchesEntityNow gates incremental add/remove of one entity', () => {
    const h = residualHarness()
    const R = 1 as ComponentId
    const engine = new QueryEngine(h.deps)
    const q = engine.query([term(h, R as number)] as never)
    expect(q.count).toBe(0)

    // Seat entity 5 holding R, then drive the per-entity matcher via maintainEntity. The residual
    // loop (signatureOf + sigHas) must admit it.
    const sig = canonicalize([R]) as Signature
    seat(h, 5, sig, R, 0)
    engine.maintainEntity(5, R)
    expect(q.count).toBe(1)
    expect(sigHas(h.store.byId[h.recordArch.get(5)!]!.signature, R)).toBe(true)

    // Now move entity 5 to an R-less signature and re-test: the residual loop must drop it.
    const empty = canonicalize([]) as Signature
    h.recordArch.set(5, 0) // EMPTY archetype id 0
    h.bitmask.bitmaskApplyDelta(5, sig, empty)
    engine.maintainEntity(5, R)
    expect(q.count).toBe(0)
  })
})
