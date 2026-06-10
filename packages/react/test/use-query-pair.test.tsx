// useQuery with a rel.Pair(R, target) term: the query returns the subjects whose pair matches the
// target, and re-renders ONLY when that membership changes (a pair add/remove/retarget for the
// relation), staying identity-stable through unrelated pair churn. The v1 limitation (Pair terms
// threw) is lifted — the bridge now subscribes a relation-level pair watcher per Pair term.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { defineComponent, read } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { WorldProvider, useQuery } from '../src/index.js'
import { makeKit } from './helpers.js'

describe('useQuery with a rel.Pair(...) term', () => {
  test('returns matching subjects and re-renders only on pair membership change', () => {
    const Pos = defineComponent({ x: 'i32' }, { name: 'pos' })
    const { world, tick } = makeKit([Pos])
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })
    const parentA = world.spawn()
    const parentB = world.spawn()
    const c1 = world.spawnWith(Pos)
    const c2 = world.spawnWith(Pos)

    let renders = 0
    const arrays: EntityHandle[][] = []
    function Kids() {
      const kids = useQuery(read(Pos), rel.Pair(ChildOf, parentA))
      renders += 1
      arrays.push([...kids])
      return <div data-testid="kids">{kids.join(',')}</div>
    }
    render(
      <WorldProvider world={world} relations={rel}>
        <Kids />
      </WorldProvider>,
    )
    expect(arrays[arrays.length - 1]).toEqual([]) // no ChildOf→parentA yet
    expect(screen.getByTestId('kids').textContent).toBe('')
    const base = renders

    // c1 → parentA: appears at the next tick (the pair-add observer drains there).
    rel.addPair(c1, ChildOf, parentA)
    tick()
    expect(renders).toBe(base + 1)
    expect(arrays[arrays.length - 1]).toEqual([c1])

    // c2 → parentB: a ChildOf pair event, but it doesn't match the parentA filter — recompute happens,
    // membership is unchanged, so the handle array keeps its identity and the component does NOT re-render.
    const stable = arrays[arrays.length - 1]
    rel.addPair(c2, ChildOf, parentB)
    tick()
    expect(renders).toBe(base + 1)
    expect(arrays[arrays.length - 1]).toBe(stable)

    // Exclusive retarget c1 → parentB drops it from the parentA query.
    rel.addPair(c1, ChildOf, parentB)
    tick()
    expect(renders).toBe(base + 2)
    expect(arrays[arrays.length - 1]).toEqual([])
  })

  test('a Pair term no longer throws (the v1 restriction is lifted)', () => {
    const { world } = makeKit([])
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null)
    const parent = world.spawn()
    function Q() {
      useQuery(rel.Pair(ChildOf, parent))
      return null
    }
    expect(() =>
      render(
        <WorldProvider world={world} relations={rel}>
          <Q />
        </WorldProvider>,
      ),
    ).not.toThrow()
  })
})
