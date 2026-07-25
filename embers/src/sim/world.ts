// Builds one EMBER WORKS session: same seed + same paint events → same universe, byte for byte.
// Also home to the state hash: FNV-1a over every live particle, the whole air field, and the tick
// — the number the HUD shows, share URLs embed, and the replay verifier + E2E bench assert on.
// It reads column VALUES in fixed row order, never event order.

import { createScheduler, createWorld, read, write } from '@ecsia/kit'
import type { SchedulerHandle, World } from '@ecsia/kit'
import { makeDefs } from './components.js'
import type { SimDefs } from './components.js'
import { makeSystems } from './systems.js'
import type { RunState } from './systems.js'
import { makeCtx } from './particles.js'
import type { FieldCols, PaintEvent, ParticleCols } from './particles.js'
import { AMBIENT_T, BANDS, BAND_CELLS, DT, PART_CAP, f32bits, fnvInit, fnvMix, makeRng } from './shared.js'
import { E_NONE } from './elements.js'

export interface SimConfig {
  seed: number
  threaded: boolean
  workers: number
  createWorker?: (() => Worker) | undefined
}

export interface Sim {
  world: World
  defs: SimDefs
  threaded: boolean
  /** Advance one tick. Returns a promise on the threaded path. */
  step(): void | Promise<void>
  tick(): number
  /** Queue paint segments for a future tick (live input, scripts, replays). */
  queue(tick: number, events: PaintEvent[]): void
  hash(): number
  live(): number
  /** Direct read views for the renderer and the hash — valid only between steps. */
  cols(): ParticleCols
  fields(): FieldCols
  dispose(): Promise<void>
}

interface QueryChunk {
  count: number
  column(def: unknown, field: string): ArrayBufferView
}

export function buildSim(cfg: SimConfig): Sim {
  const defs = makeDefs()
  const world = createWorld({
    components: [...defs.FCur, ...defs.FNew, defs.Particle, defs.MainPin],
    maxEntities: 1 << 18,
    ...(cfg.threaded ? { threaded: true as const, scheduler: { workers: cfg.workers } } : {}),
  })

  // Field entities FIRST, band-major and row-major — the worker kernels' row ↔ cell contract
  // (kernels.ts) depends on this exact spawn order. Then the whole particle pool.
  for (let b = 0; b < BANDS; b++) {
    for (let i = 0; i < BAND_CELLS; i++) {
      world.spawnWith(
        [defs.FCur[b]!, { t: AMBIENT_T, p: 0, vx: 0, vy: 0 }],
        [defs.FNew[b]!, { t: AMBIENT_T, p: 0, vx: 0, vy: 0 }],
      )
    }
  }
  for (let i = 0; i < PART_CAP; i++) {
    world.spawnWith([defs.Particle, { elem: 0, px: 0, py: 0, vx: 0, vy: 0, temp: 0, life: 0, meta: 0 }])
  }

  const pending = new Map<number, PaintEvent[]>()
  const state: RunState = {
    sim: makeCtx(makeRng(cfg.seed)),
    eventsFor(tick: number): PaintEvent[] {
      const evs = pending.get(tick)
      if (evs === undefined) return []
      pending.delete(tick)
      return evs
    },
  }

  const systems = makeSystems(defs, state)
  const createWorker = cfg.threaded ? cfg.createWorker : undefined
  const threaded = createWorker !== undefined
  const scheduler: SchedulerHandle = createScheduler(
    world,
    systems,
    createWorker !== undefined ? { workers: cfg.workers, threading: { createWorker } } : undefined,
  )

  const grabCols = (): ParticleCols => {
    let cols: ParticleCols | null = null
    ;(world.query(read(defs.Particle)) as unknown as { eachChunk(fn: (c: QueryChunk) => void): void }).eachChunk(
      (chunk) => {
        cols = {
          elem: chunk.column(defs.Particle, 'elem') as Int32Array,
          px: chunk.column(defs.Particle, 'px') as Int32Array,
          py: chunk.column(defs.Particle, 'py') as Int32Array,
          vx: chunk.column(defs.Particle, 'vx') as Float32Array,
          vy: chunk.column(defs.Particle, 'vy') as Float32Array,
          temp: chunk.column(defs.Particle, 'temp') as Float32Array,
          life: chunk.column(defs.Particle, 'life') as Int32Array,
          meta: chunk.column(defs.Particle, 'meta') as Int32Array,
        }
      },
    )
    if (cols === null) throw new Error('particle pool missing')
    return cols
  }

  const grabFields = (): FieldCols => {
    const f: FieldCols = { t: [], p: [], vx: [], vy: [] }
    for (let b = 0; b < BANDS; b++) {
      ;(world.query(read(defs.FCur[b]!)) as unknown as { eachChunk(fn: (c: QueryChunk) => void): void }).eachChunk(
        (chunk) => {
          f.t.push(chunk.column(defs.FCur[b]!, 't') as Float32Array)
          f.p.push(chunk.column(defs.FCur[b]!, 'p') as Float32Array)
          f.vx.push(chunk.column(defs.FCur[b]!, 'vx') as Float32Array)
          f.vy.push(chunk.column(defs.FCur[b]!, 'vy') as Float32Array)
        },
      )
    }
    return f
  }

  return {
    world,
    defs,
    threaded,
    step: () => scheduler.update(DT),
    tick: () => world.currentTick() as unknown as number,
    queue(tick, events) {
      const at = pending.get(tick)
      if (at === undefined) pending.set(tick, [...events])
      else at.push(...events)
    },
    hash() {
      const c = grabCols()
      const f = grabFields()
      let h = fnvInit()
      h = fnvMix(h, world.currentTick() as unknown as number)
      h = fnvMix(h, state.sim.live)
      for (let row = 0; row < PART_CAP; row++) {
        const e = c.elem[row]!
        if (e === E_NONE) continue
        h = fnvMix(h, e)
        h = fnvMix(h, c.px[row]!)
        h = fnvMix(h, c.py[row]!)
        h = fnvMix(h, f32bits(c.vx[row]!))
        h = fnvMix(h, f32bits(c.vy[row]!))
        h = fnvMix(h, f32bits(c.temp[row]!))
        h = fnvMix(h, c.life[row]!)
        h = fnvMix(h, c.meta[row]!)
      }
      for (let b = 0; b < BANDS; b++) {
        const t = f.t[b]!
        const p = f.p[b]!
        const vx = f.vx[b]!
        const vy = f.vy[b]!
        for (let i = 0; i < BAND_CELLS; i++) {
          h = fnvMix(h, f32bits(t[i]!))
          h = fnvMix(h, f32bits(p[i]!))
          h = fnvMix(h, f32bits(vx[i]!))
          h = fnvMix(h, f32bits(vy[i]!))
        }
      }
      return h
    },
    live: () => state.sim.live,
    cols: grabCols,
    fields: grabFields,
    dispose: () => scheduler.dispose(),
  }
}
