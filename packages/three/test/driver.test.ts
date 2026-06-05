import { describe, expect, test } from 'vitest'
import { createThreeDriver } from '../src/index.js'

describe('@ecsia/three createThreeDriver', () => {
  test('variable-step: tick(dt) runs one update with the real delta + one render', () => {
    const updates: number[] = []
    let renders = 0
    const driver = createThreeDriver({ update: (dt) => updates.push(dt), render: () => renders++ })

    const steps = driver.tick(0.016)
    expect(steps).toBe(1)
    expect(updates).toEqual([0.016])
    expect(renders).toBe(1)
  })

  test('fixed-timestep: accumulates and runs whole steps, carrying the remainder', () => {
    const updates: number[] = []
    let renders = 0
    const driver = createThreeDriver({
      update: (dt) => updates.push(dt),
      render: () => renders++,
      fixedTimestep: 0.01,
    })

    // 0.025 of real time → two 0.01 steps, 0.005 carried.
    expect(driver.tick(0.025)).toBe(2)
    expect(updates).toEqual([0.01, 0.01])
    expect(renders).toBe(1)

    // Next 0.007 → accumulator 0.005 + 0.007 = 0.012 → one more step, 0.002 carried.
    expect(driver.tick(0.007)).toBe(1)
    expect(updates).toEqual([0.01, 0.01, 0.01])
    expect(renders).toBe(2)
  })

  test('fixed-timestep: maxSubSteps caps catch-up and discards the backlog', () => {
    let updates = 0
    const driver = createThreeDriver({
      update: () => updates++,
      render: () => {},
      fixedTimestep: 0.01,
      maxSubSteps: 3,
    })
    // A 1-second stall would be 100 steps; capped at 3, backlog discarded.
    expect(driver.tick(1)).toBe(3)
    expect(updates).toBe(3)
    // The backlog was cleared, so the next small tick does not replay it.
    expect(driver.tick(0.001)).toBe(0)
  })

  test('start() is a no-op when no requestAnimationFrame is available (Node)', () => {
    const driver = createThreeDriver({ update: () => {}, render: () => {} })
    expect(driver.running).toBe(false)
    driver.start() // no rAF in Node → stays stopped, drive via tick instead
    expect(driver.running).toBe(false)
  })

  test('start()/stop() are idempotent (double start schedules one loop; double stop is inert)', () => {
    let scheduled = 0
    let cancelled = 0
    const queue: Array<(t: number) => void> = []
    let nextId = 1
    const driver = createThreeDriver({
      update: () => {},
      render: () => {},
      requestAnimationFrame: (cb) => {
        scheduled++
        queue.push(cb)
        return nextId++
      },
      cancelAnimationFrame: () => {
        cancelled++
      },
    })

    driver.start()
    driver.start() // second start is a no-op while running — no extra rAF scheduled
    expect(driver.running).toBe(true)
    expect(scheduled).toBe(1)

    driver.stop()
    expect(driver.running).toBe(false)
    expect(cancelled).toBe(1)
    driver.stop() // second stop is inert — no extra cancel
    expect(cancelled).toBe(1)
    expect(driver.running).toBe(false)
  })

  test('variable-step tick is deterministic: identical dt sequence → identical update inputs', () => {
    const run = () => {
      const seen: number[] = []
      const d = createThreeDriver({ update: (dt) => seen.push(dt), render: () => {} })
      for (const dt of [0.016, 0.02, 0.008, 0.033]) d.tick(dt)
      return seen
    }
    expect(run()).toEqual([0.016, 0.02, 0.008, 0.033])
    expect(run()).toEqual(run())
  })

  test('start()/stop() drive an injected rAF loop', () => {
    const queue: Array<(t: number) => void> = []
    let nextId = 1
    let updates = 0
    const driver = createThreeDriver({
      update: () => updates++,
      render: () => {},
      requestAnimationFrame: (cb) => {
        queue.push(cb)
        return nextId++
      },
      cancelAnimationFrame: () => {},
    })

    driver.start()
    expect(driver.running).toBe(true)
    // Pump three frames manually through the injected queue.
    let t = 0
    for (let i = 0; i < 3; i++) {
      const cb = queue.shift()
      cb?.((t += 16))
    }
    // First frame has dt 0 (no prior timestamp); all three run an update.
    expect(updates).toBe(3)

    driver.stop()
    expect(driver.running).toBe(false)
    // After stop, a leftover queued callback is inert.
    const leftover = queue.shift()
    leftover?.(999)
    expect(updates).toBe(3)
  })
})
