// The per-world ReactBridge. Hooks ride the deferred observer layer (never changed filters: a
// pull-side log pointer that isn't drained every frame pins the write-log ring), and the bridge
// multiplexes them: ONE refcounted world.observe per (kind, component) in use, fanned out through
// the bridge's own maps. Two hundred useComponent(h, Health) hooks are one core observer plus a map
// lookup — core dispatch is O(events x observers-on-that-(kind, comp)), so per-hook core observers
// would each be invoked for every Health event and self-filter.
//
// Fan-out:
// - per-entity: component -> entityIndex -> Set<watcher>, with a generation check so a recycled
//   index never wakes a watcher of the dead entity (remove events wake by index alone — the dying
//   occupant's generation is already bumped by the time the drain runs, and a dead watcher must
//   still learn it died).
// - per-query: keyed by the LiveQuery identity world.query returns (canonical term-signature hash —
//   identical term sets share one LiveQuery, so this IS the term signature). Any add/remove event
//   touching a term component marks the entry dirty, INCLUDING without() components: an add can
//   evict a match.
//
// Snapshots are cached per store and recomputed only when dirty, so getSnapshot is allocation-free
// on the happy path (useSyncExternalStore treats a fresh object per call as an endless change).

import { onAdd, onChange, onRemove } from '@ecsia/core'
import type { ObserverContext, ObserverHandle, PairObserverTerm } from '@ecsia/core'
import type { ComponentDef, EntityHandle, QueryTerm, Schema } from '@ecsia/schema'
import { computeSnapshot, snapshotsEqual } from './snapshot.js'
import type { EcsiaWorld, RelationLike, RelationsLike } from './world.js'

type Kind = 'add' | 'remove' | 'change'
type PairKind = 'pair-add' | 'pair-remove'

const PAIR_KINDS: readonly PairKind[] = ['pair-add', 'pair-remove']

const VALUE_KINDS: readonly Kind[] = ['add', 'remove', 'change']
const PRESENCE_KINDS: readonly Kind[] = ['add', 'remove']

const EMPTY_HANDLES: readonly EntityHandle[] = Object.freeze([])

/** The slice of a LiveQuery the bridge needs; world.query's cached return satisfies it. */
export interface QueryLike {
  readonly terms: readonly QueryTerm[]
  each(fn: (e: { readonly handle: EntityHandle }) => void): void
}

interface EntityWatcher {
  readonly watchedIndex: number
  onEvent(kind: Kind, eventHandle: EntityHandle, ctx: ObserverContext): void
}

interface ObserverCell {
  refs: number
  readonly handle: ObserverHandle
}

function isComponentDef(value: unknown): value is ComponentDef<Schema> {
  return typeof value === 'object' && value !== null && 'fields' in value && 'schema' in value
}

/**
 * The components whose add/remove events can change the query's membership: every positive term
 * plus every without() term (an add to a Without component evicts a match). optional() terms never
 * gate membership. Pair terms are rejected — pair-aware observer terms are not on core's public
 * surface (relations hooks are deferred to v2).
 */
function membershipComponents(terms: readonly QueryTerm[]): readonly ComponentDef<Schema>[] {
  const out: ComponentDef<Schema>[] = []
  for (const term of terms) {
    if (isComponentDef(term)) {
      out.push(term)
      continue
    }
    if (typeof term === 'object' && term !== null && '__term' in term) {
      if (term.__term === 'optional') continue
      const c = (term as { c: unknown }).c
      if (!isComponentDef(c)) {
        throw new Error(
          '@ecsia/react useQuery: relation Pair(...) terms are not supported in v1 — filter on components, and read relations with useTarget/useTargets',
        )
      }
      out.push(c)
      continue
    }
    // The query-options term ({ matchPrefabs }) gates prefab visibility, not membership — it
    // contributes no observable component and must not fall through to the throw below.
    if (typeof term === 'object' && term !== null && 'matchPrefabs' in term) continue
    throw new Error(
      '@ecsia/react useQuery: unsupported query term — relation Pair(...) terms are deferred to v2; ' +
        'pass component defs or read/write/has/without/optional terms',
    )
  }
  return out
}

