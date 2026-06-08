// The hook surface. Every value-bearing hook is useSyncExternalStore over a bridge store:
// subscribe registers the listener (refcounted core observer underneath), getSnapshot returns the
// store's CACHED snapshot, and getServerSnapshot always recomputes (identity-preserved when values
// match) — no observer invalidates the cache on the server, and ecsia reads are synchronous and
// Node-safe. Handles in, snapshots out — no EntityRef ever crosses this surface.
//
// Visibility latency: hooks reflect world state as of the last completed update()'s observer
// drain. A world that is not ticking appears frozen to hooks.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ObserverContext, ObserverHandle, ObserverTerm } from '@ecsia/core'
import type { ComponentDef, EntityHandle, QueryTerm, Schema } from '@ecsia/schema'
import { bridgeFor } from './bridge.js'
import type { QueryLike } from './bridge.js'
import type { ComponentSnapshot } from './snapshot.js'
import { useRelationsRuntime, useWorld } from './world.js'
import type { EntityRefLike, RelationLike } from './world.js'

/**
 * The handles currently matching `terms` (the full query DSL: `read`/`write`/`has`/`without`/
 * `optional`; relation `Pair` terms are deferred to v2). Re-renders ONLY when membership changes —
 * value writes inside matching entities never re-render this hook; render per-entity values with
 * {@link useComponent} in a child keyed by the handle.
 */
export function useQuery(...terms: readonly QueryTerm[]): readonly EntityHandle[] {
  const world = useWorld()
  // world.query canonical-hashes the term set, so a fresh terms array per render still resolves to
  // the SAME cached LiveQuery — its identity is the bridge's term-signature key.
  const query = world.query(...(terms as QueryTerm[])) as unknown as QueryLike
  const store = bridgeFor(world).queryStore(query)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

/** The first handle matching `terms`, or `undefined`. Same re-render cut as {@link useQuery}. */
export function useQueryFirst(...terms: readonly QueryTerm[]): EntityHandle | undefined {
  return useQuery(...terms)[0]
}

/**
 * A frozen {@link ComponentSnapshot} of `def` on `handle`, or `undefined` when the entity is dead
 * or lacks the component. Re-renders only when an observer event for THIS entity's component lands
 * AND the recomputed snapshot differs field-shallow — a write that lands the same values keeps the
 * previous object identity. Write through the world at the point of use:
 * `world.entity(handle).write(C).hp -= 10`.
 */
export function useComponent<const C extends ComponentDef<Schema>>(
  handle: EntityHandle,
  def: C,
): ComponentSnapshot<C> | undefined {
  const world = useWorld()
  const store = bridgeFor(world).componentStore(handle, def)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot) as
    | ComponentSnapshot<C>
    | undefined
}

/**
 * The current targets of `relation` on `handle` — every entity this subject points at, as stable
 * handles (valid React keys). Re-renders ONLY when the pair membership for this (subject, relation)
 * changes: a pair added or removed (explicit, exclusive retarget, or cascade teardown). Values are
 * recomputed from `rel.targetsOf` at snapshot time — always-current truth, identity-stable when the
 * set is unchanged. Requires the relations runtime on the provider:
 * `<WorldProvider world={world} relations={rel}>`.
 */
export function useTargets(handle: EntityHandle, relation: RelationLike): readonly EntityHandle[] {
  const world = useWorld()
  const rel = useRelationsRuntime()
  const store = bridgeFor(world).targetsStore(rel, handle, relation)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

/**
 * The single target of `relation` on `handle`, or `undefined` when none — the exclusive-relation
 * ergonomic (a ChildOf parent, a Targeting victim). Same subscription and re-render cut as
 * {@link useTargets}; for a non-exclusive relation this is its first target.
 */
export function useTarget(handle: EntityHandle, relation: RelationLike): EntityHandle | undefined {
  return useTargets(handle, relation)[0]
}

/**
 * Presence of `def` on `handle` (covers `defineTag` tags). Subscribes to add/remove only — value
 * writes never wake it.
 */
export function useHas(handle: EntityHandle, def: ComponentDef<Schema>): boolean {
  const world = useWorld()
  const store = bridgeFor(world).hasStore(handle, def)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

/**
 * Fire `callback` on every add/remove/change of `def` on `handle` WITHOUT re-rendering this
 * component. The callback receives a frozen {@link ComponentSnapshot} copy (`undefined` on
 * remove/despawn), never the pooled EntityRef core observers hand their handlers — a stashed
 * snapshot is harmless where a stashed ref throws. Events arrive at the observer drain inside
 * update(), once per tick per (entity, component).
 */
export function useComponentEffect<const C extends ComponentDef<Schema>>(
  handle: EntityHandle,
  def: C,
  callback: (snapshot: ComponentSnapshot<C> | undefined, ctx: ObserverContext) => void,
): void {
  const world = useWorld()
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  })
  useEffect(() => {
    return bridgeFor(world).addComponentEffect(handle, def, (snapshot, ctx) => {
      callbackRef.current(snapshot as ComponentSnapshot<C> | undefined, ctx)
    })
  }, [world, handle, def])
}

/**
 * Lifecycle wrapper over `world.observe`: register on mount, dispose on unmount — the general
 * escape hatch. The handler receives the pooled EntityRef exactly as core observers do; the
 * pooling contract applies (read fields inside the handler, never store the ref).
 */
export function useObserve(
  term: ObserverTerm,
  handler: (e: EntityRefLike, ctx: ObserverContext) => void,
): void {
  const world = useWorld()
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })
  // Term factories return a fresh object per render; key the effect on the term's signature so an
  // equivalent term does not churn the registration. Keyed by component id, not name — two defs
  // may share a name, and ids are world-assigned and stable by the time a hook can run. Pair terms
  // (onPairAdded/onPairRemoved) key by relation id.
  const signature =
    'relationId' in term
      ? `${term.kind}:rel:${term.relationId}`
      : `${term.kind}:${term.components.map((c) => c.id).join(',')}`
  useEffect(() => {
    const handle: ObserverHandle = world.observe(term, (e, ctx) => {
      handlerRef.current(e, ctx)
    })
    return () => {
      handle.dispose()
    }
  }, [world, signature])
}
