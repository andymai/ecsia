// M6 scheduler PROPERTY suite (fast-check). Every property is written to DISCRIMINATE — it would
// fail if the invariant it guards were broken — and each is checked against an INDEPENDENT oracle,
// never against the implementation's own helpers.
//
//   DET-1   Determinism: a random DAG of systems with random {read,write} sets yields a REPEATABLE
//           plan (wave/round/batch layout byte-stable) across independent builds.
//   TOPO-1  Topological soundness: the executed wave order is a valid topological order of the
//           REDUCED DAG — no system runs before one it write-before-reads (oracle: recompute the
//           must-precede relation from the raw access sets and assert wave levels respect it).
//   CONF-1  Conflict correctness: two systems in the SAME round have disjoint write-sets AND neither
//           reads the other's writes — checked against an INDEPENDENT set-based conflict oracle.
//   CYC-1   Cycle detection soundness: any injected back-edge cycle is detected (no false negatives).
//   CYC-2   Cycle detection completeness: a purely-forward explicit-edge graph is NEVER reported
//           cyclic (no false positives), and neither is any access-only graph.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, Schema } from '@ecsia/core'
import {
  CycleError,
  aggregateAccess,
  buildDAG,
  buildEdges,
  buildPlan,
  defineSystem,
  lowerSystems,
  resolveOrdering,
} from '@ecsia/scheduler'
import type { ScheduleWave, SystemDef } from '@ecsia/scheduler'

// ---- shared component pool -----------------------------------------------------------------------
// A ComponentDef interns per world, so a property mints a FRESH pool + world on every fast-check run.
const COMP_COUNT = 5
function freshPool(): ComponentDef<Schema>[] {
  const comps = Array.from({ length: COMP_COUNT }, (_, i) =>
    defineComponent({ v: 'f32' }, { name: `c${i}` }),
  )
  createWorld({ components: comps }) // registers ids on the defs
  return comps
}

// A generated system: which component indices it reads / writes.
interface SysSpec {
  readonly read: readonly number[]
  readonly write: readonly number[]
}

const idxSet = fc.uniqueArray(fc.integer({ min: 0, max: COMP_COUNT - 1 }), { maxLength: COMP_COUNT })
const sysSpec: fc.Arbitrary<SysSpec> = fc.record({ read: idxSet, write: idxSet })
const sysSpecs = fc.array(sysSpec, { minLength: 1, maxLength: 8 })

function buildDefs(specs: readonly SysSpec[], comps: readonly ComponentDef<Schema>[]): SystemDef[] {
  return specs.map((s, i) =>
    defineSystem({
      name: `S${i}`,
      read: s.read.map((c) => comps[c]!),
      write: s.write.map((c) => comps[c]!),
      run() {},
    }),
  )
}

function planFor(specs: readonly SysSpec[], comps: readonly ComponentDef<Schema>[], stride = 1, workers = 0) {
  const defs = buildDefs(specs, comps)
  const boxes = resolveOrdering(lowerSystems(defs, stride), defs)
  const dag = buildDAG(boxes, buildEdges(boxes, defs, aggregateAccess(boxes)))
  return { plan: buildPlan(boxes, dag, stride, workers), dag }
}

function waveLevelOf(waves: readonly ScheduleWave[]): Map<number, number> {
  const level = new Map<number, number>()
  waves.forEach((w, i) => {
    for (const b of w.rounds.flat()) level.set(b.systemId as unknown as number, i)
  })
  return level
}

// ---- independent ORACLE: do two specs conflict at type granularity? ------------------------------
// Disjoint iff write∩write = ∅ AND write∩otherRead = ∅ AND read∩otherWrite = ∅. Pure read∩read OK.
function specsConflict(a: SysSpec, b: SysSpec): boolean {
  const aw = new Set(a.write)
  const bw = new Set(b.write)
  const ar = new Set(a.read)
  const br = new Set(b.read)
  for (const c of aw) if (bw.has(c) || br.has(c)) return true
  for (const c of bw) if (ar.has(c)) return true
  return false
}

