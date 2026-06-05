import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createScheduler } from '@ecsia/scheduler'
import { BufferGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three'
import { makeInstancedSyncSystem } from '../src/index.js'

const mkPosition = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const mkRotation = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32', w: 'f32' }, { name: 'rotation' })
const mkScale = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'scale' })

const mkMesh = (capacity: number) =>
  new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), capacity)

const translationAt = (mesh: InstancedMesh, slot: number): Vector3 => {
  const m = new Matrix4()
  mesh.getMatrixAt(slot, m)
  return new Vector3().setFromMatrixPosition(m)
}

describe('@ecsia/three makeInstancedSyncSystem', () => {
  test('writes instanceMatrix translations from position columns and sets count + needsUpdate', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const mesh = mkMesh(8)
    const versionBefore = mesh.instanceMatrix.version

    world.spawnWith([Position, { x: 10, y: 0, z: 0 }])
    world.spawnWith([Position, { x: 20, y: 0, z: 0 }])
    world.spawnWith([Position, { x: 30, y: 0, z: 0 }])

    const sync = makeInstancedSyncSystem({ mesh, position: Position })
    createScheduler(world, [sync]).update()

    expect(mesh.count).toBe(3)
    // `needsUpdate = true` is write-only on three's BufferAttribute (it bumps `.version`).
    expect(mesh.instanceMatrix.version).toBeGreaterThan(versionBefore)

    const xs = [0, 1, 2].map((s) => translationAt(mesh, s).x).sort((a, b) => a - b)
    expect(xs).toEqual([10, 20, 30])
  })

  test('composes scale into the instance matrix when configured', () => {
    const Position = mkPosition()
    const Scale = mkScale()
    const world = createWorld({ components: [Position, Scale] })
    const mesh = mkMesh(4)
    world.spawnWith([Position, { x: 1, y: 2, z: 3 }], [Scale, { x: 2, y: 2, z: 2 }])

    const sync = makeInstancedSyncSystem({ mesh, position: Position, scale: Scale })
    createScheduler(world, [sync]).update()

    const m = new Matrix4()
    mesh.getMatrixAt(0, m)
    const pos = new Vector3()
    const scl = new Vector3()
    const q = new Quaternion()
    m.decompose(pos, q, scl)
    expect([pos.x, pos.y, pos.z]).toEqual([1, 2, 3])
    expect([scl.x, scl.y, scl.z]).toEqual([2, 2, 2])
  })

  test('composes the FULL TRS (position + rotation + scale) per entity, matching a hand-built matrix', () => {
    // Strongest matrix-content assertion: build the expected Matrix4 from the SAME TRS the columns hold
    // and compare element-by-element against what the system wrote. This proves rotation is composed in
    // (not just translation/scale) and in the right TRS order.
    const Position = mkPosition()
    const Rotation = mkRotation()
    const Scale = mkScale()
    const world = createWorld({ components: [Position, Rotation, Scale] })
    const mesh = mkMesh(4)

    const qExp = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3) // 60° about Y
    world.spawnWith(
      [Position, { x: 4, y: 5, z: 6 }],
      [Rotation, { x: qExp.x, y: qExp.y, z: qExp.z, w: qExp.w }],
      [Scale, { x: 2, y: 3, z: 4 }],
    )

    const sync = makeInstancedSyncSystem({ mesh, position: Position, rotation: Rotation, scale: Scale })
    createScheduler(world, [sync]).update()

    const got = new Matrix4()
    mesh.getMatrixAt(0, got)
    const expected = new Matrix4().compose(new Vector3(4, 5, 6), qExp, new Vector3(2, 3, 4))
    // f32 columns → tolerate single-precision rounding per element.
    for (let i = 0; i < 16; i++) {
      expect(got.elements[i]!).toBeCloseTo(expected.elements[i]!, 5)
    }

    // Decompose as a second, independent check of the TRS round-trip.
    const p = new Vector3()
    const q = new Quaternion()
    const s = new Vector3()
    got.decompose(p, q, s)
    expect([p.x, p.y, p.z].map((v) => Math.round(v))).toEqual([4, 5, 6])
    expect([s.x, s.y, s.z].map((v) => Math.round(v))).toEqual([2, 3, 4])
    // Quaternion equal up to sign (decompose may flip the whole quaternion).
    const dot = Math.abs(q.x * qExp.x + q.y * qExp.y + q.z * qExp.z + q.w * qExp.w)
    expect(dot).toBeCloseTo(1, 5)
  })

  test('sets instanceMatrix.needsUpdate true every sync', () => {
    // `needsUpdate` is a write-only setter on three's BufferAttribute (it bumps `.version` and resets the
    // backing flag). We assert the version advances on EACH update — proving the buffer is re-flagged for
    // re-upload every frame, even when nothing structurally changed.
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const mesh = mkMesh(4)
    world.spawnWith([Position, { x: 1, y: 0, z: 0 }])

    const sched = createScheduler(world, [makeInstancedSyncSystem({ mesh, position: Position })])
    const v0 = mesh.instanceMatrix.version
    sched.update()
    const v1 = mesh.instanceMatrix.version
    sched.update()
    const v2 = mesh.instanceMatrix.version
    expect(v1).toBeGreaterThan(v0)
    expect(v2).toBeGreaterThan(v1)
  })

  test('declares a read-only SystemDef shape (read terms present, write empty)', () => {
    const Position = mkPosition()
    const Scale = mkScale()
    const world = createWorld({ components: [Position, Scale] })
    const mesh = mkMesh(2)
    const sync = makeInstancedSyncSystem({ mesh, position: Position, scale: Scale })
    expect(sync.name).toBe('three:instancedSync')
    expect(sync.write).toEqual([])
    expect(new Set(sync.read)).toEqual(new Set([Position, Scale]))
    expect(typeof sync.run).toBe('function')
  })

  test('count tracks query size as the population changes across frames', () => {
    // count is recomputed from the matched set each frame: grow the population, count grows; nothing
    // matched → count is 0.
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const mesh = mkMesh(8)
    const sched = createScheduler(world, [makeInstancedSyncSystem({ mesh, position: Position })])

    sched.update()
    expect(mesh.count).toBe(0)

    world.spawnWith([Position, { x: 1, y: 0, z: 0 }])
    world.spawnWith([Position, { x: 2, y: 0, z: 0 }])
    sched.update()
    expect(mesh.count).toBe(2)

    world.spawnWith([Position, { x: 3, y: 0, z: 0 }])
    sched.update()
    expect(mesh.count).toBe(3)
  })

  test('count caps at mesh capacity; entities beyond it are dropped', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const mesh = mkMesh(2)
    for (let i = 0; i < 5; i++) world.spawnWith([Position, { x: i, y: 0, z: 0 }])

    const sync = makeInstancedSyncSystem({ mesh, position: Position })
    createScheduler(world, [sync]).update()
    expect(mesh.count).toBe(2)
  })

  test('slots are swap-compacted across despawns (NOT entity-stable)', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const mesh = mkMesh(8)

    // Spawn 3 birds in one archetype. Archetype-walk order == spawn order, so slots are 0,1,2.
    const h0 = world.spawnWith([Position, { x: 100, y: 0, z: 0 }])
    const h1 = world.spawnWith([Position, { x: 200, y: 0, z: 0 }])
    const h2 = world.spawnWith([Position, { x: 300, y: 0, z: 0 }])
    void h1

    const sched = createScheduler(world, [makeInstancedSyncSystem({ mesh, position: Position })])
    sched.update()
    expect([0, 1, 2].map((s) => translationAt(mesh, s).x)).toEqual([100, 200, 300])

    // Despawn the FIRST entity (h0) in its own frame. The storage swap-compacts: the last row (h2,
    // x=300) fills h0's hole. Run a separate frame for the despawn so it is fully applied before the
    // next sync, then re-sync — slot 0 now holds 300, proving slots are NOT entity-stable.
    const killer = {
      name: 'kill',
      read: [],
      write: [],
      run({ world: w }: { world: typeof world }) {
        if (w.isAlive(h0)) w.despawn(h0)
      },
    }
    createScheduler(world, [killer]).update()
    sched.update()

    expect(mesh.count).toBe(2)
    const remaining = [0, 1].map((s) => translationAt(mesh, s).x).sort((a, b) => a - b)
    expect(remaining).toEqual([200, 300]) // h0 (100) gone; the survivors' transforms are intact
    // Slot 0 was rewritten from the compacted survivor (300), proving slots track iteration order.
    expect(translationAt(mesh, 0).x).toBe(300)
    void h2
  })
})
