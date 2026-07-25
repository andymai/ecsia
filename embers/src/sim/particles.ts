// The serial CA kernel: paint, movement, reactions, explosions. Runs main-thread-only inside the
// Particles system, in pool-row order — the update order IS part of the deterministic contract
// (same rows, same rng draws, same result, every engine).
//
// Structural-churn-free by design: the pool is pre-spawned once; "spawn" pops the freelist and
// writes fields, "kill" pushes it back and writes ELEM_NONE. No ECS structural op ever happens
// after world build, so archetype rows are stable and pmap can store rows directly.

import {
  CATEGORY,
  CAT_GAS,
  CAT_LIQUID,
  CAT_POWDER,
  CAT_SOLID,
  DENSITY,
  E_ACID,
  E_FIRE,
  E_FUSE,
  E_GLASS,
  E_GUNPOWDER,
  E_ICE,
  E_LAVA,
  E_NITRO,
  E_NONE,
  E_PLANT,
  E_SALT,
  E_SAND,
  E_SMOKE,
  E_STEAM,
  E_VIRUS,
  E_WALL,
  E_WATER,
  E_WOOD,
  FLAMMABLE,
  SPAWN_LIFE,
  SPAWN_T,
} from './elements.js'
import { BAND_ROWS, FIELD_SCALE, FIELD_W, PART_CAP, SIM_H, SIM_W } from './shared.js'

export interface ParticleCols {
  elem: Int32Array
  px: Int32Array
  py: Int32Array
  vx: Float32Array
  vy: Float32Array
  temp: Float32Array
  life: Int32Array
  meta: Int32Array
}

/** FCur band arrays, captured from the ECS columns each tick by the Particles system body. */
export interface FieldCols {
  t: Float32Array[]
  p: Float32Array[]
  vx: Float32Array[]
  vy: Float32Array[]
}

/** One brush segment for one tick: stamp discs of `elem` along (x0,y0)→(x1,y1). */
export interface PaintEvent {
  elem: number
  x0: number
  y0: number
  x1: number
  y1: number
  r: number
}

export interface SimCtx {
  rng: () => number
  /** cell → pool row + 1, 0 = empty. WALLs live here too. */
  pmap: Int32Array
  free: Int32Array
  freeTop: number
  live: number
  /** Explosion queue, (x, y, power) triples — filled during the sweep, applied after it. */
  booms: number[]
}

export function makeCtx(rng: () => number): SimCtx {
  const free = new Int32Array(PART_CAP)
  // Stack pops from the top: fill descending so the first spawn takes row 0 — pool-row update
  // order then matches spawn order, which keeps early paint strokes updating first.
  for (let i = 0; i < PART_CAP; i++) free[i] = PART_CAP - 1 - i
  return { rng, pmap: new Int32Array(SIM_W * SIM_H), free, freeTop: PART_CAP, live: 0, booms: [] }
}

const fieldBandOf = (fy: number): number => (fy / BAND_ROWS) | 0

function fieldIdx(px: number, py: number): number {
  const fx = (px / FIELD_SCALE) | 0
  const fy = (py / FIELD_SCALE) | 0
  const b = fieldBandOf(fy)
  return b * 0x100000 + (fy - b * BAND_ROWS) * FIELD_W + fx
}

function fieldGetT(f: FieldCols, px: number, py: number): number {
  const k = fieldIdx(px, py)
  return f.t[(k / 0x100000) | 0]![k & 0xfffff]!
}

function fieldAddT(f: FieldCols, px: number, py: number, target: number, k: number): void {
  const i = fieldIdx(px, py)
  const band = f.t[(i / 0x100000) | 0]!
  const at = i & 0xfffff
  band[at] = band[at]! + (target - band[at]!) * k
}

function fieldAddP(f: FieldCols, px: number, py: number, dp: number): void {
  const i = fieldIdx(px, py)
  const band = f.p[(i / 0x100000) | 0]!
  const at = i & 0xfffff
  band[at] = band[at]! + dp
}

function fieldGetP(f: FieldCols, px: number, py: number): number {
  const k = fieldIdx(px, py)
  return f.p[(k / 0x100000) | 0]![k & 0xfffff]!
}

