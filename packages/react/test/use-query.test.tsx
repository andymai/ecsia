// useQuery: result-set identity. Re-renders ONLY when membership changes — value churn inside
// matching entities keeps the cached handle array's identity, including without() evictions (an
// add can evict a match).

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { defineComponent, defineTag } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { read, without } from '@ecsia/schema'
import { WorldProvider, useQuery, useQueryFirst } from '../src/index.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

describe('useQuery membership identity cut', () => {
  test('value churn -> zero re-renders; one spawn -> exactly one', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const a = world.spawnWith([Health, { hp: 1 }])
    const b = world.spawnWith([Health, { hp: 2 }])

    let renders = 0
    const arrays: Array<readonly EntityHandle[]> = []
    function List() {
      const handles = useQuery(read(Health))
      renders += 1
      arrays.push(handles)
      return <div data-testid="list">{handles.join(',')}</div>
    }
    render(
      <WorldProvider world={world}>
        <List />
      </WorldProvider>,
    )
    const base = renders
    const baseArray = arrays[arrays.length - 1]
    expect(baseArray).toEqual([a, b])

    // Value churn across several ticks: no membership change, no re-render, same array identity.
    for (let i = 0; i < 3; i++) {
      world.entity(a).write(Health).hp = 10 + i
      world.entity(b).write(Health).hp = 20 + i
      tick()
    }
    expect(renders).toBe(base)
    expect(arrays[arrays.length - 1]).toBe(baseArray)

    // One spawn: exactly one re-render, fresh array identity.
    const c = world.spawnWith([Health, { hp: 3 }])
    tick()
    expect(renders).toBe(base + 1)
    expect(arrays[arrays.length - 1]).not.toBe(baseArray)
    expect(arrays[arrays.length - 1]).toEqual([a, b, c])
  })

  test('despawn shrinks membership at the next tick', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const a = world.spawnWith([Health, { hp: 1 }])
    const b = world.spawnWith([Health, { hp: 2 }])

    function List() {
      const handles = useQuery(read(Health))
      return <div data-testid="list">{handles.join(',')}</div>
    }
    render(
      <WorldProvider world={world}>
        <List />
      </WorldProvider>,
    )
    expect(screen.getByTestId('list').textContent).toBe(`${a},${b}`)

    world.despawn(a)
    tick()
    expect(screen.getByTestId('list').textContent).toBe(`${b}`)
  })

  test('without() eviction: adding the excluded component dirties the query', () => {
    const Health = mkHealth()
    const Dead = defineTag('dead')
    const { world, tick } = makeKit([Health, Dead])
    const a = world.spawnWith([Health, { hp: 1 }])
    const b = world.spawnWith([Health, { hp: 2 }])

    function List() {
      const handles = useQuery(read(Health), without(Dead))
      return <div data-testid="list">{handles.join(',')}</div>
    }
    render(
      <WorldProvider world={world}>
        <List />
      </WorldProvider>,
    )
    expect(screen.getByTestId('list').textContent).toBe(`${a},${b}`)

    world.add(a, Dead)
    tick()
    expect(screen.getByTestId('list').textContent).toBe(`${b}`)

    world.remove(a, Dead)
    tick()
    expect(screen.getByTestId('list').textContent?.split(',').map(Number).sort()).toEqual(
      [a, b].map(Number).sort(),
    )
  })

  test('an unrelated migration that keeps membership keeps the array identity', () => {
    const Health = mkHealth()
    const Marker = defineTag('marker')
    const { world, tick } = makeKit([Health, Marker])
    const a = world.spawnWith([Health, { hp: 1 }])
    const b = world.spawnWith([Health, { hp: 2 }])
    void b

    const arrays: Array<readonly EntityHandle[]> = []
    function List() {
      const handles = useQuery(read(Health))
      arrays.push(handles)
      return null
    }
    render(
      <WorldProvider world={world}>
        <List />
      </WorldProvider>,
    )
    const baseArray = arrays[arrays.length - 1]
    expect(baseArray).toHaveLength(2)

    // `a` migrates to a different archetype (Health+Marker) but still matches read(Health):
    // membership is set-compared, so the cached array identity survives even if row order shifted.
    world.add(a, Marker)
    tick()
    expect(arrays[arrays.length - 1]).toBe(baseArray)
  })
})

describe('useQueryFirst', () => {
  test('first match or undefined, tracking membership', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])

    let first: EntityHandle | undefined
    function Probe() {
      first = useQueryFirst(read(Health))
      return null
    }
    render(
      <WorldProvider world={world}>
        <Probe />
      </WorldProvider>,
    )
    expect(first).toBeUndefined()

    const a = world.spawnWith([Health, { hp: 1 }])
    tick()
    expect(first).toBe(a)

    world.despawn(a)
    tick()
    expect(first).toBeUndefined()
  })
})

describe('useQuery term restrictions', () => {
  test('handles are usable as React keys: child rows mount per entity', () => {
    const Health = mkHealth()
    const { world, tick } = makeKit([Health])
    const a = world.spawnWith([Health, { hp: 5 }])

    function List() {
      const handles = useQuery(read(Health))
      return (
        <ul>
          {handles.map((h) => (
            <li key={h} data-testid={`row-${h}`} />
          ))}
        </ul>
      )
    }
    render(
      <WorldProvider world={world}>
        <List />
      </WorldProvider>,
    )
    expect(screen.getByTestId(`row-${a}`)).toBeDefined()

    const b = world.spawnWith([Health, { hp: 6 }])
    tick()
    expect(screen.getByTestId(`row-${b}`)).toBeDefined()
  })
})
