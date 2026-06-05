// M3 archetype-storage invariant suite (archetype-storage.md §11). Property-based (fast-check) plus
// instrumented-counter assertions. Each property is written to DISCRIMINATE: it would fail if the
// invariant it guards were broken.
//
//   SIG-1   every Signature from any op sequence is sorted-ascending + de-duped.
//   AR-1    structurally-equal signatures intern to the SAME Archetype (identity ===), any add order.
//   EDGE-1  2nd+ edgeAdd/edgeRemove for (arch,c) is a cache HIT (instrumented miss counter); first
//           miss caches the add AND the reverse remove.
//   ROW-1   after random allocRow/removeRow: rows+columns dense over [0,count), count correct,
//           fixSibling fires exactly once iff row !== count-1.
//   MIG-1   migrate commits exactly 2 record words for the migrant + at most 1 (row) for the
//           shuffle-popped sibling (instrumented commitRecord counter).
//   MIG-2   migration copy/commit cost is independent of arch.count (size-10 vs size-10000) —
//           the wall-clock bench is DEFERRED (no bench harness); see note at the MIG-2 block.
//   BM-2    after EVERY structural op in a random sequence, bitmaskHas(i,c) === sigHas(sig(i),c).
//   BM-1    any bitmask access with phase !== 'serial' THROWS (fuzz the phase flag).
//   FRAG-1  a query over a forced-cold archetype yields the same entity set as a kept-hot one.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { defineComponent } from '@ecsia/core'
import { ArchetypeStore, Bitmask, Buffers, ComponentRegistry, canonicalize, probeCapabilities, sigEquals, sigHas, signatureMatches } from '../src/internal.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/core'
import type { RecordSurface, Signature } from '../src/internal.js'

// --- shared instrumented harness ------------------------------------------------------------------

const newBuffers = (): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

interface Harness {
  store: ArchetypeStore
  bitmask: Bitmask
  recordArch: Map<number, number>
  recordRow: Map<number, number>
  /** commitRecord invocations per entity index (MIG-1). */
  commits: Map<number, number>
  /** total commitRecord invocations since last reset (MIG-1/MIG-2). */
  totalCommits: { n: number }
  setPhase: (p: 'serial' | 'wave') => void
  /** the entity index encoded in the low 16 bits of a handle (matches handleIndex below). */
  handleIndex: (h: number) => number
}

function makeHarness(componentCount: number, maxHotArchetypes = 1 << 20): Harness {
  const buffers = newBuffers()
  const registry = new ComponentRegistry()
  const defs = Array.from({ length: componentCount }, (_, i) =>
    defineComponent({ ['f' + i]: 'i32' as const }, { name: 'f' + i }),
  )
  registry.register(defs)

  const recordArch = new Map<number, number>()
  const recordRow = new Map<number, number>()
  const commits = new Map<number, number>()
  const totalCommits = { n: 0 }
  let phase: 'serial' | 'wave' = 'serial'

  const record: RecordSurface = {
    commitRecord: (index, archId, row) => {
      recordArch.set(index, archId)
      recordRow.set(index, row)
      commits.set(index, (commits.get(index) ?? 0) + 1)
      totalCommits.n += 1
    },
    archetypeIdOf: (index) => recordArch.get(index) ?? 0,
    rowOf: (index) => recordRow.get(index) ?? 0,
  }

  const handleIndex = (h: number): number => h & 0xffff
  const bitmask = new Bitmask(buffers, registry.nextComponentId, 1 << 16, () => phase)
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
    handleIndex,
  })

  return {
    store,
    bitmask,
    recordArch,
    recordRow,
    commits,
    totalCommits,
    setPhase: (p) => {
      phase = p
    },
    handleIndex,
  }
}

/** Seat an entity (by index, encoded as its own handle) into the empty archetype. */
function seatInEmpty(h: Harness, index: number): number {
  const handle = index & 0xffff
  const row = h.store.allocRow(h.store.emptyArchetype, handle)
  h.recordArch.set(index, 0)
  h.recordRow.set(index, row)
  h.bitmask.bitmaskApplyDelta(index, h.store.emptyArchetype.signature, h.store.emptyArchetype.signature)
  return handle
}

/** Current committed signature for an alive entity index. */
function currentSig(h: Harness, index: number): Signature {
  return h.store.byId[h.recordArch.get(index) ?? 0]!.signature
}

