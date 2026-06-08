// useTargets / useTarget: pair-membership identity. Re-renders ONLY when the (subject, relation)
// pair set changes — adds, removes, exclusive retargets, cascade teardown — and stays identity-
// stable (and silent) through unrelated churn. Values come from rel.targetsOf at snapshot time.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { WorldProvider, useTarget, useTargets } from '../src/index.js'
import { makeKit } from './helpers.js'

describe('useTargets membership identity cut', () => {
  test('renders current targets; re-renders only on pair membership change', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const { world, tick } = makeKit([Health])
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawnWith(Health)
    const t1 = world.spawn()
    const t2 = world.spawn()

    let renders = 0
    const arrays: Array<readonly EntityHandle[]> = []
    function Targets() {
      const targets = useTargets(s, Likes)
      renders += 1
      arrays.push(targets)
      return <div data-testid="targets">{targets.join(',')}</div>
    }
    render(
      <WorldProvider world={world} relations={rel}>
        <Targets />
      </WorldProvider>,
    )
    expect(arrays[arrays.length - 1]).toEqual([])
    const base = renders

    // A pair lands at the next tick: exactly one re-render with the new target.
    rel.addPair(s, Likes, t1)
    tick()
    expect(renders).toBe(base + 1)
    expect(arrays[arrays.length - 1]).toEqual([t1])

    // Unrelated churn (component writes on the subject) never wakes the hook.
    const stable = arrays[arrays.length - 1]
    for (let i = 0; i < 3; i++) {
      world.entity(s).write(Health).hp = i
      tick()
    }
    expect(renders).toBe(base + 1)
    expect(arrays[arrays.length - 1]).toBe(stable)

    // Second target: one re-render, fresh identity.
    rel.addPair(s, Likes, t2)
    tick()
    expect(renders).toBe(base + 2)
    expect(new Set(arrays[arrays.length - 1])).toEqual(new Set([t1, t2]))

    // Removal shrinks at the next tick.
    rel.removePair(s, Likes, t1)
    tick()
    expect(renders).toBe(base + 3)
    expect(arrays[arrays.length - 1]).toEqual([t2])
  })

  test('useTarget follows an exclusive retarget', () => {
    const { world, tick } = makeKit([])
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const s = world.spawn()
    const p1 = world.spawn()
    const p2 = world.spawn()
    rel.addPair(s, ChildOf, p1)

    function Parent() {
      const parent = useTarget(s, ChildOf)
      return <div data-testid="parent">{parent === undefined ? 'none' : String(parent)}</div>
    }
    render(
      <WorldProvider world={world} relations={rel}>
        <Parent />
      </WorldProvider>,
    )
    expect(screen.getByTestId('parent').textContent).toBe(String(p1))

    rel.addPair(s, ChildOf, p2)
    tick()
    expect(screen.getByTestId('parent').textContent).toBe(String(p2))

    rel.removePair(s, ChildOf, p2)
    tick()
    expect(screen.getByTestId('parent').textContent).toBe('none')
  })

  test('cascade teardown (target despawn) empties the hook at the next tick', () => {
    const { world, tick } = makeKit([])
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    const t = world.spawn()
    rel.addPair(s, Likes, t)

    function Targets() {
      const targets = useTargets(s, Likes)
      return <div data-testid="targets">{targets.length}</div>
    }
    render(
      <WorldProvider world={world} relations={rel}>
        <Targets />
      </WorldProvider>,
    )
    expect(screen.getByTestId('targets').textContent).toBe('1')

    world.despawn(t)
    tick()
    expect(screen.getByTestId('targets').textContent).toBe('0')
  })

  test('subject despawn empties the hook at the next tick (no permanent stale links)', () => {
    const { world, tick } = makeKit([])
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()
    rel.addPair(s, Likes, world.spawn())
    rel.addPair(s, Likes, world.spawn())

    function Targets() {
      const targets = useTargets(s, Likes)
      return <div data-testid="targets">{targets.length}</div>
    }
    render(
      <WorldProvider world={world} relations={rel}>
        <Targets />
      </WorldProvider>,
    )
    expect(screen.getByTestId('targets').textContent).toBe('2')

    world.despawn(s)
    tick()
    expect(screen.getByTestId('targets').textContent).toBe('0')
  })

  test('throws a pointed error when the provider has no relations runtime', () => {
    const { world } = makeKit([])
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null)
    const s = world.spawn()

    function Targets() {
      useTargets(s, Likes)
      return null
    }
    expect(() =>
      render(
        <WorldProvider world={world}>
          <Targets />
        </WorldProvider>,
      ),
    ).toThrow(/relations runtime/)
  })
})
