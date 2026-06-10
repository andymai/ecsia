# @ecsia/three

A [three.js](https://threejs.org) bridge for [**ecsia**](https://github.com/andymai/ecsia),
an entity component system (ECS) for TypeScript — entities are ids, components are
typed data attached to them, and systems are functions that run over entities with
matching components.

`@ecsia/three` keeps three.js objects in sync with your component data, so your scene
follows your simulation. It is **deliberately not** re-exported from the umbrella,
because `three` is a large peer dependency — you opt in explicitly.

> **Status:** 0.1.0, unpublished. New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), then add this bridge when you're
> ready to draw.

## Install

```sh
# not yet published — local workspace for now
pnpm add @ecsia/three @ecsia/core three
```

`three` is a **peer dependency** (`>=0.169 <1`); install it alongside.

## Use

Bind entities to `Object3D`s, then let a bridge system copy your component columns into the
scene each frame:

```ts
import { createWorld, defineComponent, createScheduler } from '@ecsia/kit'
import { createThreeBindings, makeTransformSyncSystem, createThreeDriver } from '@ecsia/three'
import { Object3D, Scene } from 'three'

const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position] })

const scene = new Scene()
const bindings = createThreeBindings(world, scene) // EntityHandle <-> Object3D
bindings.autoUnbindOn(Position)                    // drop the Object3D when the entity despawns

const ship = world.spawnWith([Position, { x: 0, y: 0, z: 0 }])
bindings.bind(ship, new Object3D())

// A bridge system copies each entity's Position into its bound Object3D every frame. It only reads
// Position, so the scheduler runs it after your movement systems — no manual ordering needed.
const sync = makeTransformSyncSystem({ position: Position, bindings })
const scheduler = createScheduler(world, [sync])

// The driver owns the frame loop: start() runs requestAnimationFrame in the browser; in Node, call
// tick(dt) by hand. render() stands in for renderer.render(scene, camera).
const driver = createThreeDriver({ update: (dt) => scheduler.update(dt), render: () => {} })
driver.start()
```

The world stays the single source of truth; three.js follows it. There's also
`makeInstancedSyncSystem` for driving an `InstancedMesh` from a column in one draw call — see the
[full headless example](https://github.com/andymai/ecsia/blob/main/examples/threejs-birds.ts).

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- three.js bridge guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