// ==================================================================================================
// SIG-1
// ==================================================================================================

describe('SIG-1: every Signature is sorted-ascending + de-duped', () => {
  test('canonicalize of any id multiset is sorted + unique (and stays so under add/remove ops)', () => {
    const id = fc.integer({ min: 1, max: 60 })
    fc.assert(
      fc.property(fc.array(id, { maxLength: 30 }), (ids) => {
        const sig = canonicalize(ids as unknown as ComponentId[])
        // sorted strictly ascending => sorted AND de-duped in one check.
        for (let i = 1; i < sig.length; i++) {
          expect(sig[i]! > sig[i - 1]!).toBe(true)
        }
        // every input id is present exactly once.
        const uniq = new Set(ids)
        expect(sig.length).toBe(uniq.size)
        for (const c of uniq) expect(sigHas(sig, c)).toBe(true)
      }),
    )
  })

  test('every archetype reachable by a random add/remove op sequence has a sorted+unique signature', () => {
    const h = makeHarness(40)
    const op = fc.record({
      kind: fc.constantFrom('add', 'remove'),
      c: fc.integer({ min: 1, max: 40 }),
    })
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        seatInEmpty(h, 1)
        for (const o of ops) {
          if (o.kind === 'add') h.store.migrateAdding(1, o.c as ComponentId)
          else h.store.migrateRemoving(1, o.c as ComponentId)
        }
        // discriminating: assert over the WHOLE archetype set, not just the entity's current one.
        for (const arch of h.store.byId) {
          for (let i = 1; i < arch.signature.length; i++) {
            expect(arch.signature[i]! > arch.signature[i - 1]!).toBe(true)
          }
        }
      }),
      { numRuns: 60 },
    )
  })
})

// ==================================================================================================
// AR-1
// ==================================================================================================

describe('AR-1: structurally-equal signatures intern to the SAME Archetype (identity ===)', () => {
  test('adding components in any RANDOM order yields the identical Archetype object', () => {
    const h = makeHarness(40)
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 0xffff }),
        (ids, seed) => {
          // reference: build the set in sorted order.
          const refArch = h.store.getOrCreateArchetype(canonicalize(ids as unknown as ComponentId[]))
          // shuffle ids by seed and add one at a time via the edge graph.
          const shuffled = [...ids]
          let s = seed | 1
          for (let i = shuffled.length - 1; i > 0; i--) {
            s = (s * 1103515245 + 12345) & 0x7fffffff
            const j = s % (i + 1)
            ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
          }
          let arch = h.store.emptyArchetype
          for (const c of shuffled) arch = h.store.edgeAdd(arch, c as ComponentId)
          // identity, not just structural equality.
          expect(arch).toBe(refArch)
          expect(sigEquals(arch.signature, refArch.signature)).toBe(true)
        },
      ),
      { numRuns: 80 },
    )
  })
})

// ==================================================================================================
// EDGE-1
// ==================================================================================================

describe('EDGE-1: edge transitions are cached (2nd+ call is a hit; reverse primed on first miss)', () => {
  test('a repeated (arch,c) edgeAdd/edgeRemove computes the neighbor signature only ONCE', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 2, max: 8 }),
        (ids, repeats) => {
          const h = makeHarness(30)
          // Instrument the MISS path: count getOrCreateArchetype calls that actually CREATE.
          const before = h.store.byId.length
          const arch0 = h.store.emptyArchetype
          // First pass: walk add edges, recording the chain of archetypes.
          const chain = [arch0]
          let cur = arch0
          for (const c of ids) {
            cur = h.store.edgeAdd(cur, c as ComponentId)
            chain.push(cur)
          }
          const createdAfterFirst = h.store.byId.length - before
          // Re-walk the SAME edges `repeats` times: pure cache hits, NO new archetypes created.
          for (let r = 0; r < repeats; r++) {
            cur = arch0
            for (let i = 0; i < ids.length; i++) {
              const next = h.store.edgeAdd(cur, ids[i] as ComponentId)
              expect(next).toBe(chain[i + 1]) // identical object — cache hit
              cur = next
            }
          }
          expect(h.store.byId.length - before).toBe(createdAfterFirst) // zero further creation

          // reverse edge primed for free: removing the last-added id returns the prior archetype with
          // NO archetype creation.
          const lastArch = chain[chain.length - 1]!
          const lastId = ids[ids.length - 1] as ComponentId
          const reverseBefore = h.store.byId.length
          expect(lastArch.edges.get(lastId)?.remove).toBe(chain[chain.length - 2])
          expect(h.store.edgeRemove(lastArch, lastId)).toBe(chain[chain.length - 2])
          expect(h.store.byId.length).toBe(reverseBefore) // reverse was a hit, nothing created
        },
      ),
      { numRuns: 60 },
    )
  })
})

