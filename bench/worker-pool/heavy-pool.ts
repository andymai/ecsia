// REAL worker-pool speedup bench (the becsy gap): genuine OS-thread parallelism over node:worker_threads
// + Atomics, NOT an in-process dispatcher. It stands up the actual @ecsia/scheduler WorkerPool (the same
// path as examples/test/worker-pool.smoke.test.ts) and drives a CPU-HEAVY workload of systems that
// write different components.
//
// Workload: GROUP_COUNT disjoint Body components (body0..body7); each group's Integrate{g} system writes
// ONLY its own group's Body. Because no two systems write the same component, the scheduler packs up to
// `workers` of them into one concurrent round. Per entity per frame we run an iterated damped-oscillator
// integrator (a small spring-physics simulation): HEAVY_ITERS sub-steps (multiple physics updates per
// rendered frame) of expensive math calls (sin/cos/exp) — heavy enough that the parallel compute
// amortizes the wave-sync/dispatch overhead, i.e. the per-frame work is large enough that coordination
// overhead stops mattering (trivial arithmetic would never show speedup).
//
// We time the single-thread executor (scheduler.update) against the real pool (scheduler.updateThreaded)
// at workers ∈ {1,2,4,8} (clamped to os.cpus().length) and report wall-clock (real elapsed) time +
// SPEEDUP. Results are asserted IDENTICAL to single-thread by the smoke test; the magnitude here is
// informational.

import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  write,
  loadWorkerPool,
} from '@ecsia/kit'
import type { EntityHandle, PoolSystem, SystemDef, World } from '@ecsia/kit'
import type { SystemId } from '@ecsia/schema'

// Mirror the kernel module's constants + inner loop EXACTLY (serial-equivalence by construction). The
// mjs lives next to the m7-kernels.mjs fixture so a raw worker can resolve @ecsia/core; we re-declare
// the math here for the single-thread twin (importing the .mjs from TS is fine but re-stating keeps
// this file the single source the typechecker sees).
const GROUP_COUNT = 8
const HEAVY_ITERS = 512
const DT = 1 / 60
const OMEGA = 6.0
const DAMP = 0.015

// Each group is ONE archetype column. A threaded column is backed by a SharedArrayBuffer (SAB —
// memory several threads can read and write at once) and reserves
// INITIAL_ROWS(64) × GROWTH_RESERVE_FACTOR(16) = 1024 rows of resizable-SAB address space. Crossing
// 1024 rows forces re-backing — moving the column onto a NEW, larger SAB; the worker pool drains that
// re-backing notice at the wave fence (the synchronization point between waves) and re-wraps every
// worker's column view before the next dispatch (see docs/spec/memory-buffers.md and
// docs/spec/serialization.md), so growing past the reservation stays byte-for-byte
// serial-equivalent. The boundary is covered directly by
// packages/scheduler/test/worker-growth-boundary.test.ts (1024 in-place grow + 1025/1040 re-backing).
// No per-column cap: perGroup is free to cross 1024; the smoke test still asserts threaded === serial.
const DEFAULT_PER_GROUP = 1024

