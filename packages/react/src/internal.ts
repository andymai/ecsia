// Test-only seams for THIS package's tests (relative import, not in package.json#exports).

import { bridgeFor } from './bridge.js'
import type { EcsiaWorld } from './world.js'

/** Live core-observer count held by `world`'s bridge — the leak tests' dispose-accounting probe. */
export function liveObserverCount(world: EcsiaWorld): number {
  return bridgeFor(world).__liveObserverCount()
}

/** Live store-map entry count held by `world`'s bridge — the render-phase leak tests' probe. */
export function liveStoreCount(world: EcsiaWorld): number {
  return bridgeFor(world).__liveStoreCount()
}
