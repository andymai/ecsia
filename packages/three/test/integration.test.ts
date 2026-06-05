// Integration: the full bridge driven frame-by-frame against a tiny moving sim. Unlike the
// examples/threejs-birds smoke test (which checks only the END state via the example's main()), this
// drives the scheduler one tick at a time and asserts that BOTH the bound Object3Ds AND the
// InstancedMesh slots track the ECS columns at EVERY intermediate frame — the "tracks the sim over
// frames" requirement. Everything is headless (Object3D / InstancedMesh / Matrix4 math core only).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { BufferGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three'
import {
  createThreeBindings,
  createThreeDriver,
  makeInstancedSyncSystem,
  makeTransformSyncSystem,
} from '../src/index.js'

const mkPosition = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const mkVelocity = () => defineComponent({ dx: 'f32', dy: 'f32', dz: 'f32' }, { name: 'velocity' })

const translationAt = (mesh: InstancedMesh, slot: number): Vector3 => {
  const m = new Matrix4()
  mesh.getMatrixAt(slot, m)
  return new Vector3().setFromMatrixPosition(m)
}

describe('@ecsia/three integration (driver + bindings + both sync systems)', () => {
  test('bound Object3Ds and InstancedMesh slots track the moving sim at every frame', () => {
    const Position = mkPosition()
    const Velocity = mkVelocity()
    const world = createWorld({ components: [Position, Velocity] })

    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    bindings.autoUnbindOn(Position)
    const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 8)

    // Three entities moving at distinct constant velocities — fully predictable per-frame.
    const specs = [
      { p: { x: 0, y: 0, z: 0 }, v: { dx: 1, dy: 0, dz: 0 } },
      { p: { x: 10, y: 0, z: 0 }, v: { dx: 0, dy: 2, dz: 0 } },
      { p: { x: 0, y: 10, z: 0 }, v: { dx: 0, dy: 0, dz: 3 } },
    ]
    const handles = specs.map((s) => {
      const h = world.spawnWith([Position, s.p], [Velocity, s.v])
      bindings.bind(h, new Object3D())
      return h
    })

    const dt = 0.5
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

    const transformSync = makeTransformSyncSystem({ position: Position, bindings })
    const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })
    const scheduler = createScheduler(world, [Movement, transformSync, instancedSync])
    const driver = createThreeDriver({ update: (d) => scheduler.update(d), render: () => {} })

    for (let frame = 0; frame < 6; frame++) {
      driver.tick(dt)

      // Every bound Object3D matches its entity's ECS position with ZERO drift this frame.
      const ecsByX: number[] = []
      for (const h of handles) {
        const p = world.entity(h).read(Position)
        const obj = bindings.objectOf(h)!
        expect(obj.position.x).toBe(p.x)
        expect(obj.position.y).toBe(p.y)
        expect(obj.position.z).toBe(p.z)
        ecsByX.push(p.x)
      }

      // The InstancedMesh holds one slot per entity, and its translations are the same multiset as the
      // ECS positions (both fed from the same columns this frame).
      expect(mesh.count).toBe(3)
      const meshXs = [0, 1, 2].map((s) => translationAt(mesh, s).x).sort((a, b) => a - b)
      expect(meshXs).toEqual([...ecsByX].sort((a, b) => a - b))
    }

    // After 6 ticks of dt=0.5 (t=3) the sim has visibly progressed: each entity moved velocity*t along
    // its axis, and the bound Object3D mirrors the ECS position exactly (asserted against the ECS, not a
    // hand-computed constant, so the assertion is robust to integration-order details).
    for (const h of handles) {
      const p = world.entity(h).read(Position)
      const obj = bindings.objectOf(h)!
      expect([obj.position.x, obj.position.y, obj.position.z]).toEqual([p.x, p.y, p.z])
    }
    // Entity 0 (vx=1) advanced from x=0; its x is now strictly positive — real motion occurred.
    expect(world.entity(handles[0]!).read(Position).x).toBeGreaterThan(0)
  })

  test('despawn mid-run: count shrinks and survivors stay correct (auto-unbind + compaction together)', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    bindings.autoUnbindOn(Position)
    const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 8)

    const h0 = world.spawnWith([Position, { x: 100, y: 0, z: 0 }])
    const h1 = world.spawnWith([Position, { x: 200, y: 0, z: 0 }])
    const h2 = world.spawnWith([Position, { x: 300, y: 0, z: 0 }])
    for (const h of [h0, h1, h2]) bindings.bind(h, new Object3D())

    const transformSync = makeTransformSyncSystem({ position: Position, bindings })
    const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })
    const scheduler = createScheduler(world, [transformSync, instancedSync])

    scheduler.update()
    expect(mesh.count).toBe(3)
    expect(bindings.size).toBe(3)

    // Despawn the middle entity inside a frame so onRemove drains; auto-unbind drops its binding.
    const killer = defineSystem({
      name: 'kill',
      read: [],
      write: [],
      run({ world: w }) {
        if (w.isAlive(h1)) w.despawn(h1)
      },
    })
    createScheduler(world, [killer]).update()
    scheduler.update()

    // The bridge: binding gone (no leak), instance count shrank, survivors' transforms intact.
    expect(bindings.size).toBe(2)
    expect(bindings.objectOf(h1)).toBeUndefined()
    expect(mesh.count).toBe(2)
    const remaining = [0, 1].map((s) => translationAt(mesh, s).x).sort((a, b) => a - b)
    expect(remaining).toEqual([100, 300])
    // Surviving Object3Ds still track their columns.
    expect(bindings.objectOf(h0)!.position.x).toBe(100)
    expect(bindings.objectOf(h2)!.position.x).toBe(300)
  })
})