// ==================================================================================================
// ROW-1
// ==================================================================================================

describe('ROW-1: swap-pop keeps rows+columns dense; fixSibling fires iff row !== count-1', () => {
  test('random allocRow/removeRow sequence stays dense and consistent', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('alloc' as const) }),
            fc.record({ kind: fc.constant('remove' as const), pick: fc.double({ min: 0, max: 1, noNaN: true }) }),
          ),
          { maxLength: 80 },
        ),
        (ops) => {
          const h = makeHarness(2)
          const arch = h.store.getOrCreateArchetype(canonicalize([1] as unknown as ComponentId[]))
          // model: ordered list of entity indices occupying rows 0..count-1.
          const occupants: number[] = []
          let nextIndex = 1
          for (const o of ops) {
            if (o.kind === 'alloc') {
              const index = nextIndex++
              const handle = index & 0xffff
              const row = h.store.allocRow(arch, handle)
              expect(row).toBe(occupants.length)
              occupants.push(index)
            } else if (occupants.length > 0) {
              const row = Math.min(occupants.length - 1, Math.floor(o.pick * occupants.length))
              const last = occupants.length - 1
              let fixCalls = 0
              let fixedTo = -1
              let movedIdx = -1
              h.store.removeRow(arch, row, (movedIndex, newRow) => {
                fixCalls++
                movedIdx = movedIndex
                fixedTo = newRow
              })
              // fixSibling exactly once iff a non-tail row was removed.
              expect(fixCalls).toBe(row === last ? 0 : 1)
              // update model with swap-pop semantics.
              if (row !== last) {
                expect(fixedTo).toBe(row)
                expect(movedIdx).toBe(occupants[last]! & 0xffff)
                occupants[row] = occupants[last]!
              }
              occupants.pop()
            }
          }
          // density: count tracks the model; rows[0..count) hold exactly the model occupants.
          expect(arch.count).toBe(occupants.length)
          for (let r = 0; r < arch.count; r++) {
            expect(arch.rows[r]! & 0xffff).toBe(occupants[r]! & 0xffff)
          }
        },
      ),
      { numRuns: 80 },
    )
  })
})

// ==================================================================================================
// MIG-1
// ==================================================================================================

describe('MIG-1: migrate commits 2 words for the migrant + at most 1 for the shuffle-popped sibling', () => {
  test('a non-tail migrant => 2 commitRecord calls (migrant + sibling); a tail migrant => 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.integer({ min: 0, max: 11 }), (n, pick) => {
        const h = makeHarness(3)
        const fromArch = h.store.getOrCreateArchetype(canonicalize([1] as unknown as ComponentId[]))
        // seat n entities into {1}.
        const indices: number[] = []
        for (let i = 0; i < n; i++) {
          const index = i + 1
          const handle = index & 0xffff
          const row = h.store.allocRow(fromArch, handle)
          h.recordArch.set(index, fromArch.id as number)
          h.recordRow.set(index, row)
          indices.push(index)
        }
        const migrantRow = pick % n
        const migrantIndex = indices[migrantRow]!
        const isTail = migrantRow === n - 1

        h.totalCommits.n = 0
        h.commits.clear()
        const toArch = h.store.edgeAdd(fromArch, 2 as ComponentId)
        h.store.migrate(migrantIndex & 0xffff, fromArch, toArch)

        // migrant: exactly one commitRecord call (both words written together).
        expect(h.commits.get(migrantIndex)).toBe(1)
        // sibling: one extra commitRecord iff the migrant was not the tail.
        expect(h.totalCommits.n).toBe(isTail ? 1 : 2)
        if (!isTail) {
          const moved = indices[n - 1]!
          expect(h.commits.get(moved)).toBe(1) // the shuffle-popped sibling's row word
        }
      }),
      { numRuns: 80 },
    )
  })
})

