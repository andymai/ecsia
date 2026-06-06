// The world slice + React context. Like @ecsia/three's WorldLike, the binding accepts a STRUCTURAL
// slice of the world surface so BOTH the `@ecsia/core` World AND the `ecsia` umbrella's public facade
// (which omits the internal `__` seams) satisfy it — importing core's full `World` here would reject
// the facade users actually pass. The slice is generous on purpose: `useWorld()` is the handle users
// reach for in event handlers (`world.entity(h).write(C)`, `world.spawnWith(...)`), so it carries the
// main-thread structural/value verbs, not just what the bridge reads.

import { createContext, createElement, useContext } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { ObserverContext, ObserverHandle, ObserverTerm } from '@ecsia/core'
import type {
  ComponentDef,
  EntityHandle,
  EntityIndex,
  ReadOf,
  Schema,
  SpawnArg,
  SpawnArgFor,
  WorldQuery,
  WriteOf,
} from '@ecsia/schema'

/**
 * The pooled-ref accessor surface the binding exposes: typed read/write plus the bound handle.
 * Satisfied by both core's `EntityRef` and the umbrella's public `EntityRef` view. The pooling
 * contract still applies — resolve at the point of use, never store the returned object.
 */
export interface EntityRefLike {
  readonly handle: EntityHandle
  read<const C extends ComponentDef<Schema>>(def: C): ReadOf<C>
  write<const C extends ComponentDef<Schema>>(def: C): WriteOf<C>
}

/** The structural world slice `@ecsia/react` consumes and `useWorld()` returns. */
export interface EcsiaWorld {
  readonly tick: number
  currentTick(): number
  spawn(): EntityHandle
  spawnWith<const T extends readonly SpawnArg[]>(...specs: { [I in keyof T]: SpawnArgFor<T[I]> }): EntityHandle
  add(handle: EntityHandle, def: ComponentDef<Schema>): void
  remove(handle: EntityHandle, def: ComponentDef<Schema>): void
  despawn(handle: EntityHandle): void
  isAlive(handle: EntityHandle): boolean
  has(handle: EntityHandle, def: ComponentDef<Schema>): boolean
  entity(handle: EntityHandle, opts?: { lenient?: boolean }): EntityRefLike
  query: WorldQuery
  observe(term: ObserverTerm, handler: (e: EntityRefLike, ctx: ObserverContext) => void): ObserverHandle
  decodeHandle(handle: EntityHandle): { index: EntityIndex }
}

const WorldContext = createContext<EcsiaWorld | null>(null)

export interface WorldProviderProps {
  world: EcsiaWorld
  children?: ReactNode
}

/**
 * Provides an existing world to the hooks below. The provider never creates, ticks, or disposes a
 * world — the simulation loop (a driver, r3f's `useFrame`, or a manual `scheduler.update(dt)`) is
 * owned elsewhere, and the world MUST tick for hooks to see mutations (see the package README).
 */
export function WorldProvider({ world, children }: WorldProviderProps): ReactElement {
  return createElement(WorldContext.Provider, { value: world }, children)
}

/** The world from the nearest {@link WorldProvider}. Throws when rendered outside one. */
export function useWorld(): EcsiaWorld {
  const world = useContext(WorldContext)
  if (world === null) {
    throw new Error('useWorld: no <WorldProvider world={...}> above this component')
  }
  return world
}
