// INTEGRATION — the scheduler drives the deferred observer drain at the SERIAL SLOT under both the
// single-thread (runUpdate) and threaded (runUpdateThreaded) executors, for both observerCadence
// values ('frame-end' default, 'per-system' opt-in). The headline goal end-to-end: an observer
// that stages a structural op during the drain has it applied at the NEXT serial flush, observed by
// onAdd next drain — never mid-system, never re-entrant.
//
// The threaded path is exercised with workerCount === 0 (the degenerate threaded executor): it walks
// the same wave loop and calls world.observerDrain() at the serial slot, proving the wiring holds on
// runUpdateThreaded without needing the worker pool spun up.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onAdd, onChange, write } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'

interface TickView {
  ticker: { n: number }
}

function kit(opts?: { observerCadence?: 'frame-end' | 'per-system'; threaded?: boolean }) {
  const Ticker = defineComponent({ n: 'i32' }, { name: 'ticker' })
  const Spawned = defineComponent({ k: 'i32' }, { name: 'spawned' })
  const world = createWorld({
    components: [Ticker, Spawned],
    maxEntities: 1 << 12,
    ...(opts?.threaded ? { threaded: true, scheduler: { workers: 'no-sab' as const } } : {}),
    reactivity: { observerCadence: opts?.observerCadence ?? 'frame-end' },
  })
  // A system that writes Ticker every frame so onChange(Ticker) fires.
  const Advance = defineSystem({
    name: 'Advance',
    read: [],
    write: [Ticker],
    run({ query }) {
      for (const e of query(write(Ticker))) {
        ;(e as unknown as TickView).ticker.n += 1
      }
    },
  })
  return { world, Ticker, Spawned, Advance }
}

describe('single-thread runUpdate drives observerDrain at the serial slot (frame-end)', () => {
  test('a spawn staged inside an onChange observer applies next frame; onAdd fires next frame', async () => {
    const { world, Ticker, Spawned, Advance } = kit({ observerCadence: 'frame-end' })
    const scheduler = createScheduler(world, [Advance])

    const e = world.spawnWith(Ticker)
    const spawnedHandles: EntityHandle[] = []
    let added = 0
    let onChangeFires = 0

    world.observe(onChange(Ticker), () => {
      onChangeFires++
      // Spawn ONCE (first drain) to avoid an unbounded spawn cascade.
      if (spawnedHandles.length === 0) {
        const ne = world.spawn()
        world.add(ne, Spawned)
        spawnedHandles.push(ne)
      }
    })
    world.observe(onAdd(Spawned), () => added++)

    // Frame 1: Advance writes Ticker → onChange fires → stages a spawn. onAdd must NOT fire yet.
    scheduler.update(1)
    expect(onChangeFires).toBe(1)
    expect(added).toBe(0)
    expect(world.has(spawnedHandles[0] as EntityHandle, Spawned)).toBe(false) // not applied yet

    // Frame 2: the staged spawn applies at the frame-start drain's flush; onAdd observes it.
    scheduler.update(1)
    expect(added).toBe(1)
    expect(world.has(spawnedHandles[0] as EntityHandle, Spawned)).toBe(true)
    void e
  })
})

describe('single-thread runUpdate drives observerDrain per wave (per-system)', () => {
  test('per-system cadence still drains at the serial slot and defers observer mutations', () => {
    const { world, Ticker, Spawned, Advance } = kit({ observerCadence: 'per-system' })
    const scheduler = createScheduler(world, [Advance])

    world.spawnWith(Ticker)
    const spawnedHandles: EntityHandle[] = []
    let added = 0

    world.observe(onChange(Ticker), () => {
      if (spawnedHandles.length === 0) {
        const ne = world.spawn()
        world.add(ne, Spawned)
        spawnedHandles.push(ne)
      }
    })
    world.observe(onAdd(Spawned), () => added++)

    scheduler.update(1)
    // per-system: the single wave's serial slot drained observers; the spawn was staged (not mid-drain).
    expect(world.has(spawnedHandles[0] as EntityHandle, Spawned)).toBe(false)

    scheduler.update(1)
    expect(added).toBe(1)
    expect(world.has(spawnedHandles[0] as EntityHandle, Spawned)).toBe(true)
  })
})

describe('threaded runUpdateThreaded drives observerDrain at the serial slot (degenerate, workers=0)', () => {
  test('the threaded frame loop fires the same deferred observer drain', async () => {
    const { world, Ticker, Spawned, Advance } = kit({ observerCadence: 'frame-end', threaded: true })
    const scheduler = createScheduler(world, [Advance])

    world.spawnWith(Ticker)
    const spawnedHandles: EntityHandle[] = []
    let added = 0
    world.observe(onChange(Ticker), () => {
      if (spawnedHandles.length === 0) {
        const ne = world.spawn()
        world.add(ne, Spawned)
        spawnedHandles.push(ne)
      }
    })
    world.observe(onAdd(Spawned), () => added++)

    // No real worker pool: an empty round-dispatcher (runRound is never called with 0 worker batches).
    const pool = { runRound: async (): Promise<void> => {} }

    await scheduler.updateThreaded(pool, 1)
    expect(added).toBe(0)
    expect((world as World).phase).toBe('serial') // exits the serial slot

    await scheduler.updateThreaded(pool, 1)
    expect(added).toBe(1)
    expect(world.has(spawnedHandles[0] as EntityHandle, Spawned)).toBe(true)
  })
})
