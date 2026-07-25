// Orchestrator: session lifecycle, pointer input, the recorder, script playback (attract +
// presets), share/replay flow, the stats HUD, and the fixed-step frame pump. Everything that
// touches the sim goes through the per-tick event queue, so live painting, scripts, and replays
// are one code path — which is why a share URL reproduces any session byte for byte.

import { decodeSession, encodeSession } from './game/codec.js'
import type { RecEvent, SessionRecord } from './game/codec.js'
import { toSegment } from './game/feed.js'
import { PRESETS, attractProgram } from './game/scripts.js'
import { createRenderer } from './render/gl.js'
import { E_SAND, PALETTE, ROSTER } from './sim/elements.js'
import type { PaintEvent } from './sim/particles.js'
import { DT, PART_CAP, SIM_H, SIM_W, TICKS_PER_SECOND } from './sim/shared.js'
import { buildSim } from './sim/world.js'
import type { Sim } from './sim/world.js'

const $ = (id: string): HTMLElement => document.getElementById(id)!
const canvas = $('screen') as HTMLCanvasElement
const hudStats = $('hud-stats')
const hudMode = $('hud-mode')
const banner = $('banner')
const progress = $('progress')
const progressBar = progress.querySelector('b')!
const fatal = $('fatal')

// ---------------------------------------------------------------------------------------------
// Cross-origin isolation (GitHub Pages can't set COOP/COEP headers — a service worker adds them)
// ---------------------------------------------------------------------------------------------
async function ensureIsolation(): Promise<void> {
  if (crossOriginIsolated || !('serviceWorker' in navigator)) return
  if (sessionStorage.getItem('embers-coi') !== null) return
  try {
    sessionStorage.setItem('embers-coi', '1')
    await navigator.serviceWorker.register('./coi-sw.js')
    location.reload()
    await new Promise(() => {})
  } catch {
    // No service worker: single-threaded, and the HUD says so.
  }
}

const isolationOk = (): boolean => typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated === true
const workerCount = Math.min(6, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))
const makeWorker = (): Worker => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })

// ---------------------------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------------------------
let sim: Sim | null = null
let seed = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 0
let recorded: RecEvent[] = []
let script: RecEvent[] = []
let scriptAt = 0
let replayTarget: SessionRecord | null = null
let paused = false
let interacted = false
let attractArmed = true

const brush = { elem: E_SAND, r: 7 }
const pointer = { down: false, x: 0, y: 0 }
let liveLast: { x: number; y: number } | null = null
let scriptLast: { x: number; y: number } | null = null

function newSession(newSeed: number): void {
  if (sim !== null) void sim.dispose()
  seed = newSeed >>> 0
  const threaded = isolationOk()
  sim = buildSim({ seed, threaded, workers: workerCount, ...(threaded ? { createWorker: makeWorker } : {}) })
  recorded = []
  script = []
  scriptAt = 0
  liveLast = null
  scriptLast = null
  lastHash = null
}

function feedScript(events: RecEvent[], baseTick: number): void {
  const shifted = events.map((e) => ({ ...e, tick: e.tick + baseTick }))
  script = scriptAt < script.length ? [...script.slice(scriptAt), ...shifted] : shifted
  scriptAt = 0
  script.sort((a, b) => a.tick - b.tick)
}


/** Gather this tick's events (script first, then live pointer), record them, queue them. */
function pumpTickEvents(tick: number): void {
  const segs: PaintEvent[] = []
  while (scriptAt < script.length && script[scriptAt]!.tick <= tick) {
    const ev = script[scriptAt++]!
    if (ev.tick === tick) {
      segs.push(toSegment(ev, scriptLast))
      scriptLast = { x: ev.x, y: ev.y }
      recorded.push({ ...ev })
    }
  }
  if (pointer.down && replayTarget === null) {
    const ev: RecEvent = {
      tick,
      elem: brush.elem,
      x: pointer.x,
      y: pointer.y,
      r: brush.r,
      stroke: liveLast === null,
    }
    segs.push(toSegment(ev, liveLast))
    liveLast = { x: ev.x, y: ev.y }
    recorded.push(ev)
  }
  if (!pointer.down) liveLast = null
  if (segs.length > 0) sim!.queue(tick, segs)
}

// ---------------------------------------------------------------------------------------------
// Frame pump
// ---------------------------------------------------------------------------------------------
let renderer: ReturnType<typeof createRenderer> | null = null
let acc = 0
let lastNow = 0
let pumping = false
let simMs = 0
let frames = 0
let fps = 0
let fpsAt = 0
let lastHash: number | null = null
let hashAt = 0

