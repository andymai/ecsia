// A flock of birds. Each bird is an entity with a Position and a Velocity; a Cohesion system
// nudges every bird toward the group's center, and a Movement system adds velocity to position
// each tick (one simulation step), so the flock visibly pulls together. Demonstrates the everyday
// ecsia loop — defineComponent, createWorld, defineSystem, createScheduler, and the query API —
// all imported from the umbrella package. The thing to notice: the systems never declare an
// order; the scheduler works it out from their read/write declarations.

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  read,
  write,
} from 'ecsia'
import type { EntityHandle } from 'ecsia'

export interface BirdsOptions {
  /** Number of birds to simulate. Default 256. */
  readonly count?: number
  /** Number of fixed ticks to run. Default 120. */
  readonly ticks?: number
  /** Fixed timestep. Default 1/60. */
  readonly dt?: number
  /** Strength of the pull toward the flock's center, per second. Default 0.5. */
  readonly cohesion?: number
  /** Seed for the random-number generator. Default 1. */
  readonly seed?: number
}

export interface BirdsResult {
  readonly count: number
  readonly ticks: number
  /** The centroid — the average position, the flock's center — of all birds at the end. */
  readonly centroid: { x: number; y: number }
  /** Mean speed at the end (proof the movement system actually ran). */
  readonly meanSpeed: number
  /** Raw end positions (for the smoke test). */
  readonly positions: ReadonlyArray<{ x: number; y: number }>
}

// A tiny seeded random-number generator (same seed, same sequence — keeps runs reproducible
// without pulling in a dependency).
function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function main(opts: BirdsOptions = {}): BirdsResult {
  const count = opts.count ?? 256
  const ticks = opts.ticks ?? 120
  const dt = opts.dt ?? 1 / 60
  const cohesion = opts.cohesion ?? 0.5
  const rand = seededRandom(opts.seed ?? 1)

  // Component definitions get their id when registered with a world, so they're created fresh on
  // every call — that lets main() run repeatedly (e.g. across smoke-test cases).
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

  const handles: EntityHandle[] = []
  for (let i = 0; i < count; i++) {
    // One spawnWith call creates the entity AND fills in both components. Object literals evaluate
    // left to right, so the rand() draws land in x, y, dx, dy order — keeping runs reproducible.
    handles.push(
      world.spawnWith(
        [Position, { x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200 }],
        [Velocity, { dx: (rand() - 0.5) * 20, dy: (rand() - 0.5) * 20 }],
      ),
    )
  }

  // Cohesion is the pull toward the group's center that makes individuals form a flock. Each tick
  // this system recomputes the centroid (the average position — the flock's center) from a
  // read-only Position query, then steers every bird's velocity toward it.
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

  // Cohesion writes Velocity and Movement reads it, so the scheduler places them in separate waves
  // (a wave is a batch of systems that can safely run at the same time): Cohesion first, then
  // Movement. We never wrote that ordering down — it falls out of the read/write declarations.
  const scheduler = createScheduler(world, [Cohesion, Movement])
  for (let t = 0; t < ticks; t++) scheduler.update(dt)

  const positions: { x: number; y: number }[] = []
  let cx = 0
  let cy = 0
  let speedSum = 0
  for (const h of handles) {
    // world.entity() reuses one pooled reference rather than allocating a new one, so copy a
    // component's fields out before asking for the next — never hold two live accessors at once.
    const p = world.entity(h).read(Position)
    const px = p.x
    const py = p.y
    const v = world.entity(h).read(Velocity)
    positions.push({ x: px, y: py })
    cx += px
    cy += py
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
