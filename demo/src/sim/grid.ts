// Uniform spatial hash over the arena, rebuilt once per tick from the cohort position columns
// (counting sort into flat typed arrays — no per-tick allocation). Serial-side only: bullets,
// contact damage, novas, and next-tick auto-aim all query it. Determinism: insertion order is the
// cohort/chunk/row iteration order, which is itself deterministic.

import { ARENA_H, ARENA_W } from './shared.js'

const CELL = 16
const CW = Math.ceil(ARENA_W / CELL)
const CH = Math.ceil(ARENA_H / CELL)
const MAX = 1 << 16

export class SpatialGrid {
  readonly counts = new Int32Array(CW * CH + 1)
  readonly starts = new Int32Array(CW * CH + 1)
  readonly cellOf = new Int32Array(MAX)
  readonly ex = new Float32Array(MAX)
  readonly ey = new Float32Array(MAX)
  readonly eh = new Uint32Array(MAX)
  readonly slot = new Int32Array(MAX)
  readonly sx = new Float32Array(MAX)
  readonly sy = new Float32Array(MAX)
  readonly sh = new Uint32Array(MAX)
  n = 0

  reset(): void {
    this.n = 0
    this.counts.fill(0)
  }

  add(x: number, y: number, handle: number): void {
    if (this.n >= MAX) return
    let cxi = (x / CELL) | 0
    let cyi = (y / CELL) | 0
    if (cxi < 0) cxi = 0
    else if (cxi >= CW) cxi = CW - 1
    if (cyi < 0) cyi = 0
    else if (cyi >= CH) cyi = CH - 1
    const cell = cyi * CW + cxi
    const i = this.n++
    this.cellOf[i] = cell
    this.ex[i] = x
    this.ey[i] = y
    this.eh[i] = handle >>> 0
    this.counts[cell]!++
  }

  /** Counting-sort entries into cell order. Call once after the last add() of the tick. */
  build(): void {
    let acc = 0
    for (let c = 0; c < CW * CH + 1; c++) {
      this.starts[c] = acc
      acc += this.counts[c]!
    }
    const cursor = this.slot
    cursor.set(this.starts.subarray(0, CW * CH))
    for (let i = 0; i < this.n; i++) {
      const at = cursor[this.cellOf[i]!]!++
      this.sx[at] = this.ex[i]!
      this.sy[at] = this.ey[i]!
      this.sh[at] = this.eh[i]!
    }
  }

  /**
   * Visit entries within `r` of (x, y): fn(handle, ex, ey, d2). Return true from fn to stop early.
   */
  query(x: number, y: number, r: number, fn: (handle: number, ex: number, ey: number, d2: number) => boolean | void): void {
    const r2 = r * r
    let x0 = ((x - r) / CELL) | 0
    let x1 = ((x + r) / CELL) | 0
    let y0 = ((y - r) / CELL) | 0
    let y1 = ((y + r) / CELL) | 0
    if (x0 < 0) x0 = 0
    if (y0 < 0) y0 = 0
    if (x1 >= CW) x1 = CW - 1
    if (y1 >= CH) y1 = CH - 1
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = cy * CW + cx
        const start = this.starts[cell]!
        const end = this.starts[cell + 1]!
        for (let i = start; i < end; i++) {
          const dx = this.sx[i]! - x
          const dy = this.sy[i]! - y
          const d2 = dx * dx + dy * dy
          if (d2 <= r2) {
            if (fn(this.sh[i]!, this.sx[i]!, this.sy[i]!, d2) === true) return
          }
        }
      }
    }
  }

  /** Nearest entry within `r` of (x, y), or 0 if none (0 is never a valid full handle here). */
  nearest(x: number, y: number, r: number): { handle: number; x: number; y: number } | null {
    let best = r * r
    let bh = -1
    let bx = 0
    let by = 0
    this.query(x, y, r, (h, ex, ey, d2) => {
      if (d2 < best) {
        best = d2
        bh = h
        bx = ex
        by = ey
      }
    })
    return bh < 0 ? null : { handle: bh, x: bx, y: by }
  }
}
