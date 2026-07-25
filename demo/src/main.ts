// ECHO SURVIVORS — the orchestrator. Owns everything OUTSIDE the deterministic sim: the CRT page,
// input sampling, the run/echo state machine (8 lives, each death adds a ghost), render-only
// particles, the perf HUD with the live state hash, threading controls, and the replay-URL share
// flow. The sim itself lives in sim/ and is driven one fixed 60Hz tick at a time; on the threaded
// path each tick is awaited across the Web-Worker pool.

import { read } from '@ecsia/kit'
import { buildLife } from './sim/world.js'
import type { Life } from './sim/world.js'
import { DT, LOOP_TICKS, MAX_LIVES, TICKS_PER_SECOND } from './sim/shared.js'
import { BOSS_HP } from './sim/shared.js'
import {
  FX_BOSS_DEATH,
  FX_BOSS_SPAWN,
  FX_ENEMY_DEATH,
  FX_GHOST_FADE,
  FX_HIT,
  FX_NOVA,
  FX_PICKUP,
  FX_PLAYER_DEATH,
} from './sim/systems.js'
import { decodeRun, encodeRun } from './game/codec.js'
import type { RunRecord } from './game/codec.js'
import {
  Renderer,
  SPR_BOSS,
  SPR_BRUTE,
  SPR_BULLET,
  SPR_DOT,
  SPR_FLAME,
  SPR_GEM,
  SPR_MOTH,
  SPR_MOTH2,
  SPR_PLAYER,
  SPR_RING,
  SPR_SWARM,
} from './render/gl.js'

// ---------------------------------------------------------------------------------------------
// Cross-origin isolation bootstrap (GitHub Pages can't send COOP/COEP; the service worker can).
// ---------------------------------------------------------------------------------------------
async function ensureIsolation(): Promise<void> {
  if (crossOriginIsolated || !('serviceWorker' in navigator)) return
  if (sessionStorage.getItem('echo-coi') !== null) return // already tried once; run without SAB
  try {
    sessionStorage.setItem('echo-coi', '1')
    await navigator.serviceWorker.register('./coi-sw.js')
    location.reload()
    await new Promise(() => {}) // reloading — never continue into a half-isolated session
  } catch {
    // No service worker (old browser, private mode): single-threaded it is — loudly, in the HUD.
  }
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------
const held = new Set<string>()
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault()
  held.add(e.key.toLowerCase())
})
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()))
addEventListener('blur', () => {
  held.clear()
  // A drag never gets its pointerup if focus is lost mid-press (app switcher, notification) —
  // release the joystick too or the ship steers forever.
  hideStick()
})

// Set by the pointer joystick below; touch/drag input wins over held keys while a drag is active.
// Both feed the SAME 8-way dir stream the sim records, so replays are input-source-agnostic.
let touchActive = false
let touchDir = 0

function sampleDir(): number {
  if (touchActive) return touchDir
  const left = held.has('a') || held.has('arrowleft')
  const right = held.has('d') || held.has('arrowright')
  const up = held.has('w') || held.has('arrowup')
  const down = held.has('s') || held.has('arrowdown')
  const dx = (right ? 1 : 0) - (left ? 1 : 0)
  const dy = (down ? 1 : 0) - (up ? 1 : 0)
  if (dx === 0 && dy === 0) return 0
  if (dx === 1) return dy === -1 ? 2 : dy === 1 ? 8 : 1
  if (dx === -1) return dy === -1 ? 4 : dy === 1 ? 6 : 5
  return dy === -1 ? 3 : 7
}

// ---------------------------------------------------------------------------------------------
// Render-only particles (never feed back into the sim).
// ---------------------------------------------------------------------------------------------
const P_MAX = 4096
const part = {
  x: new Float32Array(P_MAX),
  y: new Float32Array(P_MAX),
  vx: new Float32Array(P_MAX),
  vy: new Float32Array(P_MAX),
  life: new Float32Array(P_MAX),
  max: new Float32Array(P_MAX),
  r: new Float32Array(P_MAX),
  g: new Float32Array(P_MAX),
  b: new Float32Array(P_MAX),
  size: new Float32Array(P_MAX),
  head: 0,
}
// Screen flashes (additive glows that decay) — novas, deaths, pickups.
interface Flash {
  x: number
  y: number
  ttl: number
  max: number
  size: number
  r: number
  g: number
  b: number
}
const flashes: Flash[] = []
function flash(x: number, y: number, size: number, ttl: number, r: number, g: number, b: number): void {
  if (flashes.length < 160) flashes.push({ x, y, ttl, max: ttl, size, r, g, b })
}

// Short motion trails for player ships (render-only ring buffers, reset per life).
const TRAIL_N = 10
const trailX = new Float32Array(8 * TRAIL_N).fill(-999)
const trailY = new Float32Array(8 * TRAIL_N)
const trailHead = new Int32Array(8)
const prevPX = new Float32Array(8).fill(-999)
const prevPY = new Float32Array(8)
let trailLife: Life | null = null

