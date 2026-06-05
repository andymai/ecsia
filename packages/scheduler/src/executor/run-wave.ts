// The single-threaded executor — the NORMATIVE semantics. Runs waves IN ORDER on
// the main thread; each wave's rounds run sequentially and (single-thread) each round's batches run
// sequentially in batch-index order. Because batches in a round are conflict-free by construction
// (WAVE-CONFLICT), the observable result equals the threaded path.
//
// Rule PHASE-1: in single-thread mode (workers === 0) runWave does NOT flip world.phase to
// 'wave'. It stays 'serial' for the entire update, so every structural op a system performs takes the
// synchronous direct-apply fast path and there are no command buffers to
// flush. The post-wave serial slot's flushAll/mergeCorrals are no-ops — zero cost single-threaded.

import type { Schema, Tick } from '@ecsia/schema'
import type { TopicDef, TopicEvent, TopicEventInit, World } from '@ecsia/core'
import type { ScheduleWave } from '../graph/index.js'
import type { SystemBox, SystemContext } from '../planner/index.js'
import type { CommandSink } from '../commands/index.js'
import { makeScopedQuery } from './guards.js'

/** The per-system topic verbs handed to the system context (pre-built, like scoped queries). */
export interface TopicCtx {
  readonly publish: SystemContext['publish']
  readonly consume: SystemContext['consume']
}

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
  /** Pre-built per-system topic publish/consume verbs (dev-guarded). Indexed by SystemId. */
  readonly topicCtx: readonly TopicCtx[]
}

export function buildScopedQueries(world: World, systems: readonly SystemBox[], dev: boolean): World['query'][] {
  return systems.map((sb) => makeScopedQuery(world, sb, dev))
}

/**
 * Per-system `publish`/`consume`: declaration-gated (dev error on undeclared use), staging by the
 * system's own SystemId so the serial-slot segment sort yields the canonical order. Consume cursors
 * key by system NAME so they survive a re-plan (SystemIds can shift when systems are added).
 */
export function buildTopicCtx(world: World, systems: readonly SystemBox[], dev: boolean): TopicCtx[] {
  const topics = world.__topics
  return systems.map((sb) => {
    const declaredPublish = new Set(sb.publishTopics)
    const declaredConsume = new Set(sb.consumeTopics)
    const systemId = sb.id as unknown as number
    return {
      publish<S extends Schema>(topic: TopicDef<S>, init?: TopicEventInit<S>): void {
        if (dev && !declaredPublish.has(topic as TopicDef<Schema>)) {
          throw new Error(
            `system '${sb.name}' publishes topic '${topic.name}' without declaring it — add it to the system's publish: [...] so the scheduler can order consumers after it`,
          )
        }
        topics.stageValues(topic as TopicDef<Schema>, systemId, init as Record<string, unknown> | undefined)
      },
      consume<S extends Schema>(topic: TopicDef<S>): IterableIterator<TopicEvent<S>> {
        if (dev && !declaredConsume.has(topic as TopicDef<Schema>)) {
          throw new Error(
            `system '${sb.name}' consumes topic '${topic.name}' without declaring it — add it to the system's consume: [...] so the scheduler can order it after publishers`,
          )
        }
        return topics.consume(topic as TopicDef<Schema>, sb.name) as IterableIterator<TopicEvent<S>>
      },
    }
  })
}

function runSystem(env: ExecutorEnv, sb: SystemBox, dt: number): void {
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
  // Canonicalize this wave's published events (segment sort by SystemId) so later waves see them —
  // the same merge point the threaded path uses. No-op when nothing was staged.
  env.world.__topics.mergeStaged()
  env.world.maintainStructural()
  if (env.observerCadence === 'per-system') env.world.observerDrain()
}
