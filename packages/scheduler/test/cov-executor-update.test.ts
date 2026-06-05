// Coverage: executor/update.ts (runUpdate entry/exit phase guards, frame-end cadence) and
// executor/update-threaded.ts (runUpdateThreaded entry/exit phase guards, per-system serial-slot
// observer drain) driven through a STUB world + a STUB RoundDispatcher — never a real WorkerPool.

import { describe, expect, test, vi } from 'vitest'
import { runUpdate, runUpdateThreaded } from '../src/internal.js'
import type { RoundDispatcher } from '@ecsia/scheduler'
import type { ExecutorEnv, SchedulePlan, ScheduleWave, SystemBox } from '../src/internal.js'

interface FakeWorld {
  phase: string
  frameReset: ReturnType<typeof vi.fn>
  observerDrain: ReturnType<typeof vi.fn>
  flushLogs: ReturnType<typeof vi.fn>
  maintainStructural: ReturnType<typeof vi.fn>
  mergeCorrals: ReturnType<typeof vi.fn>
  currentTick: ReturnType<typeof vi.fn>
}

function fakeWorld(overrides: Partial<{ phase: string; onFlushLogs: () => void }> = {}): FakeWorld {
  return {
    phase: overrides.phase ?? 'serial',
    frameReset: vi.fn(),
    observerDrain: vi.fn(),
    flushLogs: vi.fn(overrides.onFlushLogs),
    maintainStructural: vi.fn(),
    mergeCorrals: vi.fn(),
    currentTick: vi.fn(() => 0),
  }
}

function envOf(world: FakeWorld, cadence: 'frame-end' | 'per-system', systems: SystemBox[] = []): ExecutorEnv {
  return {
    world: world as unknown as ExecutorEnv['world'],
    dev: false,
    commands: { flushAll: vi.fn() } as unknown as ExecutorEnv['commands'],
    observerCadence: cadence,
    systems,
    scopedQueries: systems.map(() => vi.fn() as unknown as ExecutorEnv['scopedQueries'][number]),
  }
}

function emptyPlan(): SchedulePlan {
  return { waves: [], systems: [], accessStrideWords: 1, workers: 0 } as unknown as SchedulePlan
}

describe('update.ts: runUpdate phase guards (lines 12-13/24-25, branches 11/23)', () => {
  test('entering with phase !== serial throws the entry guard (branch 11)', () => {
    const world = fakeWorld({ phase: 'wave' })
    expect(() => runUpdate(envOf(world, 'frame-end'), emptyPlan(), 0)).toThrow(
      /scheduler\.update entered with world\.phase === 'wave', expected 'serial'/,
    )
    // The guard fires BEFORE any frame work.
    expect(world.frameReset).not.toHaveBeenCalled()
  })

  test('a phase that becomes non-serial DURING the frame throws the exit guard (branch 23)', () => {
    // flushLogs is the last serial step; flipping phase there models an invariant violation that the
    // exit guard must catch.
    const world = fakeWorld({
      onFlushLogs() {
        world.phase = 'wave'
      },
    })
    expect(() => runUpdate(envOf(world, 'frame-end'), emptyPlan(), 0)).toThrow(
      /scheduler\.update exited with world\.phase === 'wave', expected 'serial'/,
    )
    // The frame body DID run before the exit guard tripped.
    expect(world.frameReset).toHaveBeenCalledOnce()
    expect(world.flushLogs).toHaveBeenCalledOnce()
  })

  test('frame-end cadence drains observers ONCE after the waves (branch 21 true)', () => {
    const world = fakeWorld()
    runUpdate(envOf(world, 'frame-end'), emptyPlan(), 0)
    expect(world.observerDrain).toHaveBeenCalledOnce()
    expect(world.flushLogs).toHaveBeenCalledOnce()
    expect(world.frameReset).toHaveBeenCalledOnce()
  })

  test('per-system cadence does NOT drain observers at frame end (branch 21 false)', () => {
    // With an empty plan and per-system cadence, the frame-end observerDrain is skipped entirely.
    const world = fakeWorld()
    runUpdate(envOf(world, 'per-system'), emptyPlan(), 0)
    expect(world.observerDrain).not.toHaveBeenCalled()
    expect(world.flushLogs).toHaveBeenCalledOnce()
  })
})

