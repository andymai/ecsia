# THREE.js bridge

`@ecsia/three` mirrors ECS entities into THREE.js objects: an `EntityHandle → THREE.Object3D` registry,
per-frame transform sync (to `Object3D`s and `InstancedMesh`es), and a frame driver.

::: tip Opt-in, not in the umbrella
`@ecsia/three` is deliberately **not** re-exported from `@ecsia/ecsia`. THREE is a large peer dependency
with WebGL/DOM assumptions; the kernel stays renderer-agnostic. Install it explicitly:

```ts no-check
pnpm add @ecsia/three three   # @ecsia/three is unpublished today — workspace-local for now
```
:::

It depends only on `@ecsia/core` + `@ecsia/schema`, with `three` as a **peer** dependency — the arrow
points one way (core ← three), so the kernel never imports a renderer.

## Bindings: entity → Object3D

`createThreeBindings(world, scene)` builds the registry. `bind(handle, object)` associates an entity
with a THREE object; `objectOf(handle)` resolves it back. `autoUnbindOn(anchor)` opts an anchor
component into auto-teardown when the entity despawns.

```ts no-check
import { createWorld, defineComponent } from '@ecsia/ecsia'
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

## Sync systems: columns → THREE every frame

Two read-only systems copy transform columns to the THREE side each frame, so they layer **after** any
system that writes position (a read-after-write conflict orders them — no manual ordering needed):

- `makeTransformSyncSystem({ position, bindings })` — copies columns into each bound `Object3D`.
- `makeInstancedSyncSystem({ mesh, position })` — writes a `THREE.InstancedMesh`'s `instanceMatrix`.

```ts no-check
import { createScheduler } from '@ecsia/ecsia'
import { makeTransformSyncSystem, makeInstancedSyncSystem } from '@ecsia/three'
import { BufferGeometry, InstancedMesh, MeshBasicMaterial } from 'three'

const mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), 64)

const transformSync = makeTransformSyncSystem({ position: Position, bindings })
const instancedSync = makeInstancedSyncSystem({ mesh, position: Position })

const scheduler = createScheduler(world, [Movement, transformSync, instancedSync])
```

## Driver: the frame loop

`createThreeDriver({ update, render })` runs the loop: a `requestAnimationFrame` loop in the browser, or
manual `.tick(dt)` stepping in Node (no rAF). A fixed-timestep option is available.

```ts no-check
import { createThreeDriver } from '@ecsia/three'

const driver = createThreeDriver({
  update: (dt) => scheduler.update(dt),
  render: () => {/* renderer.render(scene, camera) */},
})

// Browser: the rAF loop drives it. Node / headless: step it manually.
for (let t = 0; t < 90; t++) driver.tick(1 / 60)
```

## A complete headless example

The `three-boids` example in `examples/` runs the full bridge **headless** — it uses THREE's math and
scene-graph core (`Object3D` / `InstancedMesh` / `Matrix4`) but no `WebGLRenderer`, so it runs in Node
with no GPU and asserts that the THREE objects track the ECS positions every frame.

::: warning Snippets here are shown, not compiled
The blocks on this page are marked `no-check` because they require the `three` peer types in a way the
doc-snippet checker doesn't wire. The compiled, asserted version lives in `examples/three-boids.ts`.
:::

## See also

- [Devtools](/guide/devtools) — inspect the world the bridge drives.
- [Core concepts](/guide/core-concepts) — the systems and queries the sync systems layer after.
