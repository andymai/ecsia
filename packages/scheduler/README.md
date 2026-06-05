# @ecsia/scheduler

The frame scheduler for [**ecsia**](https://github.com/andymai/ecsia) — a batteries-included,
TypeScript-native Entity Component System.

`@ecsia/scheduler` derives an access-graph conflict DAG from each system's declared
`{read, write}` set, runs the resulting waves, and — opt-in — dispatches disjoint-write work
across a real `worker_threads` + `Atomics` pool whose result is **bit-identical** to the
serial path (a fixed worker-index command-buffer merge makes the merge order deterministic).

> **Status:** 0.1.0, unpublished. Most users want the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), which re-exports `defineSystem`,
> `createScheduler`, and `WorkerPool`.
>
> **Known limitation (worker pool):** the pool is `node:worker_threads`-based and requires
> `SharedArrayBuffer` (it falls back to a `postMessage` path, never silently, when the host
> is not cross-origin-isolated). A browser Web-Worker pool is future work. There is also a
> documented per-column growth cap above 1024 rows-per-column in the threaded path — see the
> repository's known-issues / CHANGELOG before relying on very wide threaded columns.

## Install

```sh
pnpm add @ecsia/scheduler @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
