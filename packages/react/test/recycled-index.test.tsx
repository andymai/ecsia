// Generation correctness on index recycling: a despawned entity's slot is reused at a bumped
// generation, so the handle VALUE changes. A hook still watching the dead handle must read
// undefined (never the new occupant's values), and the new handle used as a React key remounts.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { WorldProvider, useComponent } from '../src/index.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

function HpProbe({ handle, Health }: { handle: EntityHandle; Health: ReturnType<typeof mkHealth> }) {
  const health = useComponent(handle, Health)
  return <div data-testid={`probe-${handle}`}>{health === undefined ? 'gone' : `hp:${health.hp}`}</div>
}

describe('recycled-index generation correctness', () => {
  test('the old handle reads undefined; the new handle (same index, new generation) reads its own values', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const stale = world.spawnWith([Health, { hp: 5 }])
    tick()

    const { rerender } = render(
      <WorldProvider world={world}>
        <HpProbe key={stale} handle={stale} Health={Health} />
      </WorldProvider>,
    )
    expect(screen.getByTestId(`probe-${stale}`).textContent).toBe('hp:5')

    world.despawn(stale)
    const fresh = world.spawnWith([Health, { hp: 9 }])
    // The freelist reuses the slot: same index, bumped generation, different handle value.
    expect(world.decodeHandle(fresh).index).toBe(world.decodeHandle(stale).index)
    expect(fresh).not.toBe(stale)
    tick()

    // The stale watcher went undefined — it must NOT show the new occupant's 9.
    expect(screen.getByTestId(`probe-${stale}`).textContent).toBe('gone')

    // Keying rows by handle remounts: the stale row unmounts, the fresh row mounts cleanly.
    rerender(
      <WorldProvider world={world}>
        <HpProbe key={fresh} handle={fresh} Health={Health} />
      </WorldProvider>,
    )
    expect(screen.getByTestId(`probe-${fresh}`).textContent).toBe('hp:9')
    expect(screen.queryByTestId(`probe-${stale}`)).toBeNull()
  })

  test('writes to the new occupant never wake a hook still watching the dead handle', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const stale = world.spawnWith([Health, { hp: 5 }])
    tick()

    let renders = 0
    function CountingProbe({ handle }: { handle: EntityHandle }) {
      useComponent(handle, Health)
      renders += 1
      return null
    }
    render(
      <WorldProvider world={world}>
        <CountingProbe handle={stale} />
      </WorldProvider>,
    )

    world.despawn(stale)
    const fresh = world.spawnWith([Health, { hp: 1 }])
    tick()
    const afterDeath = renders

    // Churn the NEW occupant: the dead watcher's generation check must filter every event.
    for (let i = 0; i < 3; i++) {
      world.entity(fresh).write(Health).hp = 100 + i
      tick()
    }
    expect(renders).toBe(afterDeath)
  })
})
