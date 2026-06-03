// The world.update(dt) frame loop (scheduler.md §6.2; byte-identical to public-api.md §6). Asserts
// world.phase === 'serial' on entry and exit (SCH-4): single-thread mode never leaves 'serial'.

import type { World } from '@ecsia/core'
import type { SchedulePlan } from '../graph/index.js'
import { runWave } from './run-wave.js'
import type { ExecutorEnv } from './run-wave.js'

export function runUpdate(env: ExecutorEnv, plan: SchedulePlan, dt: number): void {
  const world: World = env.world
  if (world.phase !== 'serial') {
    throw new Error(`scheduler.update entered with world.phase === '${world.phase}', expected 'serial' (SCH-4)`)
  }
  // ---- 1. frame start ----
  world.frameReset() // advance currentTick; reset transient query lists (reactivity.md §3.7)
  // ---- 2..4. run every wave, flushing structural + reactivity between waves ----
  for (const wave of plan.waves) {
    runWave(env, wave, dt)
  }
  // ---- 5. end-of-frame reactivity ----
  if (env.observerCadence === 'frame-end') world.observerDrain()
  world.flushLogs() // drain spill, schedule ring resize (reactivity.md §8.2)
  if (world.phase !== 'serial') {
    throw new Error(`scheduler.update exited with world.phase === '${world.phase}', expected 'serial' (SCH-4)`)
  }
}
