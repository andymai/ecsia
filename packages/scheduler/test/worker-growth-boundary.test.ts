// WORKER GROWTH BOUNDARY — the pre-publish "Known issue" reproduction + hardening (CHANGELOG / heavy-pool
// bench cap). The acceptance bar throughout is SERIAL-EQUIVALENCE: every threaded path is compared to a
// single-thread replay of the identical seeding + plan, and must be byte-identical.
//
// A threaded column reserves INITIAL_ROWS(64) × GROWTH_RESERVE_FACTOR(16) = 1024 rows of resizable-SAB
// address space (floored by MIN_RESERVE_ROWS=1024). Growth has two flavors:
//
// IN-PLACE (≤1024 rows, within the reservation): `sab.grow()` widens the SAME SharedArrayBuffer.
// Worker views are length-tracking (world-view.ts `wrap` — no length arg), so they auto-widen
// and NO re-backing notice is emitted (the growth generation does NOT advance). ASSERTED below.
// RE-BACKING (>1024 rows): the reservation is exhausted, so buffers.ts #growFallback allocates a NEW
// SharedArrayBuffer, copies, and re-binds the MAIN thread's ViewHolders. It ALSO records a
// re-backing notice (buffers.ts columnGrowth journal); the pool drains it at the wave fence
// and broadcasts the new SAB to every worker (pool.#drainColumnGrowth → worker applyColumnGrowth)
// BEFORE the next dispatch, so the worker re-wraps and stays serial-equivalent past 1024.
//
// Wiring mirrors m7-threaded-update.integration.test.ts: a real WorkerPool over the built worker-entry +
// a kernel .mjs. The boundary matrix (group 1) crosses 1024 at pool-start, between waves (main-thread
// spawns), and via worker-staged OP_CREATE whose serial-slot apply triggers growth. Group 2 forces BOTH
// flavors explicitly (in-place: assert generation unchanged; re-backing: a high-row sentinel the worker
// reads back). Group 3 is a bounded property test. Group 4 guards the steady-state zero-overhead path.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, write } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { WorkerPool } from '@ecsia/scheduler/workers'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))
const GROWTH_KERNEL_MODULE = fileURLToPath(new URL('./fixtures/growth-kernels.mjs', import.meta.url))

// The reservation boundary under test: INITIAL_ROWS(64) × GROWTH_RESERVE_FACTOR(16), floored by
// MIN_RESERVE_ROWS(1024). Anything ≤ this grows in place; anything past it re-backs.
const RESERVATION_ROWS = 1024

interface World1 {
  world: World
  Health: ReturnType<typeof defineComponent>
  Mana: ReturnType<typeof defineComponent>
  handles: EntityHandle[]
}

// One Health column carries the whole population, so a spawn past 1024 IS the boundary crossing. Mana is
// registered too (the Copy read-back + Spawner add target) but only populated where a test uses it.
function makeWorld(threaded: boolean, workers: number): World1 {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world: World = createWorld(
    threaded
      ? { components: [Health, Mana], maxEntities: 1 << 13, threaded: true, scheduler: { workers } }
      : { components: [Health, Mana], maxEntities: 1 << 13 },
  )
  return { world, Health, Mana, handles: [] }
}

function spawnInto(w: World1, from: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const h = w.world.spawnWith(w.Health)
    ;(w.world.entity(h).write(w.Health) as { hp: number }).hp = from + i
    w.handles.push(h)
  }
}