export function spawnAt(ctx: SimCtx, c: ParticleCols, x: number, y: number, elem: number): number {
  if (x < 0 || x >= SIM_W || y < 0 || y >= SIM_H) return -1
  const cell = y * SIM_W + x
  if (ctx.pmap[cell] !== 0 || ctx.freeTop === 0) return -1
  const row = ctx.free[--ctx.freeTop]!
  c.elem[row] = elem
  c.px[row] = x
  c.py[row] = y
  c.vx[row] = 0
  c.vy[row] = 0
  c.temp[row] = SPAWN_T[elem]!
  c.life[row] = SPAWN_LIFE[elem]!
  c.meta[row] = 0
  ctx.pmap[cell] = row + 1
  ctx.live++
  return row
}

function kill(ctx: SimCtx, c: ParticleCols, row: number): void {
  ctx.pmap[c.py[row]! * SIM_W + c.px[row]!] = 0
  c.elem[row] = E_NONE
  ctx.free[ctx.freeTop++] = row
  ctx.live--
}

/** Become another element in place, resetting per-element state. */
function morph(c: ParticleCols, row: number, elem: number, keepMeta: boolean): void {
  c.elem[row] = elem
  c.temp[row] = SPAWN_T[elem]!
  c.life[row] = SPAWN_LIFE[elem]!
  if (!keepMeta) c.meta[row] = 0
  c.vx[row] = 0
  c.vy[row] = 0
}

function moveTo(ctx: SimCtx, c: ParticleCols, row: number, nx: number, ny: number): void {
  ctx.pmap[c.py[row]! * SIM_W + c.px[row]!] = 0
  ctx.pmap[ny * SIM_W + nx] = row + 1
  c.px[row] = nx
  c.py[row] = ny
}

function swapCells(ctx: SimCtx, c: ParticleCols, rowA: number, rowB: number): void {
  const ax = c.px[rowA]!
  const ay = c.py[rowA]!
  const bx = c.px[rowB]!
  const by = c.py[rowB]!
  ctx.pmap[ay * SIM_W + ax] = rowB + 1
  ctx.pmap[by * SIM_W + bx] = rowA + 1
  c.px[rowA] = bx
  c.py[rowA] = by
  c.px[rowB] = ax
  c.py[rowB] = ay
}

const occupant = (ctx: SimCtx, x: number, y: number): number =>
  x < 0 || x >= SIM_W || y < 0 || y >= SIM_H ? -2 : ctx.pmap[y * SIM_W + x]! - 1

/** Fire/heat touches a neighbor: returns true if the victim ignited/detonated. */
function ignite(ctx: SimCtx, c: ParticleCols, victim: number): boolean {
  const e = c.elem[victim]!
  const flam = FLAMMABLE[e]!
  if (flam === 0 || ctx.rng() >= flam) return false
  if (e === E_GUNPOWDER) {
    ctx.booms.push(c.px[victim]!, c.py[victim]!, 90)
    kill(ctx, c, victim)
    return true
  }
  if (e === E_NITRO) {
    ctx.booms.push(c.px[victim]!, c.py[victim]!, 160)
    kill(ctx, c, victim)
    return true
  }
  if (e === E_FUSE) {
    c.meta[victim] = 1
    return true
  }
  if (e === E_WOOD) {
    c.meta[victim] = 1
    c.life[victim] = 180
    return true
  }
  morph(c, victim, E_FIRE, false)
  c.life[victim] = 30 + ((ctx.rng() * 30) | 0)
  return true
}

const DX8 = [1, -1, 0, 0, 1, -1, 1, -1]
const DY8 = [0, 0, 1, -1, 1, 1, -1, -1]

const SPREAD = new Int32Array([0, 0, 0, 5, 3, 0, 0, 0, 4, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0])

