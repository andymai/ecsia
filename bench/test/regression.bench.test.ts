// CI bench REGRESSION lane. Times each ecsia iteration path against a SAME-RUN bitECS control and
// asserts the ns/entity RATIO stays under a committed ceiling (bench/regression-baseline.json). The
// ratio cancels machine drift — a noisy shared runner moves both ecsia and bitECS together — so a
// failure means a genuine regression (e.g. codegen breaking and bindColumns deopting to ~1.5x), not
// scheduling noise. Gated behind BENCH_REGRESSION=1 so it runs ONLY in its dedicated CI job, never
// in the default `pnpm test` (where measurement noise would flake unit CI). Ratchet ceilings down in
// the baseline file when a path durably improves.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeEcsiaIter, makeEcsiaCursorIter, makeEcsiaPinnedIter, makeBitEcsIter } from '../iterate.js'
import type { IterCase } from '../iterate.js'

const ENABLED = process.env['BENCH_REGRESSION'] === '1'
const N = 50_000
const WARMUP = 300
const TIMED = 1500
const REPS = 3 // best-of-N rounds (each round rebuilds + re-warms) to shake off a single bad schedule

interface CtxIter extends IterCase {
  step(): void
}

/** p50 ns/entity over TIMED samples, taking the best (min) p50 across REPS rebuilds. */
function nsPerEntity(make: (n: number) => CtxIter): number {
  let best = Infinity
  for (let rep = 0; rep < REPS; rep++) {
    const c = make(N)
    for (let i = 0; i < WARMUP; i++) c.step()
    const s: number[] = []
    for (let r = 0; r < TIMED; r++) {
      const t0 = performance.now()
      c.step()
      s.push(performance.now() - t0)
    }
    s.sort((a, b) => a - b)
    const p50 = (s[s.length >> 1] as number) * 1e6 / N
    if (p50 < best) best = p50
  }
  return best
}

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../regression-baseline.json', import.meta.url)), 'utf8'),
) as { ratiosVsBitecs: Record<string, number> }

describe.skipIf(!ENABLED)('bench regression — ecsia/bitECS ns/entity ratios under ceiling', { timeout: 120_000 }, () => {
  // ONE bitECS control measured in the same process/run as the ecsia paths below.
  const bit = nsPerEntity(makeBitEcsIter)

  test.each([
    ['bindColumns', makeEcsiaPinnedIter as (n: number) => CtxIter],
    ['eachChunk', makeEcsiaCursorIter as (n: number) => CtxIter],
    ['each', makeEcsiaIter as (n: number) => CtxIter],
  ])('%s ratio vs bitECS stays under its ceiling', (name, make) => {
    const ns = nsPerEntity(make)
    const ratio = ns / bit
    const ceiling = baseline.ratiosVsBitecs[name] as number
    // Report the actual ratio in the assertion message so a CI failure shows the regression size.
    expect(ratio, `${name}: ${ns.toFixed(2)} ns/e = ${ratio.toFixed(3)}x bitECS (${bit.toFixed(2)} ns/e); ceiling ${ceiling}x`).toBeLessThanOrEqual(ceiling)
  })
})
