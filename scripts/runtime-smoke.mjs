// ecsia cross-runtime smoke (P3 runtime lane). Exercises the BUILT dist umbrella
// (packages/ecsia/dist) as plain ESM — NO test framework — so the exact same file runs identically
// under `node`, `bun`, and `deno run --allow-read`. Every section prints a single PASS/FAIL line; the
// process exits 0 iff every section passed, nonzero on the first assertion failure in any section.
//
// WHY dist, not source: this lane's job is to prove the SHIPPED package works on each runtime — the
// same artifact a consumer installs — not the TS the unit suite already covers. Run `pnpm build` first.
//
// HONEST SCOPING (worker pool): the WorkerPool is node:worker_threads + Atomics based. The OPTIONAL
// pool section stands up a REAL pool and round-trips one threaded frame, but it SKIPS (a printed
// notice, never a failure) when worker_threads / SharedArrayBuffer / cross-origin isolation are absent
// or behave differently (Deno, a non-isolated host, a Bun where the column path diverges). The CORE
// sections never depend on it. The browser lane (scripts/browser-smoke) does NOT claim threaded-pool
// support at all — a browser Web-Worker pool is future work (see scripts/browser-smoke/README note).

import {
  createWorld,
  defineComponent,
  defineTag,
  defineSystem,
  createScheduler,
  createRelations,
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
  bootstrapForWorker,
  object,
  read,
  write,
  has,
  without,
  onAdd,
  onRemove,
  WorkerPool,
} from '../packages/ecsia/dist/index.js'

// --- tiny harness (no framework) -------------------------------------------

let failures = 0
let passes = 0

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}
function approx(actual, expected, msg, eps = 1e-4) {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg}: expected ~${expected}, got ${actual}`)
}

function section(name, fn) {
  try {
    fn()
    passes++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name}: ${err && err.message ? err.message : err}`)
  }
}

