// Scripted stroke programs: the idle attract scene and the one-click presets. A program is just a
// RecEvent stream — the same thing live painting records and share URLs replay — so scripted,
// hand-drawn, and replayed input all flow through one deterministic pipeline.

import type { RecEvent } from './codec.js'
import {
  E_ACID,
  E_FIRE,
  E_FUSE,
  E_GUNPOWDER,
  E_LAVA,
  E_NITRO,
  E_OIL,
  E_PLANT,
  E_SALT,
  E_SAND,
  E_WALL,
  E_WATER,
  E_WOOD,
} from '../sim/elements.js'

export interface StrokeProgram {
  name: string
  events: RecEvent[]
  ticks: number
}

class Builder {
  events: RecEvent[] = []
  t = 0

  wait(ticks: number): this {
    this.t += ticks
    return this
  }

  /** Draw a polyline over `ticks`, one event per tick — visibly hand-drawn, not teleported. */
  stroke(elem: number, r: number, pts: [number, number][], ticks: number): this {
    const segs = pts.length - 1
    for (let i = 0; i < ticks; i++) {
      const u = (i / (ticks - 1 || 1)) * segs
      const s = Math.min(segs - 1, u | 0)
      const f = u - s
      const x = Math.round(pts[s]![0] + (pts[s + 1]![0] - pts[s]![0]) * f)
      const y = Math.round(pts[s]![1] + (pts[s + 1]![1] - pts[s]![1]) * f)
      this.events.push({ tick: this.t + i, elem, x, y, r, stroke: i === 0 })
    }
    this.t += ticks
    return this
  }

  /** Hold the brush at one point for `ticks` (pouring). */
  pour(elem: number, r: number, x: number, y: number, ticks: number): this {
    return this.stroke(elem, r, [[x, y], [x, y]], ticks)
  }

  done(name: string): StrokeProgram {
    return { name, events: this.events, ticks: this.t }
  }
}

/** The idle showcase: bowl → sand → water → oil slick → ignition → lava → nitro finale. */
export function attractProgram(): StrokeProgram {
  const b = new Builder()
  b.wait(30)
  b.stroke(E_WALL, 5, [[120, 200], [180, 300], [320, 330], [460, 300], [520, 200]], 150)
  b.wait(20)
  b.pour(E_SAND, 9, 250, 60, 160)
  b.pour(E_SAND, 9, 390, 60, 160)
  b.wait(40)
  b.pour(E_WATER, 10, 320, 50, 200)
  b.wait(60)
  b.stroke(E_OIL, 6, [[240, 90], [400, 90]], 120)
  b.wait(50)
  b.pour(E_FIRE, 4, 320, 80, 30)
  b.wait(180)
  b.stroke(E_LAVA, 7, [[150, 60], [200, 60]], 140)
  b.wait(200)
  b.pour(E_NITRO, 6, 480, 60, 90)
  b.wait(120)
  b.pour(E_FIRE, 3, 480, 150, 12)
  b.wait(240)
  return b.done('attract')
}

/** Wall volcano + lava throat vs an ocean — glass, steam, and a plant shoreline. */
export function volcanoProgram(): StrokeProgram {
  const b = new Builder()
  b.stroke(E_WALL, 5, [[40, 340], [170, 120], [200, 120], [330, 340]], 140)
  b.stroke(E_WALL, 4, [[170, 120], [170, 340]], 40)
  b.stroke(E_WALL, 4, [[200, 120], [200, 340]], 40)
  b.pour(E_WATER, 12, 500, 80, 260)
  b.stroke(E_PLANT, 3, [[350, 336], [430, 336]], 60)
  b.pour(E_LAVA, 6, 185, 100, 420)
  b.wait(120)
  return b.done('volcano')
}

/** A wooden fort, gunpowder magazine, and one long fuse. */
export function powderKegProgram(): StrokeProgram {
  const b = new Builder()
  b.stroke(E_WALL, 4, [[80, 350], [560, 350]], 60)
  b.stroke(E_WOOD, 5, [[200, 340], [200, 220], [440, 220], [440, 340]], 160)
  b.stroke(E_WOOD, 5, [[160, 220], [320, 140], [480, 220]], 120)
  b.pour(E_GUNPOWDER, 8, 320, 300, 140)
  b.pour(E_NITRO, 5, 260, 320, 60)
  b.stroke(E_FUSE, 2, [[320, 260], [320, 180], [560, 180]], 140)
  b.wait(30)
  b.pour(E_FIRE, 3, 560, 176, 15)
  b.wait(300)
  return b.done('powder keg')
}

/** A sandstone skyline dissolving under acid weather. */
export function acidRainProgram(): StrokeProgram {
  const b = new Builder()
  b.stroke(E_WALL, 3, [[60, 350], [580, 350]], 50)
  for (let i = 0; i < 5; i++) {
    const x = 110 + i * 105
    const h = 160 + (i % 3) * 50
    b.stroke(E_SAND, 8, [[x, 340], [x, 340 - h], [x + 46, 340 - h], [x + 46, 340]], 90)
  }
  for (let sweep = 0; sweep < 6; sweep++) {
    b.stroke(E_ACID, 3, [[80, 20], [560, 20]], 130)
  }
  b.wait(200)
  return b.done('acid rain')
}

/** Still water, salt shore, and a plant colony taking the pond. */
export function gardenProgram(): StrokeProgram {
  const b = new Builder()
  b.stroke(E_WALL, 4, [[120, 250], [120, 330], [520, 330], [520, 250]], 110)
  b.pour(E_WATER, 11, 320, 100, 300)
  b.stroke(E_SALT, 4, [[130, 240], [180, 240]], 50)
  b.stroke(E_PLANT, 2, [[240, 326], [250, 326]], 30)
  b.stroke(E_PLANT, 2, [[400, 326], [410, 326]], 30)
  b.stroke(E_SAND, 6, [[520, 200], [560, 120]], 80)
  b.wait(400)
  return b.done('garden')
}

export const PRESETS: { key: string; label: string; make: () => StrokeProgram }[] = [
  { key: 'volcano', label: 'VOLCANO', make: volcanoProgram },
  { key: 'keg', label: 'POWDER KEG', make: powderKegProgram },
  { key: 'acid', label: 'ACID RAIN', make: acidRainProgram },
  { key: 'garden', label: 'GARDEN', make: gardenProgram },
]
