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

On top of that it ships the loop itself: `createRollbackSession` predicts the inputs
that have not arrived, checkpoints every frame into a bounded ring, and — when a
confirmed input contradicts a prediction — rewinds and re-simulates automatically.

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

## The rollback loop

`createRollbackSession` owns the predict → confirm → rollback → re-simulate cycle. It
takes no dependency on a scheduler (you hand it one fixed step) and knows nothing about
your input format (opaque bytes it buffers and byte-compares); `applyInputs` is where you
write them into whatever components your systems read.

```ts
import { createWorld, defineComponent } from '@ecsia/core'
import { createRollbackSession } from '@ecsia/rollback'

const Intent = defineComponent({ move: 'i32', fire: 'i32' }, { name: 'intent' })
const world = createWorld({ components: [Intent] })
const avatars = new Map<number, ReturnType<typeof world.spawnWith>>([
  [0, world.spawnWith(Intent)],
  [1, world.spawnWith(Intent)],
])

const session = createRollbackSession(world, {
  maxRollbackFrames: 8, // ≈133 ms at 60Hz — the deepest correction the ring can absorb
  players: [0, 1],
  step: () => runOneFixedStep(), // e.g. () => scheduler.update(1 / 60)
  applyInputs: (_frame, inputs) => {
    for (const player of inputs.players) {
      const bytes = inputs.get(player)
      const intent = world.entity(avatars.get(player as number)!).write(Intent)
      intent.move = bytes[0] ?? 0
      intent.fire = bytes[1] ?? 0
    }
  },
})

// Per frame: feed the local input, advance. Remote inputs are predicted until they land.
for (let i = 0; i < 2; i++) {
  session.recordInput(0, session.currentFrame + 1, new Uint8Array([1, 0]))
  session.advance()
}

// A remote input for a PAST frame that contradicts its prediction rewinds and re-simulates
// inside this call; one that matches costs nothing but an advancing confirmedFrame. Only a frame
// this session actually simulated is accepted — the first is the tick it was created at, plus one.
session.recordInput(1, session.currentFrame - 1, new Uint8Array([0, 1]))

declare function runOneFixedStep(): void
```

`step()` must advance `world.tick` exactly once and must end at a frame boundary (its
observer drain done) — the session checkpoints immediately after it returns, and an image
rewinds state, not the event stream. Both are asserted, not assumed.

A correction for a frame further back than `maxRollbackFrames` is **unrecoverable**: the
session leaves the world untouched (never a partial rewind) and reports it through
`onUnrecoverable`, or throws when you did not supply one. Resync from a fresh
authoritative state at that point.

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
