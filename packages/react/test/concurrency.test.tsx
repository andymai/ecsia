// Concurrency smoke: world.update() interleaved with startTransition renders. useSyncExternalStore
// detects mid-render store changes and re-renders consistently, so NO committed tree ever shows a
// torn frame where useQuery and useComponent disagree (a listed row whose component reads as gone).
// A per-commit effect log records (rowCount, tornCount) for EVERY commit, not just the final tree.

import { describe, expect, test } from 'vitest'
import { startTransition, useEffect, useState } from 'react'
import { render, act, screen } from '@testing-library/react'
import { defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { read } from '@ecsia/schema'
import { WorldProvider, useComponent, useQuery } from '../src/index.js'
import { makeKit } from './helpers.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })

describe('startTransition smoke', () => {
  test(
    'no committed frame shows a listed row without its component value',
    () => {
      const Health = mkHealth()
      const { world, tick } = makeKit([Health])
      const spawned: EntityHandle[] = []
      for (let i = 0; i < 4; i++) spawned.push(world.spawnWith([Health, { hp: i + 1 }]))
      tick()

      const commits: Array<{ rows: number; torn: number }> = []
      const logCommit = (): void => {
        const rows = Array.from(document.querySelectorAll('[data-row]'))
        commits.push({
          rows: rows.length,
          torn: rows.filter((r) => r.textContent === 'TORN').length,
        })
      }

      function Row({ handle, Health: def }: { handle: EntityHandle; Health: ReturnType<typeof mkHealth> }) {
        const health = useComponent(handle, def)
        // No dep array: observes the committed tree after every commit that re-rendered this row —
        // value-write commits re-render only rows, which App's effect would never see.
        useEffect(logCommit)
        return <li data-row="">{health === undefined ? 'TORN' : `hp:${health.hp}`}</li>
      }

      let bumpGeneration: () => void = () => {}
      function App() {
        const [generation, setGeneration] = useState(0)
        bumpGeneration = () => setGeneration((g) => g + 1)
        const handles = useQuery(read(Health))
        useEffect(logCommit)
        return (
          <ul data-testid="list" data-generation={generation}>
            {handles.map((h) => (
              <Row key={h} handle={h} Health={Health} />
            ))}
          </ul>
        )
      }
      const { container } = render(
        <WorldProvider world={world}>
          <App />
        </WorldProvider>,
      )

      const assertNotTorn = (): void => {
        expect(container.textContent).not.toContain('TORN')
        const rows = container.querySelectorAll('[data-row]')
        let live = 0
        world.query(read(Health)).each(() => void (live += 1))
        expect(rows.length).toBe(live)
      }

      // Rounds of: transition render + world mutations (writes, churn, despawn/spawn) + tick,
      // all interleaved inside one act() so React must reconcile mid-flight store changes.
      for (let round = 0; round < 8; round++) {
        act(() => {
          startTransition(() => bumpGeneration())
          for (const h of spawned) {
            if (world.isAlive(h)) world.entity(h).write(Health).hp = round * 10
          }
          const victim = spawned.find((h) => world.isAlive(h))
          if (victim !== undefined && round % 2 === 0) world.despawn(victim)
          spawned.push(world.spawnWith([Health, { hp: 100 + round }]))
          tick()
        })
        assertNotTorn()
      }

      expect(Number(screen.getByTestId('list').dataset['generation'])).toBeGreaterThan(0)

      // EVERY committed frame held the invariant — not just the final tree.
      expect(commits.length).toBeGreaterThan(1)
      for (const [i, commit] of commits.entries()) {
        expect(commit.torn, `commit ${i} (${commit.rows} rows)`).toBe(0)
        expect(commit.rows, `commit ${i}`).toBeGreaterThan(0)
      }
    },
    15_000,
  )
})
