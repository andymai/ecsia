import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createScheduler } from '@ecsia/scheduler'
import { Object3D, Scene } from 'three'
import { createThreeBindings } from '../src/index.js'

// Component defs are world-scoped singletons (their id is minted at registration), so each test mints
// its own Position — the module-level exported `Position` can only ever bind to a single world.
const mkPosition = () => defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })

// Despawn an entity inside a system body and run one full frame, so the remove is logged DURING the wave
// and the onRemove observer drains at frame end — the lifecycle the dot-cascade example documents. A
// despawn issued outside a frame would have its shape-log entry reset by the next frame's frameReset.
function despawnAndStep(world: ReturnType<typeof createWorld>, h: ReturnType<typeof world.spawn>): void {
  const sys = {
    name: 'despawner',
    read: [],
    write: [],
    run({ world: w }: { world: ReturnType<typeof createWorld> }) {
      if (w.isAlive(h)) w.despawn(h)
    },
  }
  createScheduler(world, [sys]).update()
}

describe('@ecsia/three bindings', () => {
  test('bind / objectOf / unbind round-trip', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const h = world.spawnWith(Position)
    const obj = new Object3D()

    expect(bindings.has(h)).toBe(false)
    bindings.bind(h, obj)
    expect(bindings.objectOf(h)).toBe(obj)
    expect(bindings.has(h)).toBe(true)
    expect(bindings.size).toBe(1)

    expect(bindings.unbind(h)).toBe(obj)
    expect(bindings.objectOf(h)).toBeUndefined()
    expect(bindings.size).toBe(0)
  })

  test('bind adds to scene, unbind removes from scene', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    const h = world.spawnWith(Position)
    const obj = new Object3D()

    bindings.bind(h, obj)
    expect(obj.parent).toBe(scene)
    bindings.unbind(h)
    expect(obj.parent).toBeNull()
  })

  test('re-binding a handle detaches the previous object', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    const h = world.spawnWith(Position)
    const a = new Object3D()
    const b = new Object3D()

    bindings.bind(h, a)
    bindings.bind(h, b)
    expect(a.parent).toBeNull()
    expect(b.parent).toBe(scene)
    expect(bindings.objectOf(h)).toBe(b)
  })

  test('autoUnbindOn drops the binding when the entity despawns', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    bindings.autoUnbindOn(Position)

    const h = world.spawnWith(Position)
    const obj = new Object3D()
    bindings.bind(h, obj)
    expect(bindings.size).toBe(1)

    despawnAndStep(world, h) // despawn inside a frame + drain the onRemove observer

    expect(bindings.size).toBe(0)
    expect(bindings.objectOf(h)).toBeUndefined()
    expect(obj.parent).toBeNull()
  })

  test('autoUnbindOn drains via the public world.observerDrain path (no scheduler needed)', () => {
    // The onRemove observer can be flushed by ANY public drain seam, not just a scheduler frame: a
    // bare despawn + world.observerDrain() is the minimal public path and must also tear the binding down.
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    bindings.autoUnbindOn(Position)

    const h = world.spawnWith(Position)
    const obj = new Object3D()
    bindings.bind(h, obj)
    expect(bindings.size).toBe(1)

    world.despawn(h)
    world.observerDrain() // public reactive-flush seam

    expect(bindings.size).toBe(0)
    expect(bindings.objectOf(h)).toBeUndefined()
    expect(obj.parent).toBeNull()
  })

  test('no registry leak: size returns to zero across many spawn/despawn cycles', () => {
    // Guards against the index-keyed map retaining stale entries: spawn→bind→despawn→drain in a loop,
    // reusing freed slots. If unbind missed despawned entities (or keyed off the bumped handle) the map
    // would grow unbounded. We assert the registry is empty after every cycle AND at the end.
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    bindings.autoUnbindOn(Position)

    for (let i = 0; i < 50; i++) {
      const h = world.spawnWith(Position)
      bindings.bind(h, new Object3D())
      expect(bindings.size).toBe(1)
      world.despawn(h)
      world.observerDrain()
      expect(bindings.size).toBe(0)
    }
    expect(bindings.size).toBe(0)
  })

  test('autoUnbindOn is idempotent per anchor', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const a = bindings.autoUnbindOn(Position)
    const b = bindings.autoUnbindOn(Position)
    expect(a).toBe(b)
  })

  test('sweep drops bindings of dead entities without an anchor observer', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const h = world.spawnWith(Position)
    bindings.bind(h, new Object3D())
    world.despawn(h)

    expect(bindings.size).toBe(1) // not auto-swept (no anchor observer)
    const dropped = bindings.sweep()
    expect(dropped).toBe(1)
    expect(bindings.size).toBe(0)
  })

  test('entries() yields the live (handle, object) pairs', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const bindings = createThreeBindings(world)
    const h0 = world.spawnWith(Position)
    const h1 = world.spawnWith(Position)
    const o0 = new Object3D()
    const o1 = new Object3D()
    bindings.bind(h0, o0)
    bindings.bind(h1, o1)

    const pairs = [...bindings.entries()]
    expect(pairs.length).toBe(2)
    const objs = new Set(pairs.map(([, o]) => o))
    expect(objs).toEqual(new Set([o0, o1]))
    // The handle in each pair resolves back to the same bound object.
    for (const [h, o] of pairs) expect(bindings.objectOf(h)).toBe(o)
  })

  test('clear detaches everything', () => {
    const Position = mkPosition()
    const world = createWorld({ components: [Position] })
    const scene = new Scene()
    const bindings = createThreeBindings(world, scene)
    const objs = [new Object3D(), new Object3D()]
    for (const o of objs) bindings.bind(world.spawnWith(Position), o)
    bindings.clear()
    expect(bindings.size).toBe(0)
    for (const o of objs) expect(o.parent).toBeNull()
  })
})
