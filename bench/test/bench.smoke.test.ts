// Bench self-check: the macro-bench harness compiles + runs end-to-end at tiny sizes so CI proves the
// cross-library comparison wiring works (ecsia/miniplex/bitECS builders, the relation walk, and the
// parallel serial-vs-threaded measurement) WITHOUT paying the full measurement cost. The real numbers
// come from `pnpm bench:macro` on demand.

import { describe, expect, test } from 'vitest'
import { makeEcsiaIter, makeMiniplexIter, makeBitEcsIter } from '../iterate.js'
import { makeEcsiaRelations } from '../relations.js'
import { main as runBench } from '../run.js'

describe('bench builders advance state', () => {
  test('each iterate builder integrates Position from Velocity', () => {
    for (const make of [makeEcsiaIter, makeMiniplexIter, makeBitEcsIter]) {
      const c = make(1000)
      const before = c.sampleX()
      for (let i = 0; i < 10; i++) c.step()
      expect(c.sampleX()).toBeGreaterThan(before)
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
      expect(report.iterate.map((r) => r.name)).toEqual(['ecsia', 'miniplex', 'bitECS'])
      for (const r of report.iterate) expect(r.meanMs).toBeGreaterThanOrEqual(0)
      expect(report.relations[0]!.name).toBe('ecsia-relations')
      expect(report.parallel.serialMs).toBeGreaterThan(0)
      expect(report.parallel.threadedMs).toBeGreaterThan(0)
      expect(Number.isFinite(report.parallel.speedup)).toBe(true)
    },
    macro ? 120_000 : 30_000,
  )
})