describe('DET-1 — deterministic, repeatable plan across independent builds (§5.5)', () => {
  test('two independent builds of the same systems produce the identical wave/round/batch layout', () => {
    fc.assert(
      fc.property(sysSpecs, (specs) => {
        const comps = freshPool()
        const a = planFor(specs, comps)
        const b = planFor(specs, comps)
        const serialize = (waves: readonly ScheduleWave[]) =>
          waves.map((w) => w.rounds.map((r) => r.map((x) => [x.systemId as unknown as number, x.workerIndex])))
        expect(serialize(a.plan.waves)).toEqual(serialize(b.plan.waves))
      }),
      { numRuns: 250 },
    )
  })

  test('repeatability holds with workers > 0 (worker-index assignment is plan-order deterministic)', () => {
    fc.assert(
      fc.property(sysSpecs, fc.integer({ min: 1, max: 4 }), (specs, workers) => {
        const comps = freshPool()
        const a = planFor(specs, comps, 1, workers)
        const b = planFor(specs, comps, 1, workers)
        const serialize = (waves: readonly ScheduleWave[]) =>
          waves.map((w) => [
            w.rounds.map((r) => r.map((x) => [x.systemId as unknown as number, x.workerIndex])),
            [...w.perWorkerSpawnHint],
          ])
        expect(serialize(a.plan.waves)).toEqual(serialize(b.plan.waves))
      }),
      { numRuns: 200 },
    )
  })
})