function burst(x: number, y: number, n: number, speed: number, color: [number, number, number], life = 0.6, size = 0.22): void {
  for (let i = 0; i < n; i++) {
    const k = part.head++ % P_MAX
    const a = Math.random() * Math.PI * 2
    const v = speed * (0.3 + Math.random() * 0.7)
    part.x[k] = x
    part.y[k] = y
    part.vx[k] = Math.cos(a) * v
    part.vy[k] = Math.sin(a) * v
    part.life[k] = part.max[k] = life * (0.5 + Math.random() * 0.5)
    part.r[k] = color[0]
    part.g[k] = color[1]
    part.b[k] = color[2]
    part.size[k] = size
  }
}

// ---------------------------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------------------------
const LIVE_COLOR: [number, number, number] = [0.45, 0.92, 1]
const GHOST_COLORS: [number, number, number][] = [
  [1, 0.45, 0.9],
  [1, 0.78, 0.4],
  [0.72, 0.52, 1],
  [0.55, 1, 0.62],
  [0.5, 0.68, 1],
  [1, 0.58, 0.35],
  [0.62, 1, 0.9],
  [0.95, 0.95, 1],
]
const KIND_COLOR: [number, number, number][] = [
  [1, 0.38, 0.5],
  [1, 0.72, 0.32],
  [0.6, 0.3, 0.92],
]
const KIND_SPRITE = [SPR_SWARM, SPR_MOTH, SPR_BRUTE]
const KIND_SIZE = [0.42, 0.48, 0.75]
const GEM_COLOR: [number, number, number][] = [
  [0.42, 1, 0.55],
  [1, 0.85, 0.35],
  [0.55, 0.9, 1],
]

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------
const $ = (id: string): HTMLElement => document.getElementById(id)!
const frameEl = $('frame')
const canvas = $('screen') as HTMLCanvasElement
const overlay = $('overlay')
const hudPerf = $('hud-perf')
const hudRight = $('hud-right')
const hudBottom = $('hud-bottom')
const hudScore = $('hud-score')
const glitchEl = $('glitch')

// ---------------------------------------------------------------------------------------------
// Pointer joystick — the touch control surface (also works as mouse-drag on desktop). A drag
// anywhere on the canvas plants a virtual stick at the touch point; the drag vector maps to the
// same 8-way dir the keyboard produces.
// ---------------------------------------------------------------------------------------------
const stickEl = $('stick')
const stickNub = $('stick-nub')
const coarsePointer = matchMedia('(pointer: coarse)').matches
const portraitQuery = matchMedia('(orientation: portrait)')
const STICK_DEAD = 12
const STICK_RANGE = 34

let stickPointer = -1
let stickOx = 0
let stickOy = 0

function dirFromVector(dx: number, dy: number): number {
  if (dx * dx + dy * dy < STICK_DEAD * STICK_DEAD) return 0
  // Screen y grows downward; game dirs count 1=E counter-clockwise, so negate dy. Octant rounding
  // gives each of the 8 directions a 45° wedge.
  const oct = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4))
  return ((oct + 8) % 8) + 1
}

function hideStick(): void {
  stickPointer = -1
  touchActive = false
  touchDir = 0
  stickEl.style.display = 'none'
}

canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'playing' || (e.pointerType === 'mouse' && e.button !== 0)) return
  e.preventDefault()
  stickPointer = e.pointerId
  stickOx = e.clientX
  stickOy = e.clientY
  touchActive = true
  touchDir = 0
  canvas.setPointerCapture(e.pointerId)
  const rect = frameEl.getBoundingClientRect()
  stickEl.style.display = 'block'
  stickEl.style.left = `${e.clientX - rect.left}px`
  stickEl.style.top = `${e.clientY - rect.top}px`
  stickNub.style.transform = 'translate(0px, 0px)'
})
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickPointer) return
  const dx = e.clientX - stickOx
  const dy = e.clientY - stickOy
  touchDir = dirFromVector(dx, dy)
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const c = Math.min(len, STICK_RANGE) / len
  stickNub.style.transform = `translate(${dx * c}px, ${dy * c}px)`
})
const endStick = (e: PointerEvent): void => {
  if (e.pointerId === stickPointer) hideStick()
}
canvas.addEventListener('pointerup', endStick)
canvas.addEventListener('pointercancel', endStick)

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement !== null) {
    await document.exitFullscreen().catch(() => {})
    return
  }
  await frameEl.requestFullscreen().catch(() => {})
  // Best-effort: phones that support it get the arena in landscape.
  const so = screen.orientation as unknown as { lock?: (o: string) => Promise<void> }
  await so.lock?.('landscape')?.catch(() => {})
}

// ---------------------------------------------------------------------------------------------
// Corner HUD controls — built ONCE with persistent listeners. hudTick only updates labels: a
// per-frame innerHTML rebuild destroys the element mid-press, so taps spanning an animation
// frame (all touch taps) would drop their click.
// ---------------------------------------------------------------------------------------------
const hudBadge = document.createElement('span')
const hudThrBtn = document.createElement('button')
const hudFsBtn = document.createElement('button')
const hudPoolLbl = document.createElement('span')
hudPoolLbl.style.opacity = '.55'
hudPoolLbl.textContent = ' ecsia worker pool'
hudFsBtn.textContent = 'FS'
hudFsBtn.title = 'fullscreen'
hudFsBtn.onclick = () => void toggleFullscreen()
hudThrBtn.onclick = () => {
  settings.threaded = !settings.threaded
  localStorage.setItem('echo-threaded', settings.threaded ? '1' : '0')
}
hudRight.append(hudBadge, document.createElement('br'), hudThrBtn, hudFsBtn, hudPoolLbl)