export function paintTick(ctx: SimCtx, c: ParticleCols, events: PaintEvent[]): void {
  for (const ev of events) {
    const dx = ev.x1 - ev.x0
    const dy = ev.y1 - ev.y0
    const len = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy)
    const steps = 1 + ((len / Math.max(1, ev.r >> 1)) | 0)
    for (let s = 0; s <= steps; s++) {
      const cx = ev.x0 + ((dx * s) / steps || 0)
      const cy = ev.y0 + ((dy * s) / steps || 0)
      stamp(ctx, c, Math.floor(cx), Math.floor(cy), ev.r, ev.elem)
    }
  }
}

function stamp(ctx: SimCtx, c: ParticleCols, x: number, y: number, r: number, elem: number): void {
  const r2 = r * r
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      if (ox * ox + oy * oy > r2) continue
      const px = x + ox
      const py = y + oy
      if (px < 0 || px >= SIM_W || py < 0 || py >= SIM_H) continue
      const at = occupant(ctx, px, py)
      if (elem === E_NONE) {
        if (at >= 0) kill(ctx, c, at)
      } else if (at === -1) {
        // Sparse fill for powders/liquids reads as pouring, solid fill for structure.
        const cat = CATEGORY[elem]!
        const solid = cat === CAT_SOLID
        if (solid || ctx.rng() < 0.55) spawnAt(ctx, c, px, py, elem)
      } else if (at >= 0 && elem === E_FIRE) {
        ignite(ctx, c, at)
      }
    }
  }
}

