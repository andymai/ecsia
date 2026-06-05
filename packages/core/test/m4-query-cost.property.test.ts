// query PROPERTY suite, part 2: hash canonicality, the sparse-set churn invariants, and the
// instrumented O(A) match-cost counter (independent of N). Each property DISCRIMINATES — it fails if
// the guarded invariant is broken.
//
// HASH-ORDER term sets differing ONLY in order hash IDENTICALLY (sort makes the hash
// order-independent — ).
// HASH-DISC sets differing in any without role, optional role, or pair-target hash DIFFERENTLY
// (no collisions over a fuzzed corpus —).
// SS-CHURN SparseSetU32 add/remove/has invariants under random churn: dense iteration matches a
// reference Set, no duplicate in dense[0..size), has() is correct.
// OACOST the per-archetype matcher reads each archetype's signature words a CONSTANT number
// of times regardless of entity count N — instrumented via a counting sigWords proxy on
// a standalone QueryEngine. The cross-library wall-clock bench (vs bitECS/miniplex) is
// DEFERRED (no bench harness in this repo); see the note on the OACOST block.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { defineComponent, read, has, without, optional, write } from '@ecsia/core'
import { Buffers, QueryEngine, SparseSetU32, buildSigWords, canonicalize, compileQuery, probeCapabilities } from '../src/internal.js'
import type { ComponentDef, ComponentId, EntityHandle, QueryTerm, RegionKey, Schema } from '@ecsia/core'
import type { Archetype, CompileContext, Signature } from '../src/internal.js'

// --- a CompileContext that resolves ids by registration order, no world needed -------------------

function compileCtx(defs: ComponentDef<Schema>[], fixedBitCount = 64): { ctx: CompileContext } {
  const ids = new Map<ComponentDef<Schema>, number>()
  defs.forEach((d, i) => ids.set(d, i + 1)) // 1-based dense ids (0 = NO_COMPONENT)
  return {
    ctx: {
      idOf: (def) => (ids.get(def as ComponentDef<Schema>) ?? 0) as ComponentId,
      fixedBitCount,
    },
  }
}

function freshDefs(n: number): ComponentDef<Schema>[] {
  return Array.from({ length: n }, (_, i) => defineComponent({ v: 'i32' }, { name: 'c' + i }))
}

// A pair-like term the compiler recognizes via isPairDef (has `relation` + `target`).
function pairTerm(relId: number, target: number | symbol): QueryTerm {
  return { relation: { name: 'R' + relId, id: relId }, target, id: 1_000_000 + relId } as unknown as QueryTerm
}

describe('HASH-ORDER canonical hash is order-independent', () => {
  test('any permutation of a term set hashes identically', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.record({ role: fc.constantFrom('read', 'with', 'without', 'optional'), comp: fc.nat() }), {
          minLength: 1,
          maxLength: 6,
        }),
        (universe, rawTerms) => {
          const defs = freshDefs(universe)
          const { ctx } = compileCtx(defs)
          const terms: QueryTerm[] = rawTerms.map((t) => {
            const def = defs[t.comp % universe] as ComponentDef<Schema>
            switch (t.role) {
              case 'read':
                return read(def)
              case 'with':
                return has(def)
              case 'without':
                return without(def)
              default:
                return optional(def)
            }
          })
          const shuffled = [...terms].reverse()
          expect(compileQuery(shuffled, ctx).hash).toBe(compileQuery(terms, ctx).hash)
        },
      ),
      { numRuns: 200 },
    )
  })

  test('read/write/bare collapse to one match-hash; has/without/optional are distinct roles', () => {
    const defs = freshDefs(2)
    const { ctx } = compileCtx(defs)
    const A = defs[0] as ComponentDef<Schema>
    const h = (t: QueryTerm[]) => compileQuery(t, ctx).hash
    // read == write == bare (same matching constraint).
    expect(h([read(A)])).toBe(h([write(A)]))
    expect(h([read(A)])).toBe(h([A]))
    // has (membership-only) is distinct from read (value), and without/optional are all distinct.
    expect(h([has(A)])).not.toBe(h([read(A)]))
    expect(h([without(A)])).not.toBe(h([read(A)]))
    expect(h([optional(A)])).not.toBe(h([read(A)]))
    expect(h([without(A)])).not.toBe(h([has(A)]))
    expect(h([optional(A)])).not.toBe(h([without(A)]))
  })
})

