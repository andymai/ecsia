// Builds one LIFE's world: same seed → same horde, plus one player entity per input stream (ghosts)
// and optionally the live player. A run is a sequence of these worlds — each death rebuilds from
// t=0 with one more ghost. Also home to the state hash: FNV-1a over the full gameplay state, the
// number the HUD shows live and the replay verifier checks. It must be identical serial vs threaded
// vs replayed — it reads column VALUES in deterministic chunk order, never event order.

import { createScheduler, createWorld, has, read } from '@ecsia/kit'
import type { SchedulerHandle, World } from '@ecsia/kit'
import { makeDefs } from './components.js'
import type { SimDefs } from './components.js'
import { makeSystems, spawnPlayers } from './systems.js'
import type { RunCtx } from './systems.js'
import { SpatialGrid } from './grid.js'
import { COHORTS, DT, LOOP_TICKS, fnvInit, fnvMix, makeRng } from './shared.js'

export interface LifeConfig {
  seed: number
  /** Ghost input streams, slot-indexed (each ends at that life's death tick). */
  streams: Uint8Array[]
  /** Live input sampler, or null in replay mode (all streams are ghosts). */
  liveDir: (() => number) | null
  /** Records the live player's sampled dir per tick (LOOP_TICKS long). */
  record: Uint8Array | null
  overdrive: number
  threaded: boolean
  workers: number
  createWorker?: (() => Worker) | undefined
}

export interface Life {
  world: World
  defs: SimDefs
  ctx: RunCtx
  scheduler: SchedulerHandle
  /** Whether THIS life runs on the worker pool (the HUD badge reports the life, not the setting). */
  threaded: boolean
  /** Advance one tick. Returns a promise on the threaded path. */
  step(): void | Promise<void>
  tick(): number
  /** How many live-input ticks were recorded (the truncation length at death). */
  recordedTicks(): number
  hash(): number
  counts(): { enemies: number; bullets: number; gems: number; entities: number }
  dispose(): Promise<void>
}

const bits = new Float32Array(1)
const bitsU = new Uint32Array(bits.buffer)
const f32bits = (v: number): number => {
  bits[0] = v
  return bitsU[0]!
}

export function buildLife(cfg: LifeConfig): Life {
  const defs = makeDefs()
  const liveSlot = cfg.liveDir === null ? -1 : cfg.streams.length
  const playerCount = cfg.streams.length + (cfg.liveDir === null ? 0 : 1)
  let maxRecorded = -1

  const ctx: RunCtx = {
    dirAt(slot, tick) {
      if (slot === liveSlot && cfg.liveDir !== null) {
        const dir = cfg.liveDir()
        if (cfg.record !== null && tick < cfg.record.length) {
          cfg.record[tick] = dir
          if (tick > maxRecorded) maxRecorded = tick
        }
        return dir
      }
      const stream = cfg.streams[slot]
      if (stream === undefined || tick >= stream.length) return -1
      return stream[tick]!
    },
    liveSlot,
    overdrive: cfg.overdrive,
    // Ghost count of THIS timeline. playerCount - 1 (not streams.length) so a replay — where the
    // final life's own stream is one more ghost and there is no live player — reproduces the same
    // difficulty pressure the recorded life felt. This symmetry is what makes replays byte-identical.
    echoes: playerCount - 1,
    rng: makeRng(cfg.seed),
    grid: new SpatialGrid(),
    fx: [],
    kills: 0,
    liveDead: false,
    bossDown: false,
    spawnAcc: 0,
    spawnCounter: 0,
  }

  const world = createWorld({
    components: [...defs.EPos, ...defs.EVel, defs.EMeta, defs.Player, defs.Bullet, defs.Gem, defs.Boss, defs.MainPin],
    maxEntities: 1 << 16,
    ...(cfg.threaded ? { threaded: true as const, scheduler: { workers: cfg.workers } } : {}),
  })
  spawnPlayers(world, defs, playerCount)

  const systems = makeSystems(defs, ctx)
  // The world is created threaded for shared backings (above) on cfg.threaded alone, but a life only
  // truly drives a pool when a worker factory is also supplied — that stricter fact is what we report.
  const createWorker = cfg.threaded ? cfg.createWorker : undefined
  const threaded = createWorker !== undefined
  const scheduler = createScheduler(
    world,
    systems,
    createWorker !== undefined ? { workers: cfg.workers, threading: { createWorker } } : undefined,
  )

  return {
    world,
    defs,
    ctx,
    scheduler,
    threaded,
    step: () => scheduler.update(DT),
    tick: () => world.currentTick() as unknown as number,
    recordedTicks: () => maxRecorded + 1,
    hash() {
      let h = fnvInit()
      h = fnvMix(h, world.currentTick() as unknown as number)
      for (const e of world.query(read(defs.Player)) as Iterable<{ player: { x: number; y: number; hp: number; pow: number; slot: number } }>) {
        const p = e.player
        h = fnvMix(h, f32bits(p.x))
        h = fnvMix(h, f32bits(p.y))
        h = fnvMix(h, f32bits(p.hp))
        h = fnvMix(h, f32bits(p.pow))
        h = fnvMix(h, p.slot)
      }
      for (let c = 0; c < COHORTS; c++) {
        const q = world.query(read(defs.EPos[c]!))
        h = fnvMix(h, q.count)
        q.eachChunk((chunk) => {
          const xs = chunk.column(defs.EPos[c]!, 'x') as Float32Array
          const ys = chunk.column(defs.EPos[c]!, 'y') as Float32Array
          const n = chunk.count
          for (let r = 0; r < n; r++) {
            h = fnvMix(h, f32bits(xs[r]!))
            h = fnvMix(h, f32bits(ys[r]!))
          }
        })
      }
      const meta = world.query(read(defs.EMeta))
      meta.eachChunk((chunk) => {
        const hps = chunk.column(defs.EMeta, 'hp') as Float32Array
        const n = chunk.count
        for (let r = 0; r < n; r++) h = fnvMix(h, f32bits(hps[r]!))
      })
      const bullets = world.query(read(defs.Bullet))
      h = fnvMix(h, bullets.count)
      bullets.eachChunk((chunk) => {
        const xs = chunk.column(defs.Bullet, 'x') as Float32Array
        const ys = chunk.column(defs.Bullet, 'y') as Float32Array
        const n = chunk.count
        for (let r = 0; r < n; r++) {
          h = fnvMix(h, f32bits(xs[r]!))
          h = fnvMix(h, f32bits(ys[r]!))
        }
      })
      h = fnvMix(h, world.query(has(defs.Gem)).count)
      for (const e of world.query(read(defs.Boss)) as Iterable<{ boss: { x: number; y: number; hp: number; active: number } }>) {
        h = fnvMix(h, f32bits(e.boss.x))
        h = fnvMix(h, f32bits(e.boss.y))
        h = fnvMix(h, f32bits(e.boss.hp))
        h = fnvMix(h, e.boss.active)
      }
      return h
    },
    counts: () => ({
      enemies: world.query(has(defs.EMeta)).count,
      bullets: world.query(has(defs.Bullet)).count,
      gems: world.query(has(defs.Gem)).count,
      entities: world.handleStats().aliveCount,
    }),
    dispose: () => scheduler.dispose(),
  }
}

export { LOOP_TICKS }