function sameMembership(prev: readonly EntityHandle[], next: readonly EntityHandle[]): boolean {
  if (prev.length !== next.length) return false
  let elementwise = true
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) {
      elementwise = false
      break
    }
  }
  if (elementwise) return true
  // Same length, different order (e.g. an unrelated migration shuffled archetype rows): membership
  // is a set — query handles are unique, so a one-direction subset check at equal length suffices.
  const set = new Set<EntityHandle>(prev)
  for (const h of next) {
    if (!set.has(h)) return false
  }
  return true
}

export class ComponentStore {
  readonly #bridge: ReactBridge
  readonly #world: EcsiaWorld
  readonly #def: ComponentDef<Schema>
  readonly watchedHandle: EntityHandle
  readonly watchedIndex: number
  #dirty = true
  #snapshot: Readonly<Record<string, unknown>> | undefined = undefined
  #active = false
  readonly #listeners = new Set<() => void>()

  constructor(bridge: ReactBridge, world: EcsiaWorld, handle: EntityHandle, def: ComponentDef<Schema>) {
    this.#bridge = bridge
    this.#world = world
    this.#def = def
    this.watchedHandle = handle
    this.watchedIndex = world.decodeHandle(handle).index
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (!this.#active) {
      this.#active = true
      // Re-check on the first post-subscribe getSnapshot: the world may have ticked between the
      // render that computed the snapshot and this subscription (no observer covered the gap).
      this.#dirty = true
      this.#bridge.__registerComponentStore(this.#def, this.watchedHandle, this)
      this.#bridge.__activateEntityWatcher(this.#def, this, VALUE_KINDS)
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#active) {
        this.#active = false
        this.#bridge.__deactivateEntityWatcher(this.#def, this, VALUE_KINDS)
        this.#bridge.__evictComponentStore(this.#def, this.watchedHandle, this)
      }
    }
  }

  readonly getSnapshot = (): Readonly<Record<string, unknown>> | undefined => {
    if (this.#dirty) {
      const next = computeSnapshot(this.#world, this.watchedHandle, this.#def)
      if (!snapshotsEqual(this.#snapshot, next)) this.#snapshot = next
      this.#dirty = false
    }
    return this.#snapshot
  }

  // No observer covers server renders, so the cache is never invalidated there: always recompute,
  // keeping the previous object's identity when the values match — a shared ticking server world
  // stays honest without breaking memoization.
  readonly getServerSnapshot = (): Readonly<Record<string, unknown>> | undefined => {
    const next = computeSnapshot(this.#world, this.watchedHandle, this.#def)
    if (!snapshotsEqual(this.#snapshot, next)) this.#snapshot = next
    return this.#snapshot
  }

  onEvent(kind: Kind, eventHandle: EntityHandle): void {
    // add/change events describe the slot's CURRENT occupant; a different handle means a recycled
    // index, and this watcher's entity already got its remove wake-up when it died. Remove events
    // wake by index alone (see module header).
    if (kind !== 'remove' && eventHandle !== this.watchedHandle) return
    if (this.#dirty) return
    this.#dirty = true
    for (const listener of this.#listeners) listener()
  }
}

export class HasStore {
  readonly #bridge: ReactBridge
  readonly #world: EcsiaWorld
  readonly #def: ComponentDef<Schema>
  readonly watchedHandle: EntityHandle
  readonly watchedIndex: number
  #dirty = true
  #value = false
  #active = false
  readonly #listeners = new Set<() => void>()

  constructor(bridge: ReactBridge, world: EcsiaWorld, handle: EntityHandle, def: ComponentDef<Schema>) {
    this.#bridge = bridge
    this.#world = world
    this.#def = def
    this.watchedHandle = handle
    this.watchedIndex = world.decodeHandle(handle).index
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (!this.#active) {
      this.#active = true
      this.#dirty = true
      this.#bridge.__registerHasStore(this.#def, this.watchedHandle, this)
      this.#bridge.__activateEntityWatcher(this.#def, this, PRESENCE_KINDS)
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#active) {
        this.#active = false
        this.#bridge.__deactivateEntityWatcher(this.#def, this, PRESENCE_KINDS)
        this.#bridge.__evictHasStore(this.#def, this.watchedHandle, this)
      }
    }
  }

  readonly getSnapshot = (): boolean => {
    if (this.#dirty) {
      this.#value = this.#world.has(this.watchedHandle, this.#def)
      this.#dirty = false
    }
    return this.#value
  }

  readonly getServerSnapshot = (): boolean => this.#world.has(this.watchedHandle, this.#def)

  onEvent(kind: Kind, eventHandle: EntityHandle): void {
    if (kind !== 'remove' && eventHandle !== this.watchedHandle) return
    if (this.#dirty) return
    this.#dirty = true
    for (const listener of this.#listeners) listener()
  }
}

export class QueryStore {
  readonly #bridge: ReactBridge
  readonly #query: QueryLike
  readonly #comps: readonly ComponentDef<Schema>[]
  #dirty = true
  #handles: readonly EntityHandle[] = EMPTY_HANDLES
  #active = false
  readonly #listeners = new Set<() => void>()

  constructor(bridge: ReactBridge, query: QueryLike) {
    this.#bridge = bridge
    this.#query = query
    this.#comps = membershipComponents(query.terms)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (!this.#active) {
      this.#active = true
      this.#dirty = true
      this.#bridge.__registerQueryStore(this.#query, this)
      this.#bridge.__activateQueryWatcher(this.#comps, this)
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#active) {
        this.#active = false
        this.#bridge.__deactivateQueryWatcher(this.#comps, this)
        this.#bridge.__evictQueryStore(this.#query, this)
      }
    }
  }

  readonly getSnapshot = (): readonly EntityHandle[] => {
    if (this.#dirty) {
      const next: EntityHandle[] = []
      this.#query.each((e) => next.push(e.handle))
      if (!sameMembership(this.#handles, next)) this.#handles = next
      this.#dirty = false
    }
    return this.#handles
  }

  readonly getServerSnapshot = (): readonly EntityHandle[] => {
    const next: EntityHandle[] = []
    this.#query.each((e) => next.push(e.handle))
    if (!sameMembership(this.#handles, next)) this.#handles = next
    return this.#handles
  }

  markDirty(): void {
    if (this.#dirty) return
    this.#dirty = true
    for (const listener of this.#listeners) listener()
  }
}

/**
 * The targets of one relation on one subject — `useTargets` (all) and `useTarget` (first) share it,
 * mirroring ComponentStore's contract: handles in, value snapshots out, re-render only when the
 * pair MEMBERSHIP for this (subject, relation) actually changes (set-compared, identity-stable).
 * Subscribes through the bridge's refcounted relation-level pair observers; recomputes from
 * rel.targetsOf — always-current truth, never decoded from the event.
 */
export class TargetsStore {
  readonly #bridge: ReactBridge
  readonly #rel: RelationsLike
  readonly #relation: RelationLike
  readonly watchedHandle: EntityHandle
  readonly watchedIndex: number
  #dirty = true
  #targets: readonly EntityHandle[] = EMPTY_HANDLES
  #active = false
  readonly #listeners = new Set<() => void>()

  constructor(bridge: ReactBridge, world: EcsiaWorld, rel: RelationsLike, handle: EntityHandle, relation: RelationLike) {
    this.#bridge = bridge
    this.#rel = rel
    this.#relation = relation
    this.watchedHandle = handle
    this.watchedIndex = world.decodeHandle(handle).index
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    if (!this.#active) {
      this.#active = true
      this.#dirty = true
      this.#bridge.__registerTargetsStore(this.#relation, this.watchedHandle, this)
      this.#bridge.__activatePairWatcher(this.#relation, this)
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0 && this.#active) {
        this.#active = false
        this.#bridge.__deactivatePairWatcher(this.#relation, this)
        this.#bridge.__evictTargetsStore(this.#relation, this.watchedHandle, this)
      }
    }
  }

  #compute(): readonly EntityHandle[] {
    const next: EntityHandle[] = []
    for (const t of this.#rel.targetsOf(this.watchedHandle, this.#relation)) next.push(t)
    return next.length === 0 ? EMPTY_HANDLES : next
  }

  readonly getSnapshot = (): readonly EntityHandle[] => {
    if (this.#dirty) {
      const next = this.#compute()
      if (!sameMembership(this.#targets, next)) this.#targets = next
      this.#dirty = false
    }
    return this.#targets
  }

  readonly getServerSnapshot = (): readonly EntityHandle[] => {
    const next = this.#compute()
    if (!sameMembership(this.#targets, next)) this.#targets = next
    return this.#targets
  }

  onPairEvent(kind: PairKind, eventHandle: EntityHandle): void {
    // pair-add describes the slot's CURRENT occupant; a different handle means a recycled index
    // (this watcher's subject already got its pair-remove wake-ups when its pairs tore down).
    // pair-remove wakes by index alone — the dying subject's generation is already bumped.
    if (kind === 'pair-add' && eventHandle !== this.watchedHandle) return
    if (this.#dirty) return
    this.#dirty = true
    for (const listener of this.#listeners) listener()
  }
}

class EffectWatcher implements EntityWatcher {
  readonly #world: EcsiaWorld
  readonly #def: ComponentDef<Schema>
  readonly #handle: EntityHandle
  readonly watchedIndex: number
  readonly #callback: (snapshot: Readonly<Record<string, unknown>> | undefined, ctx: ObserverContext) => void
  #lastWasAbsent: boolean

  constructor(
    world: EcsiaWorld,
    handle: EntityHandle,
    def: ComponentDef<Schema>,
    callback: (snapshot: Readonly<Record<string, unknown>> | undefined, ctx: ObserverContext) => void,
  ) {
    this.#world = world
    this.#def = def
    this.#handle = handle
    this.watchedIndex = world.decodeHandle(handle).index
    this.#callback = callback
    // Seed from current state: a watcher mounted on a handle whose index carries a still-draining
    // remove (a previous occupant's, or its own death) must not fire a callback(undefined) for a
    // value it never saw.
    this.#lastWasAbsent = computeSnapshot(world, handle, def) === undefined
  }

  onEvent(kind: Kind, eventHandle: EntityHandle, ctx: ObserverContext): void {
    if (kind !== 'remove' && eventHandle !== this.#handle) return
    const snapshot = computeSnapshot(this.#world, this.#handle, this.#def)
    if (snapshot === undefined) {
      // A later remove on a recycled slot must not re-notify a watcher that already saw its
      // entity's component go away.
      if (kind === 'remove' && this.#lastWasAbsent) return
      this.#lastWasAbsent = true
    } else {
      this.#lastWasAbsent = false
    }
    this.#callback(snapshot, ctx)
  }
}

export class ReactBridge {
  readonly #world: EcsiaWorld
  readonly #observers = new Map<ComponentDef<Schema>, Map<Kind, ObserverCell>>()
  readonly #entityWatchers = new Map<ComponentDef<Schema>, Map<number, Set<EntityWatcher>>>()
  readonly #queryWatchers = new Map<ComponentDef<Schema>, Set<QueryStore>>()
  readonly #componentStores = new Map<ComponentDef<Schema>, Map<EntityHandle, ComponentStore>>()
  readonly #hasStores = new Map<ComponentDef<Schema>, Map<EntityHandle, HasStore>>()
  readonly #queryStores = new Map<QueryLike, QueryStore>()
  // Relation-level pair plumbing, keyed by relation id (relation defs are runtime-minted objects;
  // the numeric id is the stable identity the observer terms use anyway).
  readonly #pairObservers = new Map<number, Map<PairKind, ObserverCell>>()
  readonly #pairWatchers = new Map<number, Map<number, Set<TargetsStore>>>()
  readonly #targetsStores = new Map<number, Map<EntityHandle, TargetsStore>>()

  constructor(world: EcsiaWorld) {
    this.#world = world
  }

  // Store factories: create-on-render, insert-on-first-subscribe. A render may never commit
  // (aborted transition, renderToString), and a render-phase map insert would leak the entry for
  // the world's lifetime — so the store only enters the map when its subscription activates, and
  // an uncommitted render's store is plain garbage.

  componentStore(handle: EntityHandle, def: ComponentDef<Schema>): ComponentStore {
    return this.#componentStores.get(def)?.get(handle) ?? new ComponentStore(this, this.#world, handle, def)
  }

  hasStore(handle: EntityHandle, def: ComponentDef<Schema>): HasStore {
    return this.#hasStores.get(def)?.get(handle) ?? new HasStore(this, this.#world, handle, def)
  }

  queryStore(query: QueryLike): QueryStore {
    return this.#queryStores.get(query) ?? new QueryStore(this, query)
  }

  targetsStore(rel: RelationsLike, handle: EntityHandle, relation: RelationLike): TargetsStore {
    return (
      this.#targetsStores.get(relation.id)?.get(handle) ?? new TargetsStore(this, this.#world, rel, handle, relation)
    )
  }

  /** Register a useComponentEffect callback; returns its dispose. Not shared — one per hook. */
  addComponentEffect(
    handle: EntityHandle,
    def: ComponentDef<Schema>,
    callback: (snapshot: Readonly<Record<string, unknown>> | undefined, ctx: ObserverContext) => void,
  ): () => void {
    const watcher = new EffectWatcher(this.#world, handle, def, callback)
    this.__activateEntityWatcher(def, watcher, VALUE_KINDS)
    return () => {
      this.__deactivateEntityWatcher(def, watcher, VALUE_KINDS)
    }
  }

  // --- store wiring (package-internal; `__` marks it off the public surface) ---

  // Register methods run at (re)subscribe time. First-wins on a key collision: two renders can
  // race a fresh store for the same key before either commits — the loser still works through its
  // own watcher and converges to the canonical store at its next render. A resubscribe after
  // eviction (strict mode's unsubscribe/resubscribe pair) re-inserts, so later renders keep
  // resolving to the same store and its snapshot identity.

  __registerComponentStore(def: ComponentDef<Schema>, handle: EntityHandle, store: ComponentStore): void {
    let byHandle = this.#componentStores.get(def)
    if (byHandle === undefined) {
      byHandle = new Map()
      this.#componentStores.set(def, byHandle)
    }
    if (!byHandle.has(handle)) byHandle.set(handle, store)
  }

  __registerHasStore(def: ComponentDef<Schema>, handle: EntityHandle, store: HasStore): void {
    let byHandle = this.#hasStores.get(def)
    if (byHandle === undefined) {
      byHandle = new Map()
      this.#hasStores.set(def, byHandle)
    }
    if (!byHandle.has(handle)) byHandle.set(handle, store)
  }

  __registerQueryStore(query: QueryLike, store: QueryStore): void {
    if (!this.#queryStores.has(query)) this.#queryStores.set(query, store)
  }

  __activateEntityWatcher(def: ComponentDef<Schema>, watcher: EntityWatcher, kinds: readonly Kind[]): void {
    for (const kind of kinds) this.#acquire(def, kind)
    let byIndex = this.#entityWatchers.get(def)
    if (byIndex === undefined) {
      byIndex = new Map()
      this.#entityWatchers.set(def, byIndex)
    }
    let set = byIndex.get(watcher.watchedIndex)
    if (set === undefined) {
      set = new Set()
      byIndex.set(watcher.watchedIndex, set)
    }
    set.add(watcher)
  }

  __deactivateEntityWatcher(def: ComponentDef<Schema>, watcher: EntityWatcher, kinds: readonly Kind[]): void {
    const byIndex = this.#entityWatchers.get(def)
    const set = byIndex?.get(watcher.watchedIndex)
    if (byIndex !== undefined && set !== undefined) {
      set.delete(watcher)
      if (set.size === 0) byIndex.delete(watcher.watchedIndex)
      if (byIndex.size === 0) this.#entityWatchers.delete(def)
    }
    for (const kind of kinds) this.#release(def, kind)
  }

  __activateQueryWatcher(comps: readonly ComponentDef<Schema>[], store: QueryStore): void {
    for (const def of comps) {
      this.#acquire(def, 'add')
      this.#acquire(def, 'remove')
      let set = this.#queryWatchers.get(def)
      if (set === undefined) {
        set = new Set()
        this.#queryWatchers.set(def, set)
      }
      set.add(store)
    }
  }

  __deactivateQueryWatcher(comps: readonly ComponentDef<Schema>[], store: QueryStore): void {
    for (const def of comps) {
      const set = this.#queryWatchers.get(def)
      if (set !== undefined) {
        set.delete(store)
        if (set.size === 0) this.#queryWatchers.delete(def)
      }
      this.#release(def, 'add')
      this.#release(def, 'remove')
    }
  }

  __evictComponentStore(def: ComponentDef<Schema>, handle: EntityHandle, store: ComponentStore): void {
    const byHandle = this.#componentStores.get(def)
    if (byHandle?.get(handle) === store) {
      byHandle.delete(handle)
      if (byHandle.size === 0) this.#componentStores.delete(def)
    }
  }

  __evictHasStore(def: ComponentDef<Schema>, handle: EntityHandle, store: HasStore): void {
    const byHandle = this.#hasStores.get(def)
    if (byHandle?.get(handle) === store) {
      byHandle.delete(handle)
      if (byHandle.size === 0) this.#hasStores.delete(def)
    }
  }

  __evictQueryStore(query: QueryLike, store: QueryStore): void {
    if (this.#queryStores.get(query) === store) this.#queryStores.delete(query)
  }

  __registerTargetsStore(relation: RelationLike, handle: EntityHandle, store: TargetsStore): void {
    let byHandle = this.#targetsStores.get(relation.id)
    if (byHandle === undefined) {
      byHandle = new Map()
      this.#targetsStores.set(relation.id, byHandle)
    }
    if (!byHandle.has(handle)) byHandle.set(handle, store)
  }

  __evictTargetsStore(relation: RelationLike, handle: EntityHandle, store: TargetsStore): void {
    const byHandle = this.#targetsStores.get(relation.id)
    if (byHandle?.get(handle) === store) {
      byHandle.delete(handle)
      if (byHandle.size === 0) this.#targetsStores.delete(relation.id)
    }
  }

  __activatePairWatcher(relation: RelationLike, store: TargetsStore): void {
    for (const kind of PAIR_KINDS) this.#acquirePair(relation.id, kind)
    let byIndex = this.#pairWatchers.get(relation.id)
    if (byIndex === undefined) {
      byIndex = new Map()
      this.#pairWatchers.set(relation.id, byIndex)
    }
    let set = byIndex.get(store.watchedIndex)
    if (set === undefined) {
      set = new Set()
      byIndex.set(store.watchedIndex, set)
    }
    set.add(store)
  }

  __deactivatePairWatcher(relation: RelationLike, store: TargetsStore): void {
    const byIndex = this.#pairWatchers.get(relation.id)
    const set = byIndex?.get(store.watchedIndex)
    if (byIndex !== undefined && set !== undefined) {
      set.delete(store)
      if (set.size === 0) byIndex.delete(store.watchedIndex)
      if (byIndex.size === 0) this.#pairWatchers.delete(relation.id)
    }
    for (const kind of PAIR_KINDS) this.#releasePair(relation.id, kind)
  }

  /** Live core-observer count — the dispose-accounting probe the leak tests assert on. */
  __liveObserverCount(): number {
    let n = 0
    for (const kinds of this.#observers.values()) n += kinds.size
    for (const kinds of this.#pairObservers.values()) n += kinds.size
    return n
  }

  /** Live store-map entry count — the render-phase leak probe (uncommitted renders must leave 0). */
  __liveStoreCount(): number {
    let n = this.#queryStores.size
    for (const byHandle of this.#componentStores.values()) n += byHandle.size
    for (const byHandle of this.#hasStores.values()) n += byHandle.size
    for (const byHandle of this.#targetsStores.values()) n += byHandle.size
    return n
  }

  // --- refcounted core observers ---

  #acquire(def: ComponentDef<Schema>, kind: Kind): void {
    let kinds = this.#observers.get(def)
    if (kinds === undefined) {
      kinds = new Map()
      this.#observers.set(def, kinds)
    }
    let cell = kinds.get(kind)
    if (cell === undefined) {
      const term = kind === 'add' ? onAdd(def) : kind === 'remove' ? onRemove(def) : onChange(def)
      cell = {
        refs: 0,
        handle: this.#world.observe(term, (e, ctx) => {
          this.#dispatch(kind, def, e.handle, ctx)
        }),
      }
      kinds.set(kind, cell)
    }
    cell.refs += 1
  }

  #release(def: ComponentDef<Schema>, kind: Kind): void {
    const kinds = this.#observers.get(def)
    const cell = kinds?.get(kind)
    if (kinds === undefined || cell === undefined) return
    cell.refs -= 1
    if (cell.refs > 0) return
    cell.handle.dispose()
    kinds.delete(kind)
    if (kinds.size === 0) this.#observers.delete(def)
  }

  #acquirePair(relationId: number, kind: PairKind): void {
    let kinds = this.#pairObservers.get(relationId)
    if (kinds === undefined) {
      kinds = new Map()
      this.#pairObservers.set(relationId, kinds)
    }
    let cell = kinds.get(kind)
    if (cell === undefined) {
      // The term object is constructed literally — same shape onPairAdded/onPairRemoved produce —
      // so the binding needs no @ecsia/relations import (it has only the numeric relation id).
      const term: PairObserverTerm = { kind, relationId }
      cell = {
        refs: 0,
        handle: this.#world.observe(term, (e) => {
          this.#dispatchPair(kind, relationId, e.handle)
        }),
      }
      kinds.set(kind, cell)
    }
    cell.refs += 1
  }

  #releasePair(relationId: number, kind: PairKind): void {
    const kinds = this.#pairObservers.get(relationId)
    const cell = kinds?.get(kind)
    if (kinds === undefined || cell === undefined) return
    cell.refs -= 1
    if (cell.refs > 0) return
    cell.handle.dispose()
    kinds.delete(kind)
    if (kinds.size === 0) this.#pairObservers.delete(relationId)
  }

  #dispatchPair(kind: PairKind, relationId: number, subjectHandle: EntityHandle): void {
    const index: number = this.#world.decodeHandle(subjectHandle).index
    const watchers = this.#pairWatchers.get(relationId)?.get(index)
    if (watchers !== undefined) {
      for (const store of watchers) store.onPairEvent(kind, subjectHandle)
    }
  }

  #dispatch(kind: Kind, def: ComponentDef<Schema>, eventHandle: EntityHandle, ctx: ObserverContext): void {
    const index: number = this.#world.decodeHandle(eventHandle).index
    const watchers = this.#entityWatchers.get(def)?.get(index)
    if (watchers !== undefined) {
      for (const watcher of watchers) watcher.onEvent(kind, eventHandle, ctx)
    }
    if (kind !== 'change') {
      const stores = this.#queryWatchers.get(def)
      if (stores !== undefined) {
        for (const store of stores) store.markDirty()
      }
    }
  }
}

const bridges = new WeakMap<EcsiaWorld, ReactBridge>()

/** The lazily-created bridge for `world`; a discarded world takes its bridge with it. */
export function bridgeFor(world: EcsiaWorld): ReactBridge {
  let bridge = bridges.get(world)
  if (bridge === undefined) {
    bridge = new ReactBridge(world)
    bridges.set(world, bridge)
  }
  return bridge
}
