# @ecsia/scheduler

The frame scheduler for [**ecsia**](https://github.com/andymai/ecsia), an entity
component system (ECS) for TypeScript — entities are ids, components are typed data
attached to them, and systems are functions that run over entities with matching
components.

Every ecsia system declares up front which components it reads and which it writes.
`@ecsia/scheduler` builds a conflict graph from those declarations, works out which
systems can never interfere with each other, and runs them in waves — batches of
systems that can safely run at the same time. Opt in, and waves run across a real
`worker_threads` + `Atomics` pool with results **bit-identical** to running on one
thread: each worker queues its changes, and the queues are merged in a fixed order, so
the outcome never depends on thread timing.

> **Status:** 0.1.0, unpublished. New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), which re-exports `defineSystem`,
> `createScheduler`, and `WorkerPool`.
>
> **Known limitation (worker pool):** the pool is `node:worker_threads`-based and
> requires `SharedArrayBuffer`; without it, ecsia warns and runs single-threaded —
> never silently. A browser Web-Worker pool is future work.

## Install

```sh
pnpm add @ecsia/scheduler @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
