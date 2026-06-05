// The flock of birds from birds.ts, mirrored into real three.js objects via the @ecsia/three
// bridge. Each frame, two bridge systems copy every bird's position into a bound Object3D and
// into an InstancedMesh (three.js's way of drawing many copies of one shape in a single draw
// call). Everything runs headless (no GPU or window — pure data, runs in Node): we use three's
// math objects only, never a renderer. The thing to notice: the bridge systems are ordinary
// systems, so the scheduler orders them after Movement from their read/write declarations alone.

import { createWorld, defineComponent, defineSystem, createScheduler, read, write } from 'ecsia'
import type { EntityHandle } from 'ecsia'
import {
  createThreeBindings,
  makeTransformSyncSystem,
  makeInstancedSyncSystem,
  createThreeDriver,
} from '@ecsia/three'
import { BufferGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three'

export interface ThreejsBirdsOptions {
  /** Number of birds. Default 64. */
  readonly count?: number
  /** Fixed ticks to run. Default 90. */
  readonly ticks?: number
  /** Fixed timestep seconds. Default 1/60. */
  readonly dt?: number
  /** Strength of the pull toward the flock's center, per second. Default 0.5. */
  readonly cohesion?: number
  /** Seed for the random-number generator. Default 1. */
  readonly seed?: number
}

export interface ThreejsBirdsResult {
  readonly count: number
  readonly ticks: number
  /** The centroid (the average position — the flock's center) of the ECS positions at the end. */
  readonly centroid: { x: number; y: number; z: number }
  /** The bound Object3D world positions at the end (one per bird, in spawn order). */
  readonly objectPositions: ReadonlyArray<{ x: number; y: number; z: number }>
  /** The InstancedMesh per-slot translations at the end (sorted by x for stable comparison). */
  readonly instanceTranslationsByX: ReadonlyArray<{ x: number; y: number; z: number }>
  /** The InstancedMesh's live instance count at the end. */
  readonly instanceCount: number
  /** Max abs difference between an ECS position and its bound Object3D (proof the sync kept up). */
  readonly maxObjectDrift: number
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function main(opts: ThreejsBirdsOptions = {}): ThreejsBirdsResult {
  const count = opts.count ?? 64
  const ticks = opts.ticks ?? 90
  const dt = opts.dt ?? 1 / 60
  const cohesion = opts.cohesion ?? 0.5
  const rand = seededRandom(opts.seed ?? 1)

  const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32', dz: 'f32' }, { name: 'velocity' })

  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

  // The three.js side: one Object3D per bird plus a single InstancedMesh for the whole flock.
  // Built headless — no renderer ever touches them.
  const scene = new Scene()
  const bindings = createThreeBindings(world, scene)
  // Unbinds automatically when an entity despawns (is removed from the world) — none do here,
  // but a real app wants this wired up.
  bindings.autoUnbindOn(Position)
  const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), count)

  const handles: EntityHandle[] = []
  for (let i = 0; i < count; i++) {
    const h = world.spawnWith(
      [Position, { x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200, z: (rand() - 0.5) * 200 }],
      [Velocity, { dx: (rand() - 0.5) * 20, dy: (rand() - 0.5) * 20, dz: (rand() - 0.5) * 20 }],
    )
    handles.push(h)
    bindings.bind(h, new Object3D())
  }

  // Cohesion: the pull toward the group's center that makes individuals form a flock. Each tick it
  // recomputes the centroid (the average position — the flock's center) and steers velocities at it.
  const centroid = { x: 0, y: 0, z: 0 }
  const Cohesion = defineSystem({
    name: 'Cohesion',
    read: [Position],
    write: [Velocity],
    run({ query }) {
      let cx = 0
      let cy = 0
      let cz = 0
      let n = 0
      for (const e of query(read(Position))) {
        cx += e.position.x
        cy += e.position.y
        cz += e.position.z
        n++
      }
      if (n > 0) {
        centroid.x = cx / n
        centroid.y = cy / n
        centroid.z = cz / n
      }
      for (const e of query(read(Position), write(Velocity))) {
        e.velocity.dx += (centroid.x - e.position.x) * cohesion * dt
        e.velocity.dy += (centroid.y - e.position.y) * cohesion * dt
        e.velocity.dz += (centroid.z - e.position.z) * cohesion * dt
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
        e.position.z += e.velocity.dz * dt
      }
    },
  })

  // The bridge systems. transformSync copies each entity's position into its bound Object3D;
  // instancedSync writes the InstancedMesh's per-instance matrices. Both only read Position, so
  // the scheduler runs them after Movement (which writes Position) — no manual ordering needed.
  const transformSync = makeTransformSyncSystem({ position: Position, bindings })
  const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })

  const scheduler = createScheduler(world, [Cohesion, Movement, transformSync, instancedSync])

  // The bridge's driver steps the frame loop by hand — there's no requestAnimationFrame in Node.
  // render() is a no-op stand-in for renderer.render(scene, camera).
  const driver = createThreeDriver({ update: (d) => scheduler.update(d), render: () => {} })
  for (let t = 0; t < ticks; t++) driver.tick(dt)

  // Read the end state from BOTH sides and confirm the three.js objects track the ECS data.
  let cx = 0
  let cy = 0
  let cz = 0
  let maxObjectDrift = 0
  const objectPositions: { x: number; y: number; z: number }[] = []
  for (const h of handles) {
    const p = world.entity(h).read(Position)
    const px = p.x
    const py = p.y
    const pz = p.z
    cx += px
    cy += py
    cz += pz
    const obj = bindings.objectOf(h)!
    objectPositions.push({ x: obj.position.x, y: obj.position.y, z: obj.position.z })
    maxObjectDrift = Math.max(
      maxObjectDrift,
      Math.abs(obj.position.x - px),
      Math.abs(obj.position.y - py),
      Math.abs(obj.position.z - pz),
    )
  }

  const m = new Matrix4()
  const v = new Vector3()
  const instanceTranslations: { x: number; y: number; z: number }[] = []
  for (let s = 0; s < mesh.count; s++) {
    mesh.getMatrixAt(s, m)
    v.setFromMatrixPosition(m)
    instanceTranslations.push({ x: v.x, y: v.y, z: v.z })
  }
  instanceTranslations.sort((a, b) => a.x - b.x)

  return {
    count,
    ticks,
    centroid: { x: cx / count, y: cy / count, z: cz / count },
    objectPositions,
    instanceTranslationsByX: instanceTranslations,
    instanceCount: mesh.count,
    maxObjectDrift,
  }
}