describe('TOPO-1 — wave levels are a valid topological order of the reduced DAG (SCH-1)', () => {
  test('no system runs before one it conflict-precedes; every edge crosses to a strictly later wave', () => {
    fc.assert(
      fc.property(sysSpecs, (specs) => {
        const comps = freshPool()
        const { plan, dag } = planFor(specs, comps)
        const level = waveLevelOf(plan.waves)

        // (a) every system placed exactly once.
        expect(level.size).toBe(specs.length)

        // (b) every reduced-DAG edge goes earlier→strictly-later wave.
        for (let u = 0; u < dag.n; u++) {
          for (const v of dag.succ[u]!) {
            expect(level.get(u)!).toBeLessThan(level.get(v as unknown as number)!)
          }
        }

        // (c) ORACLE: for every conflicting ordered pair (a<b by id), the implicit direction is
        //     a→b (registration order), so a's wave must be <= b's wave — never strictly after.
        for (let a = 0; a < specs.length; a++) {
          for (let b = a + 1; b < specs.length; b++) {
            if (specsConflict(specs[a]!, specs[b]!)) {
              expect(level.get(a)!).toBeLessThanOrEqual(level.get(b)!)
              // and they are never in the SAME round/wave concurrently (CONF-1 covers same-round,
              // but conflicting pairs must be different waves OR different rounds — assert different
              // wave here since the implicit edge forces a strict ordering).
              expect(level.get(a)!).toBeLessThan(level.get(b)!)
            }
          }
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('CONF-1 — same-round pairs are disjoint per the independent oracle (SCH-2)', () => {
  test('every pair of systems sharing a round has NO write/write and NO read/write conflict', () => {
    fc.assert(
      fc.property(sysSpecs, fc.integer({ min: 0, max: 4 }), (specs, workers) => {
        const comps = freshPool()
        const { plan } = planFor(specs, comps, 1, workers)
        for (const wave of plan.waves) {
          for (const round of wave.rounds) {
            for (let i = 0; i < round.length; i++) {
              for (let j = i + 1; j < round.length; j++) {
                const si = round[i]!.systemId as unknown as number
                const sj = round[j]!.systemId as unknown as number
                // Oracle over the ORIGINAL specs, independent of the implementation's bitmask test.
                expect(specsConflict(specs[si]!, specs[sj]!)).toBe(false)
              }
            }
          }
        }
      }),
      { numRuns: 300 },
    )
  })
})

// ---- cycle generators ----------------------------------------------------------------------------
// `resolveOrdering` binds before/after by DEF IDENTITY, so an edge reference must be the exact def
// object present in the final array. We therefore build defs in index order: a def may only `after`
// already-constructed lower-index defs (a backward dependency ⇒ a forward edge in run order). The
// last def closes the cycle with a `before:[firstDef]` back-edge (first already exists).

// A purely-forward explicit-edge graph: each system depends only on lower indices ⇒ acyclic.
const forwardEdges = (n: number) =>
  fc
    .array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), {
      maxLength: n * 2,
    })
    .map((pairs) => pairs.filter(([a, b]) => a < b)) // keep only low→high (a before b)

/** Build defs in index order; afterOf[i] lists lower indices i must run after (already constructed). */
function buildOrdered(n: number, afterOf: Map<number, number[]>, closeCycle: boolean): SystemDef[] {
  const defs: SystemDef[] = []
  for (let i = 0; i < n; i++) {
    const after = (afterOf.get(i) ?? []).map((a) => defs[a]!) // a < i ⇒ already built
    defs.push(defineSystem({ name: `S${i}`, after, run() {} }))
  }
  if (closeCycle && n >= 2) {
    // S(n-1) runs BEFORE S0 — a back-edge closing the forward chain into a loop. S0 already exists.
    defs[n - 1] = defineSystem({ ...defs[n - 1]!, before: [defs[0]!] })
  }
  return defs
}

describe('CYC-1 — every injected cycle is detected (no false negatives, SCH-9)', () => {
  test('a forced back-edge closing a forward chain always throws CycleError', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
        const comps = freshPool()
        void comps
        // Forward chain 0←1←...←(n-1): each i runs after i-1. Then close it: S(n-1) before S0.
        const afterOf = new Map<number, number[]>()
        for (let i = 1; i < n; i++) afterOf.set(i, [i - 1])
        const defs = buildOrdered(n, afterOf, true)
        const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
        const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
        expect(() => buildDAG(boxes, edges)).toThrow(CycleError)
      }),
      { numRuns: 100 },
    )
  })

  test('a spanning forward chain plus random extra edges, then a closing back-edge, is always cyclic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 7 }).chain((n) => fc.tuple(fc.constant(n), forwardEdges(n))),
        ([n, pairs]) => {
          const comps = freshPool()
          void comps
          // Always include the spanning chain i-1 → i so the back-edge S(n-1)→S0 closes a real cycle,
          // then layer the random forward edges on top (they cannot break acyclicity by themselves).
          const afterOf = new Map<number, number[]>()
          for (let i = 1; i < n; i++) afterOf.set(i, [i - 1])
          for (const [a, b] of pairs) {
            if (a === b - 1) continue // already in the spanning chain
            const arr = afterOf.get(b) ?? []
            arr.push(a)
            afterOf.set(b, arr)
          }
          const defs = buildOrdered(n, afterOf, true) // closeCycle ⇒ guaranteed at least one cycle
          const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
          const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
          expect(() => buildDAG(boxes, edges)).toThrow(CycleError)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('CYC-2 — acyclic graphs are never reported cyclic (no false positives)', () => {
  test('a purely-forward explicit-edge graph never throws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }).chain((n) => fc.tuple(fc.constant(n), forwardEdges(n))),
        ([n, pairs]) => {
          const comps = freshPool()
          void comps
          const afterOf = new Map<number, number[]>()
          for (const [a, b] of pairs) {
            const arr = afterOf.get(b) ?? []
            arr.push(a)
            afterOf.set(b, arr)
          }
          const defs = buildOrdered(n, afterOf, false)
          const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
          const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
          expect(() => buildDAG(boxes, edges)).not.toThrow()
        },
      ),
      { numRuns: 250 },
    )
  })

  test('any access-only graph (no explicit edges) is acyclic — implicit edges always go low→high id', () => {
    fc.assert(
      fc.property(sysSpecs, (specs) => {
        const comps = freshPool()
        // planFor would throw on a cycle; assert it never does for access-only systems.
        expect(() => planFor(specs, comps)).not.toThrow()
      }),
      { numRuns: 300 },
    )
  })
})
