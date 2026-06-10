# @ecsia/core

The storage engine at the heart of [**ecsia**](https://github.com/andymai/ecsia), an
entity component system (ECS) for TypeScript — entities are ids, components are typed
data attached to them, and systems are functions that run over entities with matching
components.

`@ecsia/core` is where that data actually lives. It stores each component field in its
own contiguous typed array, grouped by which components an entity has (a grouping
called an archetype) — which is what makes looping over thousands of entities fast. On
top of that it gives you typed accessors (`e.position.x` is a `number`, not a cast),
fast membership tracking so queries stay in sync as entities change, and change
tracking so you can react when components are added, removed, or modified.

It is a complete single-threaded ECS on its own. The opt-in layers —
`@ecsia/scheduler`, `@ecsia/relations`, `@ecsia/serialization` — plug into a world
through attachment points core provides; nothing imports upward.

> **Status:** published on npm (0.x). New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), which re-exports the whole surface
> and tree-shakes what you don't touch. Reach for `@ecsia/core` directly only when you
> want the kernel without the scheduler/serialization layers.

## Install

```sh
pnpm add @ecsia/core
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
