// Fast, NON-FLAKY smoke for the REAL worker-pool speedup bench (bench/worker-pool/heavy-pool.ts).
// It stands up the genuine @ecsia/scheduler WorkerPool (node:worker_threads + Atomics) at tiny sizes and
// asserts the threaded run is byte-for-byte IDENTICAL to the single-thread executor over the SAME heavy
// workload — the correctness gate behind the speedup claim. Speedup MAGNITUDE is informational (measured
// by `pnpm bench:macro:pool`), never asserted here, so CI stays deterministic.
//
// Requires the BUILT scheduler dist (worker-entry + the worker can't load TS); `pnpm build` runs first in
// the suite. Worker counts are clamped to os.cpus().length inside main().

import { describe, expect, test } from 'vitest'
import { main } from '../worker-pool/heavy-pool.js'

describe('REAL worker-pool heavy bench reproduces the single-thread result on OS threads', () => {
  test(
    'threaded run at workers=1,2,4 is byte-identical to single-thread (serial-equivalence)',
    async () => {
      const report = await main({ perGroup: 40, frames: 2, workerCounts: [1, 2, 4], seed: 7, silent: true })

      expect(report.totalEntities).toBe(report.perGroup * report.groupCount)
      expect(report.serialMs).toBeGreaterThan(0)
      expect(report.cpuCount).toBeGreaterThanOrEqual(1)
      expect(report.perWorker.length).toBeGreaterThanOrEqual(1)

      // CORRECTNESS: every threaded configuration's sum-of-fields checksum equals the single-thread run's.
      for (const r of report.perWorker) {
        expect(r.ms).toBeGreaterThan(0)
        expect(Number.isFinite(r.speedup)).toBe(true)
        expect(r.checksum).toBe(report.serialChecksum)
      }
    },
    60_000,
  )

  // ABOVE the 1024-row per-column reservation: each group now holds 1100 rows, so every column re-backs
  // onto a new SAB and the wave-fence re-backing protocol (memory-buffers §7.6) must keep the threaded
  // run byte-identical to single-thread. Bounded per the resource budget (perGroup ≤ 2048, frames ≤ 6,
  // workers ≤ 4). The boundary itself is unit-covered by scheduler/test/worker-growth-boundary.test.ts.
  test(
    'threaded run with groups GROWN PAST the 1024-row reservation stays byte-identical to single-thread',
    async () => {
      const report = await main({ perGroup: 1100, frames: 4, workerCounts: [2, 4], seed: 9, silent: true })
      expect(report.perGroup).toBe(1100)
      for (const r of report.perWorker) expect(r.checksum).toBe(report.serialChecksum)
    },
    120_000,
  )

  // The REAL measured speedup sweep — prints the table. Gated to BENCH_MACRO=1 (`pnpm bench:macro:pool`)
  // so it never costs CI time; it still asserts correctness (checksum equality), but the speedup
  // magnitude is informational only.
  const macro = process.env['BENCH_MACRO'] === '1'
  test.runIf(macro)(
    'full-size speedup sweep (informational table; correctness still asserted)',
    async () => {
      const report = await main({ perGroup: 1024, frames: 200, workerCounts: [1, 2, 4, 8], seed: 1234 })
      for (const r of report.perWorker) expect(r.checksum).toBe(report.serialChecksum)
    },
    600_000,
  )
})