function refScheduler(w: World1) {
  const Regen = defineSystem({
    name: 'Regen',
    read: [],
    write: [w.Health],
    run({ query }) {
      for (const e of query(write(w.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
    },
  })
  return createScheduler(w.world, [Regen])
}

function thrScheduler(w: World1, workers: number) {
  const RegenT = defineSystem({ name: 'Regen', read: [], write: [w.Health], run() {} })
  return createScheduler(w.world, [RegenT], { workers })
}

async function makePool(w: World1, workers: number): Promise<WorkerPool> {
  return makePoolForWorld(w.world, w.Health, workers)
}

// Same as makePool but over an explicit World handle (the steady-state guard hands the pool a Proxy
// world so it can count the pool's drain() calls).
async function makePoolForWorld(world: World, Health: ReturnType<typeof defineComponent>, workers: number): Promise<WorkerPool> {
  const systems: PoolSystem[] = [
    { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
  ]
  const p = new WorkerPool({ world, workers, kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY, systems })
  await p.ready()
  return p
}

// Compare every entity's Health column; report a {mismatches, firstBad} pair so a divergence shows its
// shape (all-rows / from-which-index) rather than a bare boolean.
function assertHealthMatches(thr: World1, ref: World1, n: number): void {
  let mismatches = 0
  let firstBad = -1
  for (let i = 0; i < n; i++) {
    const got = (thr.world.entity(thr.handles[i]!).read(thr.Health) as { hp: number }).hp
    const want = (ref.world.entity(ref.handles[i]!).read(ref.Health) as { hp: number }).hp
    if (got !== want) {
      mismatches++
      if (firstBad < 0) firstBad = i
    }
  }
  expect({ mismatches, firstBad }).toEqual({ mismatches: 0, firstBad: -1 })
}

const growthGen = (w: World1): number => w.world.__columnGrowth().generation

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GROUP 1 — BOUNDARY MATRIX. The 1024-crossing happens at three distinct points relative to the worker's
// manifest capture; each is compared serial-equivalent vs the single-thread replay.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('boundary matrix: a threaded column crossing its 1024-row reservation stays serial-equivalent', () => {
  // (a) CROSSING AT POOL-START (pre-grown). The pool is constructed (manifest captured at ≤64 rows) and
  // THEN 1030 entities are spawned into the one column, so it is grown + re-backed before the first wave.
  test('crossing at pool-start (pool then spawn 1030 into one column): worker run matches single-thread', async () => {
    const N = 1030

    const ref = makeWorld(false, 0)
    const refSched = refScheduler(ref)

    const thr = makeWorld(true, 2)
    const thrSched = thrScheduler(thr, 2)
    pool = await makePool(thr, 2) // manifest captured here (column at most 64 rows, or absent)

    spawnInto(ref, 0, N)
    spawnInto(thr, 0, N) // grows the threaded column past 1024 → re-backing, after manifest capture
    expect(growthGen(thr)).toBeGreaterThan(0) // a re-backing actually happened (not just in-place grow)

    refSched.update(1)
    await thrSched.updateThreaded(pool, 1)

    expect(thr.world.phase).toBe('serial')
    assertHealthMatches(thr, ref, N)
  })

  // (b) CROSSING BETWEEN WAVES via a MAIN-THREAD spawn. Seed UNDER the boundary (1000), run a wave
  // (matches), then spawn from the main thread to push 1000 → 1040 (crossing 1024), then run a second
  // wave. The re-backing occurs AFTER the worker captured the manifest, so without the fence the worker
  // views would be stale and every entity would diverge from index 0.
  test('crossing between waves (main-thread spawn mid-run): worker run matches single-thread', async () => {
    const START = 1000
    const ADD = 40 // 1000 → 1040, crossing 1024 between the two waves

    const ref = makeWorld(false, 0)
    spawnInto(ref, 0, START)
    const refSched = refScheduler(ref)

    const thr = makeWorld(true, 2)
    spawnInto(thr, 0, START)
    const thrSched = thrScheduler(thr, 2)
    pool = await makePool(thr, 2)

    // Wave 1 (under the boundary — matches; in-place growth 64→1000 already happened before capture).
    refSched.update(1)
    await thrSched.updateThreaded(pool, 1)
    assertHealthMatches(thr, ref, START)
    const genBefore = growthGen(thr)

    // Spawn mid-run from the main thread, crossing 1024.
    spawnInto(ref, START, ADD)
    spawnInto(thr, START, ADD)
    expect(growthGen(thr)).toBeGreaterThan(genBefore) // the crossing re-backed

    // Wave 2 (now > 1024 rows — re-backing happened after manifest capture).
    refSched.update(1)
    await thrSched.updateThreaded(pool, 1)

    expect(thr.world.phase).toBe('serial')
    assertHealthMatches(thr, ref, START + ADD)
  })

  // (c) CROSSING via a WORKER-STAGED OP_CREATE whose serial-slot apply triggers growth. Seed UNDER the
  // boundary (1000), then a Spawner kernel stages OP_CREATE into its command buffer. ONE update runs two
  // sequential waves (Spawner and Regen both write Health → a write conflict → distinct waves in the same
  // frame): the Spawner's creates apply at the SERIAL FLUSH SLOT of wave 1, growing the Health column from
  // 1000 past 1024 (re-backing it); the Regen wave 2 then re-wraps at its fence and increments over the
  // now-1060-row re-backed column. Both runs use ONE scheduler [Spawner, Regen] so the threaded systemIds
  // align with the pool's `systems` registration (a separate scheduler per system would misroute the
  // dispatch). Acceptance: the PRE-EXISTING population is handle-aligned identical after the frame.
  test('crossing via worker-staged OP_CREATE (serial-slot apply grows the column): matches single-thread', async () => {
    const START = 1000
    const SPAWN = 60 // 1000 → 1060 after the spawner's creates apply, crossing 1024

    // single-thread reference: ONE scheduler [Spawner, Regen]. Spawner creates SPAWN children, then Regen
    // +1 over everything (the two systems conflict on Health → run as ordered waves in one update).
    const ref = makeWorld(false, 0)
    spawnInto(ref, 0, START)
    const refSpawner = defineSystem({
      name: 'Spawner',
      read: [ref.Health],
      write: [ref.Health],
      maxSpawnsPerWave: SPAWN,
      run({ world }) {
        for (let i = 0; i < SPAWN; i++) {
          const child = world.spawn()
          world.add(child, ref.Health)
          ;(world.entity(child).write(ref.Health) as { hp: number }).hp = 4242
        }
      },
    })
    const refRegen = defineSystem({
      name: 'Regen',
      read: [],
      write: [ref.Health],
      run({ query }) {
        for (const e of query(write(ref.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
      },
    })
    const refSched = createScheduler(ref.world, [refSpawner, refRegen])

    // threaded run: ONE scheduler [Spawner, Regen] over a pool whose `systems` array matches that order.
    const thr = makeWorld(true, 1)
    spawnInto(thr, 0, START)
    const SpawnerT = defineSystem({ name: 'Spawner', read: [thr.Health], write: [thr.Health], maxSpawnsPerWave: SPAWN, run() {} })
    const RegenT = defineSystem({ name: 'Regen', read: [thr.Health], write: [thr.Health], run() {} })
    const thrSched = createScheduler(thr.world, [SpawnerT, RegenT], { workers: 1 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Spawner', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: SPAWN },
      { id: 1 as unknown as SystemId, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({
      world: thr.world,
      workers: 1,
      kernelModule: GROWTH_KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      components: [thr.Health, thr.Mana],
      maxBatchEntities: 1 << 13,
      // The Spawner kernel calls cmd.create() once per matched entity (1000), capped at the 60-slot
      // reservation — the expected, benign "spawn capped" diagnostics; silence them so the run is clean.
      diagnostic: () => {},
    })
    await pool.ready()

    const genBefore = growthGen(thr)
    const refAliveBefore = ref.world.handleStats().aliveCount
    const thrAliveBefore = thr.world.handleStats().aliveCount

    // ONE frame: Spawner wave (OP_CREATE apply grows + re-backs the column) → Regen wave (re-wraps at the
    // fence, +1 over the re-backed 1060-row column). A stale-backing worker would miss every Regen write.
    refSched.update(1)
    await thrSched.updateThreaded(pool, 1)

    const refGrew = ref.world.handleStats().aliveCount - refAliveBefore
    const thrGrew = thr.world.handleStats().aliveCount - thrAliveBefore
    expect(thrGrew).toBe(refGrew)
    expect(thrGrew).toBe(SPAWN) // the worker-staged OP_CREATE applied at the serial slot
    expect(growthGen(thr)).toBeGreaterThan(genBefore) // and that apply re-backed the column past 1024

    expect(thr.world.phase).toBe('serial')
    // Seeded population: hp started at i, +1 from the Regen wave → i+1 in BOTH runs, handle-for-handle.
    assertHealthMatches(thr, ref, START)
    for (let i = 0; i < START; i++) {
      const hp = (thr.world.entity(thr.handles[i]!).read(thr.Health) as { hp: number }).hp
      expect(hp).toBe(i + 1)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GROUP 2 — BOTH FLAVORS FORCED. One test pins the in-place path (no notice), one pins the re-backing
// path with an explicit high-row sentinel the worker must read back off the NEW SAB.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('both growth flavors forced', () => {
  // IN-PLACE: growing WITHIN the reservation must NOT emit a re-backing notice — length-tracking views
  // auto-widen, so the steady-state generation stays put. We seed SEED rows BEFORE the pool so the Health
  // column is present in the worker's captured manifest, THEN grow it (after capture) to exactly 1024 —
  // the reservation ceiling, still an in-place `sab.grow()`. The worker's length-tracking view must see
  // the new rows with NO re-backing broadcast: serial-equivalent AND the growth generation stays 0.
  test('in-place grow within the reservation: serial-equivalent AND emits no re-backing notice', async () => {
    const SEED = 64 // present in the manifest at pool-construction time
    const N = RESERVATION_ROWS // 1024 — the last capacity that still fits the in-place reservation

    const ref = makeWorld(false, 0)
    spawnInto(ref, 0, N)
    const refSched = refScheduler(ref)

    const thr = makeWorld(true, 2)
    spawnInto(thr, 0, SEED) // column exists (64 rows) when the pool captures the manifest
    const thrSched = thrScheduler(thr, 2)
    pool = await makePool(thr, 2)
    expect(growthGen(thr)).toBe(0)

    spawnInto(thr, SEED, N - SEED) // 64 → 1024 AFTER capture: in-place `sab.grow()`, within reservation
    expect(growthGen(thr)).toBe(0) // CURE INVARIANT: in-place growth never advances the generation

    refSched.update(1)
    await thrSched.updateThreaded(pool, 1)

    expect(thr.world.phase).toBe('serial')
    assertHealthMatches(thr, ref, N) // every row (incl. the post-capture in-place-grown ones) matches
    expect(growthGen(thr)).toBe(0) // still zero after the wave — the steady-state fence never fired
  })

  // RE-BACKING with an EXPLICIT SENTINEL read-back. The worker pool runs Regen+Copy. We:
  // 1. seed 1000 (under boundary), run a wave to capture the worker manifest at the OLD backing,
  // 2. spawn to 1040 from the main thread → the Health column RE-BACKS onto a NEW SAB,
  // 3. write a distinctive SENTINEL into a HIGH Health row (index 1039) on the main thread, post-grow,
  // 4. run a wave whose Copy kernel does Mana := Health.
  // If the worker re-wrapped onto the NEW backing it reads the sentinel and writes it into that entity's
  // Mana. If it kept the OLD (abandoned, 1024-row) backing, row 1039 is out of range → it reads/writes
  // garbage and Mana never equals the sentinel. We assert Mana[1039] === sentinel EXACTLY.
  test('re-backing onto a new SAB: worker reads back a main-thread sentinel written at a high row', async () => {
    const START = 1000
    const TOTAL = 1040 // crosses 1024
    const SENTINEL = 0x5eed_beef | 0 // distinctive 32-bit value at a high row

    const thr = makeWorld(true, 1)
    spawnInto(thr, 0, START)
    // Give every entity Mana too (Copy writes into it). Re-add Mana to the existing Health entities.
    for (let i = 0; i < START; i++) thr.world.add(thr.handles[i]!, thr.Mana)

    const CopyT = defineSystem({ name: 'Copy', read: [thr.Health], write: [thr.Mana], run() {} })
    const thrSched = createScheduler(thr.world, [CopyT], { workers: 1 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Copy', matchComponents: [thr.Health, thr.Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({
      world: thr.world,
      workers: 1,
      kernelModule: GROWTH_KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      components: [thr.Health, thr.Mana],
      maxBatchEntities: 1 << 13,
    })
    await pool.ready()

    // Wave 1 under the boundary: the worker captures the manifest views over the OLD (≤1024-row) SAB.
    await thrSched.updateThreaded(pool, 1)
    const genBefore = growthGen(thr)

    // Grow past the reservation from the main thread → Health (and Mana) re-back onto NEW SABs.
    spawnInto(thr, START, TOTAL - START)
    for (let i = START; i < TOTAL; i++) thr.world.add(thr.handles[i]!, thr.Mana)
    expect(growthGen(thr)).toBeGreaterThan(genBefore) // re-backing happened

    // Write the SENTINEL into a HIGH Health row (only reachable on the NEW backing) AFTER the grow.
    const highIdx = TOTAL - 1 // 1039, well past the old 1024-row reservation
    ;(thr.world.entity(thr.handles[highIdx]!).write(thr.Health) as { hp: number }).hp = SENTINEL

    // Wave 2: Copy does Mana := Health over every matched entity. The worker MUST be on the new backing.
    await thrSched.updateThreaded(pool, 1)
    expect(thr.world.phase).toBe('serial')

    // The read-back proof: the high row's Mana equals the sentinel the main thread wrote post-re-backing.
    const manaHigh = (thr.world.entity(thr.handles[highIdx]!).read(thr.Mana) as { mp: number }).mp
    expect(manaHigh).toBe(SENTINEL)
    // And a spot-check on a LOW row (present in both backings) to prove Copy actually ran everywhere.
    const lowMana = (thr.world.entity(thr.handles[0]!).read(thr.Mana) as { mp: number }).mp
    const lowHealth = (thr.world.entity(thr.handles[0]!).read(thr.Health) as { hp: number }).hp
    expect(lowMana).toBe(lowHealth)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GROUP 3 — PROPERTY TEST (bounded). A random interleaving of {spawn k, run wave} steps, with random
// per-entity Health seeds, crossing multiple growth boundaries. The final Health column must be
// byte-identical to a single-thread replay of the SAME script. ≤64 fast-check runs, small worlds.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('property: random spawn/run interleavings crossing growth boundaries replay byte-identical', () => {
  // A step is a spawn count k (each spawned entity gets a random hp). After every spawn we run one wave
  // (Regen +1). Bias the k values so the cumulative population repeatedly crosses 1024 within a script.
  test('threaded replay equals single-thread replay for any spawn/run interleaving', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 3–6 steps; each step spawns 350–600 entities. The MINIMUM script (SEED 32 + 3×350 = 1082)
        // already crosses 1024, and larger ones cross 2048 — so EVERY generated (and shrunk) case
        // exercises at least one re-backing boundary. This is what makes `growthGen > 0` always hold.
        fc.array(
          fc.record({
            k: fc.integer({ min: 350, max: 600 }),
            vals: fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 350, maxLength: 600 }),
          }),
          { minLength: 3, maxLength: 6 },
        ),
        async (script) => {
          const SEED = 32 // present before the pool so the Health column is in the captured manifest
          const ref = makeWorld(false, 0)
          const thr = makeWorld(true, 2)
          // identical pre-seed in BOTH worlds (deterministic hp = -1..-SEED, never collides with script vals).
          for (let i = 0; i < SEED; i++) {
            const v = -1 - i
            const rh = ref.world.spawnWith(ref.Health)
            ;(ref.world.entity(rh).write(ref.Health) as { hp: number }).hp = v
            ref.handles.push(rh)
            const th = thr.world.spawnWith(thr.Health)
            ;(thr.world.entity(th).write(thr.Health) as { hp: number }).hp = v
            thr.handles.push(th)
          }
          const refSched = refScheduler(ref)
          const thrSched = thrScheduler(thr, 2)
          const p = await makePool(thr, 2) // manifest captures the SEED-row Health column
          try {
            let total = SEED
            for (const step of script) {
              const k = step.k
              for (let i = 0; i < k; i++) {
                const v = step.vals[i % step.vals.length]!
                const rh = ref.world.spawnWith(ref.Health)
                ;(ref.world.entity(rh).write(ref.Health) as { hp: number }).hp = v
                ref.handles.push(rh)
                const th = thr.world.spawnWith(thr.Health)
                ;(thr.world.entity(th).write(thr.Health) as { hp: number }).hp = v
                thr.handles.push(th)
              }
              total += k
              refSched.update(1)
              await thrSched.updateThreaded(p, 1)
            }
            assertHealthMatches(thr, ref, total)
            expect(growthGen(thr)).toBeGreaterThan(0) // the script DID cross a re-backing boundary
          } finally {
            await p.dispose()
          }
        },
      ),
      { numRuns: 12 }, // bounded: each run spins a real worker pool + worlds; ≤64 per the budget
    )
  }, 120_000)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GROUP 4 — STEADY-STATE OVERHEAD GUARD. With a population that never crosses 1024, running N waves must
// fire the re-backing fence ZERO times. We instrument the world's growth journal: its `drain()` must
// never be invoked by the pool (counter stays 0) and the generation must stay constant across all waves.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('steady-state overhead guard: no re-backing application across N no-growth waves', () => {
  test('zero re-wrap applications and a constant growth generation over many waves', async () => {
    const N = 512 // under 1024 — no growth ever after the initial in-place fill
    const WAVES = 16

    const thr = makeWorld(true, 2)
    spawnInto(thr, 0, N)

    // Instrument the journal: count every drain() the pool performs. The pool only drains when the
    // generation advanced, so on a no-growth run this counter MUST stay 0. The world object is frozen,
    // so we hand the POOL a Proxy world whose __columnGrowth wraps drain() with a counter; the scheduler
    // still drives the real world (it only re-reads through the pool's #world reference).
    let drainCalls = 0
    // createWorld returns an Object.frozen object, so neither assignment nor a Proxy can override its
    // non-configurable __columnGrowth. The world's methods are closures over private state (not
    // `this`-bound — e.g. `__columnGrowth() { return buffers.columnGrowth() }` closes over `buffers`),
    // so a shallow Object.assign copy is a faithful, MUTABLE twin: every other method delegates exactly,
    // and we replace __columnGrowth with a drain-counting wrapper. The pool reads through this copy.
    const realColumnGrowth = thr.world.__columnGrowth
    const proxiedWorld: World = Object.assign({} as World, thr.world, {
      __columnGrowth() {
        const log = realColumnGrowth()
        return {
          generation: log.generation,
          drain: () => {
            drainCalls++
            return log.drain()
          },
        }
      },
    })

    const thrSched = thrScheduler(thr, 2)
    pool = await makePoolForWorld(proxiedWorld, thr.Health, 2)

    const genStart = thr.world.__columnGrowth().generation // capture via the real log (drain not called)

    for (let w = 0; w < WAVES; w++) await thrSched.updateThreaded(pool, 1)

    expect(thr.world.phase).toBe('serial')
    expect(drainCalls).toBe(0) // the re-backing fence never fired across WAVES no-growth waves
    expect(thr.world.__columnGrowth().generation).toBe(genStart) // generation unchanged → zero re-wraps

    // Every entity still got exactly WAVES increments (the pool DID run the waves — the guard isn't
    // trivially green because nothing ran).
    for (let i = 0; i < N; i++) {
      const hp = (thr.world.entity(thr.handles[i]!).read(thr.Health) as { hp: number }).hp
      expect(hp).toBe(i + WAVES)
    }
  })
})
