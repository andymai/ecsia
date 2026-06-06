// Watch mode: per-frame deltas built on the PUBLIC observer/reactivity API (onChange via
// world.observe) plus cheap state sampling (handleStats + archetype census). spawned/despawned are
// REAL entity-lifecycle counts — per-tick diffs of handleStats' monotonic spawn/despawn totals,
// which every alloc/free passes through — NOT component-observer counts: onAdd/onRemove fire for
// component churn on living entities and never fire for a bare spawn(), so they cannot measure
// lifecycle. Change observers fire at the serial drain, so accumulated counts are read + reset each
// time the caller signals a frame boundary via `tick()`. `dispose()` tears every observer down cleanly.

import type { World, ComponentDef, Schema, ObserverContext } from '@ecsia/core'
import { onChange } from '@ecsia/core'
import type { FrameDelta } from './types.js'
import { componentNameMap } from './names.js'

export interface WatchOptions {
  /** Called once per frame boundary with the deltas since the previous boundary. */
  readonly onFrame: (delta: FrameDelta) => void
}

export interface WorldWatcher {
  /**
   * Signal a frame boundary: drain the accumulated observer counts + sample state, invoke `onFrame` with
   * the deltas, then reset the accumulators for the next frame. Call this after each `scheduler.update()`.
   */
  tick(): void
  /** Tear down every installed observer. Idempotent. */
  dispose(): void
}

/**
 * Watch `world` for per-frame deltas. Registers add/remove/change observers across the world's
 * registered components and samples aliveCount + archetype count at each `tick()`. The returned watcher's
 * `dispose()` removes all observers.
 */
export function watchWorld(world: World, opts: WatchOptions): WorldWatcher {
  const names = componentNameMap(world)
  const components = world.options.components as readonly ComponentDef<Schema>[]

  const changed = new Map<number, number>()

  const handles = components.map((def) =>
    world.observe(onChange(def), (_e, ctx: ObserverContext) => {
      const c = ctx.component as number
      changed.set(c, (changed.get(c) ?? 0) + 1)
    }),
  )

  let frame = 0
  let prev = world.handleStats()
  let prevArchetypes = world.__inspect.archetypes().length
  let disposed = false

  return {
    tick(): void {
      if (disposed) return
      const stats = world.handleStats()
      const archetypes = world.__inspect.archetypes().length

      const changedComponents: Record<string, number> = {}
      let changedTotal = 0
      for (const [id, count] of changed) {
        changedComponents[names.get(id) ?? `#${id}`] = count
        changedTotal += count
      }

      const delta: FrameDelta = {
        frame,
        spawned: stats.spawned - prev.spawned,
        despawned: stats.despawned - prev.despawned,
        aliveDelta: stats.aliveCount - prev.aliveCount,
        archetypesCreated: Math.max(0, archetypes - prevArchetypes),
        changedComponents,
        changedTotal,
      }
      opts.onFrame(delta)

      frame += 1
      prev = stats
      prevArchetypes = archetypes
      changed.clear()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const h of handles) h.dispose()
    },
  }
}
