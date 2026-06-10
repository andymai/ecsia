# @ecsia/react

React bindings for [**ecsia**](https://github.com/andymai/ecsia), an entity component
system (ECS) for TypeScript — entities are ids, components are typed data attached to
them, and systems are functions that run over entities with matching components.

`@ecsia/react` lets React render your simulation: wrap the app in a `WorldProvider`,
list entities with `useQuery`, and read component values with `useComponent`. Hooks
re-render with surgical granularity — `useQuery` only when membership changes,
`useComponent` only when that entity's values actually change. It is **deliberately
not** re-exported from the umbrella, because `react` is a peer dependency — you opt in
explicitly.

> **Status:** 0.x, API-frozen. New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit), then add this binding when you're
> ready to render UI from it.

## Install

```sh
pnpm add @ecsia/react @ecsia/core react
```

`react` is a **peer dependency** (`>=18 <20`); install it alongside. There is no
`react-dom` dependency — the hooks work under any renderer, including
react-three-fiber.

## Use

```tsx
import { WorldProvider, useQuery, useComponent, useWorld } from '@ecsia/react'
import { createWorld, defineComponent, read, type EntityHandle } from '@ecsia/core'

const Health = defineComponent({ hp: 'u32' }, { name: 'health' })
const world = createWorld({ components: [Health] })

const app = <WorldProvider world={world}><App /></WorldProvider>

function App() {
  const enemies = useQuery(read(Health))        // readonly EntityHandle[] — valid as keys
  return <>{enemies.map((h) => <Row key={h} handle={h} />)}</>
}

function Row({ handle }: { handle: EntityHandle }) {
  const world = useWorld()
  const health = useComponent(handle, Health)   // frozen snapshot | undefined
  if (!health) return null
  const hit = () => { world.entity(handle).write(Health).hp -= 10 }
  return <div onClick={hit}>{health.hp}</div>
}
```

Hooks traffic in `EntityHandle`s and frozen snapshot copies — never the pooled
`EntityRef` (holding one across renders throws by design). `vec` fields copy into plain
number arrays; `object<T>` fields copy the **reference**, so mutating the referenced
object bypasses change tracking (the same caveat core documents). Writes go through the
world at the point of use: `world.entity(handle).write(C)`.

**The world must tick for the UI to move.** Hooks ride ecsia's deferred observers,
which fire once per `scheduler.update(dt)` — run the simulation loop (a driver, r3f's
`useFrame`, or a manual loop) and hooks see each tick's net state; a mutation made
outside the loop (e.g. in a click handler) becomes visible at the next tick. A world
that never ticks appears frozen.

## SSR

Hooks render synchronously on the server: `getServerSnapshot` recomputes from the world
on every server render pass, so each `renderToString` reflects the world's state at that
moment. Create a **world per request** — a shared, ticking server world can change
between render passes, and the emitted HTML must match the world the client hydrates
against.

## Links

- Runnable example: [`examples/react-dashboard.tsx`](https://github.com/andymai/ecsia/blob/main/examples/react-dashboard.tsx) — a fleet dashboard with `useQuery`/`useComponent`/`useHas`, write-back, and a ticking world.
- Repository & full docs: https://github.com/andymai/ecsia
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)
- three.js bridge (composes with this one): [`@ecsia/three`](https://github.com/andymai/ecsia/tree/main/packages/three)

## License

[MIT](./LICENSE) © Andy Aragon