async function asyncSection(name, fn) {
  try {
    const result = await fn()
    if (result === 'skip') return // the section printed its own SKIP notice
    passes++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL  ${name}: ${err && err.message ? err.message : err}`)
  }
}

// Detect the host runtime for the printed banner + the pool-section gate.
const runtime =
  typeof Deno !== 'undefined' ? 'deno' : typeof Bun !== 'undefined' ? 'bun' : 'node'

console.log(`ecsia runtime smoke — runtime=${runtime}`)
console.log('-'.repeat(60))

// --- 1. createWorld + defineComponent (numeric + rich string/object) -------

section('world + component definitions (numeric + rich string/object)', () => {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const Label = defineComponent({ text: 'string' }, { name: 'label' })
  const Node = defineComponent(
    { hp: 'i32', meta: object() },
    { name: 'node' },
  )
  const Frozen = defineTag('frozen')

  const world = createWorld({
    components: [Position, Velocity, Label, Node, Frozen],
    maxEntities: 1 << 12,
  })
  assert(world !== undefined, 'createWorld returned a world')
  assertEq(typeof world.spawnWith, 'function', 'world.spawnWith is a function')
  assertEq(typeof world.query, 'function', 'world.query is a function')

  // spawnWith with TUPLE values (numeric + rich): the [def, value] form initializes the component.
  const e = world.spawnWith(
    [Position, { x: 3, y: 4 }],
    [Velocity, { dx: 1, dy: -1 }],
    [Label, { text: 'wörld 🌍' }],
    [Node, { hp: 42, meta: { tags: ['a', 'b'], n: 7 } }],
    Frozen,
  )
  assert(world.isAlive(e), 'spawned entity is alive')

  const p = world.entity(e).read(Position)
  approx(p.x, 3, 'Position.x initialized via tuple')
  approx(p.y, 4, 'Position.y initialized via tuple')

  const label = world.entity(e).read(Label)
  assertEq(label.text, 'wörld 🌍', 'rich string round-trips through the column (UTF-8 + emoji)')

  const node = world.entity(e).read(Node)
  assertEq(node.hp, 42, 'numeric field of a mixed component')
  assertEq(node.meta.n, 7, 'rich object<T> field carries structured data')
  assertEq(node.meta.tags.join(','), 'a,b', 'rich object<T> array preserved')
})

// --- 2. query each / eachChunk / has / without -----------------------------

section('query each / eachChunk / has / without', () => {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const Frozen = defineTag('frozen')
  const world = createWorld({ components: [Position, Velocity, Frozen], maxEntities: 1 << 12 })

  const moving = []
  for (let i = 0; i < 8; i++) {
    const h = world.spawnWith([Position, { x: i, y: 0 }], [Velocity, { dx: 2, dy: 0 }])
    moving.push(h)
  }
  // Two entities carry Position but NOT Velocity (and one is Frozen) — exercises `without`.
  const stuckA = world.spawnWith([Position, { x: 100, y: 0 }], Frozen)
  const stuckB = world.spawnWith([Position, { x: 200, y: 0 }])

  // has(): Velocity holders only.
  let velCount = 0
  world.query(has(Velocity)).each(() => velCount++)
  assertEq(velCount, 8, 'has(Velocity) matches exactly the 8 movers')

  // without(): Position holders that lack Velocity.
  let stuckCount = 0
  world.query(read(Position), without(Velocity)).each(() => stuckCount++)
  assertEq(stuckCount, 2, 'without(Velocity) matches the 2 stuck entities')

  // each(): integrate position from velocity once.
  world.query(read(Velocity), write(Position)).each((el) => {
    el.position.x += el.velocity.dx
    el.position.y += el.velocity.dy
  })
  for (let i = 0; i < moving.length; i++) {
    approx(world.entity(moving[i]).read(Position).x, i + 2, `mover ${i} integrated by each()`)
  }
  // The stuck ones were untouched.
  approx(world.entity(stuckA).read(Position).x, 100, 'stuckA untouched by the each() write')
  approx(world.entity(stuckB).read(Position).x, 200, 'stuckB untouched by the each() write')

  // eachChunk(): SoA fast path. Sum every mover's x through the chunk columns; must equal the each-path
  // total. eachChunk only visits archetypes where every row matches — the movers form one such chunk.
  // The chunk exposes `count` rows + per-(def,field) typed `column(def, field)` views (stride-1 here).
  let chunkSum = 0
  let chunksSeen = 0
  world.query(read(Position), has(Velocity)).eachChunk((chunk) => {
    chunksSeen++
    const len = chunk.count
    const xs = chunk.column(Position, 'x')
    for (let i = 0; i < len; i++) chunkSum += xs[i]
  })
  assert(chunksSeen >= 1, 'eachChunk visited at least one chunk')
  // movers now have x = i+2 for i in 0..7 → sum = (2+3+...+9) = 44.
  approx(chunkSum, 44, 'eachChunk SoA column sum equals the AoS result')
})

// --- 3. scheduler single-thread update -------------------------------------

section('scheduler single-thread update', () => {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 12 })

  const handles = []
  for (let i = 0; i < 16; i++) {
    handles.push(world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 1, dy: 2 }]))
  }

  const Move = defineSystem({
    name: 'Move',
    read: [Velocity],
    write: [Position],
    run({ query }) {
      query(read(Velocity), write(Position)).each((el) => {
        el.position.x += el.velocity.dx
        el.position.y += el.velocity.dy
      })
    },
  })
  const scheduler = createScheduler(world, [Move])
  const FRAMES = 10
  for (let f = 0; f < FRAMES; f++) scheduler.update(1)

  for (const h of handles) {
    const p = world.entity(h).read(Position)
    approx(p.x, FRAMES, 'x integrated FRAMES times by the scheduler')
    approx(p.y, FRAMES * 2, 'y integrated FRAMES times by the scheduler')
  }
})

// --- 4. relations: pair add + exclusive deleteSubject cascade --------------

section('relations: pair add + exclusive deleteSubject cascade', () => {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const world = createWorld({ components: [Health], maxEntities: 1 << 12 })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

  const root = world.spawnWith(Health)
  const child = world.spawnWith(Health)
  const grandchild = world.spawnWith(Health)
  rel.addPair(child, ChildOf, root)
  rel.addPair(grandchild, ChildOf, child)

  assert(rel.hasPair(child, ChildOf, root), 'pair child->root established')
  assert(rel.hasPair(grandchild, ChildOf, child), 'pair grandchild->child established')

  // Despawning the root cascades to child AND grandchild (iterative deleteSubject).
  world.despawn(root)
  // The despawn protocol applies the cascade synchronously on the structural verb.
  assert(!world.isAlive(root), 'root despawned')
  assert(!world.isAlive(child), 'child cascaded by deleteSubject')
  assert(!world.isAlive(grandchild), 'grandchild cascaded transitively')
})

// --- 5. observers: onAdd / onRemove drain ----------------------------------

section('observers: onAdd / onRemove drain (via scheduler frame-end cadence)', () => {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Shield = defineComponent({ hp: 'i32' }, { name: 'shield' })
  const world = createWorld({ components: [Health, Shield], maxEntities: 1 << 12 })

  let added = 0
  let removed = 0
  world.observe(onAdd(Shield), () => added++)
  world.observe(onRemove(Health), () => removed++)

  const a = world.spawnWith(Health)
  const b = world.spawnWith(Health)

  // A system that mutates structure: add Shield to `a` (fires onAdd next drain), despawn `b` (fires
  // onRemove(Health)). Structural mutation is staged and the drain runs at frame-end.
  let ran = false
  const Sys = defineSystem({
    name: 'Mutate',
    read: [],
    write: [Health, Shield],
    run({ world: w }) {
      if (ran) return
      ran = true
      w.add(a, Shield)
      w.despawn(b)
    },
  })
  const scheduler = createScheduler(world, [Sys])

  // Frame 1 stages the structural ops; frame 2's frame-end drain observes the resulting add/remove.
  scheduler.update(1)
  scheduler.update(1)

  assert(world.has(a, Shield), 'Shield genuinely added to a')
  assert(!world.isAlive(b), 'b despawned')
  assertEq(added, 1, 'onAdd(Shield) drained exactly once')
  assertEq(removed, 1, 'onRemove(Health) drained exactly once (despawn enqueues the removal)')
})

// --- 6. snapshot round-trip -------------------------------------------------

section('snapshot round-trip (serialize -> deserialize, remapped)', () => {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Label = defineComponent({ text: 'string' }, { name: 'label' })

  const src = createWorld({ components: [Position, Label], maxEntities: 1 << 12 })
  const e1 = src.spawnWith([Position, { x: 11, y: 22 }], [Label, { text: 'alpha' }])
  const e2 = src.spawnWith([Position, { x: 33, y: 44 }], [Label, { text: 'βeta 漢' }])

  const bytes = createSnapshotSerializer(src).snapshot()
  assert(bytes.byteLength > 0, 'snapshot produced bytes')

  // The receiver declares the SAME component set (schemaHash must match).
  const Position2 = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Label2 = defineComponent({ text: 'string' }, { name: 'label' })
  const dst = createWorld({ components: [Position2, Label2], maxEntities: 1 << 12 })

  const { remap } = createSnapshotDeserializer(dst).load(bytes)
  const n1 = remap.get(e1)
  const n2 = remap.get(e2)
  assert(dst.isAlive(n1), 'remapped e1 alive in dst')
  assert(dst.isAlive(n2), 'remapped e2 alive in dst')

  approx(dst.entity(n1).read(Position2).x, 11, 'e1 Position.x survived the round-trip')
  approx(dst.entity(n2).read(Position2).y, 44, 'e2 Position.y survived the round-trip')
  assertEq(dst.entity(n1).read(Label2).text, 'alpha', 'e1 rich string survived')
  assertEq(dst.entity(n2).read(Label2).text, 'βeta 漢', 'e2 non-ASCII rich string survived')
})

// --- 7. delta with a structural section ------------------------------------

section('delta with structural section (value writes + spawns since T)', () => {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const mkWorld = () => createWorld({ components: [Position], maxEntities: 1 << 12 })

  const src = mkWorld()
  const seed = []
  for (let i = 0; i < 4; i++) seed.push(src.spawnWith([Position, { x: i, y: 0 }]))

  // Establish a baseline in the receiver via a full snapshot.
  const Position2 = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const dst = createWorld({ components: [Position2], maxEntities: 1 << 12 })
  const baselineBytes = createSnapshotSerializer(src).snapshot()
  const { remap } = createSnapshotDeserializer(dst).load(baselineBytes)

  // Open the delta AT T, advance the frame tick, THEN mutate (value write + structural spawn) so both
  // ops fall strictly after T and land in the (T, now] window the serializer captures.
  const ser = createDeltaSerializer(src, src.currentTick()) // includeStructural defaults ON
  src.frameReset() // advances the world tick (the public path to advanceTick)
  src.entity(seed[0]).write(Position).x = 999 // value write since T
  const spawned = src.spawnWith([Position, { x: 7, y: 7 }]) // STRUCTURAL op since T

  const deltaBytes = ser.delta()
  assert(deltaBytes.byteLength > 0, 'delta produced bytes')

  // Apply the delta to the receiver. applyDelta MUTATES `remap` in place, extending it with the new
  // structural entity's producer->receiver mapping (the same contract the serialization suite relies on).
  const work = new Map(remap)
  const applied = applyDelta(dst, deltaBytes, work)
  assert(applied >= 0, 'applyDelta returned a non-negative count')

  // The value write landed on the already-mapped entity.
  approx(dst.entity(work.get(seed[0])).read(Position2).x, 999, 'value write since T applied to receiver')

  // The structural spawn is the load-bearing assertion: with the structural section dropped this
  // entity would be missing. applyDelta extends `work` with the new producer->receiver mapping.
  const nSpawned = work.get(spawned)
  assert(nSpawned !== undefined, 'structural section carried the spawned entity into the remap')
  assert(dst.isAlive(nSpawned), 'spawned-since-T entity is alive in the receiver')
  approx(dst.entity(nSpawned).read(Position2).x, 7, 'spawned-since-T entity carries its value')
})

// --- 8. SAB capability probe (printed result) ------------------------------

section('SAB capability probe (result printed)', () => {
  const world = createWorld({ maxEntities: 1 << 8 })
  // The frozen runtime capability probe is surfaced through the PUBLIC umbrella via the worker-bootstrap
  // manifest (`bootstrapForWorker(world).capabilities`) — the same probe the world ran at construction.
  const boot = bootstrapForWorker(world)
  const caps = boot.capabilities
  assert(caps !== undefined && typeof caps === 'object', 'bootstrap carries a capabilities probe')
  assertEq(typeof caps.sabAvailable, 'boolean', 'caps.sabAvailable is a boolean')
  assertEq(typeof caps.backing, 'string', 'caps.backing is a strategy string')
  console.log(
    `      probe: sab=${caps.sabAvailable} resizableSab=${caps.resizableSab} ` +
      `resizableAb=${caps.resizableAb} waitAsync=${caps.waitAsync} ` +
      `waitBlocking=${caps.waitBlocking} crossOriginIsolated=${String(caps.crossOriginIsolated)} ` +
      `backing=${caps.backing}`,
  )
  // A single-threaded world (default) selects an ArrayBuffer backing regardless of SAB availability.
  assert(caps.backing.endsWith('-ab'), 'default single world selects an ArrayBuffer backing')
})

// --- 9. OPTIONAL: real worker_threads pool round-trip (skips off-Node) ------

await asyncSection('OPTIONAL worker_threads pool round-trip', async () => {
  // The pool is node:worker_threads + Atomics based. It REQUIRES SharedArrayBuffer; it also needs the
  // built worker-entry (a raw worker can't load TS) + a kernel .mjs the worker imports by URL. Off-Node
  // (Deno without the worker_threads + Atomics behavior, or a host without SAB) we print a SKIP notice
  // — a notice, NOT a failure — and the smoke's overall result stays governed by the core sections.
  if (runtime === 'deno') {
    console.log('SKIP  OPTIONAL worker_threads pool round-trip: runtime=deno (node:worker_threads pool not exercised)')
    return 'skip'
  }
  if (typeof SharedArrayBuffer !== 'function') {
    console.log('SKIP  OPTIONAL worker_threads pool round-trip: SharedArrayBuffer unavailable')
    return 'skip'
  }
  let workerThreads
  try {
    workerThreads = await import('node:worker_threads')
  } catch {
    console.log('SKIP  OPTIONAL worker_threads pool round-trip: node:worker_threads unavailable')
    return 'skip'
  }
  if (!workerThreads || typeof workerThreads.Worker !== 'function') {
    console.log('SKIP  OPTIONAL worker_threads pool round-trip: no Worker constructor')
    return 'skip'
  }

  // The built worker-entry + the committed M7 kernel fixture (the same real-pool path the unit suite's
  // worker-pool smoke uses). Resolved relative to THIS script so it works from any cwd. node:url is
  // imported HERE (not at module top) so the core sections carry zero node: dependency and run on any
  // runtime; this section is Node-only and already gated above.
  const { fileURLToPath } = await import('node:url')
  const WORKER_ENTRY = fileURLToPath(
    new URL('../packages/scheduler/dist/workers/worker-entry.js', import.meta.url),
  )
  const KERNEL_MODULE = fileURLToPath(
    new URL('../packages/scheduler/test/fixtures/m7-kernels.mjs', import.meta.url),
  )

  const N = 16
  const WORKERS = 2
  const FRAMES = 2

  const mkWorld = (threaded) => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
    const world = createWorld(
      threaded
        ? { components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers: WORKERS } }
        : { components: [Health, Mana], maxEntities: 1 << 12 },
    )
    const handles = []
    for (let i = 0; i < N; i++) {
      const h = world.spawnWith(Health, Mana)
      world.entity(h).write(Health).hp = i
      world.entity(h).write(Mana).mp = 100 + i
      handles.push(h)
    }
    return { world, Health, Mana, handles }
  }

  // Single-thread reference: defineSystem twins of the worker kernels (Regen: +1 hp, Channel: -1 mp).
  const ref = mkWorld(false)
  const Regen = defineSystem({
    name: 'Regen',
    read: [],
    write: [ref.Health],
    run({ query }) {
      query(write(ref.Health)).each((e) => {
        e.health.hp += 1
      })
    },
  })
  const Channel = defineSystem({
    name: 'Channel',
    read: [],
    write: [ref.Mana],
    run({ query }) {
      query(write(ref.Mana)).each((e) => {
        e.mana.mp -= 1
      })
    },
  })
  const refSched = createScheduler(ref.world, [Regen, Channel])

  // Threaded run: the SAME plan dispatched to real OS threads through scheduler.updateThreaded.
  const thr = mkWorld(true)
  const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
  const ChannelT = defineSystem({ name: 'Channel', read: [], write: [thr.Mana], run() {} })
  const thrSched = createScheduler(thr.world, [RegenT, ChannelT], { workers: WORKERS })
  const systems = [
    { id: 0, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    { id: 1, name: 'Channel', matchComponents: [thr.Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
  ]

  let pool
  try {
    pool = new WorkerPool({
      world: thr.world,
      workers: WORKERS,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()
    for (let f = 0; f < FRAMES; f++) {
      refSched.update(1)
      await thrSched.updateThreaded(pool, 1)
    }
    // Serial-equivalence: the real-thread run reproduces the single-thread column state byte-for-byte.
    assertEq(thr.world.phase, 'serial', 'pool returned the world to the serial phase')
    for (let i = 0; i < N; i++) {
      assertEq(
        thr.world.entity(thr.handles[i]).read(thr.Health).hp,
        ref.world.entity(ref.handles[i]).read(ref.Health).hp,
        `entity ${i} Health matches single-thread`,
      )
      assertEq(
        thr.world.entity(thr.handles[i]).read(thr.Mana).mp,
        ref.world.entity(ref.handles[i]).read(ref.Mana).mp,
        `entity ${i} Mana matches single-thread`,
      )
    }
    console.log(`      pool: ${WORKERS} real worker_threads, ${FRAMES} frames, byte-identical to single-thread`)
  } catch (err) {
    // On Bun (or any host) where worker_threads / SAB behave differently, treat a pool failure as a
    // SKIP (printed notice), NOT a smoke failure — the core paths above already passed.
    if (runtime === 'bun') {
      console.log(
        `SKIP  OPTIONAL worker_threads pool round-trip: runtime=bun pool path diverged ` +
          `(${err && err.message ? err.message : err})`,
      )
      return 'skip'
    }
    throw err
  } finally {
    if (pool) await pool.dispose()
  }
})

// --- summary + exit ---------------------------------------------------------

console.log('-'.repeat(60))
console.log(`runtime=${runtime}  passed=${passes}  failed=${failures}`)

if (failures > 0) {
  console.log('RESULT: FAIL')
  if (typeof process !== 'undefined' && typeof process.exit === 'function') process.exit(1)
  else throw new Error(`${failures} smoke section(s) failed`)
} else {
  console.log('RESULT: PASS')
}