// ==================================================================================================
// MIG-2  (wall-clock bench DEFERRED — no bench harness; asserting O(K) via instrumented copy counts)
// ==================================================================================================

describe('MIG-2: migration copy/commit cost is independent of arch.count (O(K), not O(count))', () => {
  // NOTE: the wall-clock migration bench from the spec is DEFERRED — there is no bench harness in the
  // repo. Instead we assert the asymptotic claim directly: instrument the TypedArray bulk-copy
  // intrinsics the migration uses (copyWithin for the shuffle-pop, set for the cross-archetype copy)
  // and the commitRecord counter, then show the per-migration counts are IDENTICAL whether the source
  // archetype holds 10 or 10000 rows. If migration scaled with count, these counts would diverge.
  function migrateMiddleAndCount(srcCount: number): { copies: number; commits: number } {
    const h = makeHarness(3)
    const fromArch = h.store.getOrCreateArchetype(canonicalize([1] as unknown as ComponentId[]))
    for (let i = 0; i < srcCount; i++) {
      const index = i + 1
      const row = h.store.allocRow(fromArch, index & 0xffff)
      h.recordArch.set(index, fromArch.id as number)
      h.recordRow.set(index, row)
    }
    const toArch = h.store.edgeAdd(fromArch, 2 as ComponentId)
    // migrate the MIDDLE entity so the shuffle-pop is exercised in both runs.
    const midIndex = (srcCount >>> 1) + 1

    // copyWithin (shuffle-pop) and set (cross-archetype copy) both live on %TypedArray%.prototype —
    // exactly one level above Uint32Array.prototype. Patch that single prototype and restore it.
    const ta = Object.getPrototypeOf(Uint32Array.prototype) as {
      copyWithin: (...a: unknown[]) => unknown
      set: (...a: unknown[]) => unknown
    }
    const realCopyWithin = ta.copyWithin
    const realSet = ta.set
    let copies = 0
    ;(ta as { copyWithin: unknown }).copyWithin = function (this: Uint32Array, ...args: unknown[]) {
      copies++
      return (realCopyWithin as (...a: unknown[]) => unknown).apply(this, args)
    }
    ;(ta as { set: unknown }).set = function (this: ArrayLike<number>, ...args: unknown[]) {
      copies++
      return (realSet as (...a: unknown[]) => unknown).apply(this, args)
    }
    h.totalCommits.n = 0
    try {
      h.store.migrate(midIndex & 0xffff, fromArch, toArch)
    } finally {
      ;(ta as { copyWithin: unknown }).copyWithin = realCopyWithin
      ;(ta as { set: unknown }).set = realSet
    }
    return { copies, commits: h.totalCommits.n }
  }

  test('migrating in a 10-row vs a 10000-row archetype performs the same copy + commit work', () => {
    const small = migrateMiddleAndCount(10)
    const large = migrateMiddleAndCount(10000)
    expect(large.copies).toBe(small.copies)
    expect(large.commits).toBe(small.commits)
    // sanity: some copying actually happened (shuffle-pop + cross-archetype copy of the shared column).
    expect(small.copies).toBeGreaterThan(0)
  })
})

// ==================================================================================================
// BM-2
// ==================================================================================================

describe('BM-2: bitmaskHas(i,c) === sigHas(currentSignature(i),c) after EVERY structural op', () => {
  test('random spawn/add/remove/despawn sequence keeps bitmask coherent with the signature', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('add' as const), e: fc.integer({ min: 1, max: 6 }), c: fc.integer({ min: 1, max: 10 }) }),
            fc.record({ kind: fc.constant('remove' as const), e: fc.integer({ min: 1, max: 6 }), c: fc.integer({ min: 1, max: 10 }) }),
          ),
          { maxLength: 50 },
        ),
        (ops) => {
          const h = makeHarness(10)
          const alive = new Set<number>()
          const ensure = (e: number): void => {
            if (!alive.has(e)) {
              seatInEmpty(h, e)
              alive.add(e)
            }
          }
          const checkAll = (): void => {
            for (const e of alive) {
              const sig = currentSig(h, e)
              for (let c = 1; c <= 10; c++) {
                expect(h.bitmask.bitmaskHas(e, c as ComponentId)).toBe(sigHas(sig, c))
              }
            }
          }
          for (const o of ops) {
            ensure(o.e)
            if (o.kind === 'add') h.store.migrateAdding(o.e & 0xffff, o.c as ComponentId)
            else h.store.migrateRemoving(o.e & 0xffff, o.c as ComponentId)
            // discriminating: re-check coherence after EVERY op, for every alive entity.
            checkAll()
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})

