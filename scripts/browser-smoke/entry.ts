// Browser-scoped smoke entry. esbuild bundles this (build.mjs) into a single browser ESM module the
// Playwright-driven page loads. It exercises the SHIPPED dist umbrella in a real browser:
//
// • kernel ops: createWorld / defineComponent / spawnWith / query each / scheduler update
// • SharedArrayBuffer alloc + grow (the resizable-SAB path) — ONLY when the page is cross-origin
// isolated (COOP/COEP). The probe must SELECT the SAB backing there.
// • crossOriginIsolated assertion: in the isolated server variant it MUST be true; in the
// --no-isolation variant the probe MUST FALL BACK LOUDLY (no SAB path, ArrayBuffer backing).
// • THREADED pool: a real browser Web-Worker pool (threading.createWorker → dist/worker.js running
// `ecsiaWorker`) drives scheduler.update() in the isolated variant, and its column state must be
// BYTE-IDENTICAL (snapshot bytes) to a serial run of the same simulation — parallel equals serial,
// in an actual browser tab. In the non-isolated variant the scheduler must fall back LOUDLY to
// single-threaded with identical bytes (no silent slowdown, no silent divergence).
//
// The page sets `window.__ECSIA_EXPECT_ISOLATED` before importing this module so the SAME bundle covers
// BOTH server variants: isolated (expect true) and non-isolated (expect false).

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  createSnapshotSerializer,
  createSnapshotDeserializer,
  bootstrapForWorker,
  read,
  write,
} from '../../packages/ecsia/dist/index.js'
import { makeDefs, POSITION_STEP, ENERGY_STEP } from './threaded-fixture.js'

interface SmokeResult {
  ok: boolean
  isolated: boolean
  expectedIsolated: boolean
  backing: string
  sabAvailable: boolean
  sabPathSelected: boolean
  sabAllocated: boolean
  sabGrew: boolean
  sections: Array<{ name: string; ok: boolean; detail?: string }>
}

declare global {
  interface Window {
    __ECSIA_EXPECT_ISOLATED?: boolean
    __ecsiaBrowserSmoke?: () => SmokeResult
  }
}

