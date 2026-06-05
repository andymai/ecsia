// Watch mode (P5 §2): per-frame deltas built on the PUBLIC observer/reactivity API (onAdd / onRemove /
// onChange via world.observe) plus cheap state sampling (aliveCount + archetype census). The watcher
// installs one add/remove/change observer over the world's registered components; observers fire at the
// serial drain, so accumulated counts are read + reset each time the caller signals a frame boundary via
// `tick()`. `dispose()` tears every observer down cleanly.

import type { World, ComponentDef, Schema, ObserverContext } from '@ecsia/core'
import { onAdd, onRemove, onChange } from '@ecsia/core'
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
 * Watch `world` for per-frame deltas (§2). Registers add/remove/change observers across the world's
 * registered components and samples aliveCount + archetype count at each `tick()`. The returned watcher's
 * `dispose()` removes all observers.
 */
export function watchWorld(world: World, opts: WatchOptions): WorldWatcher {
  const names = componentNameMap(world)
  const components = world.options.components as readonly ComponentDef<Schema>[]

  // Per-frame accumulators. add/remove are deduped per entity index so an entity gaining/losing several
  // components in one frame counts as ONE spawn/despawn, not one per component.
  const added = new Set<number>()
  const removed = new Set<number>()
  const changed = new Map<number, number>()

  const handles = components.map((def) => {
    const idxOf = (e: { handle: number }): number => world.__serialize.handleIndex(e.handle as never)
    const onAddH = world.observe(onAdd(def), (e) => {
      added.add(idxOf(e))
    })
    const onRemoveH = world.observe(onRemove(def), (e) => {
      removed.add(idxOf(e))
    })
    const onChangeH = world.observe(onChange(def), (_e, ctx: ObserverContext) => {
      const c = ctx.component as number
      changed.set(c, (changed.get(c) ?? 0) + 1)
    })
    return [onAddH, onRemoveH, onChangeH]
  })

  let frame = 0
  let prevAlive = world.__serialize.aliveCount()
  let prevArchetypes = world.__inspect.archetypes().length
  let disposed = false

  return {
    tick(): void {
      if (disposed) return
      const alive = world.__serialize.aliveCount()
      const archetypes = world.__inspect.archetypes().length

      const changedComponents: Record<string, number> = {}
      let changedTotal = 0
      for (const [id, count] of changed) {
        changedComponents[names.get(id) ?? `#${id}`] = count
        changedTotal += count
      }

      const delta: FrameDelta = {
        frame,
        spawned: added.size,
        despawned: removed.size,
        aliveDelta: alive - prevAlive,
        archetypesCreated: Math.max(0, archetypes - prevArchetypes),
        changedComponents,
        changedTotal,
      }
      opts.onFrame(delta)

      frame += 1
      prevAlive = alive
      prevArchetypes = archetypes
      added.clear()
      removed.clear()
      changed.clear()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const trio of handles) for (const h of trio) h.dispose()
    },
  }
}