export function stepParticles(ctx: SimCtx, c: ParticleCols, f: FieldCols, tick: number): void {
  const rng = ctx.rng
  const elems = c.elem
  for (let row = 0; row < PART_CAP; row++) {
    const e = elems[row]!
    if (e === E_NONE || e === E_WALL) continue
    const x = c.px[row]!
    const y = c.py[row]!

    // ── Heat exchange with the air field ─────────────────────────────────────
    const ft = fieldGetT(f, x, y)
    let temp = c.temp[row]!
    if (e === E_FIRE) {
      temp = 900
      fieldAddT(f, x, y, 900, 0.08)
    } else if (e === E_LAVA) {
      fieldAddT(f, x, y, temp, 0.05)
      temp += (ft - temp) * 0.004
    } else if (e === E_ICE) {
      fieldAddT(f, x, y, -30, 0.02)
      temp += (ft - temp) * 0.02
    } else {
      temp += (ft - temp) * 0.06
    }
    c.temp[row] = temp

    // ── Temperature transitions ──────────────────────────────────────────────
    switch (e) {
      case E_WATER: {
        const salty = (c.meta[row]! & 1) !== 0
        if (temp >= (salty ? 108 : 100)) {
          morph(c, row, E_STEAM, true)
          continue
        }
        if (temp <= (salty ? -21 : 0)) {
          morph(c, row, E_ICE, true)
          continue
        }
        break
      }
      case E_STEAM:
        if (temp < 95) {
          morph(c, row, E_WATER, true)
        }
        break
      case E_ICE:
        if (temp > 2) {
          morph(c, row, E_WATER, true)
          continue
        }
        break
      case E_SAND:
        if (temp > 1700) {
          morph(c, row, E_LAVA, false)
          c.meta[row] = E_GLASS
          continue
        }
        break
      case E_GLASS:
        if (temp > 1700) {
          morph(c, row, E_LAVA, false)
          c.meta[row] = E_GLASS
          continue
        }
        break
      case E_LAVA:
        if (temp < 700) {
          morph(c, row, E_GLASS, false)
          continue
        }
        break
      case E_GUNPOWDER:
        if (temp > 180) {
          ctx.booms.push(x, y, 90)
          kill(ctx, c, row)
          continue
        }
        break
      case E_NITRO:
        if (temp > 320 || Math.abs(fieldGetP(f, x, y)) > 60) {
          ctx.booms.push(x, y, 160)
          kill(ctx, c, row)
          continue
        }
        break
      case E_PLANT:
        if (temp > 260) {
          morph(c, row, E_FIRE, false)
          continue
        }
        break
      default:
        break
    }

    // ── Per-element behavior ─────────────────────────────────────────────────
    const eNow = elems[row]!
    switch (eNow) {
      case E_FIRE: {
        c.life[row] = c.life[row]! - 1
        if (c.life[row]! <= 0) {
          if (rng() < 0.4) morph(c, row, E_SMOKE, false)
          else kill(ctx, c, row)
          continue
        }
        const d = (rng() * 8) | 0
        const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
        if (n >= 0) ignite(ctx, c, n)
        break
      }
      case E_LAVA: {
        const d = (rng() * 8) | 0
        const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
        if (n >= 0) {
          const ne = elems[n]!
          if (ne === E_WATER || ne === E_STEAM) {
            // Water (or the steam already flashing off it) quenches lava to glass.
            if (ne === E_WATER) morph(c, n, E_STEAM, true)
            morph(c, row, E_GLASS, false)
            fieldAddP(f, x, y, 3)
            continue
          }
          ignite(ctx, c, n)
        }
        break
      }
      case E_WATER: {
        const d = (rng() * 4) | 0
        const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
        if (n >= 0) {
          const ne = elems[n]!
          if (ne === E_FIRE) {
            morph(c, n, E_SMOKE, false)
            c.life[n] = 30
          } else if (ne === E_LAVA) {
            morph(c, row, E_STEAM, true)
            morph(c, n, E_GLASS, false)
            fieldAddP(f, x, y, 3)
            continue
          }
        }
        break
      }
      case E_ACID: {
        const d = (rng() * 4) | 0
        const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
        if (n >= 0) {
          const ne = elems[n]!
          if (ne !== E_WALL && ne !== E_GLASS && ne !== E_ACID && ne !== E_FIRE) {
            kill(ctx, c, n)
            c.life[row] = c.life[row]! - 60
            fieldAddT(f, x, y, 90, 0.03)
          }
        }
        if (c.life[row]! <= 0) {
          morph(c, row, E_SMOKE, false)
          c.life[row] = 40
          continue
        }
        break
      }
      case E_SALT: {
        const d = (rng() * 4) | 0
        const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
        if (n >= 0 && elems[n]! === E_WATER) {
          c.meta[n] = c.meta[n]! | 1
          kill(ctx, c, row)
          continue
        }
        break
      }
      case E_FUSE: {
        if (c.meta[row]! === 1) {
          c.life[row] = c.life[row]! - 1
          fieldAddT(f, x, y, 400, 0.05)
          if (c.life[row]! <= 4) {
            for (let k = 0; k < 8; k++) {
              const n = occupant(ctx, x + DX8[k]!, y + DY8[k]!)
              if (n >= 0 && elems[n]! === E_FUSE && c.meta[n]! === 0) c.meta[n] = 1
            }
          }
          if (c.life[row]! <= 0) {
            morph(c, row, E_FIRE, false)
            c.life[row] = 50
            fieldAddP(f, x, y, 6)
          }
        }
        continue // static — no movement
      }
      case E_PLANT: {
        if (((tick + row) & 7) === 0) {
          const d = (rng() * 8) | 0
          const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
          if (n >= 0 && elems[n]! === E_WATER) morph(c, n, E_PLANT, false)
        }
        continue
      }
      case E_WOOD: {
        if (c.meta[row]! === 1) {
          c.life[row] = c.life[row]! - 1
          fieldAddT(f, x, y, 700, 0.06)
          if (rng() < 0.12) {
            const ox = ((rng() * 3) | 0) - 1
            spawnAt(ctx, c, x + ox, y - 1, E_FIRE)
          }
          if (rng() < 0.03) {
            const k = (rng() * 8) | 0
            const n = occupant(ctx, x + DX8[k]!, y + DY8[k]!)
            if (n >= 0) ignite(ctx, c, n)
          }
          if (c.life[row]! <= 0) {
            morph(c, row, E_SMOKE, false)
            continue
          }
        }
        continue
      }
      case E_VIRUS: {
        c.life[row] = c.life[row]! - 1
        if (c.life[row]! <= 0) {
          kill(ctx, c, row)
          continue
        }
        if (((tick + row) & 3) === 0) {
          const d = (rng() * 8) | 0
          const n = occupant(ctx, x + DX8[d]!, y + DY8[d]!)
          if (n >= 0) {
            const ne = elems[n]!
            if (ne !== E_WALL && ne !== E_GLASS && ne !== E_VIRUS && ne !== E_FIRE) {
              const inherited = c.life[row]! - 12
              if (inherited > 0) {
                morph(c, n, E_VIRUS, false)
                c.life[n] = inherited
              }
            }
          }
        }
        continue
      }
      case E_SMOKE: {
        c.life[row] = c.life[row]! - 1
        if (c.life[row]! <= 0) {
          kill(ctx, c, row)
          continue
        }
        break
      }
      case E_ICE:
      case E_GLASS:
        continue // static
      default:
        break
    }

    // ── Movement ─────────────────────────────────────────────────────────────
    const em = elems[row]!
    if (em === E_NONE) continue
    const cat = CATEGORY[em]!
    const px2 = c.px[row]!
    const py2 = c.py[row]!

    // Ballistic impulse from explosions: straight-line steps until blocked, then damp out.
    let ivx = c.vx[row]!
    let ivy = c.vy[row]!
    if (ivx * ivx + ivy * ivy >= 1) {
      const mag = Math.sqrt(ivx * ivx + ivy * ivy)
      const steps = mag > 4 ? 4 : mag | 0
      const sx = ivx / mag
      const sy = ivy / mag
      let cx = px2
      let cy = py2
      let fxp = px2
      let fyp = py2
      for (let s = 1; s <= steps; s++) {
        const tx = px2 + Math.round(sx * s)
        const ty = py2 + Math.round(sy * s)
        if (tx === cx && ty === cy) continue
        const at = occupant(ctx, tx, ty)
        if (at !== -1) {
          c.vx[row] = ivx * 0.25
          c.vy[row] = ivy * 0.25
          break
        }
        fxp = tx
        fyp = ty
        cx = tx
        cy = ty
      }
      if (fxp !== px2 || fyp !== py2) moveTo(ctx, c, row, fxp, fyp)
      c.vx[row] = c.vx[row]! * 0.8
      c.vy[row] = c.vy[row]! * 0.8
      continue
    }

    if (cat === CAT_POWDER || cat === CAT_LIQUID) {
      // Gravity accumulates into vy → accelerating multi-cell falls.
      let gv = c.vy[row]! + 0.22
      if (gv > 4) gv = 4
      let fell = 0
      const maxFall = 1 + (gv | 0)
      let cx = c.px[row]!
      let cy = c.py[row]!
      while (fell < maxFall) {
        const below = occupant(ctx, cx, cy + 1)
        if (below === -1) {
          moveTo(ctx, c, row, cx, cy + 1)
          cy++
          fell++
          continue
        }
        if (below >= 0) {
          const be = elems[below]!
          const bcat = CATEGORY[be]!
          if ((bcat === CAT_LIQUID || bcat === CAT_GAS) && DENSITY[be]! < DENSITY[em]!) {
            swapCells(ctx, c, row, below)
            cy++
            fell++
            continue
          }
        }
        break
      }
      if (fell > 0) {
        c.vy[row] = gv
        continue
      }
      c.vy[row] = 0

      // Diagonal slide.
      const dir = rng() < 0.5 ? 1 : -1
      for (let k = 0; k < 2; k++) {
        const dx = k === 0 ? dir : -dir
        const diag = occupant(ctx, cx + dx, cy + 1)
        if (diag === -1) {
          moveTo(ctx, c, row, cx + dx, cy + 1)
          fell = 1
          break
        }
        if (diag >= 0 && cat === CAT_POWDER) {
          const be = elems[diag]!
          const bcat = CATEGORY[be]!
          if (bcat === CAT_LIQUID && DENSITY[be]! < DENSITY[em]!) {
            swapCells(ctx, c, row, diag)
            fell = 1
            break
          }
        }
      }
      if (fell > 0) continue

      // Liquids spread laterally.
      if (cat === CAT_LIQUID) {
        const run = SPREAD[em]!
        const ldir = rng() < 0.5 ? 1 : -1
        for (let k = 0; k < 2; k++) {
          const dx = k === 0 ? ldir : -ldir
          let moved = false
          for (let s = 1; s <= run; s++) {
            if (occupant(ctx, cx + dx * s, cy) !== -1) break
            moved = true
            if (occupant(ctx, cx + dx * s, cy + 1) === -1) break
          }
          if (moved) {
            let s = 1
            while (s <= run && occupant(ctx, cx + dx * s, cy) === -1) {
              if (occupant(ctx, cx + dx * s, cy + 1) === -1) break
              s++
            }
            const fx = cx + dx * Math.min(s, run)
            if (occupant(ctx, fx, cy) === -1) {
              moveTo(ctx, c, row, fx, cy)
              break
            }
          }
        }
      }
      continue
    }

    if (cat === CAT_GAS) {
      const cx = c.px[row]!
      const cy = c.py[row]!
      const roll = rng()
      let dx = 0
      let dy = -1
      if (roll < 0.55) dx = 0
      else if (roll < 0.75) dx = -1
      else if (roll < 0.95) dx = 1
      else dy = 0
      if (dy === 0) dx = roll < 0.975 ? -1 : 1
      const at = occupant(ctx, cx + dx, cy + dy)
      if (at === -1) {
        moveTo(ctx, c, row, cx + dx, cy + dy)
      } else if (at >= 0 && dy === -1) {
        const ae = elems[at]!
        if (CATEGORY[ae]! === CAT_LIQUID) swapCells(ctx, c, row, at) // bubbles
      }
      continue
    }
  }

  // ── Apply queued explosions (the queue may grow while applying — chains) ───
  for (let qi = 0; qi + 2 < ctx.booms.length + 3 && qi < 128 * 3; qi += 3) {
    if (qi >= ctx.booms.length) break
    applyBoom(ctx, c, f, ctx.booms[qi]!, ctx.booms[qi + 1]!, ctx.booms[qi + 2]!)
  }
  ctx.booms.length = 0
}

