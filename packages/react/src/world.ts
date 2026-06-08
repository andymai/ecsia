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

/**
 * The structural slice of a relation definition the hooks need — satisfied by @ecsia/relations'
 * RelationDef without importing it (the binding depends only on core + schema; same trick as
 * {@link EcsiaWorld}). `id` is the world-assigned RelationId (a branded number).
 */
export interface RelationLike {
  readonly id: number
  readonly name?: string
}

/**
 * The structural slice of the relations runtime the hooks consume — satisfied by the object
 * `createRelations(world)` returns. Reads only; writes go through the runtime at the point of use,
 * exactly like component writes go through the world.
 */
export interface RelationsLike {
  targetsOf(subject: EntityHandle, relation: RelationLike): Iterable<EntityHandle>
  targetOf(subject: EntityHandle, relation: RelationLike): EntityHandle | null
}

const WorldContext = createContext<EcsiaWorld | null>(null)
const RelationsContext = createContext<RelationsLike | null>(null)

export interface WorldProviderProps {
  world: EcsiaWorld
  /**
   * The relations runtime from `createRelations(world)` — required only by the relation hooks
   * (useTarget / useTargets). Omit it in a relations-free app; the relation hooks then throw a
   * pointed error instead of silently returning nothing.
   */
  relations?: RelationsLike
  children?: ReactNode
}

/**
 * Provides an existing world to the hooks below. The provider never creates, ticks, or disposes a
 * world — the simulation loop (a driver, r3f's `useFrame`, or a manual `scheduler.update(dt)`) is
 * owned elsewhere, and the world MUST tick for hooks to see mutations (see the package README).
 */
export function WorldProvider({ world, relations, children }: WorldProviderProps): ReactElement {
  return createElement(
    WorldContext.Provider,
    { value: world },
    createElement(RelationsContext.Provider, { value: relations ?? null }, children),
  )
}

/** The world from the nearest {@link WorldProvider}. Throws when rendered outside one. */
export function useWorld(): EcsiaWorld {
  const world = useContext(WorldContext)
  if (world === null) {
    throw new Error('useWorld: no <WorldProvider world={...}> above this component')
  }
  return world
}

/** The relations runtime from the nearest provider — internal to the relation hooks. */
export function useRelationsRuntime(): RelationsLike {
  const rel = useContext(RelationsContext)
  if (rel === null) {
    throw new Error(
      'useTarget/useTargets: no relations runtime — pass it to the provider: <WorldProvider world={world} relations={createRelations(world)}>',
    )
  }
  return rel
}
