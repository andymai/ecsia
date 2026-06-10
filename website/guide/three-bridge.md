# THREE.js bridge

`@ecsia/three` keeps three.js objects in sync with your ECS entities (an entity is just an id — a
thing in your world whose data lives in components). It gives you three pieces: an
`EntityHandle → THREE.Object3D` registry, per-frame transform sync — to plain `Object3D`s and to
`InstancedMesh`es (three.js's way of drawing many copies of one shape in a single draw call) — and a
frame driver.

::: tip Opt-in, not in the umbrella
`@ecsia/three` is deliberately **not** re-exported from `@ecsia/kit`. THREE is a large peer dependency
with WebGL/DOM assumptions; the kernel stays renderer-agnostic. Install it explicitly:

```sh
pnpm add @ecsia/three three   # @ecsia/three is unpublished today — workspace-local for now
```
:::

It depends only on `@ecsia/core` + `@ecsia/schema`, with `three` as a **peer** dependency — the arrow
points one way (core ← three), so the kernel never imports a renderer.

## Bindings: entity → Object3D

`createThreeBindings(world, scene)` builds the registry. `bind(handle, object)` associates an entity
with a THREE object; `objectOf(handle)` resolves it back. `autoUnbindOn(anchor)` opts an anchor
component into auto-teardown when the entity despawns.

```ts
import { createWorld, defineComponent } from '@ecsia/kit'
import { createThreeBindings } from '@ecsia/three'
import { Object3D, Scene } from 'three'

const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], maxEntities: 1 << 16 })

const scene = new Scene()
const bindings = createThreeBindings(world, scene)
bindings.autoUnbindOn(Position)   // auto-teardown the binding when the entity despawns

const h = world.spawnWith([Position, { x: 0, y: 0, z: 0 }])
bindings.bind(h, new Object3D())
bindings.objectOf(h)              // → the bound Object3D
```

## Sync systems: component data → THREE every frame

Two read-only systems copy transform data to the THREE side each frame. Because they declare a read
on position, the scheduler automatically orders them **after** any system that writes position — a
read-after-write conflict does the ordering, so you never sequence them by hand:

- `makeTransformSyncSystem({ position, bindings })` — copies positions into each bound `Object3D`.
- `makeInstancedSyncSystem({ mesh, position })` — writes a `THREE.InstancedMesh`'s `instanceMatrix`.

```ts
import { createWorld, createScheduler, defineComponent } from '@ecsia/kit'
import { createThreeBindings, makeTransformSyncSystem, makeInstancedSyncSystem } from '@ecsia/three'
import { BufferGeometry, InstancedMesh, MeshBasicMaterial, Scene } from 'three'

const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], maxEntities: 1 << 16 })
const bindings = createThreeBindings(world, new Scene())

const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 64)

const transformSync = makeTransformSyncSystem({ position: Position, bindings })
const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })

const scheduler = createScheduler(world, [transformSync, instancedSync])
scheduler.update(1 / 60)
```

## Driver: the frame loop

`createThreeDriver({ update, render })` runs the loop: a `requestAnimationFrame` loop in the browser,
or manual `.tick(dt)` stepping in Node (no rAF). A fixed-timestep option is available.

```ts
import { createWorld, createScheduler } from '@ecsia/kit'
import { createThreeDriver } from '@ecsia/three'

const world = createWorld()
const scheduler = createScheduler(world, [])
const driver = createThreeDriver({
  update: (dt) => scheduler.update(dt),
  render: () => {/* renderer.render(scene, camera) */},
})

// Browser: the rAF loop drives it. Node / headless: step it manually.
for (let t = 0; t < 90; t++) driver.tick(1 / 60)
```

## A complete headless example

The `threejs-birds` example in `examples/` simulates a flock of birds and runs the full bridge
**headless** — it uses THREE's math and scene-graph core (`Object3D` / `InstancedMesh` / `Matrix4`)
but no `WebGLRenderer`, so it runs in Node with no GPU and asserts that the THREE objects track the
ECS positions every frame.

## See also

- [Devtools](/guide/devtools) — inspect the world the bridge drives.
- [Core concepts](/guide/core-concepts) — the systems and queries the sync systems layer after.
