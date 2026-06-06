// The THREADED frame loop (PHASE-2): the same wave/round walk as the
// single-thread executor (update.ts/run-wave.ts), but each round's worker-eligible batches are
// dispatched to the WorkerPool (pool.runRound) — which flips world.phase to 'wave' across the
// dispatch, awaits the Atomics wave fence, flips back to 'serial', and applies the per-worker command
// buffers in the deterministic ascending-worker-index merge order (flushAll).
//
// This is the missing integration the headline requires: a threaded world REPRODUCES the
// single-thread observable result through the SAME frame loop, not only
// through a hand-driven runRound. Worker batches run concurrently on workers; main-thread batches
// (workerIndex === -1, e.g. object-field systems) run serially on the main thread BEFORE the wave's
// dispatch, while world.phase is still 'serial' (so their direct-apply fast path is legal).
//
// Because batches in a round are conflict-free by construction (WAVE-CONFLICT ) and the command
// merge order is fixed, the threaded result equals the single-thread result for the same
// (state, plan, dt).

import type { World } from '@ecsia/core'
import type { SchedulePlan, ScheduleWave, SystemBatch } from '../graph/index.js'
import type { ExecutorEnv } from './run-wave.js'
import type { Tick } from '@ecsia/schema'
import type { SystemContext } from '../planner/index.js'

/** The slice of WorkerPool the threaded executor drives. Kept structural to avoid a hard dependency
 * cycle on the concrete pool (the workers layer is the deeper sibling). */
export interface RoundDispatcher {
  runRound(batches: readonly { systemId: import('@ecsia/schema').SystemId; workerIndex: number }[], dt: number): Promise<void>
}

function runMainThreadSystem(env: ExecutorEnv, batch: SystemBatch, dt: number): void {
  const sb = env.systems[batch.systemId as unknown as number]!
  const topic = env.topicCtx[sb.id as unknown as number]!
  const ctx: SystemContext = {
    world: env.world,
    dt,
    tick: env.world.currentTick() as unknown as Tick,
    query: env.scopedQueries[sb.id as unknown as number]!,
    publish: topic.publish,
    consume: topic.consume,
  }
  sb.run(ctx)
}

async function runWaveThreaded(env: ExecutorEnv, pool: RoundDispatcher, wave: ScheduleWave, dt: number): Promise<void> {
  for (const round of wave.rounds) {
    // Main-thread batches first (phase stays 'serial', direct-apply legal — PHASE-2 ).
    for (const batch of round) {
      if (batch.workerIndex < 0) runMainThreadSystem(env, batch, dt)
    }
    // Worker-eligible batches dispatched concurrently; runRound flips phase 'wave'→'serial', awaits the
    // fence, and applies the per-worker command buffers (deterministic merge). It is a no-op if there
    // are no worker batches in this round.
    const workerBatches = round.filter((b) => b.workerIndex >= 0)
    if (workerBatches.length > 0) {
      await pool.runRound(
        workerBatches.map((b) => ({ systemId: b.systemId, workerIndex: b.workerIndex })),
        dt,
      )
    }
  }
  // ---- SERIAL SLOT (after the wave) ---- canonical topic merge + query maintenance + observers.
  // The topic merge runs ONCE PER WAVE (not per round): a per-round merge would expose round-packing
  // order, which differs from SystemId order — the segment sort over the whole wave's staging is
  // what makes the stream byte-identical to the single-thread executor's.
  env.world.__topics.mergeStaged()
  env.world.maintainStructural()
  if (env.observerCadence === 'per-system') env.world.observerDrain()
}

/**
 * Run one threaded tick: the whole schedule (worker waves) + reactivity flush. The frame order is
 * byte-identical to the single-thread runUpdate (frameReset → waves → observerDrain → flushLogs);
 * the only difference is that each round's worker batches run on workers.
 */
export async function runUpdateThreaded(env: ExecutorEnv, plan: SchedulePlan, pool: RoundDispatcher, dt: number): Promise<void> {
  const world: World = env.world
  if (world.phase !== 'serial') {
    throw new Error(`scheduler.update entered with world.phase === '${world.phase}', expected 'serial'`)
  }
  world.__topics.beginUpdate()
  world.frameReset()
  for (const wave of plan.waves) {
    await runWaveThreaded(env, pool, wave, dt)
  }
  if (env.observerCadence === 'frame-end') world.observerDrain()
  world.flushLogs()
  world.__topics.endUpdate()
  if (world.phase !== 'serial') {
    throw new Error(`scheduler.update exited with world.phase === '${world.phase}', expected 'serial'`)
  }
}