// Default relative to THIS file's source location (bench/worker-pool/ → repo root is ../../). The
// tsx-free report runner (scripts/bench-report.mjs) emits this module to a different depth, so it sets
// ECSIA_WORKER_ENTRY / ECSIA_KERNEL_MODULE to absolute paths; the vitest source path uses the default.
const WORKER_ENTRY =
  process.env['ECSIA_WORKER_ENTRY'] ??
  fileURLToPath(new URL('../../packages/scheduler/dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE =
  process.env['ECSIA_KERNEL_MODULE'] ??
  fileURLToPath(new URL('../../packages/scheduler/test/fixtures/heavy-bench-kernels.mjs', import.meta.url))

interface Body6 {
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
}

/** The heavy per-entity integrator twin (identical math to integrateBody in the .mjs). */
function integrate(b: Body6): void {
  const h = DT / HEAVY_ITERS
  let { px, py, pz, vx, vy, vz } = b
  for (let k = 0; k < HEAVY_ITERS; k++) {
    const r = Math.sqrt(px * px + py * py + pz * pz) + 1e-3
    const inv = 1 / r
    const s = Math.sin(OMEGA * r + k * 0.1)
    const c = Math.cos(OMEGA * r - k * 0.1)
    const att = Math.exp(-DAMP * r)
    const ax = (-OMEGA * OMEGA * px + s * py - c * pz) * inv * att
    const ay = (-OMEGA * OMEGA * py + s * pz - c * px) * inv * att
    const az = (-OMEGA * OMEGA * pz + s * px - c * py) * inv * att
    vx = (vx + ax * h) * (1 - DAMP * h)
    vy = (vy + ay * h) * (1 - DAMP * h)
    vz = (vz + az * h) * (1 - DAMP * h)
    px += vx * h
    py += vy * h
    pz += vz * h
  }
  b.px = px
  b.py = py
  b.pz = pz
  b.vx = vx
  b.vy = vy
  b.vz = vz
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

type BodyDef = ReturnType<typeof defineComponent>

interface Seeded {
  readonly world: World
  readonly bodies: readonly BodyDef[]
  /** handles[g][i] — entity i of group g. */
  readonly handles: readonly EntityHandle[][]
}

function seed(threaded: boolean, workers: number, perGroup: number, seedVal: number): Seeded {
  const bodies: BodyDef[] = []
  for (let g = 0; g < GROUP_COUNT; g++) {
    bodies.push(
      defineComponent(
        { px: 'f32', py: 'f32', pz: 'f32', vx: 'f32', vy: 'f32', vz: 'f32' },
        { name: `body${g}` },
      ),
    )
  }
  const cap = nextPow2(perGroup * GROUP_COUNT)
  const world: World = createWorld(
    threaded
      ? { components: bodies, maxEntities: cap, threaded: true, scheduler: { workers } }
      : { components: bodies, maxEntities: cap },
  )
  const rand = lcg(seedVal)
  const handles: EntityHandle[][] = []
  for (let g = 0; g < GROUP_COUNT; g++) {
    const def = bodies[g]!
    const row: EntityHandle[] = []
    for (let i = 0; i < perGroup; i++) {
      const e = world.spawnWith(def)
      const b = world.entity(e).write(def) as unknown as Body6
      b.px = (rand() - 0.5) * 20
      b.py = (rand() - 0.5) * 20
      b.pz = (rand() - 0.5) * 20
      b.vx = (rand() - 0.5) * 4
      b.vy = (rand() - 0.5) * 4
      b.vz = (rand() - 0.5) * 4
      row.push(e)
    }
    handles.push(row)
  }
  return { world, bodies, handles }
}

/** Single-thread twins: one heavy defineSystem per group, writing only that group's Body. */
function twinSystems(s: Seeded): SystemDef[] {
  const defs: SystemDef[] = []
  for (let g = 0; g < GROUP_COUNT; g++) {
    const def = s.bodies[g]!
    defs.push(
      defineSystem({
        name: `Integrate${g}`,
        read: [def],
        write: [def],
        run({ query }) {
          for (const e of query(write(def)) as Iterable<Record<string, unknown>>) {
            integrate(e[def.name] as Body6)
          }
        },
      }),
    )
  }
  return defs
}

/** Empty-body twins + PoolSystems for the threaded plan (the real kernels live in the .mjs). */
function poolSystems(s: Seeded): { defs: SystemDef[]; systems: PoolSystem[] } {
  const defs: SystemDef[] = []
  const systems: PoolSystem[] = []
  for (let g = 0; g < GROUP_COUNT; g++) {
    const def = s.bodies[g]!
    defs.push(defineSystem({ name: `Integrate${g}`, read: [def], write: [def], run() {} }))
    systems.push({
      id: g as unknown as SystemId,
      name: `Integrate${g}`,
      matchComponents: [def],
      kernel: () => {},
      maxSpawnsPerWave: 0,
    })
  }
  return { defs, systems }
}

function checksum(s: Seeded): number {
  let acc = 0
  for (let g = 0; g < GROUP_COUNT; g++) {
    const def = s.bodies[g]!
    for (const h of s.handles[g]!) {
      const b = s.world.entity(h).read(def) as unknown as Body6
      acc += b.px + b.py + b.pz + b.vx + b.vy + b.vz
    }
  }
  return acc
}

export interface WorkerCount {
  readonly workers: number
  readonly ms: number
  /** serialMs / ms. >1 means the threaded run at this worker count beat single-thread. */
  readonly speedup: number
  /** Sum-of-all-fields checksum, used by the smoke test to assert serial-equivalence. */
  readonly checksum: number
}

export interface HeavyPoolReport {
  readonly perGroup: number
  readonly groupCount: number
  readonly totalEntities: number
  readonly heavyIters: number
  readonly frames: number
  readonly cpuCount: number
  readonly serialMs: number
  readonly serialChecksum: number
  readonly perWorker: ReadonlyArray<WorkerCount>
}

export interface HeavyPoolOptions {
  /**
   * Entities per group (GROUP_COUNT groups total). May exceed 1024: crossing the per-column reservation
   * is handled by re-backing at the wave fence (see worker-growth-boundary.test.ts); no cap is applied.
   */
  readonly perGroup?: number
  /** Frames to run per configuration. Default 200. */
  readonly frames?: number
  /** Worker counts to sweep (clamped to os.cpus().length). Default [1,2,4,8]. */
  readonly workerCounts?: readonly number[]
  readonly seed?: number
  readonly silent?: boolean
}

async function timeThreaded(perGroup: number, frames: number, workers: number, seedVal: number): Promise<{ ms: number; checksum: number }> {
  const s = seed(true, workers, perGroup, seedVal)
  const { defs, systems } = poolSystems(s)
  const sched = createScheduler(s.world, defs, { workers })
  const WorkerPool = await loadWorkerPool()
  const pool = new WorkerPool({
    world: s.world as never,
    workers,
    kernelModule: KERNEL_MODULE,
    workerEntryUrl: WORKER_ENTRY,
    systems,
  })
  await pool.ready()
  try {
    // One untimed warmup frame first, so JIT compilation and first-dispatch costs don't pollute the
    // numbers. It mutates state, but re-seeding is unnecessary: the smoke test compares
    // THREADED-vs-SERIAL over the SAME frame count without warmup (see heavy-pool.smoke.test.ts).
    // Here we measure steady-state throughput, warmup excluded.
    await sched.updateThreaded(pool, 1)
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) await sched.updateThreaded(pool, 1)
    const ms = performance.now() - t0
    return { ms, checksum: checksum(s) }
  } finally {
    await pool.dispose()
  }
}

function timeSerial(perGroup: number, frames: number, seedVal: number): { ms: number; checksum: number } {
  const s = seed(false, 0, perGroup, seedVal)
  const defs = twinSystems(s)
  const sched = createScheduler(s.world, defs)
  sched.update(1) // matching warmup frame (kept out of the timed window)
  const t0 = performance.now()
  for (let f = 0; f < frames; f++) sched.update(1)
  const ms = performance.now() - t0
  return { ms, checksum: checksum(s) }
}

export async function main(opts: HeavyPoolOptions = {}): Promise<HeavyPoolReport> {
  const perGroup = opts.perGroup ?? DEFAULT_PER_GROUP
  const frames = opts.frames ?? 200
  const seedVal = opts.seed ?? 1234
  const silent = opts.silent ?? false
  const cpuCount = cpus().length
  const requested = opts.workerCounts ?? [1, 2, 4, 8]
  const workerCounts = [...new Set(requested.map((w) => Math.min(w, cpuCount)))].sort((a, b) => a - b)
  const totalEntities = perGroup * GROUP_COUNT
  const log = (...a: unknown[]): void => {
    if (!silent) console.log(...a)
  }

  const ser = timeSerial(perGroup, frames, seedVal)

  const perWorker: WorkerCount[] = []
  for (const w of workerCounts) {
    const r = await timeThreaded(perGroup, frames, w, seedVal)
    perWorker.push({ workers: w, ms: r.ms, speedup: r.ms > 0 ? ser.ms / r.ms : 0, checksum: r.checksum })
  }

  const report: HeavyPoolReport = {
    perGroup,
    groupCount: GROUP_COUNT,
    totalEntities,
    heavyIters: HEAVY_ITERS,
    frames,
    cpuCount,
    serialMs: ser.ms,
    serialChecksum: ser.checksum,
    perWorker,
  }

  log('\n=== ecsia REAL worker-pool speedup (node:worker_threads + Atomics) ===')
  log(
    `entities=${totalEntities.toLocaleString()} (${GROUP_COUNT} groups × ${perGroup.toLocaleString()}), ` +
      `heavy_iters/entity/frame=${HEAVY_ITERS}, frames=${frames}, os.cpus()=${cpuCount}`,
  )
  log(`\n  single-thread   ${ser.ms.toFixed(1).padStart(9)} ms   (baseline)`)
  log('  ' + 'workers'.padEnd(9) + 'wall ms'.padStart(11) + 'speedup'.padStart(11) + '   checksum Δ vs serial')
  for (const r of perWorker) {
    const delta = Math.abs(r.checksum - ser.checksum)
    log(
      '  ' +
        String(r.workers).padEnd(9) +
        r.ms.toFixed(1).padStart(11) +
        `${r.speedup.toFixed(2)}x`.padStart(11) +
        `   ${delta === 0 ? 'IDENTICAL' : delta.toExponential(2)}`,
    )
  }
  log('\n' + JSON.stringify(report))

  return report
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return Math.max(p, 1024)
}

// Allow `tsx bench/worker-pool/heavy-pool.ts` direct execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
