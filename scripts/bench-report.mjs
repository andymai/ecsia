// benchmark report harness — the single source the performance page reads from.
//
// Runs the published numbers SEQUENTIALLY, one process, no parallelism beyond the worker-pool bench's
// own OS threads:
// 1. iterate comparison (tinybench): ecsia .each, ecsia eachChunk, ecsia bindColumns, miniplex,
// bitECS — reusing the builders in bench/iterate.ts verbatim (NOT reimplemented here).
// 2. tracked-write cost: one ecsia .each run with a .changed() filter attached — the write-log cost
// users opt into. Built from the SAME component/integrator as the iterate row.
// 3. worker-pool speedup: bench/worker-pool/heavy-pool.ts main() at the bounded config.
// then writes bench/RESULTS.json (env + raw numbers) AND website/guide/_perf-tables.md (the tables the
// VitePress page includes). Re-running regenerates both, so the page can never drift from the artifact.
//
// TSX-FREE / IMPORT-FROM-BUILT: the bench builders are TypeScript that import `ecsia`. We compile
// them ONCE to plain ESM (bench/.report-dist via tsconfig.report.json) and import that — the same spirit
// as scripts/runtime-smoke.mjs importing the built dist, no tsx/vitest in the loop. The `@ecsia/*` bare
// specifiers resolve from the repo-root node_modules workspace links (added as root devDependencies).

import { execFileSync } from 'node:child_process'
import { cpus } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Bench } from 'tinybench'
import { createWorld, defineComponent, write, read } from 'ecsia'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// --- config -----------------------------------------------------------------
// The BOUNDED production config. A tiny smoke override is provided by env so the pipeline
// can be proven once without paying the full cost — the measurement is run EXACTLY ONCE either way.
const SMOKE = process.env['BENCH_REPORT_SMOKE'] === '1'
const CONFIG = SMOKE
  ? {
      iterEntities: Number(process.env['BENCH_REPORT_N'] ?? 2000),
      iterReps: 1,
      iterTimeMs: 50,
      poolPerGroup: 64,
      poolFrames: Number(process.env['BENCH_REPORT_FRAMES'] ?? 2),
      poolWorkers: parseWorkers(process.env['BENCH_REPORT_WORKERS'] ?? '1,2'),
      poolSeed: 1234,
    }
  : {
      iterEntities: 50_000,
      iterReps: 3,
      iterTimeMs: 300,
      poolPerGroup: 1024,
      poolFrames: 60,
      poolWorkers: [1, 2, 4, 8],
      poolSeed: 1234,
    }