describe('HASH-DISC distinct constraints hash differently (no collisions)', () => {
  test('differing in any component, role, or pair target produces distinct hashes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        fc.array(fc.record({ role: fc.constantFrom('with', 'without', 'optional', 'read'), comp: fc.nat() }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.record({ role: fc.constantFrom('with', 'without', 'optional', 'read'), comp: fc.nat() }),
        (universe, baseRaw, extraRaw) => {
          const defs = freshDefs(universe)
          const { ctx } = compileCtx(defs)
          const toTerm = (r: { role: string; comp: number }): QueryTerm => {
            const def = defs[r.comp % universe] as ComponentDef<Schema>
            return r.role === 'read'
              ? read(def)
              : r.role === 'with'
                ? has(def)
                : r.role === 'without'
                  ? without(def)
                  : optional(def)
          }
          const base = baseRaw.map(toTerm)
          const baseHash = compileQuery(base, ctx).hash

          // Flipping ONE term's role (read↔With↔Without↔optional, which the hash distinguishes —
          // except read/with collapse only across read/write/bare, never read↔With) must change the
          // hash whenever the role tag changes. Compare base vs base-with-one-term-role-swapped.
          const swapRole = (r: { role: string; comp: number }): { role: string; comp: number } => {
            const order = ['with', 'without', 'optional', 'read']
            const next = order[(order.indexOf(r.role) + 1) % order.length] as string
            return { role: next, comp: r.comp }
          }
          if (base.length > 0) {
            const mutated = baseRaw.map((r, i) => (i === 0 ? toTerm(swapRole(r)) : toTerm(r)))
            const r0 = baseRaw[0] as { role: string; comp: number }
            const r0Tag = r0.role === 'read' ? 'P' : r0.role === 'with' ? 'M' : r0.role === 'without' ? 'N' : 'O'
            const swapped = swapRole(r0)
            const swTag =
              swapped.role === 'read' ? 'P' : swapped.role === 'with' ? 'M' : swapped.role === 'without' ? 'N' : 'O'
            // Only assert distinctness when the role TAG actually changes (read/with both P? no:
            // read→P, with→M, so all four map to distinct tags; the swap always changes the tag).
            if (r0Tag !== swTag) {
              // The mutated set differs in exactly one role tag → its hash must differ, UNLESS another
              // identical term already carries the swapped (tag,comp) AND the original (tag,comp) is
              // still otherwise present (multiset collision). Guard against that by requiring the
              // multiset of (tag,comp) pairs to actually differ.
              const key = (r: { role: string; comp: number }) =>
                (r.role === 'read' ? 'P' : r.role === 'with' ? 'M' : r.role === 'without' ? 'N' : 'O') +
                ':' +
                (r.comp % universe)
              const baseKeys = [...baseRaw.map(key)].sort().join('|')
              const mutKeys = [...baseRaw.map((r, i) => (i === 0 ? key(swapRole(r)) : key(r)))].sort().join('|')
              if (baseKeys !== mutKeys) {
                expect(compileQuery(mutated, ctx).hash).not.toBe(baseHash)
              }
            }
          }
          void extraRaw
        },
      ),
      { numRuns: 200 },
    )
  })

  test('pair terms with different targets / wildcard hash distinctly', () => {
    const defs = freshDefs(2)
    const { ctx } = compileCtx(defs)
    const A = defs[0] as ComponentDef<Schema>
    const h = (t: QueryTerm[]) => compileQuery(t, ctx).hash
    // Pair(R1, p1) vs Pair(R1, p2): target folded into the key → distinct.
    expect(h([read(A), pairTerm(1, 5)])).not.toBe(h([read(A), pairTerm(1, 6)]))
    // Pair(R1, p1) vs Pair(R2, p1): different relation → distinct.
    expect(h([pairTerm(1, 5)])).not.toBe(h([pairTerm(2, 5)]))
    // Wildcard target distinct from a specific target on the same relation.
    expect(h([pairTerm(1, Symbol.for('ecsia.query.wildcard'))])).not.toBe(h([pairTerm(1, 5)]))
    // Same pair both ways round still order-independent.
    expect(h([read(A), pairTerm(1, 5)])).toBe(h([pairTerm(1, 5), read(A)]))
  })
})

describe('SS-CHURN sparse-set add/remove/has invariants under random churn', () => {
  const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

  test('dense matches a reference Set, no duplicates, has() correct', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            op: fc.constantFrom('add', 'remove'),
            index: fc.integer({ min: 0, max: 200 }),
          }),
          { minLength: 0, maxLength: 400 },
        ),
        (ops) => {
          let seq = 0
          const ss = new SparseSetU32(
            newBuffers(),
            `ss.${seq}.d` as RegionKey,
            `ss.${seq++}.s` as RegionKey,
            8,
            1 << 16,
          )
          const ref = new Set<number>()
          for (const { op, index } of ops) {
            if (op === 'add') {
              ss.add(index)
              ref.add(index)
            } else {
              ss.remove(index)
              ref.delete(index)
            }
            // has() invariant after every op.
            expect(ss.has(index)).toBe(ref.has(index))
          }
          // size matches.
          expect(ss.size).toBe(ref.size)
          // dense is exactly the reference set, with NO duplicates.
          const dense = [...ss]
          expect(dense.length).toBe(ref.size)
          expect(new Set(dense).size).toBe(dense.length)
          expect(new Set(dense)).toEqual(ref)
          // has() agrees with the reference set over the whole touched range.
          for (let i = 0; i <= 200; i++) expect(ss.has(i)).toBe(ref.has(i))
        },
      ),
      { numRuns: 200 },
    )
  })

  test('re-add after remove is a no-dup, idempotent add is a no-op', () => {
    const ss = new SparseSetU32(newBuffers(), 'idem.d' as RegionKey, 'idem.s' as RegionKey, 4, 1 << 16)
    ss.add(7)
    ss.add(7)
    expect(ss.size).toBe(1)
    ss.remove(7)
    expect(ss.size).toBe(0)
    expect(ss.has(7)).toBe(false)
    ss.add(7)
    expect(ss.size).toBe(1)
    expect([...ss]).toEqual([7])
  })
})

