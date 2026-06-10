# @ecsia/schema

The type-level vocabulary for [**ecsia**](https://github.com/andymai/ecsia), an entity
component system (ECS) for TypeScript — entities are ids, components are typed data
attached to them, and systems are functions that run over entities with matching
components.

`@ecsia/schema` defines the field types you declare components with (like `'f32'` for
a 32-bit float) and the type inference that makes queries of one to eight components
fully typed — ask for a position and a velocity, and TypeScript knows `e.position.x`
is a `number`. It is almost entirely compile-time machinery; very little of it exists
at runtime.

> **Status:** 0.1.0, unpublished. You normally get all of this through the umbrella
> package [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit) — start there. This package
> is pulled in transitively; you rarely depend on it directly.

## Install

```sh
pnpm add @ecsia/schema   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
