// Deterministic sim math + constants, shared by the PAGE bundle (serial system bodies) and the
// WORKER bundle (field-band kernels). One arithmetic, two call sites — the byte-identical
// guarantee between serial, threaded, and replayed runs rests on both sides calling THESE
// functions.
//
// PORTABILITY RULE: sim math uses only IEEE-exact operations (+ - * / sqrt abs floor min max) and
// integer ops. No Math.sin/cos/exp/pow — their last-bit rounding varies across JS engines, which
// would break replay-URL verification across browsers.

export const DT = 1 / 60
export const TICKS_PER_SECOND = 60

export const SIM_W = 640
export const SIM_H = 360

/** Air/heat field: quarter resolution, split into horizontal bands for the worker pool. */
export const FIELD_SCALE = 4
export const FIELD_W = SIM_W / FIELD_SCALE // 160
export const FIELD_H = SIM_H / FIELD_SCALE // 90
export const BANDS = 6
export const BAND_ROWS = FIELD_H / BANDS // 15
export const BAND_CELLS = FIELD_W * BAND_ROWS // 2400
export const FIELD_CELLS = FIELD_W * FIELD_H

/** Particle pool: pre-spawned once, freelisted forever. elem === ELEM_NONE means dead. */
export const PART_CAP = 1 << 17 // 131072

export const AMBIENT_T = 22

// Field tuning (all consumed with exact ops only).
export const K_DIFF = 0.12 // temperature diffusion
export const K_VP = 0.06 // pressure gradient → air velocity
export const K_DIV = 0.35 // air divergence → pressure
export const DAMP_V = 0.985
export const DAMP_P = 0.994
export const K_COOL = 0.996 // ambient relaxation multiplier applied to (t - AMBIENT_T)
export const K_BUOY = 0.0016 // hot air rises

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

export function fnvInit(): number {
  return 0x811c9dc5 >>> 0
}

export function fnvMix(h: number, v: number): number {
  h ^= v >>> 0
  h = Math.imul(h, 0x01000193) >>> 0
  h ^= v >>> 16
  return Math.imul(h, 0x01000193) >>> 0
}

const bits = new Float32Array(1)
const bitsU = new Uint32Array(bits.buffer)
export function f32bits(v: number): number {
  bits[0] = v
  return bitsU[0]!
}

/**
 * One field cell's stencil step, FCur → FNew (Jacobi: reads previous-tick values only, so band
 * kernels may run concurrently). `sample(arrs, fx, fy)` reads across band boundaries; edges clamp.
 * Field layout: per band, row-major Float32Array of BAND_CELLS.
 */
export type BandArrays = Float32Array[]

function fsample(arrs: BandArrays, fx: number, fy: number): number {
  if (fx < 0) fx = 0
  else if (fx >= FIELD_W) fx = FIELD_W - 1
  if (fy < 0) fy = 0
  else if (fy >= FIELD_H) fy = FIELD_H - 1
  const b = (fy / BAND_ROWS) | 0
  return arrs[b]![(fy - b * BAND_ROWS) * FIELD_W + fx]!
}

/**
 * Advance one band: writes tN/pN/vxN/vyN (band-local arrays) from the full cur field. The exact
 * body both the serial twin systems and the worker kernels execute.
 */
export function stepFieldBand(
  band: number,
  tC: BandArrays,
  pC: BandArrays,
  vxC: BandArrays,
  vyC: BandArrays,
  tN: Float32Array,
  pN: Float32Array,
  vxN: Float32Array,
  vyN: Float32Array,
): void {
  const y0 = band * BAND_ROWS
  for (let ly = 0; ly < BAND_ROWS; ly++) {
    const fy = y0 + ly
    for (let fx = 0; fx < FIELD_W; fx++) {
      const i = ly * FIELD_W + fx
      const t = tC[band]![i]!
      const p = pC[band]![i]!
      const vx = vxC[band]![i]!
      const vy = vyC[band]![i]!

      const tL = fsample(tC, fx - 1, fy)
      const tR = fsample(tC, fx + 1, fy)
      const tU = fsample(tC, fx, fy - 1)
      const tD = fsample(tC, fx, fy + 1)
      let nt = t + K_DIFF * (0.25 * (tL + tR + tU + tD) - t)
      nt = AMBIENT_T + (nt - AMBIENT_T) * K_COOL

      const pL = fsample(pC, fx - 1, fy)
      const pR = fsample(pC, fx + 1, fy)
      const pU = fsample(pC, fx, fy - 1)
      const pD = fsample(pC, fx, fy + 1)
      let nvx = (vx - K_VP * (pR - pL)) * DAMP_V
      let nvy = (vy - K_VP * (pD - pU)) * DAMP_V
      nvy -= K_BUOY * (t - AMBIENT_T)

      const dvx = fsample(vxC, fx + 1, fy) - fsample(vxC, fx - 1, fy)
      const dvy = fsample(vyC, fx, fy + 1) - fsample(vyC, fx, fy - 1)
      let np = (p - K_DIV * (dvx + dvy)) * DAMP_P
      np += 0.05 * (0.25 * (pL + pR + pU + pD) - p)

      // Clamp runaway blasts so repeated explosions can't push the field to Inf/NaN.
      if (np > 512) np = 512
      else if (np < -512) np = -512
      if (nt > 9999) nt = 9999
      else if (nt < -273) nt = -273
      if (nvx > 64) nvx = 64
      else if (nvx < -64) nvx = -64
      if (nvy > 64) nvy = 64
      else if (nvy < -64) nvy = -64

      tN[i] = nt
      pN[i] = np
      vxN[i] = nvx
      vyN[i] = nvy
    }
  }
}

/** The swap pass: FNew band → FCur band. Trivial, but it must be the SAME copy on both sides. */
export function swapFieldBand(
  tC: Float32Array,
  pC: Float32Array,
  vxC: Float32Array,
  vyC: Float32Array,
  tN: Float32Array,
  pN: Float32Array,
  vxN: Float32Array,
  vyN: Float32Array,
): void {
  tC.set(tN)
  pC.set(pN)
  vxC.set(vxN)
  vyC.set(vyN)
}
