// useHas (presence bit: add/remove only — value writes never wake it), useComponentEffect
// (snapshot callback, no re-render), and useObserve (lifecycle wrapper over world.observe).

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { defineComponent, defineTag, onChange } from '@ecsia/core'
import type { EntityHandle, ObserverContext } from '@ecsia/core'
import { WorldProvider, useComponentEffect, useHas, useObserve } from '../src/index.js'
import type { ComponentSnapshot } from '../src/index.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

describe('useHas', () => {
  test('tracks add/remove of a tag', () => {
    const Frozen = defineTag('frozen')
    const { world, tick } = makeKit([Frozen])
    const e = world.spawn()

    let has: boolean | undefined
    function Probe({ handle }: { handle: EntityHandle }) {
      has = useHas(handle, Frozen)
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )
    expect(has).toBe(false)

    world.add(e, Frozen)
    tick()
    expect(has).toBe(true)

    world.remove(e, Frozen)
    tick()
    expect(has).toBe(false)
  })

  test('value writes never wake it', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    let renders = 0
    function Probe({ handle }: { handle: EntityHandle }) {
      useHas(handle, Health)
      renders += 1
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )
    const base = renders

    world.entity(e).write(Health).hp = 2
    tick()
    world.entity(e).write(Health).hp = 3
    tick()
    expect(renders).toBe(base)
  })

  test('false after despawn', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    let has: boolean | undefined
    function Probe({ handle }: { handle: EntityHandle }) {
      has = useHas(handle, Health)
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )
    expect(has).toBe(true)

    world.despawn(e)
    tick()
    expect(has).toBe(false)
  })
})

describe('useComponentEffect', () => {
  test('fires per change with a frozen snapshot copy, WITHOUT re-rendering the component', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])
    // Drain the spawn's add/init events before mounting, as a running loop would have.
    tick()

    let renders = 0
    const calls: Array<{ snapshot: ComponentSnapshot<ReturnType<typeof mkHealth>> | undefined; ctx: ObserverContext }> = []
    function Probe({ handle }: { handle: EntityHandle }) {
      renders += 1
      useComponentEffect(handle, Health, (snapshot, ctx) => {
        calls.push({ snapshot, ctx })
      })
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )
    const base = renders
    expect(calls).toHaveLength(0)

    world.entity(e).write(Health).hp = 5
    tick()

    expect(renders).toBe(base)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.snapshot).toEqual({ hp: 5 })
    expect(Object.isFrozen(calls[0]!.snapshot)).toBe(true)
    expect(calls[0]!.ctx.kind).toBe('change')

    // The value is a SNAPSHOT, not the pooled ref: no read()/write() accessors to misuse.
    expect((calls[0]!.snapshot as unknown as { read?: unknown }).read).toBeUndefined()
  })

  test('fires undefined on remove and on despawn, once', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    const calls: Array<ComponentSnapshot<ReturnType<typeof mkHealth>> | undefined> = []
    function Probe({ handle }: { handle: EntityHandle }) {
      useComponentEffect(handle, Health, (snapshot) => {
        calls.push(snapshot)
      })
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )

    world.despawn(e)
    tick()
    expect(calls).toEqual([undefined])

    // Later ticks do not re-notify the dead watcher.
    tick()
    expect(calls).toEqual([undefined])
  })

  test('events coalesce: many writes in one tick -> one callback', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])
    // Drain the spawn's add/init events before mounting, as a running loop would have.
    tick()

    let fired = 0
    function Probe({ handle }: { handle: EntityHandle }) {
      useComponentEffect(handle, Health, () => {
        fired += 1
      })
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )

    world.entity(e).write(Health).hp = 2
    world.entity(e).write(Health).hp = 3
    world.entity(e).write(Health).hp = 4
    tick()
    expect(fired).toBe(1)
  })
})

describe('useObserve', () => {
  test('registers on mount, fires at the drain, disposes on unmount', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    const seen: number[] = []
    function Probe() {
      useObserve(onChange(Health), (ref) => {
        seen.push((ref.read(Health) as { hp: number }).hp)
      })
      return null
    }
    const { unmount } = render(
      <WorldProvider world={world}>
        <Probe />
      </WorldProvider>,
    )

    world.entity(e).write(Health).hp = 9
    tick()
    expect(seen).toEqual([9])

    unmount()
    world.entity(e).write(Health).hp = 10
    tick()
    expect(seen).toEqual([9])
  })
})
