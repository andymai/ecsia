// The bench runner: consolidated cross-library macro-benchmarks (timing a realistic workload, rather
// than one tiny loop). Runs three buckets with tinybench and emits a JSON + console report:
// 1. iterate-N — Position+Velocity integration: ecsia vs miniplex vs bitECS.
// 2. relation-query — ecsia wildcard subjectsOf walk (ecsia-only differentiator).
// 3. parallel-speedup — worker-parallel sim (in-process dispatcher) vs single-thread, measured as
//    wall-clock (real elapsed) time.
//
// Runnable ON DEMAND (pnpm bench:macro), NOT in the default test run — `main()` takes options so the
// smoke test can drive it at tiny sizes. The full suite uses larger N + more iterations.

import { Bench } from 'tinybench'
import { makeEcsiaIter, makeEcsiaCursorIter, makeMiniplexIter, makeBitEcsIter } from './iterate.js'
import { makeEcsiaRelations } from './relations.js'
import { main as workerSim } from '../examples/worker-sim.js'

export interface BenchOptions {
  /** Entities for the iterate bucket. Default 50_000. */
  readonly entities?: number
  /** Subjects for the relation bucket. Default 20_000. */
  readonly relSubjects?: number
  /** Distinct targets for the relation bucket. Default 256. */
  readonly relTargets?: number
  /** tinybench time budget per task (ms). Default 200. */
  readonly time?: number
  /** Particles per group + ticks (one tick = one step of the simulation) for the parallel bucket. */
  readonly parPerGroup?: number
  readonly parTicks?: number
  /** Quiet console output (the smoke test). Default false. */
  readonly silent?: boolean
}

export interface TaskResult {
  readonly name: string
  /** Operations per second (tinybench hz), or null for the manually-timed parallel bucket. */
  readonly hz: number | null
  /** Mean time per op in ms. */
  readonly meanMs: number
}

export interface BenchReport {
  readonly iterate: ReadonlyArray<TaskResult>
  readonly relations: ReadonlyArray<TaskResult>
  readonly parallel: {
    readonly serialMs: number
    readonly threadedMs: number
    /** serialMs / threadedMs. >1 means the threaded path was faster. */
    readonly speedup: number
  }
}

function collect(bench: Bench): TaskResult[] {
  return bench.tasks.map((t) => {
    const r = t.result
    const meanMs = r?.latency?.mean ?? r?.mean ?? 0
    const hz = r?.throughput?.mean ?? (meanMs > 0 ? 1000 / meanMs : null)
    return { name: t.name, hz: hz ?? null, meanMs }
  })
}

export async function main(opts: BenchOptions = {}): Promise<BenchReport> {
  const entities = opts.entities ?? 50_000
  const relSubjects = opts.relSubjects ?? 20_000
  const relTargets = opts.relTargets ?? 256
  const time = opts.time ?? 200
  const parPerGroup = opts.parPerGroup ?? 2_000
  const parTicks = opts.parTicks ?? 60
  const silent = opts.silent ?? false
  const log = (...a: unknown[]): void => {
    if (!silent) console.log(...a)
  }

  // --- bucket 1: iterate-N ---
  const iterBench = new Bench({ time })
  const ecsiaIter = makeEcsiaIter(entities)
  const ecsiaCursorIter = makeEcsiaCursorIter(entities)
  const miniIter = makeMiniplexIter(entities)
  const bitIter = makeBitEcsIter(entities)
  // Cross-check: the showcased ecsia-cursor fast path must produce the same values as the plain
  // accessor path, or the bench aborts — a measurement of a fast-but-wrong loop is worthless. Run one
  // full step of both ecsia loops at the bench's own N (which crosses the 1024 column-growth
  // boundary) before timing, so a regression that makes the cursor return corrupt values fails the
  // bench instead of silently reporting a misleadingly fast number.
  assertCursorMatchesAccessor(entities)
  iterBench.add('ecsia', () => ecsiaIter.step())
  iterBench.add('ecsia-cursor', () => ecsiaCursorIter.step())
  iterBench.add('miniplex', () => miniIter.step())
  iterBench.add('bitECS', () => bitIter.step())
  await iterBench.run()
  const iterate = collect(iterBench)

  // --- bucket 2: relation-query ---
  const relBench = new Bench({ time })
  const ecsiaRel = makeEcsiaRelations(relSubjects, relTargets)
  relBench.add('ecsia-relations', () => ecsiaRel.step())
  await relBench.run()
  const relations = collect(relBench)

  // --- bucket 3: parallel-speedup (manual wall-clock; updateThreaded is async so it can't be a
  // tinybench sync task without a wrapper, and we want a single serial-vs-threaded ratio). ---
  const serialMs = await timeMs(() => workerSim({ perGroup: parPerGroup, ticks: parTicks, parallel: false, seed: 99 }))
  const threadedMs = await timeMs(() => workerSim({ perGroup: parPerGroup, ticks: parTicks, parallel: true, seed: 99 }))
  const parallel = { serialMs, threadedMs, speedup: threadedMs > 0 ? serialMs / threadedMs : 0 }

  const report: BenchReport = { iterate, relations, parallel }

  log('\n=== ecsia bench report ===')
  log('\n[iterate-N]  (', entities, 'entities, Position+Velocity integration)')
  for (const r of iterate) log(`  ${r.name.padEnd(16)} ${fmtHz(r.hz)}  (${r.meanMs.toFixed(4)} ms/op)`)
  log('\n[relation-query]  (', relSubjects, 'subjects /', relTargets, 'targets, wildcard subjectsOf)')
  for (const r of relations) log(`  ${r.name.padEnd(16)} ${fmtHz(r.hz)}  (${r.meanMs.toFixed(4)} ms/op)`)
  log('\n[parallel-speedup]  (', parPerGroup, 'particles/group,', parTicks, 'ticks)')
  log(`  single-thread   ${serialMs.toFixed(2)} ms`)
  log(`  threaded        ${threadedMs.toFixed(2)} ms`)
  log(`  speedup         ${parallel.speedup.toFixed(2)}x`)
  log('\n' + JSON.stringify(report))

  return report
}

// Run one step of the accessor loop and the cursor loop over freshly-built worlds of N entities and
// assert their sampled result agrees. They start from identical state (dx=1, dy=0.5, x=y=0) and apply
// the same integration, so after one step both must read the same x. A mismatch means the cursor (or
// the storage it reads) is corrupt at N — exactly the failure that lurks above the 1024 growth row.
function assertCursorMatchesAccessor(n: number): void {
  const accessor = makeEcsiaIter(n)
  const cursor = makeEcsiaCursorIter(n)
  accessor.step()
  cursor.step()
  const a = accessor.sampleX()
  const c = cursor.sampleX()
  if (Math.abs(a - c) > 1e-9) {
    throw new Error(
      `bench honesty gate: ecsia-cursor disagrees with ecsia accessor at n=${n} ` +
        `(accessor x=${a}, cursor x=${c}); the cursor row would report a fast-but-wrong number`,
    )
  }
}

async function timeMs(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

function fmtHz(hz: number | null): string {
  if (hz === null) return 'n/a'
  return `${Math.round(hz).toLocaleString()} ops/s`
}

// Allow `node bench/run.js` / `tsx bench/run.ts` direct execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
