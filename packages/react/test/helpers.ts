import { act } from '@testing-library/react'
import { createWorld } from '@ecsia/core'
import type { World } from '@ecsia/core'
import { createScheduler } from '@ecsia/scheduler'
import type { ComponentDef, Schema } from '@ecsia/schema'

export interface Kit {
  world: World
  /** One simulation tick (frameReset -> waves -> observer drain), wrapped in act(). */
  tick: () => void
}

export function makeKit(components: readonly ComponentDef<Schema>[]): Kit {
  const world = createWorld({ components })
  const scheduler = createScheduler(world, [])
  const tick = (): void => {
    act(() => {
      scheduler.update()
    })
  }
  return { world, tick }
}

/**
 * Wrap a world so every observe()/dispose() pair is counted — the dispose-accounting probe the
 * strict-mode leak tests assert on. A Proxy cannot report a different `observe` for a frozen
 * target (proxy invariants), so this is a spread copy with one override.
 */
export function withObserverAccounting(world: World): { world: World; liveObservers: () => number } {
  let live = 0
  const wrapped: World = {
    ...world,
    observe: (term, handler) => {
      const handle = world.observe(term, handler)
      live += 1
      return {
        id: handle.id,
        dispose: (): void => {
          live -= 1
          handle.dispose()
        },
      }
    },
  }
  return { world: wrapped, liveObservers: () => live }
}
