# React bindings

`@ecsia/react` lets React render your simulation. The world stays the source of truth —
entities are ids, components are typed data attached to them — and React reads from it
through hooks: wrap the app in a `WorldProvider`, list entities with `useQuery`, read
component values with `useComponent`. Re-renders are surgical: a list re-renders only
when its membership changes, a value hook only when that one entity's values actually
change.

::: tip Opt-in, not in the umbrella
`@ecsia/react` is deliberately **not** re-exported from `@ecsia/kit`, because `react` is a peer
dependency — pulling it into the umbrella would tax every non-React consumer. Install it
explicitly:

```sh
pnpm add @ecsia/react react   # react is a peer dependency
```

`react` 18 or 19 is required. There is no `react-dom` dependency — the hooks work under any
renderer, including react-three-fiber.
:::

## Setup: provide the world

`WorldProvider` hands an existing world to every hook below it. It never creates, ticks,
or disposes a world — your simulation loop owns that.

```tsx
import { createWorld, defineComponent } from '@ecsia/kit'
import { WorldProvider } from '@ecsia/react'

const Health = defineComponent({ hp: 'u32' }, { name: 'health' })
const world = createWorld({ components: [Health] })

function Root() {
  return (
    <WorldProvider world={world}>
      <App />
    </WorldProvider>
  )
}

function App() {
  return null // your UI here
}
```

Anywhere under the provider, `useWorld()` returns that world — it's the handle you reach
for in event handlers to spawn entities or write values.

## Lists: `useQuery`

`useQuery` takes the same query terms your systems use (`read` / `write` / `has` /
`without` / `optional`) and returns the matching entities as a readonly array of
**entity handles** — stable numbers that are safe to store and correct as React keys.

It re-renders **only when membership changes**: an entity starts or stops matching.
Value writes inside matching entities never re-render the list — render per-entity
values with `useComponent` in a child component, keyed by the handle:

```tsx
import { defineComponent, defineTag, read, has, without } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'
import { useQuery, useComponent } from '@ecsia/react'

const Health = defineComponent({ hp: 'u32' }, { name: 'health' })
const Enemy = defineTag('enemy')
const Dead = defineTag('dead')

function EnemyList() {
  const enemies = useQuery(read(Health), has(Enemy), without(Dead))
  return <>{enemies.map((h) => <EnemyRow key={h} handle={h} />)}</>
}

function EnemyRow({ handle }: { handle: EntityHandle }) {
  const health = useComponent(handle, Health)
  if (!health) return null
  return <div>{health.hp}</div>
}
```

Keying by handle is exactly the remount behavior you want: when an entity dies and its
slot is reused for a new one, the new entity gets a different handle value, so React
unmounts the old row and mounts a fresh one.

`useQueryFirst(...terms)` returns just the first matching handle (or `undefined`) —
handy for singletons like a player entity.

## Values: `useComponent` and `useHas`

`useComponent(handle, Component)` returns a **frozen snapshot** — a plain read-only copy
of the component's field values — or `undefined` when the entity is dead or doesn't have
the component. It re-renders only when that entity's component actually changes value; a
write that lands the same values keeps the previous object identity, so React skips the
re-render.

`useHas(handle, Component)` returns just presence as a boolean (it covers tags from
`defineTag` too) and only wakes on add/remove — value writes never re-render it.

Snapshots are copies, not live views: numeric and string fields copy by value, `vec`
fields copy into plain number arrays. One caveat carried over from core: `object<T>`
fields copy the *reference*, so mutating the referenced object directly bypasses change
tracking.

## Writing back: through the world, at the point of use

Hooks are read-only by design. Writes go through the world exactly like they do in
systems — resolve the entity at the moment you need it, inside the event handler:

```tsx
import { defineComponent } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'
import { useWorld, useComponent } from '@ecsia/react'

const Health = defineComponent({ hp: 'u32' }, { name: 'health' })

function EnemyRow({ handle }: { handle: EntityHandle }) {
  const world = useWorld()
  const health = useComponent(handle, Health)
  if (!health) return null
  const hit = () => { world.entity(handle).write(Health).hp -= 10 }
  return <div onClick={hit}>{health.hp}</div>
}
```