function parseWorkers(s) {
  return s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

// --- step 0: compile bench builders to plain ESM (tsx-free) -----------------
function buildBenchBuilders() {
  execFileSync('node', [resolve(ROOT, 'node_modules/typescript/bin/tsc'), '-p', resolve(ROOT, 'bench/tsconfig.report.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
}

// --- step 1: iterate comparison ---------------------------------------------
async function runIterate(makeEcsiaIter, makeEcsiaCursorIter, makeEcsiaPinnedIter, makeMiniplexIter, makeBitEcsIter) {
  const n = CONFIG.iterEntities
  const ecsia = makeEcsiaIter(n)
  const cursor = makeEcsiaCursorIter(n)
  const pinned = makeEcsiaPinnedIter(n)
  const mini = makeMiniplexIter(n)
  const bit = makeBitEcsIter(n)

  // Honesty: the cursor and pinned rows must integrate the SAME data as the accessor row at this N
  // (crosses the 1024 column-growth boundary). Cross-validate one step before timing — a
  // fast-but-wrong loop fails here instead of silently reporting a misleading number.
  ecsia.step()
  cursor.step()
  pinned.step()
  if (Math.abs(ecsia.sampleX() - cursor.sampleX()) > 1e-9) {
    throw new Error(`bench honesty gate: ecsia-cursor disagrees with ecsia accessor at n=${n}`)
  }
  if (Math.abs(ecsia.sampleX() - pinned.sampleX()) > 1e-9) {
    throw new Error(`bench honesty gate: ecsia-pinned disagrees with ecsia accessor at n=${n}`)
  }

  const results = []
  for (let rep = 0; rep < CONFIG.iterReps; rep++) {
    const bench = new Bench({ time: CONFIG.iterTimeMs })
    bench.add('ecsia .each', () => ecsia.step())
    bench.add('ecsia eachChunk', () => cursor.step())
    bench.add('ecsia bindColumns', () => pinned.step())
    bench.add('miniplex', () => mini.step())
    bench.add('bitECS', () => bit.step())
    await bench.run()
    for (const t of bench.tasks) {
      const r = t.result
      const meanMs = r && 'latency' in r ? r.latency.mean : 0
      const hz = r && 'throughput' in r ? r.throughput.mean : meanMs > 0 ? 1000 / meanMs : 0
      results.push({ name: t.name, hz, meanMs })
    }
  }
  // Keep the best (max hz) per task across reps — steady-state, least noise.
  const best = new Map()
  for (const r of results) {
    const prev = best.get(r.name)
    if (!prev || r.hz > prev.hz) best.set(r.name, r)
  }
  const order = ['ecsia .each', 'ecsia eachChunk', 'ecsia bindColumns', 'miniplex', 'bitECS']
  return order.map((name) => {
    const r = best.get(name)
    return { name, hz: r.hz, meanMs: r.meanMs, nsPerEntity: r.meanMs > 0 ? (r.meanMs * 1e6) / n : 0 }
  })
}

// --- step 2: tracked-write cost (one .each run with a .changed() filter attached) ---------------
// Same Position+Velocity integrator as the iterate row, but the writes go through the change-tracked
// path and are drained via .changed()/.eachChanged() — measuring the write-log cost users opt into.
function makeTrackedWriteCase(n) {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const cap = nextPow2(n)
  const world = createWorld({ components: [Position, Velocity], maxEntities: cap })
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Position, Velocity)
    const v = world.entity(h).write(Velocity)
    v.dx = 1
    v.dy = 0.5
  }
  const moving = world.query(write(Position), write(Velocity))
  const changedPos = world.query(read(Position)).changed()
  const DT = 1 / 60
  return () => {
    // Open a fresh write-log window for this frame so .changed() yields exactly this frame's writes.
    world.frameReset()
    moving.each((e) => {
      e.position.x += e.velocity.dx * DT
      e.position.y += e.velocity.dy * DT
    })
    let n2 = 0
    changedPos.eachChanged(() => {
      n2++
    })
    return n2
  }
}

async function runTrackedWrite() {
  const n = CONFIG.iterEntities
  const step = makeTrackedWriteCase(n)
  step() // warm
  const bench = new Bench({ time: CONFIG.iterTimeMs })
  bench.add('ecsia .each + .changed()', () => step())
  await bench.run()
  const t = bench.tasks[0]
  const r = t.result
  const meanMs = r && 'latency' in r ? r.latency.mean : 0
  const hz = r && 'throughput' in r ? r.throughput.mean : meanMs > 0 ? 1000 / meanMs : 0
  return { name: 'ecsia .each + .changed()', hz, meanMs, nsPerEntity: meanMs > 0 ? (meanMs * 1e6) / n : 0 }
}

function nextPow2(n) {
  let p = 1
  while (p < n) p <<= 1
  return Math.max(p, 1024)
}

// --- step 3: worker-pool speedup --------------------------------------------
async function runPool(poolMain) {
  return poolMain({
    perGroup: CONFIG.poolPerGroup,
    frames: CONFIG.poolFrames,
    workerCounts: CONFIG.poolWorkers,
    seed: CONFIG.poolSeed,
    silent: true,
  })
}

// --- markdown table generation ----------------------------------------------
function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US')
}

function genTables(report) {
  const bit = report.iterate.find((r) => r.name === 'bitECS')
  const bitHz = bit?.hz ?? 0
  const iterRows = report.iterate.map((r) => {
    const ratio = bitHz > 0 && r.hz > 0 ? bitHz / r.hz : 0
    const ratioStr = r.name === 'bitECS' ? '1.00x (baseline)' : `${ratio.toFixed(2)}x`
    return `| ${r.name} | ${fmtInt(r.hz)} | ${r.meanMs.toFixed(4)} | ${r.nsPerEntity.toFixed(2)} | ${ratioStr} |`
  })

  const tw = report.trackedWrite
  const twBit = bitHz > 0 && tw.hz > 0 ? bitHz / tw.hz : 0
  const twRow = `| ${tw.name} | ${fmtInt(tw.hz)} | ${tw.meanMs.toFixed(4)} | ${tw.nsPerEntity.toFixed(2)} | ${twBit.toFixed(2)}x |`

  const single = report.pool.serialMs
  const poolRows = report.pool.perWorker.map((w) => {
    const speedup = w.ms > 0 ? single / w.ms : 0
    const identical = w.checksum === report.pool.serialChecksum ? 'yes' : 'NO'
    return `| ${w.workers} | ${w.ms.toFixed(1)} | ${speedup.toFixed(2)}x | ${identical} |`
  })

  const e = report.env
  return `<!-- GENERATED by scripts/bench-report.mjs (pnpm bench:report). DO NOT EDIT BY HAND. -->
<!-- Regenerate with: pnpm bench:report -->

**Environment.** ${e.cpuModel} (${e.cpuCores} logical cores) · Node ${e.node} · ${e.date} · commit \`${e.commit}\` · bitECS ${e.deps.bitecs} · miniplex ${e.deps.miniplex} · tinybench ${e.deps.tinybench}${e.smoke ? ' · _smoke config (not a published number)_' : ''}

### Single-thread iteration

Each loop adds every entity's velocity to its position, over ${fmtInt(report.config.iterEntities)} entities per op. \`ns per entity\` is mean op time divided by entity count (nanoseconds per entity — lower is faster); \`ratio vs bitECS\` is bitECS ops/s ÷ this row's ops/s. The \`ecsia bindColumns\` row binds its loop to the storage once, up front; if storage grows after that binding the loop runs slower from then on (roughly 1.7 ns per entity instead of ~1.0), so pre-size the world to peak capacity — spawn or reserve before binding.

| loop | ops/s | ms/op | ns per entity | ratio vs bitECS |
| --- | ---: | ---: | ---: | ---: |
${iterRows.join('\n')}

**Tracked-write cost** — the same \`.each\` loop with a \`.changed()\` filter attached and drained each frame (the change-tracking overhead you opt into for reacting to changes):

| loop | ops/s | ms/op | ns per entity | ratio vs bitECS |
| --- | ---: | ---: | ---: | ---: |
${twRow}

### Worker-pool speedup

Real \`node:worker_threads\` + Atomics. ${report.pool.groupCount} independent Body groups × ${fmtInt(report.pool.perGroup)} entities (${fmtInt(report.pool.totalEntities)} total), ${fmtInt(report.pool.heavyIters)} sub-steps of expensive math (sin/cos/exp) per entity per frame, ${fmtInt(report.pool.frames)} frames. Speedup is single-thread wall-clock time ÷ this row's. \`byte-identical\` confirms the threaded run's sum-of-fields checksum equals the single-thread run's.

Single-thread baseline: **${single.toFixed(1)} ms**.

| workers | wall ms | speedup vs 1 thread | byte-identical |
| ---: | ---: | ---: | :---: |
${poolRows.join('\n')}
`
}

// --- main -------------------------------------------------------------------
async function main() {
  buildBenchBuilders()

  // Import the freshly-emitted builders (tsx-free; plain ESM importing the built @ecsia dist).
  const iter = await import(resolve(ROOT, 'bench/.report-dist/iterate.js'))
  // The emitted heavy-pool sits at a different depth than its source, so point it at the absolute
  // worker-entry + kernel module the bench resolves by default from its source location.
  process.env['ECSIA_WORKER_ENTRY'] = resolve(ROOT, 'packages/scheduler/dist/workers/worker-entry.js')
  process.env['ECSIA_KERNEL_MODULE'] = resolve(ROOT, 'packages/scheduler/test/fixtures/heavy-bench-kernels.mjs')
  const pool = await import(resolve(ROOT, 'bench/.report-dist/worker-pool/heavy-pool.js'))

  const iterate = await runIterate(iter.makeEcsiaIter, iter.makeEcsiaCursorIter, iter.makeEcsiaPinnedIter, iter.makeMiniplexIter, iter.makeBitEcsIter)
  const trackedWrite = await runTrackedWrite()
  const poolReport = await runPool(pool.main)

  const env = {
    node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCores: cpus().length,
    date: new Date().toISOString().slice(0, 10),
    commit: gitSha(),
    smoke: SMOKE,
    // The comparison targets are moving baselines — stamp their versions so every published
    // ratio is attributable to a specific competitor release.
    deps: {
      bitecs: depVersion('bitecs'),
      miniplex: depVersion('miniplex'),
      tinybench: depVersion('tinybench'),
    },
  }

  const report = {
    env,
    config: {
      iterEntities: CONFIG.iterEntities,
      iterReps: CONFIG.iterReps,
      iterTimeMs: CONFIG.iterTimeMs,
      poolPerGroup: CONFIG.poolPerGroup,
      poolFrames: CONFIG.poolFrames,
      poolWorkers: CONFIG.poolWorkers,
      poolSeed: CONFIG.poolSeed,
    },
    iterate,
    trackedWrite,
    pool: {
      perGroup: poolReport.perGroup,
      groupCount: poolReport.groupCount,
      totalEntities: poolReport.totalEntities,
      heavyIters: poolReport.heavyIters,
      frames: poolReport.frames,
      cpuCount: poolReport.cpuCount,
      serialMs: poolReport.serialMs,
      serialChecksum: poolReport.serialChecksum,
      perWorker: poolReport.perWorker,
    },
  }

  const resultsPath = resolve(ROOT, 'bench/RESULTS.json')
  const tablesPath = resolve(ROOT, 'website/guide/_perf-tables.md')
  writeFileSync(resultsPath, JSON.stringify(report, null, 2) + '\n')
  writeFileSync(tablesPath, genTables(report))

  console.log(`bench:report wrote:\n  ${resultsPath}\n  ${tablesPath}`)
  if (SMOKE) console.log('\n(smoke config — numbers are NOT publishable)')
}

function depVersion(name) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}

await main()
