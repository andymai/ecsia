# @ecsia/core

The single-threaded kernel of [**ecsia**](https://github.com/andymai/ecsia) — a fast,
type-safe Entity Component System for TypeScript.

`@ecsia/core` provides archetype/SoA tables, a serial-only per-entity bitmask membership
index, monomorphic typed accessors, live queries, and reactivity. It runs standalone; the
opt-in `@ecsia/scheduler`, `@ecsia/relations`, and `@ecsia/serialization` layers attach to a
world through injected seams (the dependency graph is acyclic).

> **Status:** 0.1.0, unpublished. Most users want the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), which re-exports the whole cohesive
> surface and tree-shakes what you don't touch. Reach for `@ecsia/core` directly only when
> you want the kernel without the scheduler/serialization layers.

## Install

```sh
pnpm add @ecsia/core   # not yet published — local workspace for now
```

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
