# @ecsia/three

A [three.js](https://threejs.org) bridge for [**ecsia**](https://github.com/andymai/ecsia),
an entity component system (ECS) for TypeScript — entities are ids, components are
typed data attached to them, and systems are functions that run over entities with
matching components.

`@ecsia/three` keeps three.js objects in sync with your component data, so your scene
follows your simulation. It is **deliberately not** re-exported from the umbrella,
because `three` is a large peer dependency — you opt in explicitly.

> **Status:** 0.1.0, unpublished. New to ecsia? Start with the umbrella package
> [`ecsia`](https://www.npmjs.com/package/ecsia), then add this bridge when you're
> ready to draw.

## Install

```sh
# not yet published — local workspace for now
pnpm add @ecsia/three @ecsia/core three
```

`three` is a **peer dependency** (`>=0.169 <1`); install it alongside.

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- three.js bridge guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