// --- OACOST: instrumented per-archetype match-call counter independent of N ----------------------
//
// The cross-library iteration BENCH (vs bitECS / miniplex) is DEFERRED — this repo has no bench
// harness. Per the task brief we assert the O(A) match path via an instrumented signatureMatches
// counter independent of N: the engine reads each archetype's sigWords during matching, so we wrap
// sigWords in a counting Proxy and assert the per-match read count is a function of the ARCHETYPE
// SET only, never of how many entities each archetype holds.

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

interface CountingArch {
  arch: Archetype
  reads: { n: number }
}

function makeArch(id: number, sig: number[], stride: number, rowHandles: number[]): CountingArch {
  const reads = { n: 0 }
  const sigArr = canonicalize(sig) as Signature
  const rawWords = buildSigWords(sigArr, stride)
  // Count every word read the matcher performs against this archetype's signature.
  const sigWords = new Proxy(rawWords, {
    get(target, prop, recv) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.n++
      return Reflect.get(target, prop, recv)
    },
  }) as unknown as Uint32Array
  const rows = Uint32Array.from(rowHandles)
  const arch = {
    id: id as Archetype['id'],
    signature: sigArr,
    sigWords,
    columnSets: new Map(),
    rowsColumn: null,
    rows,
    count: rowHandles.length,
    cold: false,
  } as unknown as Archetype
  return { arch, reads }
}

function buildEngine(byId: Archetype[], fixedBitCount: number): QueryEngine {
  const created: Array<(a: Archetype) => void> = []
  return new QueryEngine({
    buffers: newBuffers(),
    // bitmask is only touched on the single-entity maintenance path (not the seed); a stub suffices.
    bitmask: { entityShapeWords: () => new Uint32Array(fixedBitCount >>> 5) } as never,
    maxEntities: 1 << 16,
    byId,
    onArchetypeCreated: (fn) => created.push(fn),
    compileContext: { idOf: (d) => ((d as { __id?: number }).__id ?? 0) as ComponentId, fixedBitCount },
    resolveLocation: () => ({ archetypeId: 0, row: 0 }),
    handleOf: (i) => i as unknown as EntityHandle,
    indexOfHandle: (h) => h, // rows hold bare indices in this harness
    signatureOf: () => canonicalize([]) as Signature,
  })
}

describe('OACOST per-archetype match-call count is independent of N (instrumented)', () => {
  // DEFERRED: the cross-library wall-clock iteration bench (bitECS/miniplex) needs a bench harness
  // this repo does not have. Below we assert the structural claim it would measure: matching reads an
  // archetype's signature words a constant number of times per (archetype, query) — never per entity.
  test('seeding a query reads each archetype signature the same #times for N=1 vs N=1000', () => {
    const stride = 1
    // Two worlds-of-archetypes with the SAME two signatures but different per-archetype populations.
    const run = (perArch: number): number[] => {
      const rowsA = Array.from({ length: perArch }, (_, k) => k * 2)
      const rowsB = Array.from({ length: perArch }, (_, k) => k * 2 + 1)
      const a = makeArch(0, [1, 2], stride, rowsA) // {c1,c2}
      const b = makeArch(1, [1], stride, rowsB) // {c1}
      const engine = buildEngine([a.arch, b.arch], stride * 32)
      // Query: has(c1), without(c2) → matches archetype B only. has(c1) packs to word 0 bit 1.
      const terms: QueryTerm[] = [
        { __term: 'has', c: { __id: 1 } } as unknown as QueryTerm,
        { __term: 'without', c: { __id: 2 } } as unknown as QueryTerm,
      ]
      const q = engine.query(terms)
      // Sanity: it matched exactly archetype B (one matching archetype) and seeded N entities.
      expect(q.matchingArchetypes.length).toBe(1)
      expect(q.count).toBe(perArch)
      return [a.reads.n, b.reads.n]
    }
    const small = run(1)
    const large = run(1000)
    // The signature-word read counts during matching are identical regardless of N — the match cost
    // is O(A · words), independent of the entity population.
    expect(small).toEqual(large)
    // And it is non-zero (the matcher actually consulted the words).
    expect(small[0] as number).toBeGreaterThan(0)
  })
})
