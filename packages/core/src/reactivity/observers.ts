// Deferred observers. onAdd/onRemove/onChange register a handler in a
// (kind, componentId) dispatch table. They fire ONLY from observerDrain at a serial slot —
// NEVER synchronously from a setter or a migration. The drain walks the shape log (add/remove) and
// the write log (change) once, looking up the bucket per entry (no per-event Array.from/reduce).

import type { ComponentDef, ComponentId, RelationDef, Schema } from '@ecsia/schema'
import type { EntityRef } from '../entity/index.js'

export type ObserverKind = 'add' | 'remove' | 'change'
export type PairObserverKind = 'pair-add' | 'pair-remove'

export interface ObserverHandle {
  readonly id: number
  dispose(): void
}

/** A typed observer subscription term (the component set + the kind), mirroring the query DSL. */
export interface ComponentObserverTerm {
  readonly kind: ObserverKind
  readonly components: readonly ComponentDef<Schema>[]
}

/**
 * A relation-level pair subscription: fires when ANY (subject, relation, target) pair of this
 * relation is added/removed, regardless of target. Produced by @ecsia/relations' onPairAdded /
 * onPairRemoved — core stores only the relation's numeric id (the acyclic boundary: core never
 * sees a RelationDef). Dispatch requires the relations runtime's pair resolver (installed at
 * createRelations); observing a pair term in a world without relations attached never fires.
 */
export interface PairObserverTerm {
  readonly kind: PairObserverKind
  readonly relationId: number
}

export type ObserverTerm = ComponentObserverTerm | PairObserverTerm

export interface ObserverContext {
  readonly kind: ObserverKind | PairObserverKind
  /** For pair events this is the pair's SYNTHETIC component id (an implementation detail —
   * consumers wanting targets call rel.targetsOf(subject, R) for always-current truth). */
  readonly component: ComponentId
  readonly tick: number
}

export type ObserverHandler = (e: EntityRef, ctx: ObserverContext) => void

interface Observer {
  readonly id: number
  readonly term: ObserverTerm
  readonly handler: ObserverHandler
  /** The term's component ids (resolved at registration; [] for pair terms). For multi-component "all present" checks. */
  readonly componentIds: readonly ComponentId[]
  /** Per-frame dedup of change observers (one fire per (index) per frame). */
  readonly dedup: Set<number>
}

export function onAdd(...components: ComponentDef<Schema>[]): ComponentObserverTerm {
  return { kind: 'add', components }
}
export function onRemove(...components: ComponentDef<Schema>[]): ComponentObserverTerm {
  return { kind: 'remove', components }
}
export function onChange(...components: ComponentDef<Schema>[]): ComponentObserverTerm {
  return { kind: 'change', components }
}

/**
 * Fires when ANY pair of `relation` is added on a subject — any target, including an exclusive
 * relation's retarget (which fires onPairRemoved for the old target, then onPairAdded for the new).
 * The handler gets the SUBJECT ref; for the current targets call rel.targetsOf(subject, relation) —
 * always-current truth, no stale-identity trap (the event itself carries only the subject).
 * Deferred like every observer: fires at the drain inside update(), never mid-mutation.
 */
export function onPairAdded(relation: RelationDef<Schema | void>): PairObserverTerm {
  return { kind: 'pair-add', relationId: relation.id as unknown as number }
}

/** Fires when any pair of `relation` is removed on a subject — explicit removePair, an exclusive
 * retarget's implicit removal, or the despawn cascade tearing pairs down. See {@link onPairAdded}. */
export function onPairRemoved(relation: RelationDef<Schema | void>): PairObserverTerm {
  return { kind: 'pair-remove', relationId: relation.id as unknown as number }
}

export interface ObserverDeps {
  /** Resolve a registered def's dense id (throws if not registered with this world). */
  idOf(def: ComponentDef<Schema>): ComponentId
  /** Does `index` currently hold ALL of `componentIds`? (multi-component add satisfaction). */
  holdsAll(index: number, componentIds: readonly ComponentId[]): boolean
  /** The pooled EntityRef an event for `index` dispatches with — bound to the tenant whose lifetime
   * the drain cursor is inside. While a rich pending-clear window covers the index that is the
   * stashed DYING handle (the handler reads the dead tenant's values, not a same-window re-mint's);
   * otherwise the current handle. Change events route here too: the change drain runs AFTER the
   * structural drain, so a pending window still open at that point covers an index that stayed dead
   * through the whole drain — its last-write events belong to the dead tenant. */
  eventRefOf(index: number): EntityRef
  /** The current frame tick. */
  tick(): number
}

export class ObserverRegistry {
  readonly #deps: ObserverDeps
  /** (kind, componentId) → observers. Key is `${kind}:${componentId}`. */
  readonly #table = new Map<string, Observer[]>()
  #seq = 0
  #count = 0
  #changeCount = 0
  #pairCount = 0

  constructor(deps: ObserverDeps) {
    this.#deps = deps
  }

  get hasObservers(): boolean {
    return this.#count > 0
  }

  /** True iff any `change`-kind observer is registered — gates the write-log push fast-out. */
  get hasChangeObservers(): boolean {
    return this.#changeCount > 0
  }

  /** True iff any pair-kind observer is registered — gates the drain's pairId→relationId resolve. */
  get hasPairObservers(): boolean {
    return this.#pairCount > 0
  }