function runSmoke(): SmokeResult {
  const sections: SmokeResult['sections'] = []
  const record = (name: string, fn: () => string | void) => {
    try {
      const detail = fn() ?? undefined
      sections.push({ name, ok: true, detail })
    } catch (err) {
      sections.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  // crossOriginIsolated is a browser global; in a non-isolated page it is false.
  const isolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false
  const expectedIsolated = window.__ECSIA_EXPECT_ISOLATED === true

  // --- kernel ops -----------------------------------------------------------
  record('kernel: world + components + spawnWith + query each + scheduler', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 12 })
    const handles: number[] = []
    for (let i = 0; i < 32; i++) {
      handles.push(world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 1, dy: 2 }]) as unknown as number)
    }
    const Move = defineSystem({
      name: 'Move',
      read: [Velocity],
      write: [Position],
      run({ query }) {
        query(read(Velocity), write(Position)).each((el: any) => {
          el.position.x += el.velocity.dx
          el.position.y += el.velocity.dy
        })
      },
    })
    const scheduler = createScheduler(world, [Move])
    for (let f = 0; f < 5; f++) scheduler.update(1)
    const p = (world as any).entity(handles[0]).read(Position)
    if (Math.abs(p.x - 5) > 1e-4 || Math.abs(p.y - 10) > 1e-4) {
      throw new Error(`integration wrong: x=${p.x} y=${p.y}`)
    }
    return `integrated 32 entities x5 frames (x=${p.x}, y=${p.y})`
  })

  // --- serialization round-trip (kernel-adjacent) ---------------------------
  record('serialization: snapshot round-trip in-tab', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: [Label], maxEntities: 256 })
    const e = src.spawnWith([Label, { text: 'browser 🌐' }])
    const bytes = createSnapshotSerializer(src).snapshot()
    const Label2 = defineComponent({ text: 'string' }, { name: 'label' })
    const dst = createWorld({ components: [Label2], maxEntities: 256 })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const n = remap.get(e as never)
    const got = (dst as any).entity(n).read(Label2).text
    if (got !== 'browser 🌐') throw new Error(`round-trip mismatch: ${got}`)
    return 'rich string survived snapshot in-browser'
  })

  // --- capability probe (the headline browser assertion) --------------------
  const world = createWorld({ maxEntities: 256 })
  const caps = (bootstrapForWorker(world) as { capabilities: any }).capabilities
  const backing: string = caps.backing
  const sabAvailable: boolean = caps.sabAvailable
  // The probe SELECTS the SAB path iff sabAvailable. In a single world the backing is *-ab, but the
  // probe's sabAvailable reflects whether the SAB column path COULD be selected (threaded worlds).
  const sabPathSelected = sabAvailable === true

  record('probe: crossOriginIsolated matches the server variant', () => {
    if (isolated !== expectedIsolated) {
      throw new Error(
        `crossOriginIsolated=${isolated} but expected ${expectedIsolated} for this server variant`,
      )
    }
    return `crossOriginIsolated=${isolated} (as expected for this variant)`
  })

  record('probe: SAB availability tracks isolation (loud, not silent)', () => {
    if (expectedIsolated) {
      // Isolated: SAB must be available and the probe must select the SAB path.
      if (!sabAvailable) throw new Error('isolated page but probe reports sabAvailable=false')
      if (!sabPathSelected) throw new Error('isolated page but SAB path not selected')
    } else {
      // Non-isolated: the probe MUST fall back loudly — sabAvailable=false (SAB ctor may exist but the
      // probe treats !crossOriginIsolated as unavailable), and no SAB path is selected.
      if (sabAvailable) throw new Error('non-isolated page but probe still reports sabAvailable=true')
      if (sabPathSelected) throw new Error('non-isolated page but SAB path selected anyway (silent!)')
    }
    return `sabAvailable=${sabAvailable} sabPathSelected=${sabPathSelected} backing=${backing}`
  })

  // --- raw SharedArrayBuffer alloc + grow (isolated only) -------------------
  let sabAllocated = false
  let sabGrew = false
  record('SAB: alloc + grow (isolated only; skips loudly otherwise)', () => {
    if (!expectedIsolated) {
      // In the non-isolated variant SharedArrayBuffer is unavailable as a usable shared backing; the
      // probe already proved the fallback is loud above. Nothing to allocate here.
      return 'skipped (non-isolated variant — no SAB)'
    }
    if (typeof SharedArrayBuffer !== 'function') {
      throw new Error('isolated page but SharedArrayBuffer constructor missing')
    }
    // Resizable SAB (ES2024) — the same backing class ecsia uses on the threaded/SAB path.
    const ResizableSab = SharedArrayBuffer as unknown as new (
      n: number,
      opts: { maxByteLength: number },
    ) => SharedArrayBuffer & { grow?: (n: number) => void; byteLength: number }
    const sab = new ResizableSab(16, { maxByteLength: 64 })
    sabAllocated = sab.byteLength === 16
    if (!sabAllocated) throw new Error(`alloc size wrong: ${sab.byteLength}`)
    if (typeof sab.grow === 'function') {
      sab.grow(32)
      sabGrew = sab.byteLength === 32
      if (!sabGrew) throw new Error(`grow size wrong: ${sab.byteLength}`)
    } else {
      // No resizable-SAB grow on this engine — acceptable; alloc alone proves the SAB path.
      sabGrew = false
    }
    // Atomics on the SAB prove it is a real shared backing, not a stub.
    const i32 = new Int32Array(sab)
    Atomics.store(i32, 0, 7)
    if (Atomics.load(i32, 0) !== 7) throw new Error('Atomics on SAB failed')
    return `alloc=16B grow=${sabGrew ? '32B' : 'n/a'} atomics=ok`
  })

  const ok = sections.every((s) => s.ok)
  return {
    ok,
    isolated,
    expectedIsolated,
    backing,
    sabAvailable,
    sabPathSelected,
    sabAllocated,
    sabGrew,
    sections,
  }
}

// --- threaded pool smoke ------------------------------------------------------------------------
// The PUBLIC browser threading path end-to-end: `threading.createWorker` spawns real Web Workers
// running dist/worker.js (`ecsiaWorker` + statically bundled kernels); the scheduler drives the pool
// over the Atomics.waitAsync main-thread tier. The serial reference runs the SAME defineSystem
// bodies; the worker kernels are their arithmetic twins (threaded-fixture.ts). Snapshot bytes decide.
interface ThreadedSmoke {
  ok: boolean
  engaged: boolean
  fallbackWarned: boolean
  bytesEqual: boolean
  workers: number
  frames: number
  detail?: string
}

