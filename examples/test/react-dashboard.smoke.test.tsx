// Smoke + regression test for the @ecsia/react dashboard example. Renders the Fleet under jsdom and
// pins the contract the example teaches: the UI reflects the world only after a tick. Initial
// membership shows on first render; a write or spawn made off-frame appears on the NEXT tick.
//
// One world, one narrative: the example's components are module-level defs (the realistic single-app
// shape), and a component def registers to exactly one world — so the whole story runs over a single
// dashboard rather than a fresh world per test.

import { describe, expect, test } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { WorldProvider } from '@ecsia/react'
import { createDashboard, Fleet, Health } from '../react-dashboard.js'

const hpOf = (row: HTMLElement): number => Number(within(row).getByTestId(/^hp-/).textContent)

describe('example: react-dashboard (render an ecsia world from hooks)', () => {
  test('the UI tracks the world, and only moves when the world ticks', () => {
    const { world, tick } = createDashboard()
    render(
      <WorldProvider world={world}>
        <Fleet />
      </WorldProvider>,
    )

    // Three ships are live before the first render — useQuery sees them immediately (no tick needed).
    expect(screen.getByTestId('count').textContent).toBe('3 ships')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    // One ship started burning — its 🔥 badge comes from useHas.
    expect(screen.getByRole('list').textContent).toContain('🔥')

    // A frame changes hp (burning ships -5, the rest regen +1) — the UI only moves because we ticked.
    const before = screen.getAllByRole('listitem').map(hpOf).sort((a, b) => a - b)
    act(() => tick())
    const after = screen.getAllByRole('listitem').map(hpOf).sort((a, b) => a - b)
    expect(after).not.toEqual(before)

    // A write made off-frame is deferred: the click writes hp -= 10 through the world, but hooks
    // reflect the last drain, so nothing re-renders until the next tick.
    const firstShip = screen.getAllByRole('listitem')[0]!
    const beforeHit = hpOf(firstShip)
    act(() => {
      fireEvent.click(within(firstShip).getByText('hit'))
    })
    expect(hpOf(firstShip)).toBe(beforeHit) // not on click…
    act(() => tick())
    // Exactly the write-back (-10) plus this non-burning ship's regen (+1). The precise value proves
    // the click's write actually landed — not merely that Decay moved the number — and fails loudly
    // if query order ever put a burning ship (which would read beforeHit - 15) first.
    expect(hpOf(firstShip)).toBe(beforeHit - 9)

    // Spawning is observer-driven too — the new ship joins the list on the drain, not the click.
    act(() => {
      fireEvent.click(screen.getByText('Add ship'))
    })
    expect(screen.getByTestId('count').textContent).toBe('3 ships')
    act(() => tick())
    expect(screen.getByTestId('count').textContent).toBe('4 ships')
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  test('Health stays a registered component (guards the example import wiring)', () => {
    expect(Health.name).toBe('health')
  })
})
