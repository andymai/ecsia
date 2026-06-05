# @ecsia/scheduler

The frame scheduler for [**ecsia**](https://github.com/andymai/ecsia) — a fast, type-safe Entity
Component System for TypeScript.

`@ecsia/scheduler` derives an access-graph conflict DAG from each system's declared
`{read, write}` set, runs the resulting waves, and — opt-in — dispatches disjoint-write work
across a real `worker_threads` + `Atomics` pool whose result is **bit-identical** to the
serial path (a fixed worker-index command-buffer merge makes the merge order deterministic).

> **Status:** 0.1.0, unpublished. Most users want the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), which re-exports `defineSystem`,
> `createScheduler`, and `WorkerPool`.
>
> **Known limitation (worker pool):** the pool is `node:worker_threads`-based and requires
> `SharedArrayBuffer`; without it, ecsia warns and runs single-threaded — never silently.
> A browser Web-Worker pool is future work.

## Install

```sh
pnpm add @ecsia/scheduler @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