async function pumpSteps(): Promise<void> {
  if (pumping || sim === null || paused) return
  pumping = true
  let ticks = 0
  while (acc >= DT && ticks < 3) {
    acc -= DT
    ticks++
    pumpTickEvents(sim.tick() + 1)
    const t0 = performance.now()
    const p = sim.step()
    if (p !== undefined) await p
    simMs = simMs * 0.9 + (performance.now() - t0) * 0.1
  }
  if (acc > DT * 3) acc = DT * 3
  if (ticks > 0 && renderer !== null) {
    renderer.updateCells(sim.cols())
    renderer.updateField(sim.fields())
  }
  pumping = false
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - lastNow) / 1000 || 0)
  lastNow = now
  if (!paused && replayTarget === null) acc += dt
  void pumpSteps()
  if (renderer !== null) {
    renderer.resize()
    renderer.render(now / 1000)
  }
  frames++
  if (now - fpsAt > 500) {
    fps = (frames * 1000) / (now - fpsAt)
    frames = 0
    fpsAt = now
    updateHud()
  }
  if (sim !== null && now - hashAt > 2000 && sim.live() < 40000) {
    // The full-state hash is honest but not free — refresh it only while the pool is light.
    lastHash = sim.hash() >>> 0
    hashAt = now
  }
}

function updateHud(): void {
  if (sim === null) return
  const t = sim.tick()
  const engine = sim.threaded ? `${workerCount}-worker field` : 'serial'
  hudStats.textContent =
    `grains ${sim.live().toString().padStart(6)} / ${PART_CAP}\n` +
    `sim ${simMs.toFixed(2).padStart(5)} ms   fps ${fps.toFixed(0).padStart(3)}\n` +
    `tick ${t}   ${engine}\n` +
    `hash ${lastHash === null ? '········' : lastHash.toString(16).padStart(8, '0')}`
  hudMode.textContent = paused ? 'PAUSED' : replayTarget !== null ? 'REPLAY' : ''
}

function toast(msg: string, ms = 2600): void {
  banner.textContent = msg
  banner.classList.add('show')
  window.setTimeout(() => banner.classList.remove('show'), ms)
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------
function simCoords(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  const x = Math.max(0, Math.min(SIM_W - 1, Math.floor(((e.clientX - r.left) / r.width) * SIM_W)))
  const y = Math.max(0, Math.min(SIM_H - 1, Math.floor(((e.clientY - r.top) / r.height) * SIM_H)))
  return { x, y }
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  canvas.setPointerCapture(e.pointerId)
  const p = simCoords(e)
  pointer.down = true
  pointer.x = p.x
  pointer.y = p.y
  if (!interacted) {
    interacted = true
    attractArmed = false
    script = []
    scriptAt = 0
  }
})
canvas.addEventListener('pointermove', (e) => {
  const p = simCoords(e)
  pointer.x = p.x
  pointer.y = p.y
})
const release = (): void => {
  pointer.down = false
}
canvas.addEventListener('pointerup', release)
canvas.addEventListener('pointercancel', release)
window.addEventListener('blur', release)

