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

> **Status:** 0.x, API-frozen. New to ecsia? Start with the umbrella package
> [`@ecsia/kit`](https://www.npmjs.com/package/@ecsia/kit); reach for devtools when you want to
> see inside a running world.

## Install

```sh
pnpm add @ecsia/devtools @ecsia/core
```

## Use

`inspectWorld` snapshots a world; `explainPlan` explains a scheduler's waves. Both return plain
data, and `renderText` (or `renderHTML`) turns that into a report:

```ts
import { createWorld, defineComponent, write } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { inspectWorld, explainPlan, renderText, componentNameMap } from '@ecsia/devtools'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const world = createWorld({ components: [Health] })
world.spawnWith([Health, { hp: 100 }])

const Regen = defineSystem({
  name: 'Regen',
  write: [Health],
  run({ query }) {
    for (const e of query(write(Health))) e.health.hp += 1
  },
})
const scheduler = createScheduler(world, [Regen])
scheduler.update(1)

// Entities, components, archetypes, and relations as plain data…
console.log(renderText(inspectWorld(world)))
// …and why the scheduler grouped systems into the waves it did.
console.log(renderText(explainPlan(scheduler, componentNameMap(world))))
```

Take the world from `@ecsia/core`, not the `@ecsia/kit` umbrella: `inspectWorld` reads internal
inspection hooks the umbrella's public facade deliberately omits, so the diagnostic packages wire
into core directly — exactly how a real devtools consumer does. See the
[full tour](https://github.com/andymai/ecsia/blob/main/examples/devtools-tour.ts).

## Links

- Repository & full docs: https://github.com/andymai/ecsia
- Devtools guide: https://github.com/andymai/ecsia (see the docs site once Pages is enabled)
- Umbrella package: [`@ecsia/kit`](https://github.com/andymai/ecsia)

## License

[MIT](./LICENSE) © Andy Aragon
