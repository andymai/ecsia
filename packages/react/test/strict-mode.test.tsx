// Strict-mode refcount hygiene: StrictMode double-invokes effects (subscribe -> unsubscribe ->
// resubscribe), which must net out to working hooks while mounted and ZERO leaked core observers
// after unmount — asserted via observe()/dispose() accounting on a wrapped world.

import { describe, expect, test } from 'vitest'
import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { defineComponent, onChange } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { read } from '@ecsia/schema'
import { WorldProvider, useComponent, useComponentEffect, useHas, useObserve, useQuery } from '../src/index.js'
import { liveObserverCount } from '../src/internal.js'
import { makeKit, withObserverAccounting } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

describe('strict-mode refcount hygiene', () => {
  test('every hook flavor mounts/unmounts under StrictMode with zero leaked observers', () => {
    const Health = mkHealth()
    const kit = makeKit([Health])
    const { world, liveObservers } = withObserverAccounting(kit.world)
    const e = kit.world.spawnWith([Health, { hp: 3 }])
    kit.tick()

    function Probe({ handle }: { handle: EntityHandle }) {
      const handles = useQuery(read(Health))
      const health = useComponent(handle, Health)
      const present = useHas(handle, Health)
      useComponentEffect(handle, Health, () => {})
      useObserve(onChange(Health), () => {})
      return (
        <div data-testid="probe">
          {handles.length}:{health?.hp ?? 'x'}:{String(present)}
        </div>
      )
    }
    const { unmount } = render(
      <StrictMode>
        <WorldProvider world={world}>
          <Probe handle={e} />
        </WorldProvider>
      </StrictMode>,
    )

    // Mounted and live: the double-invoked effects net out to working subscriptions.
    expect(liveObservers()).toBeGreaterThan(0)
    expect(screen.getByTestId('probe').textContent).toBe('1:3:true')

    kit.world.entity(e).write(Health).hp = 4
    kit.tick()
    expect(screen.getByTestId('probe').textContent).toBe('1:4:true')

    unmount()
    expect(liveObservers()).toBe(0)
    expect(liveObserverCount(world)).toBe(0)
  })

  test('two hooks on the same (entity, component) share one refcounted observer set', () => {
    const Health = mkHealth()
    const kit = makeKit([Health])
    const { world, liveObservers } = withObserverAccounting(kit.world)
    const e = kit.world.spawnWith([Health, { hp: 1 }])
    kit.tick()

    function Probe({ handle }: { handle: EntityHandle }) {
      useComponent(handle, Health)
      return null
    }
    const { unmount } = render(
      <WorldProvider world={world}>
        <Probe handle={e} />
        <Probe handle={e} />
      </WorldProvider>,
    )

    // One ComponentStore per (entity, component): add + remove + change = 3 core observers,
    // shared by both hooks via the refcount — not 6.
    expect(liveObservers()).toBe(3)

    unmount()
    expect(liveObservers()).toBe(0)
  })
})
