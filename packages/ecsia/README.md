# ecsia

ecsia is an entity component system (ECS) for TypeScript — entities are ids,
components are typed data attached to them, and systems are functions that run over
entities with matching components. Define your components once and you get fully
typed queries everywhere, plus optional automatic multithreading that produces
results identical to a single-threaded run.

This is the umbrella package, and the place to start: it re-exports the whole public
API — world, entities, components, queries, relations, scheduler, serialization —
from one import, and tree-shakes whatever you don't touch. (The scoped packages
underneath — `@ecsia/core`, `@ecsia/schema`, `@ecsia/relations`, `@ecsia/scheduler`,
`@ecsia/serialization` — remain available if you want to compose the layers by hand.)

> **Status:** 0.1.0, not yet on npm — a local workspace package for now.

## Install

```sh
pnpm add ecsia   # not yet published — local workspace for now
```

## Quick start

A world holds your entities. `spawnWith` creates an entity with components attached,
`write` gives you a mutable view of one component, and inside a system, `query`
iterates every entity that has all the components you ask for — `read` and `write`
marking which ones the loop touches.

```ts
import {
  createWorld, defineComponent, defineSystem, createScheduler, read, write,
} from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })

const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })

const e = world.spawnWith(Position, Velocity)
world.entity(e).write(Velocity).dx = 5

const dt = 1 / 60
const Movement = defineSystem({
  name: 'Movement',
  read: [Velocity],   // this system only reads velocities…
  write: [Position],  // …and only writes positions
  run({ query }) {
    for (const el of query(read(Velocity), write(Position))) {
      el.position.x += el.velocity.dx * dt
      el.position.y += el.velocity.dy * dt
    }
  },
})

const scheduler = createScheduler(world, [Movement])
scheduler.update(dt) // run one frame
```

### Go parallel — same user code

```ts
// One flag — no changes to any system, query, or accessor code. Results are
// bit-identical to the single-threaded run: each worker queues its changes,
// and the queues are merged in a fixed order.
const world = createWorld({ components: [/* ... */], threaded: true })
```

The worker pool is `node:worker_threads` + `Atomics` based and requires
`SharedArrayBuffer`; without it, ecsia warns and runs single-threaded — never
silently. A browser Web-Worker pool is future work.

## Links

- Repository, full guide, and benchmarks: https://github.com/andymai/ecsia
- Docs site: coming with GitHub Pages

## License

[MIT](./LICENSE) © Andy Aragon
