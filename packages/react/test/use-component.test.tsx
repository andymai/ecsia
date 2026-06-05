// useComponent: per-(entity, component) snapshot stores. Snapshot identity stability is the
// contract under test — writes to A never re-render B's hook, same-value writes keep the previous
// object identity, and hooks only learn about mutations at the next tick's observer drain.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { defineComponent, defineTag } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { object, vec3 } from '@ecsia/schema'
import type { ComponentDef, Schema } from '@ecsia/schema'
import { WorldProvider, useComponent } from '../src/index.js'
import type { ComponentSnapshot } from '../src/index.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

function HpProbe({
  handle,
  Health,
  onRender,
}: {
  handle: EntityHandle
  Health: ReturnType<typeof mkHealth>
  onRender?: (snapshot: ComponentSnapshot<ReturnType<typeof mkHealth>> | undefined) => void
}) {
  const health = useComponent(handle, Health)
  onRender?.(health)
  return <div data-testid={`hp-${handle}`}>{health === undefined ? 'gone' : `hp:${health.hp}`}</div>
}

describe('useComponent snapshot identity stability', () => {
  test('a write to entity A never re-renders a hook watching entity B', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const a = world.spawnWith([Health, { hp: 10 }])
    const b = world.spawnWith([Health, { hp: 20 }])

    let rendersA = 0
    let rendersB = 0
    render(
      <WorldProvider world={world}>
        <HpProbe handle={a} Health={Health} onRender={() => void (rendersA += 1)} />
        <HpProbe handle={b} Health={Health} onRender={() => void (rendersB += 1)} />
      </WorldProvider>,
    )
    const baseA = rendersA
    const baseB = rendersB

    world.entity(a).write(Health).hp = 11
    tick()

    expect(screen.getByTestId(`hp-${a}`).textContent).toBe('hp:11')
    expect(rendersA).toBe(baseA + 1)
    expect(rendersB).toBe(baseB)
  })

  test('a write that lands the same values keeps the snapshot identity and does not re-render', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 42 }])

    const seen: Array<ComponentSnapshot<ReturnType<typeof mkHealth>> | undefined> = []
    render(
      <WorldProvider world={world}>
        <HpProbe handle={e} Health={Health} onRender={(s) => seen.push(s)} />
      </WorldProvider>,
    )
    const baseCount = seen.length
    const baseSnapshot = seen[seen.length - 1]

    world.entity(e).write(Health).hp = 42
    tick()

    expect(seen.length).toBe(baseCount)
    expect(seen[seen.length - 1]).toBe(baseSnapshot)
  })

  test('mutations are invisible until the next tick (the world must tick)', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 1 }])

    render(
      <WorldProvider world={world}>
        <HpProbe handle={e} Health={Health} />
      </WorldProvider>,
    )
    world.entity(e).write(Health).hp = 2
    expect(screen.getByTestId(`hp-${e}`).textContent).toBe('hp:1')

    tick()
    expect(screen.getByTestId(`hp-${e}`).textContent).toBe('hp:2')
  })

  test('despawn -> undefined at the next tick', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const e = world.spawnWith([Health, { hp: 7 }])

    render(
      <WorldProvider world={world}>
        <HpProbe handle={e} Health={Health} />
      </WorldProvider>,
    )
    expect(screen.getByTestId(`hp-${e}`).textContent).toBe('hp:7')

    world.despawn(e)
    tick()
    expect(screen.getByTestId(`hp-${e}`).textContent).toBe('gone')
  })

  test('component remove (entity alive) -> undefined at the next tick', () => {
    const Health = mkHealth()
    const Dazed = defineTag('dazed')
    const { world, tick } = makeKit([Health, Dazed])
    const e = world.spawnWith([Health, { hp: 7 }], Dazed)

    render(
      <WorldProvider world={world}>
        <HpProbe handle={e} Health={Health} />
      </WorldProvider>,
    )
    world.remove(e, Health)
    tick()
    expect(world.isAlive(e)).toBe(true)
    expect(screen.getByTestId(`hp-${e}`).textContent).toBe('gone')
  })
})

describe('useComponent snapshot copies', () => {
  test('snapshots are frozen plain objects; vec fields copy into plain arrays', () => {
    const Body = defineComponent({ pos: vec3('f32'), mass: 'f32' }, { name: 'body' })
    const { world, tick } = makeKit([Body])
    const e = world.spawnWith([Body, { mass: 2 }])
    const pos = world.entity(e).write(Body).pos
    pos.x = 1
    pos.y = 2
    pos.z = 3
    tick()

    let snapshot: ComponentSnapshot<typeof Body> | undefined
    function Probe({ handle }: { handle: EntityHandle }) {
      snapshot = useComponent(handle, Body)
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )

    expect(snapshot).toBeDefined()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Array.isArray(snapshot!.pos)).toBe(true)
    expect([...snapshot!.pos]).toEqual([1, 2, 3])
    expect(snapshot!.mass).toBe(2)

    // The copy is detached: a later (un-ticked) write does not reach into the held snapshot.
    world.entity(e).write(Body).pos.x = 99
    expect(snapshot!.pos[0]).toBe(1)
  })

  test('object<T> fields copy the reference (documented caveat)', () => {
    interface Loot {
      gold: number
    }
    const Bag = defineComponent({ loot: object<Loot>() }, { name: 'bag' })
    const { world } = makeKit([Bag])
    const loot: Loot = { gold: 5 }
    const e = world.spawnWith(Bag)
    world.entity(e).write(Bag).loot = loot

    let snapshot: ComponentSnapshot<typeof Bag> | undefined
    function Probe({ handle }: { handle: EntityHandle }) {
      snapshot = useComponent(handle, Bag)
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )

    expect(snapshot!.loot).toBe(loot)
  })

  test('works for zero-field tags: presence is an empty frozen snapshot', () => {
    const Frozen = defineTag('frozen')
    const { world, tick } = makeKit([Frozen])
    const e = world.spawnWith(Frozen)

    let snapshot: object | undefined
    function Probe({ handle }: { handle: EntityHandle }) {
      snapshot = useComponent(handle, Frozen as ComponentDef<Schema>)
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe handle={e} />
      </WorldProvider>,
    )
    expect(snapshot).toEqual({})

    world.remove(e, Frozen)
    tick()
    expect(snapshot).toBeUndefined()
  })
})