function applyBoom(ctx: SimCtx, c: ParticleCols, f: FieldCols, bx: number, by: number, power: number): void {
  const r = power >= 120 ? 11 : 7
  const r2 = r * r
  const rng = ctx.rng
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const d2 = ox * ox + oy * oy
      if (d2 > r2) continue
      const x = bx + ox
      const y = by + oy
      if (x < 0 || x >= SIM_W || y < 0 || y >= SIM_H) continue
      const at = occupant(ctx, x, y)
      const dist = Math.sqrt(d2)
      if (at === -1) {
        if (rng() < 0.3) {
          const row = spawnAt(ctx, c, x, y, E_FIRE)
          if (row >= 0) c.life[row] = 12 + ((rng() * 24) | 0)
        }
      } else if (at >= 0) {
        const e = c.elem[at]!
        if (e === E_WALL) continue
        if (e === E_GUNPOWDER) {
          ctx.booms.push(x, y, 90)
          kill(ctx, c, at)
          continue
        }
        if (e === E_NITRO) {
          ctx.booms.push(x, y, 160)
          kill(ctx, c, at)
          continue
        }
        if (e === E_WATER) {
          morph(c, at, E_STEAM, true)
          continue
        }
        if (e === E_ICE) {
          morph(c, at, E_WATER, true)
          continue
        }
        if (FLAMMABLE[e]! > 0 && rng() < 0.7) {
          ignite(ctx, c, at)
          continue
        }
        const cat = CATEGORY[e]!
        if (cat === CAT_POWDER || cat === CAT_LIQUID) {
          const inv = power / (6 * (1 + dist))
          c.vx[at] = c.vx[at]! + (dist === 0 ? 0 : (ox / dist) * inv)
          c.vy[at] = c.vy[at]! + (dist === 0 ? -inv : (oy / dist) * inv)
          c.temp[at] = c.temp[at]! + 120
        }
      }
      if ((x & 3) === 0 && (y & 3) === 0) {
        const fall = 1 - dist / r
        fieldAddP(f, x, y, power * fall * 0.7)
        fieldAddT(f, x, y, 1200, 0.5 * fall)
      }
    }
  }
}
