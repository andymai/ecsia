// The single-threaded executor — the NORMATIVE semantics. Runs waves IN ORDER on
// the main thread; each wave's rounds run sequentially and (single-thread) each round's batches run
// sequentially in batch-index order. Because batches in a round are conflict-free by construction
// (WAVE-CONFLICT), the observable result equals the threaded path.
//
// Rule PHASE-1: in single-thread mode (workers === 0) runWave does NOT flip world.phase to
// 'wave'. It stays 'serial' for the entire update, so every structural op a system performs takes the
// synchronous direct-apply fast path and there are no command buffers to
// flush. The post-wave serial slot's flushAll/mergeCorrals are no-ops — zero cost single-threaded.

import type { Tick } from '@ecsia/schema'
import type { World } from '@ecsia/core'
import type { ScheduleWave } from '../graph/index.js'
import type { SystemBox, SystemContext } from '../planner/index.js'
import type { CommandSink } from '../commands/index.js'
import { makeScopedQuery } from './guards.js'

export interface ExecutorEnv {
  readonly world: World
  readonly dev: boolean
  readonly commands: CommandSink
  /** 'per-system' drains observers in every wave's serial slot; 'frame-end' once after the last wave. */
  readonly observerCadence: 'frame-end' | 'per-system'
  /** The plan's SystemBoxes, indexed by SystemId. */
  readonly systems: readonly SystemBox[]
  /** Pre-built per-system scoped queries (dev-guarded). Indexed by SystemId. */
  readonly scopedQueries: readonly World['query'][]
}

export function buildScopedQueries(world: World, systems: readonly SystemBox[], dev: boolean): World['query'][] {
  return systems.map((sb) => makeScopedQuery(world, sb, dev))
}

function runSystem(env: ExecutorEnv, sb: SystemBox, dt: number): void {
  const ctx: SystemContext = {
    world: env.world,
    dt,
    tick: env.world.currentTick() as unknown as Tick,
    query: env.scopedQueries[sb.id as unknown as number]!,
  }
  sb.run(ctx)
}

/** Run one wave, then the serial flush slot after it. */
export function runWave(env: ExecutorEnv, wave: ScheduleWave, dt: number): void {
  // ---- WAVE PHASE ---- (single-thread: world.phase stays 'serial', PHASE-1)
  for (const round of wave.rounds) {
    for (const batch of round) {
      runSystem(env, env.systems[batch.systemId as unknown as number]!, dt)
    }
  }
  // ---- SERIAL SLOT ---- apply staged structural changes + maintain queries + (maybe) observers.
  env.world.mergeCorrals() // no-op single-thread (no worker corrals)
  env.commands.flushAll() // no-op single-thread (no worker command buffers)
  env.world.maintainStructural()
  if (env.observerCadence === 'per-system') env.world.observerDrain()
}
