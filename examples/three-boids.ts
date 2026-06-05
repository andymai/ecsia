// Example: boids flocking bound to real THREE.js objects (P4). This is the @ecsia/three bridge end to
// end — the SAME flocking sim as boids.ts, but each boid is mirrored into a THREE.Object3D AND a
// THREE.InstancedMesh every frame. Everything runs HEADLESS: we use three's math + scene-graph core
// only (Object3D/InstancedMesh/Matrix4), never a WebGLRenderer, so it runs in Node with no GPU.
//
// The frame loop is driven by createThreeDriver().tick(dt) (manual stepping — no requestAnimationFrame
// in Node). Each tick: the scheduler runs Cohesion → Movement → transformSync → instancedSync, then the
// driver's render() callback (a no-op here; a real app would call renderer.render(scene, camera)).
//
// Components use the @ecsia/three transform conventions: position {x,y,z} f32. Velocity is the sim's
// own component. We define them per-call (component ids are world-scoped) so main() can run repeatedly.

import { createWorld, defineComponent, defineSystem, createScheduler, read, write } from '@ecsia/ecsia'
import type { EntityHandle } from '@ecsia/ecsia'
import {
  createThreeBindings,
  makeTransformSyncSystem,
  makeInstancedSyncSystem,
  createThreeDriver,
} from '@ecsia/three'
import { BufferGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three'

export interface ThreeBoidsOptions {
  /** Number of boids. Default 64. */
  readonly count?: number
  /** Fixed ticks to run. Default 90. */
  readonly ticks?: number
  /** Fixed timestep seconds. Default 1/60. */
  readonly dt?: number
  /** Cohesion pull toward the centroid per second. Default 0.5. */
  readonly cohesion?: number
  /** Deterministic PRNG seed. Default 1. */
  readonly seed?: number
}

export interface ThreeBoidsResult {
  readonly count: number
  readonly ticks: number
  /** Centroid of the ECS positions at end state. */
  readonly centroid: { x: number; y: number; z: number }
  /** The bound Object3D world positions at end state (one per boid, in spawn order). */
  readonly objectPositions: ReadonlyArray<{ x: number; y: number; z: number }>
  /** The InstancedMesh per-slot translations at end state (sorted by x for stable comparison). */
  readonly instanceTranslationsByX: ReadonlyArray<{ x: number; y: number; z: number }>
  /** The InstancedMesh's live instance count at end state. */
  readonly instanceCount: number
  /** Max abs difference between an ECS position and its bound Object3D (proves the sync tracks). */
  readonly maxObjectDrift: number
}

function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function main(opts: ThreeBoidsOptions = {}): ThreeBoidsResult {
  const count = opts.count ?? 64
  const ticks = opts.ticks ?? 90
  const dt = opts.dt ?? 1 / 60
  const cohesion = opts.cohesion ?? 0.5
  const rand = lcg(opts.seed ?? 1)

  const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32', dz: 'f32' }, { name: 'velocity' })

  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

  // The THREE side: a scene-graph of Object3Ds (one per boid) + a single InstancedMesh for the whole
  // flock. Constructed headless — no renderer touches them.
  const scene = new Scene()
  const bindings = createThreeBindings(world, scene)
  bindings.autoUnbindOn(Position) // auto-teardown on despawn (none here, but wires the contract)
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

  // The bridge systems. transformSync mirrors columns → each bound Object3D; instancedSync writes the
  // InstancedMesh's instanceMatrix. Both declare read-only access, so they layer after Movement (which
  // writes Position) on the read-after-write conflict — no manual ordering needed.
  const transformSync = makeTransformSyncSystem({ position: Position, bindings })
  const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })

  const scheduler = createScheduler(world, [Cohesion, Movement, transformSync, instancedSync])

  // Drive the frame loop through the bridge's driver (manual tick — no rAF in Node). render() is a
  // no-op stand-in for renderer.render(scene, camera).
  const driver = createThreeDriver({ update: (d) => scheduler.update(d), render: () => {} })
  for (let t = 0; t < ticks; t++) driver.tick(dt)

  // Read back the end state from BOTH sides and confirm the THREE objects track the ECS.
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
