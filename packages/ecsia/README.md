# ecsia

**A fast, type-safe Entity Component System for TypeScript.** Define components
once and get fully typed queries everywhere, with optional automatic
multithreading that produces results identical to a single-threaded run.

This is the umbrella package: it re-exports the whole cohesive public API —
world/entity/component/query/relations/scheduler/serialization — from one import, and
tree-shakes whatever you don't touch. (The power-user scoped packages — `@ecsia/core`,
`@ecsia/schema`, `@ecsia/relations`, `@ecsia/scheduler`, `@ecsia/serialization` — remain
available if you want to compose the layers by hand.)

> **Status:** 0.1.0, not yet on npm — a local workspace package for now.

## Install

```sh
pnpm add ecsia   # not yet published — local workspace for now
```

## Quick start

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
  read: [Velocity],
  write: [Position],
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
// threaded:true changes no system, query, or accessor code. The result is bit-identical to
// the single-threaded result (a fixed worker-index command-buffer merge makes it deterministic).
const world = createWorld({ components: [/* ... */], threaded: true })
```

The worker pool is `node:worker_threads` + `Atomics` based and requires `SharedArrayBuffer`;
without it, ecsia warns and runs single-threaded — never silently. A browser Web-Worker pool
is future work.

## Links

- Repository, full guide, and benchmarks: https://github.com/andymai/ecsia
- Docs site: coming with GitHub Pages

## License

[MIT](./LICENSE) © Andy Aragon
