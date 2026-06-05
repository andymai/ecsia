import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createScheduler } from '@ecsia/scheduler'
import { Object3D } from 'three'
import { createThreeBindings, makeTransformSyncSystem } from '../src/index.js'

const mkPosition = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const mkRotation = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32', w: 'f32' }, { name: 'rotation' })
const mkScale = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'scale' })

describe('@ecsia/three makeTransformSyncSystem', () => {
  test('copies position columns into the bound Object3D each frame', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)

    const h = world.spawnWith([Position, { x: 1, y: 2, z: 3 }])
    const obj = new Object3D()
    bindings.bind(h, obj)

    const sync = makeTransformSyncSystem({ position: Position, bindings })
    createScheduler(world, [sync]).update()

    expect(obj.position.x).toBe(1)
    expect(obj.position.y).toBe(2)
    expect(obj.position.z).toBe(3)
  })

  test('tracks updates: re-running after a column write moves the object', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const h = world.spawnWith([Position, { x: 0, y: 0, z: 0 }])
    const obj = new Object3D()
    bindings.bind(h, obj)

    const sched = createScheduler(world, [makeTransformSyncSystem({ position: Position, bindings })])
    sched.update()
    expect(obj.position.x).toBe(0)

    world.entity(h).write(Position).x = 42
    sched.update()
    expect(obj.position.x).toBe(42)
  })

  test('syncs rotation quaternion and scale when configured', () => {
    const Position = mkPosition()
    const Rotation = mkRotation()
    const Scale = mkScale()
    const world = createWorld({ components: [Position, Rotation, Scale] })
    const bindings = createThreeBindings(world)

    const h = world.spawnWith(
      [Position, { x: 5, y: 6, z: 7 }],
      [Rotation, { x: 0, y: 0, z: 0, w: 1 }],
      [Scale, { x: 2, y: 3, z: 4 }],
    )
    const obj = new Object3D()
    bindings.bind(h, obj)

    const sync = makeTransformSyncSystem({ position: Position, rotation: Rotation, scale: Scale, bindings })
    createScheduler(world, [sync]).update()

    expect([obj.position.x, obj.position.y, obj.position.z]).toEqual([5, 6, 7])
    expect(obj.quaternion.w).toBe(1)
    expect([obj.scale.x, obj.scale.y, obj.scale.z]).toEqual([2, 3, 4])
  })

  test('writes the rotation quaternion VERBATIM — it does NOT normalize (documented contract)', () => {
    // DOCUMENTED BEHAVIOUR: the sync copies the four quaternion columns straight into
    // Object3D.quaternion via .set(x,y,z,w). three's Quaternion.set does NOT renormalize, so a
    // non-unit column quaternion lands non-unit on the object. The bridge's contract is "store
    // already-normalized quaternions in your rotation component"; we pin the verbatim-copy behaviour
    // here so a future normalization change is a conscious, tested decision.
    const Position = mkPosition()
    const Rotation = mkRotation()
    const world = createWorld({ components: [Position, Rotation] })
    const bindings = createThreeBindings(world)

    // A deliberately UN-normalized quaternion (length 2).
    const h = world.spawnWith([Position, { x: 0, y: 0, z: 0 }], [Rotation, { x: 0, y: 0, z: 0, w: 2 }])
    const obj = new Object3D()
    bindings.bind(h, obj)

    createScheduler(world, [makeTransformSyncSystem({ position: Position, rotation: Rotation, bindings })]).update()

    expect(obj.quaternion.w).toBe(2)
    expect(obj.quaternion.length()).toBeCloseTo(2, 6) // NOT renormalized to 1
  })

  test('scale defaults are untouched when no scale term is configured', () => {
    // The system never writes Object3D.scale unless a scale component is configured, so a pre-set scale
    // on the object survives the sync (the bridge owns position+rotation, leaves scale to the caller).
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const h = world.spawnWith([Position, { x: 1, y: 1, z: 1 }])
    const obj = new Object3D()
    obj.scale.set(9, 9, 9)
    bindings.bind(h, obj)

    createScheduler(world, [makeTransformSyncSystem({ position: Position, bindings })]).update()

    expect([obj.scale.x, obj.scale.y, obj.scale.z]).toEqual([9, 9, 9])
  })

  test('declares a read-only SystemDef shape (read terms present, write empty)', () => {
    // Assert the FULL access-declaration shape the scheduler reads: every configured transform component
    // is a READ, the write set is empty (the system mutates only THREE objects, never the ECS), and the
    // descriptor carries a stable name. This is what lets the scheduler parallelize the bridge freely.
    const Position = mkPosition()
    const Rotation = mkRotation()
    const Scale = mkScale()
    const world = createWorld({ components: [Position, Rotation, Scale] })
    const bindings = createThreeBindings(world)
    const sync = makeTransformSyncSystem({ position: Position, rotation: Rotation, scale: Scale, bindings })

    expect(typeof sync.name).toBe('string')
    expect(sync.name).toBe('three:transformSync')
    expect(sync.write).toEqual([])
    expect(new Set(sync.read)).toEqual(new Set([Position, Rotation, Scale]))
    expect(typeof sync.run).toBe('function')
  })

  test('honours a custom system name', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const sync = makeTransformSyncSystem({ position: Position, bindings, name: 'mySync' })
    expect(sync.name).toBe('mySync')
  })

  test('unbound entities are skipped without error and bound ones still sync', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    world.spawnWith([Position, { x: 1, y: 1, z: 1 }]) // never bound — must be skipped
    const bound = world.spawnWith([Position, { x: 7, y: 8, z: 9 }])
    const obj = new Object3D()
    bindings.bind(bound, obj)

    const sync = makeTransformSyncSystem({ position: Position, bindings })
    expect(() => createScheduler(world, [sync]).update()).not.toThrow()
    // The unbound entity is skipped; the bound one is still synced correctly.
    expect([obj.position.x, obj.position.y, obj.position.z]).toEqual([7, 8, 9])
  })
})
