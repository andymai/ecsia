# @ecsia/three

A [THREE.js](https://threejs.org) bridge for [**ecsia**](https://github.com/andymai/ecsia) — a fast,
type-safe Entity Component System for TypeScript.

`@ecsia/three` lets you drive `three.js` objects from ecsia components. It is **deliberately
not** re-exported from the umbrella, because `three` is a large peer dependency — you opt in
explicitly.

> **Status:** 0.1.0, unpublished.

## Install

```sh
# not yet published — local workspace for now
pnpm add @ecsia/three @ecsia/core three
```

`three` is a **peer dependency** (`>=0.169 <1`); install it alongside.

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- THREE bridge guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`ecsia`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
