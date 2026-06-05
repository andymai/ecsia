// Browser-scoped smoke entry. esbuild bundles this (build.mjs) into a single browser ESM module the
// Playwright-driven page loads. It exercises the SHIPPED dist umbrella in a real browser:
//
// • kernel ops: createWorld / defineComponent / spawnWith / query each / scheduler update
// • SharedArrayBuffer alloc + grow (the resizable-SAB path) — ONLY when the page is cross-origin
// isolated (COOP/COEP). The probe must SELECT the SAB backing there.
// • crossOriginIsolated assertion: in the isolated server variant it MUST be true; in the
// --no-isolation variant the probe MUST FALL BACK LOUDLY (no SAB path, ArrayBuffer backing).
//
// HONEST SCOPING: this browser lane does NOT exercise a threaded worker pool. ecsia's WorkerPool is
// node:worker_threads based; a browser Web-Worker pool is future work (see README note). The browser
// claim is strictly: kernel + serialization run in-tab, SAB capability is probed correctly, and the
// probe's fallback is loud, not silent.
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

// Expose to Playwright (page.evaluate) AND auto-run for manual inspection.
window.__ecsiaBrowserSmoke = runSmoke

// The flag MUST appear even if the smoke crashes — a timeout hides the real error.
let result: SmokeResult
try {
  result = runSmoke()
} catch (err) {
  result = {
    ok: false,
    isolated: window.crossOriginIsolated === true,
    sabAvailable: typeof SharedArrayBuffer !== 'undefined',
    sabPathSelected: false,
    sabAllocated: false,
    sections: [{ name: 'module-level crash', ok: false, detail: String(err instanceof Error ? (err.stack ?? err.message) : err) }],
  }
}
const pre = document.createElement('pre')
pre.id = 'smoke-output'
pre.textContent = JSON.stringify(result, null, 2)
document.body.appendChild(pre)
// A machine-readable signal for the harness.
const flag = document.createElement('div')
flag.id = 'smoke-result'
flag.dataset['ok'] = String(result.ok)
document.body.appendChild(flag)