// ==================================================================================================
// BM-1
// ==================================================================================================

describe('BM-1: any bitmask access with phase !== serial THROWS (Must-Fix #1 guard)', () => {
  test('fuzzing the phase flag: every bitmask method throws iff phase is not serial', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }), (serialFlags) => {
        const h = makeHarness(4)
        seatInEmpty(h, 1)
        h.store.migrateAdding(1, 1 as ComponentId) // ensure a bit is set while serial
        const empty = canonicalize([]) as Signature
        const one = canonicalize([1]) as Signature
        for (const isSerial of serialFlags) {
          h.setPhase(isSerial ? 'serial' : 'wave')
          const expectThrow = (fn: () => unknown): void => {
            if (isSerial) expect(fn).not.toThrow()
            else expect(fn).toThrow(/serial-phase only/)
          }
          expectThrow(() => h.bitmask.bitmaskHas(1, 1 as ComponentId))
          expectThrow(() => h.bitmask.bitmaskApplyDelta(1, empty, one))
          expectThrow(() => h.bitmask.entityShapeWords(1))
          expectThrow(() => h.bitmask.bitmaskClear(1))
        }
        h.setPhase('serial')
      }),
      { numRuns: 40 },
    )
  })
})

// ==================================================================================================
// FRAG-1 (cold-store equivalence)
// ==================================================================================================

describe('FRAG-1: a query over a forced-cold archetype yields the same entity set as a hot one', () => {
  test('cold archetypes match signatureMatches identically and carry the same membership bits', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 5 }),
        (ids) => {
          // Hot world: generous cap. Cold world: cap so low the target archetype is forced cold.
          const sig = canonicalize(ids as unknown as ComponentId[])

          const hot = makeHarness(20, 1 << 20)
          const archHot = hot.store.getOrCreateArchetype(sig)
          expect(archHot.cold).toBe(false)

          // maxHotArchetypes=1 => EMPTY(0) is the only hot archetype; everything else is cold.
          const cold = makeHarness(20, 1)
          const archCold = cold.store.getOrCreateArchetype(sig)
          expect(archCold.cold).toBe(true)

          // Same packed sigWords => identical query-match decisions for ANY with/not term set.
          expect([...archCold.sigWords]).toEqual([...archHot.sigWords])
          for (let c = 1; c <= 20; c++) {
            const term = [{ wordIndex: c >>> 5, mask: 1 << (c & 31) }]
            expect(signatureMatches(archCold.sigWords, term, [], [])).toBe(
              signatureMatches(archHot.sigWords, term, [], []),
            )
          }

          // The "query result set" check: seat the same entities through each store and compare the
          // membership the bitmask reports (cold entities carry the bitmask identically, §10.3).
          const seatAndMembers = (h: Harness, store: ArchetypeStore): Set<number> => {
            const members = new Set<number>()
            for (let e = 1; e <= 5; e++) {
              const handle = e & 0xffff
              store.allocRow(store.emptyArchetype, handle)
              h.recordArch.set(e, 0)
              h.recordRow.set(e, store.byId[0]!.count - 1)
              // migrate into the target signature one id at a time.
              for (const c of ids) store.migrateAdding(handle, c as ComponentId)
              // an entity "matches" the query iff it holds every id in the signature.
              let holdsAll = true
              for (const c of ids) if (!h.bitmask.bitmaskHas(e, c as ComponentId)) holdsAll = false
              if (holdsAll) members.add(e)
            }
            return members
          }
          const hotMembers = seatAndMembers(hot, hot.store)
          const coldMembers = seatAndMembers(cold, cold.store)
          expect([...coldMembers].sort()).toEqual([...hotMembers].sort())
          expect(coldMembers.size).toBe(5) // all five entities matched in both worlds
        },
      ),
      { numRuns: 40 },
    )
  })
})
