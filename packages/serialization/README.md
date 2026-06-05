# @ecsia/serialization

Serialization for [**ecsia**](https://github.com/andymai/ecsia) — a fast, type-safe Entity
Component System for TypeScript.

`@ecsia/serialization` round-trips a world bit-exactly (snapshot), produces version-stamped
deltas that carry value **and** structural changes since a tick (no shadow map), remaps
entity ids and relation targets on load, and provides a zero-copy worker bootstrap.

> **Status:** 0.1.0, unpublished. Most users want the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), which re-exports
> `createSnapshotSerializer`, `createDeltaSerializer`, `applyDelta`, and friends.

## Install

```sh
pnpm add @ecsia/serialization @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