describe('update-threaded.ts: runUpdateThreaded phase guards + per-system drain (lines 70-71/79-80, branches 59/69/78)', () => {
  /** A stub RoundDispatcher — records dispatched batches, resolves immediately. NOT a WorkerPool. */
  function stubPool(): RoundDispatcher & { calls: { systemId: number; workerIndex: number }[][] } {
    const calls: { systemId: number; workerIndex: number }[][] = []
    return {
      calls,
      async runRound(batches): Promise<void> {
        calls.push(batches.map((b) => ({ systemId: b.systemId as unknown as number, workerIndex: b.workerIndex })))
      },
    }
  }

  test('entering with phase !== serial throws the entry guard (branch 69)', async () => {
    const world = fakeWorld({ phase: 'wave' })
    await expect(runUpdateThreaded(envOf(world, 'frame-end'), emptyPlan(), stubPool(), 0)).rejects.toThrow(
      /scheduler\.update entered with world\.phase === 'wave', expected 'serial'/,
    )
    expect(world.frameReset).not.toHaveBeenCalled()
  })

  test('a phase flip during the frame throws the exit guard (branch 78)', async () => {
    const world = fakeWorld({
      onFlushLogs() {
        world.phase = 'wave'
      },
    })
    await expect(runUpdateThreaded(envOf(world, 'frame-end'), emptyPlan(), stubPool(), 0)).rejects.toThrow(
      /scheduler\.update exited with world\.phase === 'wave', expected 'serial'/,
    )
    expect(world.frameReset).toHaveBeenCalledOnce()
  })

  test('per-system cadence drains observers in the post-wave serial slot (branch 59)', async () => {
    // A plan with one wave containing one worker batch. runWaveThreaded dispatches it to the stub pool,
    // then (per-system cadence) drains observers in the serial slot — exercising branch 59's true side.
    const world = fakeWorld()
    const wave: ScheduleWave = {
      rounds: [[{ systemId: 0 as never, workerIndex: 0 }]],
      perWorkerSpawnHint: new Uint32Array(1),
    }
    const plan = { waves: [wave], systems: [], accessStrideWords: 1, workers: 1 } as unknown as SchedulePlan
    const pool = stubPool()
    await runUpdateThreaded(envOf(world, 'per-system'), plan, pool, 0.5)
    // The worker batch was dispatched to the stub pool.
    expect(pool.calls).toEqual([[{ systemId: 0, workerIndex: 0 }]])
    // Per-system cadence → serial-slot observerDrain ran (once for the single wave).
    expect(world.maintainStructural).toHaveBeenCalledOnce()
    expect(world.observerDrain).toHaveBeenCalledOnce()
    // frame-end drain is NOT additionally invoked under per-system cadence.
    expect(world.observerDrain).toHaveBeenCalledTimes(1)
  })

  test('a round with ONLY main-thread batches runs them serially and skips pool dispatch', async () => {
    // workerIndex -1 batch → runMainThreadSystem invoked; no worker batches → pool.runRound NOT called.
    const ran: number[] = []
    const sb = {
      id: 0,
      name: 's',
      run: () => ran.push(1),
    } as unknown as SystemBox
    const world = fakeWorld()
    const wave: ScheduleWave = {
      rounds: [[{ systemId: 0 as never, workerIndex: -1 }]],
      perWorkerSpawnHint: new Uint32Array(0),
    }
    const plan = { waves: [wave], systems: [sb], accessStrideWords: 1, workers: 0 } as unknown as SchedulePlan
    const pool = stubPool()
    await runUpdateThreaded(envOf(world, 'frame-end', [sb]), plan, pool, 0)
    expect(ran).toEqual([1]) // main-thread system body executed
    expect(pool.calls).toEqual([]) // no worker batches → no dispatch
  })
})
