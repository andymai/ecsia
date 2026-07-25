// Deterministic sim math + constants, shared by the PAGE bundle (serial system bodies) and the
// WORKER bundle (cohort kernels). One arithmetic, two call sites — the byte-identical guarantee
// between serial, threaded, and replayed runs rests on both sides calling THESE functions.
//
// PORTABILITY RULE: sim math uses only IEEE-exact operations (+ - * / sqrt abs floor min max) and
// integer ops. No Math.sin/cos/exp/pow/hypot — their last-bit rounding varies across JS engines,
// which would break replay-URL verification across browsers. sin1/cos1 below are polynomial
// approximations built from exact ops, so a run hashes identically everywhere.

export const DT = 1 / 60
export const TICKS_PER_SECOND = 60
export const LOOP_TICKS = 90 * TICKS_PER_SECOND
export const BOSS_TICK = 72 * TICKS_PER_SECOND
export const MAX_LIVES = 8
export const COHORTS = 4

export const ARENA_W = 480
export const ARENA_H = 270

export const PLAYER_SPEED = 92
export const PLAYER_HP = 100
export const PLAYER_RADIUS = 3.2
export const PLAYER_INVULN = 0.7
export const CONTACT_DPS = 34

export const ENEMY_BASE_SPEED = 34
export const ENEMY_SWIRL = 0.55
export const ENEMY_TURN = 3.4
// The per-enemy compute knob. High enough that a capped horde is REAL work worth threading (the
// honest overdrive flex), low enough that early waves are trivially cheap either way.
export const STEER_SUBSTEPS = 8

export const BULLET_SPEED = 250
export const BULLET_TTL = 1.35
export const BULLET_RADIUS = 1.6
export const FIRE_RANGE = 190
export const FIRE_CD = 0.17
export const BULLET_DMG = 9

export const GEM_RADIUS = 3
export const GEM_PICKUP = 9
export const NOVA_RADIUS = 72

export const BOSS_HP = 5200
export const BOSS_RADIUS = 13
export const BOSS_SPEED = 26
export const BOSS_CONTACT_DPS = 70

/** Enemy kinds: stats live serial-side; agility/phase (worker-side variation) bake in at spawn. */
export const KIND_SWARM = 0
export const KIND_MOTH = 1
export const KIND_BRUTE = 2
export const KIND_HP = [10, 16, 60]
export const KIND_RADIUS = [2.4, 2.8, 5.5]
export const KIND_AGI = [1.15, 1.0, 0.55]

/** Movement input: 0 = idle, 1..8 = the eight directions starting East, counter-clockwise. */
export const DIR_X = [0, 1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476, 0, 0.7071067811865476]
export const DIR_Y = [0, 0, -0.7071067811865476, -1, -0.7071067811865476, 0, 0.7071067811865476, 1, 0.7071067811865476]

/** mulberry32 — integer + exact-division PRNG; identical on every engine. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Cheap portable sine of period 1 (input in turns). Parabola + refinement — max error ~0.1%,
 * built from exact ops only. cos1(x) = sin1(x + 0.25).
 */
export function sin1(x: number): number {
  let t = x - Math.floor(x + 0.5) // [-0.5, 0.5)
  const y = t * (8 - 16 * Math.abs(t))
  return y * (0.775 + 0.225 * Math.abs(y))
}
export function cos1(x: number): number {
  return sin1(x + 0.25)
}

/**
 * The per-enemy steering integrator: seek the target, swirl with per-entity turbulence, integrate
 * over STEER_SUBSTEPS. Writes the new (x, y, vx, vy, phase) into `out`. This is the horde's hot
 * loop — the compute the worker pool parallelizes — and the exact sequence of operations here IS
 * the determinism contract between the serial body and the worker kernel.
 */
export function stepEnemy(
  x: number,
  y: number,
  vx: number,
  vy: number,
  phase: number,
  agi: number,
  tx: number,
  ty: number,
  dt: number,
  out: Float32Array,
): void {
  const h = dt / STEER_SUBSTEPS
  const speed = ENEMY_BASE_SPEED * (0.55 + agi)
  const turn = ENEMY_TURN
  for (let k = 0; k < STEER_SUBSTEPS; k++) {
    const dx = tx - x
    const dy = ty - y
    const d = Math.sqrt(dx * dx + dy * dy) + 1e-4
    const nx = dx / d
    const ny = dy / d
    // Two turbulence octaves: a broad swirl plus a finer flutter — richer swarm motion, and real
    // per-entity work (this loop is what the worker pool parallelizes).
    const s = sin1(phase + x * 0.011 + k * 0.043)
    const c = cos1(phase * 1.31 + y * 0.0127 - k * 0.037)
    const s2 = sin1(phase * 2.7 + x * 0.031 - y * 0.024 + k * 0.011)
    const c2 = cos1(phase * 3.1 - x * 0.027 + y * 0.033 - k * 0.017)
    const wob = ENEMY_SWIRL * agi
    const swx = s * ny + 0.4 * c + 0.35 * (s2 * c2 + 0.5 * c2)
    const swy = -s * nx + 0.4 * s * c + 0.35 * (c2 * s2 - 0.5 * s2)
    const dvx = (nx + wob * swx) * speed
    const dvy = (ny + wob * swy) * speed
    vx += (dvx - vx) * turn * h
    vy += (dvy - vy) * turn * h
    x += vx * h
    y += vy * h
  }
  // Soft arena walls: fold back inside and damp the outward velocity component.
  if (x < 2) {
    x = 2
    if (vx < 0) vx = -vx * 0.5
  } else if (x > ARENA_W - 2) {
    x = ARENA_W - 2
    if (vx > 0) vx = -vx * 0.5
  }
  if (y < 2) {
    y = 2
    if (vy < 0) vy = -vy * 0.5
  } else if (y > ARENA_H - 2) {
    y = ARENA_H - 2
    if (vy > 0) vy = -vy * 0.5
  }
  out[0] = x
  out[1] = y
  out[2] = vx
  out[3] = vy
  out[4] = phase + dt * (0.31 + agi * 0.23)
}

/** Spawn curve: enemies per second at `tick`, before overdrive/echo multipliers. */
export function spawnRate(tick: number): number {
  const t = tick / TICKS_PER_SECOND
  if (t < 4) return 6
  if (t < 20) return 6 + (t - 4) * 2.2
  if (t < 45) return 41 + (t - 20) * 3.4
  if (t < BOSS_TICK / TICKS_PER_SECOND) return 126 + (t - 45) * 4.6
  return 250
}

/** Echo pressure: horde multiplier when `echoes` past selves fight beside you. */
export function echoMultiplier(echoes: number): number {
  return 1 + echoes * 0.45
}

/** FNV-1a 32-bit over unsigned 32-bit words — the state-hash mixer. */
export function fnvInit(): number {
  return 0x811c9dc5
}
export function fnvMix(h: number, word: number): number {
  h ^= word & 0xff
  h = Math.imul(h, 0x01000193)
  h ^= (word >>> 8) & 0xff
  h = Math.imul(h, 0x01000193)
  h ^= (word >>> 16) & 0xff
  h = Math.imul(h, 0x01000193)
  h ^= word >>> 24
  h = Math.imul(h, 0x01000193)
  return h >>> 0
}