const SPARK_W = 96
const SPARK_H = 22
const spark = document.createElement('canvas')
spark.id = 'spark'
spark.width = SPARK_W
spark.height = SPARK_H
const sparkCtx = spark.getContext('2d')!
const frameTimes = new Float32Array(SPARK_W)
let frameHead = 0

// ---------------------------------------------------------------------------------------------
// Settings + state machine
// ---------------------------------------------------------------------------------------------
type Mode = 'title' | 'playing' | 'fracture' | 'gameover' | 'victory' | 'replay' | 'replaydone'

const isolationOk = (): boolean => crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'
const workerCount = Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1))
let benchWorkers = workerCount

const settings = {
  threaded: localStorage.getItem('echo-threaded') !== '0',
  overdrive: 1,
}

let mode: Mode = 'title'
let life: Life | null = null
let seed = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 0
let streams: Uint8Array[] = []
let record: Uint8Array | null = null
let replayRec: RunRecord | null = null
let shareUrl = ''
let finalStats = { kills: 0, ticks: 0, hash: 0, outcome: 0 }
let hashText = '--------'
let lastHash = 0
let shakeMag = 0
let simMs = 0
let stepping = false
let acc = 0
let lastRaf = 0
let verifyBadge: 'pending' | 'ok' | 'fail' | null = null

function makeWorker(): Worker {
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
}

function threadedActive(): boolean {
  return settings.threaded && isolationOk()
}

async function disposeLife(): Promise<void> {
  const l = life
  life = null
  if (l !== null) await l.dispose()
}

function startLife(liveInput: boolean): void {
  record = liveInput ? new Uint8Array(LOOP_TICKS) : null
  life = buildLife({
    seed,
    streams,
    liveDir: liveInput ? sampleDir : null,
    record,
    overdrive: settings.overdrive,
    threaded: threadedActive(),
    workers: workerCount,
    createWorker: threadedActive() ? makeWorker : undefined,
  })
  acc = 0
}

// Guards the dispose→build window: on the threaded path disposeLife awaits worker termination,
// long enough for a double-click to build a second life and leak the first's pool.
let building = false

async function startRun(): Promise<void> {
  if (building) return
  building = true
  try {
    await disposeLife()
    streams = []
    verifyBadge = null
    startLife(true)
    mode = 'playing'
    syncOverlay()
  } finally {
    building = false
  }
}

async function startReplay(rec: RunRecord): Promise<void> {
  if (building) return
  building = true
  try {
    await disposeLife()
    replayRec = rec
    seed = rec.seed
    settings.overdrive = rec.overdrive
    streams = rec.streams
    verifyBadge = 'pending'
    startLife(false)
    mode = 'replay'
    syncOverlay()
  } finally {
    building = false
  }
}

async function onLiveDeath(): Promise<void> {
  const l = life!
  const died = l.recordedTicks()
  streams = [...streams, (record ?? new Uint8Array(0)).slice(0, died)]
  finalStats = { kills: l.ctx.kills, ticks: l.tick(), hash: l.hash(), outcome: 0 }
  glitchEl.classList.remove('on')
  void glitchEl.offsetWidth
  glitchEl.classList.add('on')
  shakeMag = 5
  if (streams.length >= MAX_LIVES) {
    // Dispose FIRST: it nulls `life` synchronously, which is what stops the pump loop and
    // afterTick from re-entering this handler on the next catch-up tick. Awaiting buildShareUrl
    // while `life`/mode are still live re-fires the terminal transition under frame drops —
    // duplicating the final stream and corrupting the share URL.
    await disposeLife()
    shareUrl = await buildShareUrl(0)
    mode = 'gameover'
    syncOverlay()
    return
  }
  mode = 'fracture'
  syncOverlay()
  await disposeLife()
  setTimeout(() => {
    if (mode !== 'fracture') return
    startLife(true)
    mode = 'playing'
    syncOverlay()
  }, 1200)
}

async function onLoopSurvived(): Promise<void> {
  const l = life!
  const outcome = l.ctx.bossDown ? 2 : 1
  finalStats = { kills: l.ctx.kills, ticks: l.tick(), hash: l.hash(), outcome }
  streams = [...streams, (record ?? new Uint8Array(0)).slice(0, l.recordedTicks())]
  // Dispose before the first deferring await (see onLiveDeath) — `life` must null synchronously
  // so a catch-up tick can't re-fire this handler and append a duplicate stream.
  await disposeLife()
  shareUrl = await buildShareUrl(outcome)
  mode = 'victory'
  syncOverlay()
}

async function onReplayEnd(): Promise<void> {
  const l = life!
  const h = l.hash()
  verifyBadge = replayRec !== null && h === replayRec.finalHash ? 'ok' : 'fail'
  finalStats = { kills: l.ctx.kills, ticks: l.tick(), hash: h, outcome: replayRec?.outcome ?? 0 }
  await disposeLife()
  mode = 'replaydone'
  syncOverlay()
}

async function buildShareUrl(outcome: number): Promise<string> {
  const payload = await encodeRun({
    seed,
    overdrive: settings.overdrive,
    outcome,
    streams,
    finalHash: finalStats.hash,
    finalTick: finalStats.ticks,
    kills: finalStats.kills,
  })
  return `${location.origin}${location.pathname}#r=${payload}`
}