  /** True iff any observer subscribes to `kind` events on `componentId` — gates deferred-row reclaim. */
  hasKindFor(kind: ObserverKind, componentId: number): boolean {
    const bucket = this.#table.get(`${kind}:${componentId}`)
    return bucket !== undefined && bucket.length > 0
  }

  observe(term: ObserverTerm, handler: ObserverHandler): ObserverHandle {
    // Pair terms key by RELATION id (one bucket per relation, any target) — the drain resolves
    // each pair entry's synthetic component id to its relation and dispatches here.
    if ('relationId' in term) {
      const obs: Observer = { id: this.#seq++, term, handler, componentIds: [], dedup: new Set() }
      const key = `${term.kind}:${term.relationId}`
      let bucket = this.#table.get(key)
      if (bucket === undefined) {
        bucket = []
        this.#table.set(key, bucket)
      }
      bucket.push(obs)
      this.#count += 1
      this.#pairCount += 1
      let disposed = false
      return {
        id: obs.id,
        dispose: (): void => {
          if (disposed) return // a double dispose would underflow the counts and silence dispatch
          disposed = true
          const b = this.#table.get(key)
          if (b !== undefined) {
            const i = b.indexOf(obs)
            if (i >= 0) b.splice(i, 1)
          }
          this.#count -= 1
          this.#pairCount -= 1
        },
      }
    }
    const componentIds = term.components.map((d) => this.#deps.idOf(d))
    const obs: Observer = { id: this.#seq++, term, handler, componentIds, dedup: new Set() }
    for (const cid of componentIds) {
      const key = `${term.kind}:${cid as number}`
      let bucket = this.#table.get(key)
      if (bucket === undefined) {
        bucket = []
        this.#table.set(key, bucket)
      }
      bucket.push(obs)
    }
    this.#count += 1
    if (term.kind === 'change') this.#changeCount += 1
    let disposed = false
    return {
      id: obs.id,
      dispose: (): void => {
        if (disposed) return // a double dispose would underflow the counts and silence dispatch
        disposed = true
        for (const cid of componentIds) {
          const key = `${term.kind}:${cid as number}`
          const bucket = this.#table.get(key)
          if (bucket === undefined) continue
          const i = bucket.indexOf(obs)
          if (i >= 0) bucket.splice(i, 1)
        }
        this.#count -= 1
        if (term.kind === 'change') this.#changeCount -= 1
      },
    }
  }

  /** Fire a structural (add/remove) event for one (index, componentId). */
  dispatchStructural(kind: 'add' | 'remove', index: number, componentId: number): void {
    const bucket = this.#table.get(`${kind}:${componentId}`)
    if (bucket === undefined) return
    const tick = this.#deps.tick()
    for (const obs of bucket) {
      // Multi-component terms: fire only if the entity now satisfies the whole term (add) — a remove
      // fires per just-removed component (the entity no longer satisfies, by construction).
      if (kind === 'add' && obs.componentIds.length > 1 && !this.#deps.holdsAll(index, obs.componentIds)) {
        continue
      }
      const ref = this.#deps.eventRefOf(index)
      obs.handler(ref, { kind, component: componentId as ComponentId, tick })
    }
  }

  /**
   * Fire a relation-level pair event for one (subjectIndex, relationId). `pairComponentId` is the
   * synthetic pair id the shape entry carried — exposed on ctx for symmetry, an implementation
   * detail otherwise (target resolution belongs to rel.targetsOf, always-current truth).
   */
  dispatchPair(kind: PairObserverKind, index: number, relationId: number, pairComponentId: number): void {
    const bucket = this.#table.get(`${kind}:${relationId}`)
    if (bucket === undefined) return
    const tick = this.#deps.tick()
    for (const obs of bucket) {
      const ref = this.#deps.eventRefOf(index)
      obs.handler(ref, { kind, component: pairComponentId as ComponentId, tick })
    }
  }

  /** Fire a change event for one (index, componentId), deduped per frame. */
  dispatchChange(index: number, componentId: number): void {
    const bucket = this.#table.get(`change:${componentId}`)
    if (bucket === undefined) return
    const tick = this.#deps.tick()
    for (const obs of bucket) {
      if (obs.dedup.has(index)) continue
      obs.dedup.add(index)
      const ref = this.#deps.eventRefOf(index)
      obs.handler(ref, { kind: 'change', component: componentId as ComponentId, tick })
    }
  }

  /**: an overflow forces every change observer to assume worst-case. */
  fireAllChangeConservatively(current: Iterable<number>): void {
    const tick = this.#deps.tick()
    for (const [key, bucket] of this.#table) {
      if (!key.startsWith('change:')) continue
      const componentId = Number(key.slice('change:'.length))
      for (const index of current) {
        for (const obs of bucket) {
          if (obs.dedup.has(index)) continue
          obs.dedup.add(index)
          const ref = this.#deps.eventRefOf(index)
          obs.handler(ref, { kind: 'change', component: componentId as ComponentId, tick })
        }
      }
    }
  }

  /** Clear per-frame change dedup state (called at the start of each observer drain). */
  resetChangeDedup(): void {
    for (const bucket of this.#table.values()) {
      for (const obs of bucket) {
        if (obs.term.kind === 'change') obs.dedup.clear()
      }
    }
  }
}