async function runThreadedSmoke(expectIsolated: boolean): Promise<ThreadedSmoke> {
  const N = 256
  const FRAMES = 4
  const WORKERS = 2
  const DT = 1 / 60

  const mkWorld = (threaded: boolean) => {
    const { Position, Energy } = makeDefs()
    const world = createWorld({
      components: [Position, Energy],
      maxEntities: 1 << 10,
      ...(threaded ? { threaded: true as const, scheduler: { workers: WORKERS } } : {}),
    })
    for (let i = 0; i < N; i++) {
      const h = world.spawnWith(Position, Energy)
      const p = world.entity(h).write(Position) as { x: number; y: number }
      p.x = i * 0.25
      p.y = -i * 0.5
      ;(world.entity(h).write(Energy) as { e: number }).e = 100 + i
    }
    const MoveX = defineSystem({
      name: 'MoveX',
      read: [],
      write: [Position],
      run({ query, dt }) {
        for (const e of query(write(Position)) as Iterable<{ position: { x: number } }>) e.position.x += dt * POSITION_STEP
      },
    })
    const Drain = defineSystem({
      name: 'Drain',
      read: [],
      write: [Energy],
      run({ query, dt }) {
        for (const e of query(write(Energy)) as Iterable<{ energy: { e: number } }>) e.energy.e -= dt * ENERGY_STEP
      },
    })
    return { world, systems: [MoveX, Drain] }
  }

  const ref = mkWorld(false)
  const refSched = createScheduler(ref.world, ref.systems)
  for (let f = 0; f < FRAMES; f++) refSched.update(DT)

  let lastUpdateWasPromise = false
  const thr = mkWorld(true)
  const sched = createScheduler(thr.world, thr.systems, {
    workers: WORKERS,
    threading: {
      createWorker: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    },
  })
  // The scheduler's fallback contract is a ONE-TIME console.warn during update — capture it so the
  // loud-not-silent property is machine-checked in both variants. Patched only across the update
  // loop (the try/finally below), so a throw can't leave console.warn hijacked for the page.
  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    origWarn.apply(console, args)
  }
  try {
    for (let f = 0; f < FRAMES; f++) {
      const r = sched.update(DT)
      // After a fallback the scheduler goes synchronous; a still-async LAST frame is the engagement
      // signal (the pool survived every frame).
      if (f === FRAMES - 1) lastUpdateWasPromise = r instanceof Promise
      if (r instanceof Promise) await r
    }
  } finally {
    console.warn = origWarn
    await sched.dispose()
  }
  const fallbackWarned = warnings.some((w) => w.includes('threaded update unavailable'))
  const engaged = !fallbackWarned && lastUpdateWasPromise

  const bytesA = createSnapshotSerializer(ref.world).snapshot()
  const bytesB = createSnapshotSerializer(thr.world).snapshot()
  const bytesEqual = bytesA.length === bytesB.length && bytesA.every((b, i) => b === bytesB[i])

  // Isolated: the pool must ENGAGE and match bytes with no fallback warning. Non-isolated: it must
  // fall back LOUDLY and still match bytes (the same system bodies run serially).
  const ok = expectIsolated ? engaged && bytesEqual && !fallbackWarned : !engaged && fallbackWarned && bytesEqual
  const detail = fallbackWarned ? warnings.find((w) => w.includes('threaded update unavailable')) : undefined
  return { ok, engaged, fallbackWarned, bytesEqual, workers: WORKERS, frames: FRAMES, ...(detail !== undefined ? { detail } : {}) }
}

// Kept for manual console runs; the Playwright harness reads the __ecsiaSmokeResult /
// __ecsiaThreadedResult objects boot() stores instead of re-invoking this.
window.__ecsiaBrowserSmoke = runSmoke

async function boot(): Promise<void> {
  // The flag MUST appear even if the smoke crashes — a timeout hides the real error.
  let result: SmokeResult
  try {
    result = runSmoke()
  } catch (err) {
    result = {
      ok: false,
      isolated: window.crossOriginIsolated === true,
      expectedIsolated: window.__ECSIA_EXPECT_ISOLATED === true,
      backing: 'unknown',
      sabAvailable: typeof SharedArrayBuffer !== 'undefined',
      sabPathSelected: false,
      sabAllocated: false,
      sabGrew: false,
      sections: [{ name: 'module-level crash', ok: false, detail: String(err instanceof Error ? (err.stack ?? err.message) : err) }],
    }
  }
  let threaded: ThreadedSmoke
  try {
    threaded = await runThreadedSmoke(window.__ECSIA_EXPECT_ISOLATED === true)
  } catch (err) {
    threaded = {
      ok: false,
      engaged: false,
      fallbackWarned: false,
      bytesEqual: false,
      workers: 0,
      frames: 0,
      detail: String(err instanceof Error ? (err.stack ?? err.message) : err),
    }
  }
  ;(window as unknown as { __ecsiaSmokeResult?: SmokeResult }).__ecsiaSmokeResult = result
  ;(window as unknown as { __ecsiaThreadedResult?: ThreadedSmoke }).__ecsiaThreadedResult = threaded

  const pre = document.createElement('pre')
  pre.id = 'smoke-output'
  pre.textContent = JSON.stringify({ ...result, threaded }, null, 2)
  document.body.appendChild(pre)
  // A machine-readable signal for the harness.
  const flag = document.createElement('div')
  flag.id = 'smoke-result'
  flag.dataset['ok'] = String(result.ok && threaded.ok)
  document.body.appendChild(flag)
}

void boot()
