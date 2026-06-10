# @ecsia/serialization

Saving and syncing for [**ecsia**](https://github.com/andymai/ecsia), an entity
component system (ECS) for TypeScript — entities are ids, components are typed data
attached to them, and systems are functions that run over entities with matching
components.

`@ecsia/serialization` turns world state into payloads you can save or send. A
**snapshot** — a complete copy of the world at one moment — round-trips bit-exactly
(for persisted fields; fields marked `persist: false` are skipped and re-default on load). A
**delta** carries just the changes, both values and structure, since a known tick (one
simulation step), and is produced without keeping a second copy of your data to
compare against. Deltas are version-stamped, and entity ids and relation targets are
remapped on load. It can also hand a world to a worker thread without copying the
data.

For network sync, `createReplicationStream` / `createReplicationReceiver` wrap the two
codecs into a broadcast recipe for ordered-reliable transports: schema validation on
every message, tick-chained deltas with an in-band `needBaseline` resync signal, an
automatic full baseline when structural churn outruns the delta journal, and a
receiver-owned entity remap — plus `encodeReplicationMessage` /
`decodeReplicationMessage` for binary transports.

> **Status:** published on npm (0.x). New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), which re-exports
> `createSnapshotSerializer`, `createDeltaSerializer`, `applyDelta`, and friends.

## Install

```sh
pnpm add @ecsia/serialization @ecsia/core
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
