// A React UI rendered from an ecsia world: a fleet status dashboard. The world is the single source
// of truth — React only renders snapshots of it, and every mutation goes back through the world at
// the point of use (`world.entity(h).write(C)`, `world.spawnWith(...)`).
//
// The contract to notice: hooks reflect the world AS OF the last completed update() drain, so the
// world MUST tick for the UI to move. A spawn or write made in an event handler is visible on the
// NEXT tick, never synchronously — the smoke test pins exactly that. (Unlike the headless node
// examples in this folder, this one renders into a DOM; its smoke test runs under jsdom.)

import { useEffect } from 'react'
import {
  createWorld,
  createScheduler,
  defineComponent,
  defineTag,
  defineSystem,
  read,
  write,
  has,
  without,
} from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'
import { WorldProvider, useWorld, useQuery, useComponent, useHas } from '@ecsia/react'

export const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
export const Burning = defineTag('burning')

// One system drives the sim: burning ships lose 5 hp/tick, the rest slowly regen toward 100. Both
// loops write Health from the same system, so they never conflict into separate waves.
export const Decay = defineSystem({
  name: 'Decay',
  read: [Burning],
  write: [Health],
  run({ query }) {
    for (const e of query(write(Health), has(Burning))) e.health.hp -= 5
    for (const e of query(write(Health), without(Burning))) {
      if (e.health.hp < 100) e.health.hp += 1
    }
  },
})

export function createDashboard() {
  const world = createWorld({ components: [Health, Burning] })
  const scheduler = createScheduler(world, [Decay])

  world.spawnWith([Health, { hp: 80 }])
  world.spawnWith([Health, { hp: 60 }])
  const ember = world.spawnWith([Health, { hp: 90 }])
  world.add(ember, Burning) // one ship starts on fire — its 🔥 badge comes from useHas

  return { world, scheduler, tick: () => scheduler.update(1) }
}

export type Dashboard = ReturnType<typeof createDashboard>

// A single ship row. useComponent re-renders only when this entity's Health changes shape; useHas
// wakes only on the Burning tag's add/remove. The "hit" button writes through the world — the new
// value lands in the UI on the next tick, not on click.
function Ship({ handle }: { handle: EntityHandle }) {
  const world = useWorld()
  const health = useComponent(handle, Health)
  const burning = useHas(handle, Burning)
  if (!health) return null
  return (
    <li data-testid={`ship-${handle}`}>
      <span data-testid={`hp-${handle}`}>{health.hp}</span> hp {burning ? '🔥' : ''}
      <button onClick={() => (world.entity(handle).write(Health).hp -= 10)}>hit</button>
    </li>
  )
}

// The fleet list. useQuery returns stable EntityHandles (valid React keys) and re-renders only when
// membership changes — value churn inside a ship never re-renders this list, only the Ship row.
export function Fleet() {
  const world = useWorld()
  const ships = useQuery(read(Health))
  return (
    <div>
      <button onClick={() => world.spawnWith([Health, { hp: 100 }])}>Add ship</button>
      <ul>
        {ships.map((h) => (
          <Ship key={h} handle={h} />
        ))}
      </ul>
      <p data-testid="count">{ships.length} ships</p>
    </div>
  )
}

// The browser entry: provides the world and drives the sim from requestAnimationFrame. The provider
// never ticks the world itself — the loop is owned here, exactly as a game's frame loop would own it.
export function App({ dashboard }: { dashboard: Dashboard }) {
  const { world, scheduler } = dashboard
  useEffect(() => {
    let raf = requestAnimationFrame(function loop() {
      scheduler.update(1)
      raf = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(raf)
  }, [scheduler])
  return (
    <WorldProvider world={world}>
      <Fleet />
    </WorldProvider>
  )
}

// Run in a browser via a bundler: `mountDashboard(document.getElementById('root')!)`. (There is no
// node entry — React needs a DOM; the smoke test exercises the same components under jsdom.) Returns
// an unmount callback so a host (hot-reload, route teardown) can tear the tree down.
export async function mountDashboard(container: Element): Promise<() => void> {
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(container)
  root.render(<App dashboard={createDashboard()} />)
  return () => root.unmount()
}
