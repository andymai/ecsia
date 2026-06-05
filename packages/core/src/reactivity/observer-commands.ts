// Deferred observer command buffer. An observer handler MAY call
// world.spawn()/despawn()/add()/remove()/addPair()/removePair() during observerDrain. Because the
// drain runs at a serial slot — iterating a FROZEN log snapshot — those structural ops must NOT be
// direct-applied mid-drain (a synchronous despawn shuffle-pops a row a later observer in the same
// drain still needs to read, and a synchronous spawn would extend the wave the drain is replaying).
//
// Instead they are STAGED here and applied at the NEXT serial flush (the start of the next drain).
// This is the main-thread analogue of the worker command buffer: the observer sees a quiescent world,
// stages intent, and the intent lands deterministically one flush later. Consequence: an
// entity spawned inside an onChange handler is observed by onAdd observers NEXT frame, never
// re-entrantly this frame.

import type { ComponentDef, EntityHandle, RelationDef, RelationId, Schema } from '@ecsia/schema'

type DeferredOp =
  | {
      readonly kind: 'spawnWith'
      readonly handle: EntityHandle
      readonly defs: readonly ComponentDef<Schema>[]
      /** Value-carrying spawn (Item 8): `[def, values]` initializers applied after placement. */
      readonly values: readonly (readonly [ComponentDef<Schema>, Record<string, unknown>])[]
    }
  | { readonly kind: 'add'; readonly handle: EntityHandle; readonly def: ComponentDef<Schema> }
  | { readonly kind: 'remove'; readonly handle: EntityHandle; readonly def: ComponentDef<Schema> }
  | { readonly kind: 'despawn'; readonly handle: EntityHandle }
  | {
      readonly kind: 'addPair'
      readonly subject: EntityHandle
      readonly relation: RelationDef<Schema | void>
      readonly relationId: RelationId
      readonly target: EntityHandle
      readonly payload: Record<string, unknown> | undefined
    }
  | {
      readonly kind: 'removePair'
      readonly subject: EntityHandle
      readonly relation: RelationDef<Schema | void>
      readonly relationId: RelationId
      readonly target: EntityHandle
    }

/** The world verbs the deferred buffer replays at flush time (all serial / main-thread). */
export interface ObserverCommandApply {
  /** Place an already-minted (alive) handle into its target signature. The handle was reserved when
   * the observer called spawn (so the observer could configure it); placement is deferred to flush. */
  placeReserved(handle: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  add(handle: EntityHandle, def: ComponentDef<Schema>): void
  remove(handle: EntityHandle, def: ComponentDef<Schema>): void
  despawn(handle: EntityHandle): void
  isAlive(handle: EntityHandle): boolean
  /** Write initializer values through the tracked accessor path (value-carrying spawnWith, Item 8). */
  writePayload(handle: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  /** Relation apply seams (undefined in a relation-free world). */
  addPair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined): void
  removePair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
}

export class ObserverCommandBuffer {
  #pending: DeferredOp[] = []
  /** Set while observerDrain is executing — structural verbs route here instead of direct-applying. */
  #deferring = false
  /** Re-entrancy guard: observerDrain must never re-enter itself (a flush could trigger a drain). */
  #draining = false

  get deferring(): boolean {
    return this.#deferring
  }

  get isDraining(): boolean {
    return this.#draining
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  beginDeferring(): void {
    this.#deferring = true
  }

  endDeferring(): void {
    this.#deferring = false
  }

  enterDrain(): boolean {
    if (this.#draining) return false
    this.#draining = true
    return true
  }

  exitDrain(): void {
    this.#draining = false
  }

  stageSpawnWith(
    handle: EntityHandle,
    defs: readonly ComponentDef<Schema>[],
    values: readonly (readonly [ComponentDef<Schema>, Record<string, unknown>])[] = [],
  ): void {
    this.#pending.push({ kind: 'spawnWith', handle, defs: defs.slice(), values: values.slice() })
  }
  stageAdd(handle: EntityHandle, def: ComponentDef<Schema>): void {
    this.#pending.push({ kind: 'add', handle, def })
  }
  stageRemove(handle: EntityHandle, def: ComponentDef<Schema>): void {
    this.#pending.push({ kind: 'remove', handle, def })
  }
  stageDespawn(handle: EntityHandle): void {
    this.#pending.push({ kind: 'despawn', handle })
  }
  stageAddPair(
    subject: EntityHandle,
    relation: RelationDef<Schema | void>,
    relationId: RelationId,
    target: EntityHandle,
    payload: Record<string, unknown> | undefined,
  ): void {
    this.#pending.push({ kind: 'addPair', subject, relation, relationId, target, payload })
  }
  stageRemovePair(
    subject: EntityHandle,
    relation: RelationDef<Schema | void>,
    relationId: RelationId,
    target: EntityHandle,
  ): void {
    this.#pending.push({ kind: 'removePair', subject, relation, relationId, target })
  }

  /**
   * Apply every staged op in FIFO order (deterministic — staging order is the observers' fire order,
   * which is itself deterministic merge order). Drop-if-dead is honored: a staged op whose subject is
   * no longer alive at flush time is skipped (the entity was despawned by an earlier staged op or the
   * intervening frame). Called at the start of the next drain — i.e. the next serial flush.
   */
  flush(apply: ObserverCommandApply): void {
    if (this.#pending.length === 0) return
    // Snapshot + clear FIRST so a re-entrant stage during apply (defensive) lands in the next batch,
    // never extends this loop.
    const ops = this.#pending
    this.#pending = []
    for (const op of ops) {
      switch (op.kind) {
        case 'spawnWith': {
          // The handle was reserved-alive when the observer called spawn; place it now, then write any
          // value-carrying initializers through the tracked path (Item 8).
          if (apply.isAlive(op.handle)) {
            apply.placeReserved(op.handle, op.defs)
            for (const [def, values] of op.values) apply.writePayload(op.handle, def, values)
          }
          break
        }
        case 'add':
          if (apply.isAlive(op.handle)) apply.add(op.handle, op.def)
          break
        case 'remove':
          if (apply.isAlive(op.handle)) apply.remove(op.handle, op.def)
          break
        case 'despawn':
          if (apply.isAlive(op.handle)) apply.despawn(op.handle)
          break
        case 'addPair':
          if (apply.addPair !== undefined && apply.isAlive(op.subject) && apply.isAlive(op.target)) {
            apply.addPair(op.subject, op.relationId, op.target, op.payload)
          }
          break
        case 'removePair':
          if (apply.removePair !== undefined && apply.isAlive(op.subject)) {
            apply.removePair(op.subject, op.relationId, op.target)
          }
          break
      }
    }
  }
}
