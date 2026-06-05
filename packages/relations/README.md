# @ecsia/relations

First-class relations for [**ecsia**](https://github.com/andymai/ecsia) — a fast,
type-safe Entity Component System for TypeScript.

`@ecsia/relations` adds integer-encoded relation pairs as first-class archetype members:
exclusive/overflow storage, presence-bit wildcard matching (`O(archetypes)`), and despawn
cascades (`deleteSubject` / `removeRelation` / `none`). It attaches to a world via
`createRelations(world)`.

> **Status:** 0.1.0, unpublished. Most users want the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), which re-exports `createRelations` and
> `Wildcard`. Use `@ecsia/relations` directly only when composing the layers by hand.

## Install

```sh
pnpm add @ecsia/relations @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Relations guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