Why this shape? `world.entity()` returns a **pooled accessor** — one shared object per
world, rebound on every call — and holding it across renders throws by design (that's
core's stale-use guard doing its job). The hooks therefore never accept or return one:
handles in, snapshots out. Resolving at the point of use is the same rule systems follow,
so there's nothing new to learn.

## The world must tick for the UI to move

Hooks ride ecsia's deferred observers, which fire once per `scheduler.update(dt)` — after
the frame's systems, batched, at a main-thread safe point. That means:

- Run the simulation loop — a driver, react-three-fiber's `useFrame`, or a manual loop
  calling `scheduler.update(dt)`. Hooks see each tick's net state.
- A mutation made *outside* the loop (in a click handler, say) is recorded immediately
  but becomes **visible at the next tick**. With a running loop that's at most one frame.
- A world that never ticks appears frozen to hooks, no matter how much you write to it.

React 18+ batches all of a tick's notifications into a single render pass, and each hook
is notified at most once per tick no matter how many times its component was written
during the frame.

Threading changes none of this: hooks run on the main thread, `update()` doesn't yield
mid-frame, and the parallel scheduler produces results identical to the single-threaded
run — so the bindings don't know or care whether the world is threaded.

## Effects without re-rendering: `useComponentEffect` and `useObserve`

Sometimes you want to *react* to a change without re-rendering — play a sound, trigger an
animation, log. `useComponentEffect` fires a callback on every add, remove, or change of
one component on one entity:

```tsx
import { defineComponent } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'
import { useComponentEffect } from '@ecsia/react'

const Health = defineComponent({ hp: 'u32' }, { name: 'health' })

function HitFlash({ handle }: { handle: EntityHandle }) {
  useComponentEffect(handle, Health, (snapshot) => {
    if (snapshot === undefined) return // removed, or the entity despawned
    // play a hit effect — no re-render happens here
  })
  return null
}
```

The callback receives a frozen snapshot (`undefined` on remove or despawn) — safe to
stash, unlike the pooled accessor.

`useObserve(term, handler)` is the general escape hatch: it registers a core observer
(`onAdd` / `onRemove` / `onChange`) on mount and disposes it on unmount. The handler
receives the pooled accessor exactly as core observers do, so the pooling contract
applies — read fields inside the handler, never store it.

## Links between entities: `useTargets` and `useTarget`

If your world uses [relations](/guide/relations) — links from one entity to another, like a
node's parent or an attacker's victim — two hooks render them. Hand the relations runtime to the
provider once, then read links the same way you read components:

```tsx
import { createWorld, createRelations } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'
import { WorldProvider, useTarget, useTargets } from '@ecsia/react'

const world = createWorld({ components: [] })
const rel = createRelations(world)
const ChildOf = rel.defineRelation(null, { exclusive: true })
const Likes = rel.defineRelation(null)

function Root({ children }: { children?: React.ReactNode }) {
  return (
    <WorldProvider world={world} relations={rel}>
      {children}
    </WorldProvider>
  )
}

function Row({ handle }: { handle: EntityHandle }) {
  const parent = useTarget(handle, ChildOf)   // EntityHandle | undefined — the one link
  const liked = useTargets(handle, Likes)     // readonly EntityHandle[] — all of them
  return <div>{parent === undefined ? 'root' : 'child'} · likes {liked.length}</div>
}
```

`useTargets` returns every entity the subject points at through that relation; `useTarget`
returns the single one (the natural fit for one-target relations like a parent link). Both
re-render **only when the links themselves change** — one added, one removed, a one-target
relation re-pointed, or a linked entity despawning and taking its links down. Writes to either
entity's components never wake them, and the returned handles are stable identities, valid as
React keys.

Forgot to pass `relations` to the provider? The hooks throw a pointed error rather than
silently rendering nothing.

## Server-side rendering

Hooks render synchronously on the server — ecsia reads are plain synchronous calls, so
`renderToString` works without ceremony and reflects the world's state at that moment.
Create a **world per request**: a shared, ticking server world can change between render
passes, and the HTML you emit must match the world the client hydrates against.

## What's deliberately not here

- **Declarative JSX entities** (`<Entity>` / `<Component>` components) — ecsia worlds are
  imperative and system-driven; the sanctioned shape is "mutate the world, React reacts."
- **World construction helpers** — `WorldProvider` takes a world you already own.
- **Link payload values** — `useTargets` tracks the links themselves; re-rendering on a link's
  stored values is a planned follow-up.

## See also

- [`examples/react-dashboard.tsx`](https://github.com/andymai/ecsia/blob/main/examples/react-dashboard.tsx) —
  a runnable fleet dashboard putting `useQuery`, `useComponent`, and `useHas` together, with
  write-back from event handlers and a world that ticks on `requestAnimationFrame`.
- [Reacting to changes](/guide/reactivity) — the observer layer the hooks ride on.
- [THREE.js bridge](/guide/three-bridge) — composes with this package: `useFrame` runs the
  simulation, `@ecsia/react` renders UI from it; neither imports the other.
- [Core concepts](/guide/core-concepts) — queries, accessors, and the pooled-ref rule.