// ---------------------------------------------------------------------------------------------
// Sim pump — fixed 60Hz, awaited per tick on the threaded path, capped catch-up.
// ---------------------------------------------------------------------------------------------
async function pump(): Promise<void> {
  if (stepping || life === null || (mode !== 'playing' && mode !== 'replay')) return
  stepping = true
  try {
    let ticks = 0
    while (acc >= DT && ticks < 3 && life !== null) {
      acc -= DT
      ticks += 1
      const t0 = performance.now()
      const r = life.step()
      if (r instanceof Promise) await r
      simMs = simMs * 0.9 + (performance.now() - t0) * 0.1
      afterTick()
      if (mode !== 'playing' && mode !== 'replay') break
    }
    if (acc > DT * 3) acc = DT * 3
  } finally {
    stepping = false
  }
}

function afterTick(): void {
  const l = life
  if (l === null) return
  for (const fx of l.ctx.fx) {
    if (fx.kind === FX_ENEMY_DEATH) {
      burst(fx.x, fx.y, 5, 55, [1, 0.55, 0.45], 0.45)
      flash(fx.x, fx.y, 0.9, 0.14, 0.7, 0.32, 0.2)
    } else if (fx.kind === FX_HIT) {
      burst(fx.x, fx.y, 2, 75, [1, 0.95, 0.7], 0.22, 0.16)
    } else if (fx.kind === FX_PLAYER_DEATH) {
      burst(fx.x, fx.y, 90, 150, LIVE_COLOR, 1.1, 0.3)
      flash(fx.x, fx.y, 7, 0.5, 0.45, 0.92, 1)
      shakeMag = Math.max(shakeMag, 6)
    } else if (fx.kind === FX_GHOST_FADE) burst(fx.x, fx.y, 26, 60, [0.8, 0.8, 1], 0.8)
    else if (fx.kind === FX_PICKUP) {
      burst(fx.x, fx.y, 10, 45, [0.95, 1, 0.7], 0.5)
      flash(fx.x, fx.y, 2.2, 0.25, 0.6, 1, 0.7)
    } else if (fx.kind === FX_NOVA) {
      burst(fx.x, fx.y, 140, 220, [0.55, 0.9, 1], 0.7)
      flash(fx.x, fx.y, 9, 0.4, 0.55, 0.9, 1)
      shakeMag = Math.max(shakeMag, 4)
    } else if (fx.kind === FX_BOSS_DEATH) {
      burst(fx.x, fx.y, 220, 190, [1, 0.5, 0.4], 1.4, 0.34)
      flash(fx.x, fx.y, 13, 0.7, 1, 0.4, 0.3)
      shakeMag = Math.max(shakeMag, 8)
    } else if (fx.kind === FX_BOSS_SPAWN) {
      flash(fx.x, fx.y, 9, 0.6, 1, 0.35, 0.3)
      shakeMag = Math.max(shakeMag, 5)
    }
  }
  l.ctx.fx.length = 0

  const t = l.tick()
  if (t % 30 === 0) {
    lastHash = l.hash()
    hashText = lastHash.toString(16).padStart(8, '0')
  }

  if (mode === 'playing') {
    if (l.ctx.liveDead) void onLiveDeath()
    else if (t >= LOOP_TICKS) void onLoopSurvived()
  } else if (mode === 'replay') {
    const target = replayRec?.finalTick ?? LOOP_TICKS
    if (t >= target) void onReplayEnd()
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const renderer = new Renderer(canvas)

function fillScene(): void {
  const l = life
  if (l === null) return
  const { world, defs } = l

  for (const e of world.query(read(defs.Gem)) as Iterable<{ gem: { x: number; y: number; kind: number } }>) {
    const g = e.gem
    const c = GEM_COLOR[g.kind]!
    renderer.sprite(g.x, g.y, SPR_GEM, 0.4, c[0], c[1], c[2], 1)
  }

  const tick = l.tick()

  for (let c = 0; c < defs.EPos.length; c++) {
    const q = world.query(read(defs.EPos[c]!))
    q.eachChunk((chunk) => {
      const xs = chunk.column(defs.EPos[c]!, 'x') as Float32Array
      const ys = chunk.column(defs.EPos[c]!, 'y') as Float32Array
      const kinds = chunk.column(defs.EMeta, 'kind') as Int32Array
      const n = chunk.count
      const flap = (tick >> 3) & 1
      for (let r = 0; r < n; r++) {
        const kind = kinds[r]!
        const col = KIND_COLOR[kind]!
        let sprite = KIND_SPRITE[kind]!
        let size = KIND_SIZE[kind]!
        if (kind === 1) {
          // Moths flap: alternate wing frames, staggered by row so the swarm shimmers.
          sprite = (flap + (r & 1)) & 1 ? SPR_MOTH2 : SPR_MOTH
        } else if (kind === 0) {
          // Swarmers pulse subtly.
          size += 0.045 * Math.sin(tick * 0.35 + r * 1.7)
        }
        renderer.sprite(xs[r]!, ys[r]!, sprite, size, col[0], col[1], col[2], 1)
      }
    })
  }

  const bq = world.query(read(defs.Bullet))
  bq.eachChunk((chunk) => {
    const xs = chunk.column(defs.Bullet, 'x') as Float32Array
    const ys = chunk.column(defs.Bullet, 'y') as Float32Array
    const vxs = chunk.column(defs.Bullet, 'vx') as Float32Array
    const vys = chunk.column(defs.Bullet, 'vy') as Float32Array
    const n = chunk.count
    for (let r = 0; r < n; r++) {
      const x = xs[r]!
      const y = ys[r]!
      // Tracer: two fading ticks trailing opposite the velocity — bolts read as motion.
      renderer.sprite(x - vxs[r]! * 0.012, y - vys[r]! * 0.012, SPR_DOT, 0.2, 0.5, 0.9, 0.7, 0.35)
      renderer.sprite(x - vxs[r]! * 0.006, y - vys[r]! * 0.006, SPR_DOT, 0.24, 0.7, 1, 0.85, 0.6)
      renderer.sprite(x, y, SPR_BULLET, 0.32, 0.85, 1, 0.95, 1)
    }
  })

  const liveSlot = l.ctx.liveSlot
  if (trailLife !== l) {
    trailX.fill(-999)
    prevPX.fill(-999)
    trailHead.fill(0)
    trailLife = l
  }
  const playerGlows: { x: number; y: number; c: [number, number, number]; live: boolean }[] = []
  for (const e of world.query(read(defs.Player)) as Iterable<{ player: { x: number; y: number; hp: number; slot: number } }>) {
    const p = e.player
    if (p.hp <= 0) continue
    const isLive = p.slot === liveSlot
    const c = isLive ? LIVE_COLOR : GHOST_COLORS[p.slot % GHOST_COLORS.length]!
    const s = p.slot & 7

    // Motion trail (drawn under the ship — earlier sprites render first).
    for (let k = 1; k < TRAIL_N; k++) {
      const i = s * TRAIL_N + ((trailHead[s]! + k) % TRAIL_N)
      const tx = trailX[i]!
      if (tx < -900) continue
      const a = (k / TRAIL_N) * (isLive ? 0.34 : 0.2)
      renderer.sprite(tx, trailY[i]!, SPR_DOT, 0.16, c[0], c[1], c[2], a)
    }
    trailHead[s] = (trailHead[s]! + 1) % TRAIL_N
    trailX[s * TRAIL_N + trailHead[s]!] = p.x
    trailY[s * TRAIL_N + trailHead[s]!] = p.y

    // Thruster flame opposite the frame-to-frame motion, flickering.
    const pdx = prevPX[s]! > -900 ? p.x - prevPX[s]! : 0
    const pdy = prevPX[s]! > -900 ? p.y - prevPY[s]! : 0
    const speed2 = pdx * pdx + pdy * pdy
    if (speed2 > 0.01) {
      const inv = 1 / Math.sqrt(speed2)
      const fa = 0.6 + Math.random() * 0.4
      renderer.sprite(p.x - pdx * inv * 5.5, p.y - pdy * inv * 5.5, SPR_FLAME, 0.4 + Math.random() * 0.1, 1, 0.68, 0.28, fa * (isLive ? 1 : 0.5))
    }
    prevPX[s] = p.x
    prevPY[s] = p.y

    if (isLive) {
      // The anchor ring: keeps YOUR ship findable inside the melee, breathing gently.
      const ra = 0.5 + 0.16 * Math.sin(tick * 0.12)
      renderer.sprite(p.x, p.y, SPR_RING, 0.85 + 0.05 * Math.sin(tick * 0.12), c[0], c[1], c[2], ra)
    }
    renderer.sprite(p.x, p.y, SPR_PLAYER, 0.55, c[0], c[1], c[2], isLive ? 1 : 0.62)
    playerGlows.push({ x: p.x, y: p.y, c, live: isLive })
  }

  let bossInfo: { x: number; y: number; hp: number; active: number } | null = null
  for (const e of world.query(read(defs.Boss)) as Iterable<{ boss: { x: number; y: number; hp: number; active: number } }>) {
    bossInfo = { x: e.boss.x, y: e.boss.y, hp: e.boss.hp, active: e.boss.active }
    break
  }
  if (bossInfo !== null && bossInfo.active !== 0) {
    const throb = 1.05 + 0.07 * Math.sin(tick * 0.2)
    renderer.sprite(bossInfo.x, bossInfo.y, SPR_BOSS, throb, 1, 0.42, 0.42, 1)
    // HP pips above the reaper.
    const maxHp = BOSS_HP * (1 + 0.3 * l.ctx.echoes)
    const frac = Math.max(0, Math.min(1, bossInfo.hp / maxHp))
    const pips = 12
    const lit = Math.ceil(frac * pips)
    for (let i = 0; i < pips; i++) {
      const on = i < lit
      renderer.sprite(bossInfo.x - 13 + i * 2.3, bossInfo.y - 15, SPR_DOT, 0.13, on ? 1 : 0.25, on ? 0.35 : 0.1, on ? 0.3 : 0.1, on ? 1 : 0.6)
    }
  }

  // Particles (solid pass).
  for (let k = 0; k < P_MAX; k++) {
    if (part.life[k]! <= 0) continue
    const a = part.life[k]! / part.max[k]!
    renderer.sprite(part.x[k]!, part.y[k]!, SPR_DOT, part.size[k]!, part.r[k]!, part.g[k]!, part.b[k]!, a)
  }

  // Additive glow pass — last.
  for (const g of playerGlows) {
    renderer.glow(g.x, g.y, g.live ? 3.1 : 1.8, g.c[0] * 0.55, g.c[1] * 0.55, g.c[2] * 0.55, g.live ? 0.65 : 0.3)
  }
  if (bossInfo !== null && bossInfo.active !== 0) renderer.glow(bossInfo.x, bossInfo.y, 4.5, 0.5, 0.12, 0.12, 0.6)
  for (const f of flashes) {
    const a = f.ttl / f.max
    renderer.glow(f.x, f.y, f.size * (1.4 - 0.4 * a), f.r * a, f.g * a, f.b * a, a * 0.85)
  }
}

function stepParticles(dt: number): void {
  for (let k = 0; k < P_MAX; k++) {
    if (part.life[k]! <= 0) continue
    part.life[k]! -= dt
    part.x[k]! += part.vx[k]! * dt
    part.y[k]! += part.vy[k]! * dt
    part.vx[k]! *= 0.94
    part.vy[k]! *= 0.94
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    flashes[i]!.ttl -= dt
    if (flashes[i]!.ttl <= 0) flashes.splice(i, 1)
  }
}

// ---------------------------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------------------------
function hudTick(frameMs: number): void {
  frameTimes[frameHead++ % SPARK_W] = frameMs
  sparkCtx.clearRect(0, 0, SPARK_W, SPARK_H)
  sparkCtx.fillStyle = 'rgba(125,255,179,0.8)'
  for (let i = 0; i < SPARK_W; i++) {
    const v = frameTimes[(frameHead + i) % SPARK_W]!
    const h = Math.min(20, (v / 33.3) * 20)
    sparkCtx.fillRect(i, SPARK_H - h, 1, h)
  }

  const l = life
  const counts = l?.counts()
  const entLine = counts === undefined ? '' : `entities ${counts.entities.toString().padStart(6)}  horde ${counts.enemies.toString().padStart(6)}`
  hudPerf.textContent = `frame ${frameMs.toFixed(1).padStart(5)} ms   sim ${simMs.toFixed(2).padStart(6)} ms\n${entLine}\nhash  ${hashText}`
  hudPerf.appendChild(spark)

  const iso = isolationOk()
  const thr = l !== null ? l.threaded : settings.threaded && iso
  hudBadge.className = thr ? 'badge' : 'warn'
  hudBadge.textContent = thr
    ? `threaded · ${workerCount} workers · SAB ✓`
    : iso
      ? 'single-thread (toggle off)'
      : 'single-thread — no cross-origin isolation'
  hudThrBtn.style.display = iso ? '' : 'none'
  hudThrBtn.className = settings.threaded ? 'on' : ''
  hudThrBtn.textContent = settings.threaded ? 'THREADED' : 'SERIAL'
  hudFsBtn.style.display = document.fullscreenEnabled ? '' : 'none'

  if (l !== null && (mode === 'playing' || mode === 'replay')) {
    const t = l.tick()
    const remain = Math.max(0, LOOP_TICKS - t)
    const mm = Math.floor(remain / TICKS_PER_SECOND / 60)
    const ss = Math.floor((remain / TICKS_PER_SECOND) % 60).toString().padStart(2, '0')
    let hp = 0
    let pow = 0
    for (const e of l.world.query(read(l.defs.Player)) as Iterable<{ player: { hp: number; pow: number; slot: number } }>) {
      if (e.player.slot === l.ctx.liveSlot) {
        hp = e.player.hp
        pow = e.player.pow
        break
      }
    }
    const hpBar = '█'.repeat(Math.max(0, Math.round(hp / 10))) + '░'.repeat(Math.max(0, 10 - Math.round(hp / 10)))
    const echoes = '◆'.repeat(streams.length) + '◇'.repeat(Math.max(0, MAX_LIVES - 1 - streams.length))
    hudBottom.textContent =
      mode === 'replay'
        ? `REPLAY ◈ echoes ${streams.length}  T-${mm}:${ss}`
        : `HP ${hpBar}  PWR ${pow.toFixed(0)}\nECHOES ${echoes}  LOOP T-${mm}:${ss}`
    hudScore.textContent = `KILLS ${(l.ctx.kills).toString().padStart(6)}\n${l.ctx.bossDown ? 'REAPER DOWN ✓' : ''}`
  } else {
    hudBottom.textContent = ''
    hudScore.textContent = ''
  }
}

// ---------------------------------------------------------------------------------------------
// Overlay screens
// ---------------------------------------------------------------------------------------------
function syncOverlay(): void {
  const iso = isolationOk()
  if (mode === 'playing' || mode === 'replay') {
    overlay.classList.add('hidden')
    overlay.innerHTML = ''
    return
  }
  overlay.classList.remove('hidden')
  hideStick()
  if (mode === 'title') {
    const controls = coarsePointer
      ? 'drag anywhere to steer · you fire automatically · gems heal, power, or detonate'
      : 'WASD / arrows — or drag with the mouse · you fire automatically · gems heal, power, or detonate'
    const rotateHint =
      coarsePointer && portraitQuery.matches
        ? `<p class="warn">tip: rotate to landscape — or go fullscreen — for the full arena</p>`
        : ''
    const fsButton = document.fullscreenEnabled && coarsePointer ? `<button id="btn-fs-title">FULLSCREEN</button>` : ''
    const thrButton = iso
      ? `<span>engine</span><button id="btn-thr-title" class="${settings.threaded ? 'on' : ''}">${settings.threaded ? 'THREADED' : 'SERIAL'}</button>`
      : ''
    overlay.innerHTML = `
      <h1>ECHO SURVIVORS</h1>
      <p>Survive the 90-second loop. When you die, time rewinds — and your past self
      fights beside you, replaying your exact run. Eight lives. One timeline. The horde grows.</p>
      <p class="keys">${controls}</p>
      ${rotateHint}
      <div class="row">
        <span>overdrive</span>
        ${[1, 2, 4].map((o) => `<button data-od="${o}" class="${settings.overdrive === o ? 'on' : ''}">${o}×</button>`).join('')}
        ${thrButton}
      </div>
      <div class="row"><button id="btn-start">▶ ENTER THE LOOP</button>${fsButton}</div>
      <p style="opacity:.6">every enemy is a real entity in <a href="https://github.com/andymai/ecsia" target="_blank" rel="noopener">ecsia</a>'s
      deterministic ECS — ${iso ? `steering runs on a ${workerCount}-worker SharedArrayBuffer pool` : 'running single-threaded here (no cross-origin isolation)'} ·
      the hash in the corner is the whole world state, and replays reproduce it byte for byte</p>`
    overlay.querySelectorAll('button[data-od]').forEach((b) => {
      ;(b as HTMLButtonElement).onclick = () => {
        settings.overdrive = Number((b as HTMLElement).dataset['od'])
        syncOverlay()
      }
    })
    ;(document.getElementById('btn-start') as HTMLButtonElement).onclick = () => void startRun()
    const fsTitle = document.getElementById('btn-fs-title')
    if (fsTitle !== null) (fsTitle as HTMLButtonElement).onclick = () => void toggleFullscreen()
    const thrTitle = document.getElementById('btn-thr-title')
    if (thrTitle !== null) {
      ;(thrTitle as HTMLButtonElement).onclick = () => {
        settings.threaded = !settings.threaded
        localStorage.setItem('echo-threaded', settings.threaded ? '1' : '0')
        syncOverlay()
      }
    }
  } else if (mode === 'fracture') {
    overlay.innerHTML = `
      <h2 class="bad">TIME FRACTURE</h2>
      <p>ECHO ${streams.length} JOINS THE TIMELINE</p>`
  } else if (mode === 'gameover' || mode === 'victory') {
    const title = mode === 'victory' ? (finalStats.outcome === 2 ? 'LOOP MASTERED' : 'LOOP SURVIVED') : 'THE LOOP CONSUMES YOU'
    const cls = mode === 'victory' ? '' : 'bad'
    overlay.innerHTML = `
      <h2 class="${cls}">${title}</h2>
      <p>kills ${finalStats.kills} · echoes ${streams.length - (mode === 'victory' ? 1 : 0)} · survived ${(finalStats.ticks / TICKS_PER_SECOND).toFixed(1)}s
      · final hash <span class="badge">${finalStats.hash.toString(16).padStart(8, '0')}</span></p>
      <p>this exact run — every echo, every kill, every bit — lives in this URL:</p>
      <div id="sharebox"></div>
      <div class="row">
        <button id="btn-copy">COPY LINK</button>
        <button id="btn-watch">WATCH THE REPLAY</button>
        <button id="btn-again">RUN IT BACK</button>
        <button id="btn-new">NEW SEED</button>
      </div>
      <p style="opacity:.6">anyone opening that link re-simulates your run from pure inputs —
      and the engine proves the result is byte-identical</p>`
    // textContent, not interpolation — the URL is same-origin data but never trust a string into HTML.
    document.getElementById('sharebox')!.textContent = shareUrl
    ;(document.getElementById('btn-copy') as HTMLButtonElement).onclick = () => void navigator.clipboard.writeText(shareUrl)
    ;(document.getElementById('btn-watch') as HTMLButtonElement).onclick = () => {
      void (async () => {
        const payload = shareUrl.split('#r=')[1]!
        const rec = await decodeRun(payload)
        if (rec !== null) void startReplay(rec)
      })()
    }
    ;(document.getElementById('btn-again') as HTMLButtonElement).onclick = () => void startRun()
    ;(document.getElementById('btn-new') as HTMLButtonElement).onclick = () => {
      seed = (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 0
      void startRun()
    }
  } else if (mode === 'replaydone') {
    const ok = verifyBadge === 'ok'
    overlay.innerHTML = `
      <h2>${ok ? 'REPLAY VERIFIED' : 'REPLAY DIVERGED'}</h2>
      <p class="${ok ? 'badge' : 'bad'}" style="font-size:clamp(14px,2vw,22px)">
        ${ok ? '✓ byte-identical' : '✗ hash mismatch'} — state hash ${finalStats.hash.toString(16).padStart(8, '0')}
        ${ok ? '=' : '≠'} recorded ${replayRec?.finalHash.toString(16).padStart(8, '0') ?? '?'}</p>
      <p>${ok
        ? `this machine just re-simulated the entire run — ${replayRec?.streams.length ?? 0} lives, ${replayRec?.kills ?? 0} kills — from nothing but a seed and the recorded inputs, and arrived at exactly the same universe, bit for bit. that determinism is the guarantee <a href="https://github.com/andymai/ecsia" target="_blank" rel="noopener">ecsia</a> property-tests, serial and threaded alike.`
        : 'the reconstruction did not match the recorded hash — please report this, it would be a determinism bug.'}</p>
      <div class="row">
        <button id="btn-replay-again">WATCH AGAIN</button>
        <button id="btn-try">PLAY THIS SEED YOURSELF</button>
      </div>`
    ;(document.getElementById('btn-replay-again') as HTMLButtonElement).onclick = () => {
      if (replayRec !== null) void startReplay(replayRec)
    }
    ;(document.getElementById('btn-try') as HTMLButtonElement).onclick = () => {
      history.replaceState(null, '', location.pathname)
      replayRec = null
      void startRun()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------------------------
function frame(now: number): void {
  requestAnimationFrame(frame)
  const dtReal = Math.min(0.1, (now - lastRaf) / 1000 || 0.016)
  lastRaf = now

  const dpr = Math.min(2, devicePixelRatio || 1)
  const w = Math.round(canvas.clientWidth * dpr)
  const h = Math.round(canvas.clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }

  if (mode === 'playing' || mode === 'replay') acc += dtReal
  void pump()

  stepParticles(dtReal)
  shakeMag *= 0.9
  const sx = (Math.random() - 0.5) * shakeMag
  const sy = (Math.random() - 0.5) * shakeMag

  renderer.begin()
  fillScene()
  renderer.flush(now / 1000, sx, sy)

  hudTick(dtReal * 1000)
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
// Headless bench/verify mode (#bench=serial|threaded&seed=N&ticks=N): run a deterministic scripted
// life without rendering and expose { hash, msPerTick } — the E2E harness compares the two modes'
// hashes in a real browser, the ultimate parallel==serial check.
async function runBench(kind: string, seedArg: number, ticks: number, od: number): Promise<void> {
  const scripted = { t: 0 }
  const l = buildLife({
    seed: seedArg,
    streams: [],
    liveDir: () => {
      scripted.t += 1
      return (scripted.t >> 5) % 9
    },
    record: new Uint8Array(LOOP_TICKS),
    overdrive: od,
    threaded: kind === 'threaded' && isolationOk(),
    workers: benchWorkers,
    createWorker: kind === 'threaded' && isolationOk() ? makeWorker : undefined,
  })
  // Report the FINAL 300 ticks' cost (peak horde), not the ramp-up average.
  const tail = Math.min(300, ticks)
  let t0 = performance.now()
  for (let i = 0; i < ticks; i++) {
    if (i === ticks - tail) t0 = performance.now()
    const r = l.step()
    if (r instanceof Promise) await r
  }
  const ms = (performance.now() - t0) / tail
  const result = { kind, hash: l.hash(), tick: l.tick(), msPerTick: ms, enemies: l.counts().enemies, threaded: kind === 'threaded' && isolationOk() }
  await l.dispose()
  ;(window as unknown as { __benchResult?: unknown }).__benchResult = result
  const el = document.createElement('div')
  el.id = 'bench-done'
  el.textContent = JSON.stringify(result)
  document.body.appendChild(el)
}

async function boot(): Promise<void> {
  await ensureIsolation()
  const bench = /[#&]bench=(serial|threaded)/.exec(location.hash)
  if (bench !== null) {
    const seedArg = Number(/[#&]seed=(\d+)/.exec(location.hash)?.[1] ?? 12345) >>> 0
    const ticks = Number(/[#&]ticks=(\d+)/.exec(location.hash)?.[1] ?? 600)
    const od = Number(/[#&]od=(\d)/.exec(location.hash)?.[1] ?? 2)
    const w = Number(/[#&]w=(\d)/.exec(location.hash)?.[1] ?? 0)
    if (w > 0) benchWorkers = w
    seed = seedArg
    await runBench(bench[1]!, seedArg, ticks, od)
    return
  }
  const m = /[#&]r=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (m !== null) {
    const rec = await decodeRun(m[1]!)
    if (rec !== null) {
      replayRec = rec
      overlay.innerHTML = `
        <h1>ECHO SURVIVORS</h1>
        <h2>INCOMING TRANSMISSION</h2>
        <p>a recorded run: seed <span class="badge">${rec.seed.toString(16)}</span> · ${rec.streams.length} lives ·
        ${rec.kills} kills · overdrive ${rec.overdrive}× ·
        claimed hash <span class="badge">${rec.finalHash.toString(16).padStart(8, '0')}</span></p>
        <p>this machine will now re-simulate it from pure inputs and check the claim, bit for bit.</p>
        <div class="row"><button id="btn-verify">▶ WATCH &amp; VERIFY</button>
        <button id="btn-skip">skip to fresh run</button></div>`
      ;(document.getElementById('btn-verify') as HTMLButtonElement).onclick = () => {
        if (replayRec !== null) void startReplay(replayRec)
      }
      ;(document.getElementById('btn-skip') as HTMLButtonElement).onclick = () => {
        history.replaceState(null, '', location.pathname)
        replayRec = null
        mode = 'title'
        syncOverlay()
      }
      requestAnimationFrame(frame)
      return
    }
  }
  syncOverlay()
  requestAnimationFrame(frame)
}

// Re-render the title's rotate hint when the device flips orientation.
portraitQuery.addEventListener('change', () => {
  if (mode === 'title') syncOverlay()
})

void boot()
