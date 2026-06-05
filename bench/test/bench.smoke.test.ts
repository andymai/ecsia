// Bench self-check: the macro-bench harness compiles + runs end-to-end at tiny sizes so CI proves the
// cross-library comparison wiring works (ecsia/miniplex/bitECS builders, the relation walk, and the
// parallel serial-vs-threaded measurement) WITHOUT paying the full measurement cost. The real numbers
// come from `pnpm bench:macro` on demand.

import { describe, expect, test } from 'vitest'
import { makeEcsiaIter, makeEcsiaCursorIter, makeMiniplexIter, makeBitEcsIter } from '../iterate.js'
import { makeEcsiaRelations } from '../relations.js'
import { main as runBench } from '../run.js'

describe('bench builders advance state', () => {
  test('each iterate builder integrates Position from Velocity', () => {
    for (const make of [makeEcsiaIter, makeEcsiaCursorIter, makeMiniplexIter, makeBitEcsIter]) {
      const c = make(1000)
      const before = c.sampleX()
      for (let i = 0; i < 10; i++) c.step()
      expect(c.sampleX()).toBeGreaterThan(before)
    }
  })

  // The cursor row is the showcased fast path; it must integrate the SAME data the accessor path does
  // ABOVE the 1024 column-growth boundary (the size the macro-bench actually runs). A fast-but-wrong
  // cursor would pass below 1024 and silently report a misleading number above it (the prior bug), so
  // this pins the cursor against the accessor at n>1024 across multiple steps.
  test('ecsia-cursor result equals the ecsia accessor result above the 1024 growth boundary', () => {
    for (const n of [1025, 5000]) {
      const accessor = makeEcsiaIter(n)
      const cursor = makeEcsiaCursorIter(n)
      for (let i = 0; i < 10; i++) {
        accessor.step()
        cursor.step()
        expect(cursor.sampleX()).toBeCloseTo(accessor.sampleX(), 9)
      }
      // Both start at x=0, dx=1, dt=1/60: after 10 steps x must be 10/60, NOT a halved/aliased value.
      expect(cursor.sampleX()).toBeCloseTo(10 / 60, 6)
    }
  })

  test('relation builder visits every subject through the wildcard walk', () => {
    const c = makeEcsiaRelations(500, 16)
    c.step()
    expect(c.visited()).toBe(500)
  })
})

describe('bench runner emits a report', () => {
  // BENCH_MACRO=1 (via `pnpm bench:macro`) runs the real consolidated macro-bench with full sizes +
  // console output; the default CI run uses tiny sizes + silent for a fast green gate.
  const macro = process.env['BENCH_MACRO'] === '1'
  const sizes = macro
    ? { entities: 50_000, relSubjects: 20_000, relTargets: 256, time: 200, parPerGroup: 2_000, parTicks: 60, silent: false }
    : { entities: 500, relSubjects: 400, relTargets: 16, time: 20, parPerGroup: 100, parTicks: 5, silent: true }

  test(
    'main() runs all three buckets and returns a structured report',
    async () => {
      const report = await runBench(sizes)
      expect(report.iterate.map((r) => r.name)).toEqual(['ecsia', 'ecsia-cursor', 'miniplex', 'bitECS'])
      for (const r of report.iterate) expect(r.meanMs).toBeGreaterThanOrEqual(0)
      expect(report.relations[0]!.name).toBe('ecsia-relations')
      expect(report.parallel.serialMs).toBeGreaterThan(0)
      expect(report.parallel.threadedMs).toBeGreaterThan(0)
      expect(Number.isFinite(report.parallel.speedup)).toBe(true)
    },
    macro ? 120_000 : 30_000,
  )
})
