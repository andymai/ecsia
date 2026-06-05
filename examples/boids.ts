// Example: boids flocking. Position + Velocity components, one Movement system that integrates
// position from velocity each tick, plus a cohesion nudge toward the flock centroid so the end state
// is observable and deterministic. Single-threaded — the default kernel + scheduler path.
//
// Everything imports from the umbrella (@ecsia/ecsia), exercising defineComponent / createWorld /
// defineSystem / createScheduler / query DSL end-to-end.

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  read,
  write,
} from '@ecsia/ecsia'
import type { EntityHandle } from '@ecsia/ecsia'
import { wr, rd } from './_helpers.js'

export interface BoidsOptions {
  /** Number of boids to simulate. Default 256. */
  readonly count?: number
  /** Number of fixed ticks to run. Default 120. */
  readonly ticks?: number
  /** Fixed timestep. Default 1/60. */
  readonly dt?: number
  /** Cohesion pull toward the centroid per second. Default 0.5. */
  readonly cohesion?: number
  /** Deterministic PRNG seed. Default 1. */
  readonly seed?: number
}

export interface BoidsResult {
  readonly count: number
  readonly ticks: number
  /** Centroid of all boid positions at end state. */
  readonly centroid: { x: number; y: number }
  /** Mean speed at end state (the movement system actually ran). */
  readonly meanSpeed: number
  /** Raw end positions (for the smoke test). */
  readonly positions: ReadonlyArray<{ x: number; y: number }>
}

// A tiny deterministic LCG so the example is reproducible without a dependency.
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function main(opts: BoidsOptions = {}): BoidsResult {
  const count = opts.count ?? 256
  const ticks = opts.ticks ?? 120
  const dt = opts.dt ?? 1 / 60
  const cohesion = opts.cohesion ?? 0.5
  const rand = lcg(opts.seed ?? 1)

  // Component defs are world-scoped singletons (their id is minted at registration), so they are
  // created per-call — this lets the example's main() run repeatedly (e.g. across smoke-test cases).
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

  const handles: EntityHandle[] = []
  for (let i = 0; i < count; i++) {
    const h = world.spawnWith(Position, Velocity)
    const p = wr(world, h, Position)
    p.x = (rand() - 0.5) * 200
    p.y = (rand() - 0.5) * 200
    const v = wr(world, h, Velocity)
    v.dx = (rand() - 0.5) * 20
    v.dy = (rand() - 0.5) * 20
    handles.push(h)
  }

  // Cohesion: shared per-tick centroid the movement system steers toward. Recomputed each tick from a
  // read-only Position query so the example shows a read query feeding a write system.
  const centroid = { x: 0, y: 0 }
  const Cohesion = defineSystem({
    name: 'Cohesion',
    read: [Position],
    write: [Velocity],
    run({ query }) {
      let cx = 0
      let cy = 0
      let n = 0
      for (const e of query(read(Position))) {
        cx += e.position.x
        cy += e.position.y
        n++
      }
      if (n > 0) {
        centroid.x = cx / n
        centroid.y = cy / n
      }
      for (const e of query(read(Position), write(Velocity))) {
        e.velocity.dx += (centroid.x - e.position.x) * cohesion * dt
        e.velocity.dy += (centroid.y - e.position.y) * cohesion * dt
      }
    },
  })

  const Movement = defineSystem({
    name: 'Movement',
    read: [Velocity],
    write: [Position],
    run({ query }) {
      for (const e of query(read(Velocity), write(Position))) {
        e.position.x += e.velocity.dx * dt
        e.position.y += e.velocity.dy * dt
      }
    },
  })

  // Cohesion writes Velocity (wave 0); Movement reads Velocity + writes Position (wave 1) — a
  // read-after-write conflict on Velocity orders them, demonstrating the scheduler's wave layering.
  const scheduler = createScheduler(world, [Cohesion, Movement])
  for (let t = 0; t < ticks; t++) scheduler.update(dt)

  const positions: { x: number; y: number }[] = []
  let cx = 0
  let cy = 0
  let speedSum = 0
  for (const h of handles) {
    const p = rd(world, h, Position)
    const v = rd(world, h, Velocity)
    positions.push({ x: p.x, y: p.y })
    cx += p.x
    cy += p.y
    speedSum += Math.hypot(v.dx, v.dy)
  }

  return {
    count,
    ticks,
    centroid: { x: cx / count, y: cy / count },
    meanSpeed: speedSum / count,
    positions,
  }
}