// ---------------------------------------------------------------------------------------------
// Dock UI
// ---------------------------------------------------------------------------------------------
function buildDock(): void {
  const rail = $('elements')
  for (const el of ROSTER) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.textContent = el.name
    const [r, g, bl] = PALETTE[el.id]!.rgb
    b.style.setProperty('--sw', `rgb(${r},${g},${bl})`)
    if (el.id === brush.elem) b.classList.add('on')
    b.onclick = () => {
      brush.elem = el.id
      rail.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'))
      b.classList.add('on')
    }
    rail.appendChild(b)
  }

  const controls = $('controls')
  const mkBtn = (label: string, fn: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.onclick = () => fn(b)
    controls.appendChild(b)
    return b
  }

  for (const preset of PRESETS) {
    mkBtn(preset.label, () => {
      interacted = true
      attractArmed = false
      newSession((crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 0)
      const prog = preset.make()
      feedScript(prog.events, sim!.tick() + 1)
      history.replaceState(null, '', location.pathname)
    })
  }

  const pauseBtn = mkBtn('PAUSE', (b) => {
    paused = !paused
    b.textContent = paused ? 'RESUME' : 'PAUSE'
    b.classList.toggle('on', paused)
    updateHud()
  })
  void pauseBtn

  mkBtn('CLEAR', () => {
    interacted = true
    attractArmed = false
    newSession((crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 0)
    history.replaceState(null, '', location.pathname)
  })

  mkBtn('SHARE', () => {
    void (async () => {
      if (sim === null) return
      const rec: SessionRecord = {
        seed,
        finalTick: sim.tick(),
        finalHash: sim.hash() >>> 0,
        events: recorded,
      }
      const payload = await encodeSession(rec)
      const url = `${location.origin}${location.pathname}#r=${payload}`
      history.replaceState(null, '', `#r=${payload}`)
      try {
        await navigator.clipboard.writeText(url)
        toast(`link copied — ${(url.length / 1024).toFixed(1)} kB\nanyone opening it re-simulates this exact scene`)
      } catch {
        toast('link is in the address bar')
      }
    })()
  })

  const sizes = document.createElement('div')
  sizes.className = 'sizes'
  controls.appendChild(sizes)
  for (const r of [3, 7, 14, 24]) {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = `${r}`
    if (r === brush.r) b.classList.add('on')
    b.onclick = () => {
      brush.r = r
      sizes.querySelectorAll('.btn').forEach((c) => c.classList.remove('on'))
      b.classList.add('on')
    }
    sizes.appendChild(b)
  }
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------
async function runReplay(rec: SessionRecord): Promise<void> {
  replayTarget = rec
  newSession(rec.seed)
  feedScript(rec.events, 0)
  progress.style.display = 'block'
  updateHud()
  const target = rec.finalTick
  while (sim !== null && sim.tick() < target) {
    const until = Math.min(target, sim.tick() + 240)
    while (sim.tick() < until) {
      pumpTickEvents(sim.tick() + 1)
      const p = sim.step()
      if (p !== undefined) await p
    }
    progressBar.style.width = `${((sim.tick() / target) * 100).toFixed(1)}%`
    if (renderer !== null) {
      renderer.updateCells(sim.cols())
      renderer.updateField(sim.fields())
    }
    await new Promise(requestAnimationFrame)
  }
  progress.style.display = 'none'
  if (sim === null) return
  const h = sim.hash() >>> 0
  lastHash = h
  const ok = h === rec.finalHash
  toast(
    ok
      ? `replay verified — ${rec.events.length} strokes re-simulated to hash ${h.toString(16).padStart(8, '0')}\nkeep painting, it is yours now`
      : `replay diverged — got ${h.toString(16).padStart(8, '0')}, expected ${rec.finalHash.toString(16).padStart(8, '0')}\nthis would be a determinism bug: please report it`,
    6000,
  )
  recorded = [...rec.events]
  replayTarget = null
  interacted = true
  attractArmed = false
  updateHud()
}

// ---------------------------------------------------------------------------------------------
// Headless bench/verify (#bench=serial|threaded&seed=N&ticks=N)
// ---------------------------------------------------------------------------------------------
async function runBench(kind: string, benchSeed: number, ticks: number): Promise<void> {
  const threaded = kind === 'threaded' && isolationOk()
  const s = buildSim({
    seed: benchSeed,
    threaded,
    workers: workerCount,
    ...(threaded ? { createWorker: makeWorker } : {}),
  })
  sim = s
  const prog = attractProgram()
  feedScript(prog.events, 0)
  const t0 = performance.now()
  for (let t = 0; t < ticks; t++) {
    pumpTickEvents(s.tick() + 1)
    const p = s.step()
    if (p !== undefined) await p
  }
  const msPerTick = (performance.now() - t0) / ticks
  const result = {
    kind,
    threaded: s.threaded,
    seed: benchSeed,
    ticks,
    hash: (s.hash() >>> 0).toString(16).padStart(8, '0'),
    live: s.live(),
    msPerTick,
  }
  ;(window as unknown as { __benchResult?: unknown }).__benchResult = result
  const el = document.createElement('div')
  el.id = 'bench-done'
  el.textContent = JSON.stringify(result)
  document.body.appendChild(el)
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
async function boot(): Promise<void> {
  const bench = /[#&]bench=(serial|threaded)/.exec(location.hash)
  if (bench === null) await ensureIsolation()
  try {
    renderer = bench === null ? createRenderer(canvas) : null
  } catch (err) {
    fatal.style.display = 'flex'
    fatal.textContent = `this demo needs WebGL2 — ${err instanceof Error ? err.message : 'unavailable'}`
    return
  }

  if (bench !== null) {
    const seedArg = Number(/[#&]seed=(\d+)/.exec(location.hash)?.[1] ?? '7') >>> 0
    const ticks = Math.max(1, Number(/[#&]ticks=(\d+)/.exec(location.hash)?.[1] ?? '600'))
    await runBench(bench[1]!, seedArg, ticks)
    return
  }

  buildDock()
  const r = /[#&]r=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (r !== null) {
    const rec = await decodeSession(r[1]!)
    if (rec !== null) {
      requestAnimationFrame(frame)
      await runReplay(rec)
      return
    }
    toast('that replay link did not decode — starting fresh')
  }

  newSession(seed)
  requestAnimationFrame(frame)
  window.setTimeout(() => {
    if (attractArmed && !interacted && sim !== null) {
      const prog = attractProgram()
      feedScript(prog.events, sim.tick() + 1)
    }
  }, 3000)
}

void boot()
