# @ecsia/rollback

Checkpointing for [**ecsia**](https://github.com/andymai/ecsia), an entity component
system (ECS) for TypeScript — entities are ids, components are typed data attached to
them, and systems are functions that run over entities with matching components.

`@ecsia/rollback` captures a whole world into a reusable image and restores it **in
place**, so a rollback-netcode or prediction loop can rewind to a checkpoint and
re-simulate. A restore is **handle-stable**: every entity keeps the exact handle it had
at capture, every entity reference stored in a component still resolves, and queries
stay valid — no remap table, unlike a network snapshot from
[`@ecsia/serialization`](https://www.npmjs.com/package/@ecsia/serialization), which
re-mints entities on the receiver.

Images are reusable: after the live set stops growing, capturing into an existing image
allocates nothing, so a ring of images costs no per-frame garbage.

> **Status:** 0.x. v1 refuses (loudly) to capture a world that uses relations, has
> entities in cold archetypes, or registers a rich (`'string'` / `object<T>`) field —
> that state is not in the image, and failing fast beats restoring a partial world.

## Install

```sh
pnpm add @ecsia/rollback @ecsia/core
```

```ts
import { createWorld } from '@ecsia/core'
import { createRollbackSurface } from '@ecsia/rollback'

const world = createWorld({ components: [] })
const rollback = createRollbackSurface(world)
const checkpoint = rollback.newImage()

rollback.captureImage(checkpoint) // between frames, world.phase === 'serial'
// ...simulate, mispredict...
rollback.restoreImage(checkpoint) // every handle is back, in place
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
