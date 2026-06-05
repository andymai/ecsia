# @ecsia/devtools

Developer tooling for [**ecsia**](https://github.com/andymai/ecsia), an entity
component system (ECS) for TypeScript — entities are ids, components are typed data
attached to them, and systems are functions that run over entities with matching
components.

`@ecsia/devtools` gives you two things. It lets you inspect what's in a world — the
entities, their components, and how they're grouped in storage. And it explains the
scheduler's choices — why systems were grouped into the waves they were. Both come as
plain data or an HTML report. It is **deliberately not** re-exported from the
umbrella, and nothing in the framework imports it — so it never lands in a consumer
bundle unless you pull it in yourself.

> **Status:** 0.1.0, unpublished. New to ecsia? Start with the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia); reach for devtools when you want to
> see inside a running world.

## Install

```sh
pnpm add @ecsia/devtools @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Devtools guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
