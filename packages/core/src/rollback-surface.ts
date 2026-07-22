// The internal seam @ecsia/rollback drives, handed out by `World.__installRollback()`. Keeps the
// dependency direction acyclic AND the lean bundle lean: the host is handed OUT (like
// `__installRelations`), so core holds no static reference to the rollback mechanism and a consumer
// that never imports @ecsia/rollback ships none of it.
//
// WHY a NEW seam (not `__serialize`): the two have OPPOSITE handle semantics. A network snapshot
// re-mints entities on the receiver and returns a remap table — every handle changes. A rollback
// restore is the exact inverse: it rewrites the LIVE world IN PLACE so every entity keeps its
// ORIGINAL handle (index AND generation), every stored `eid` still resolves, and archetype-driven
// query iteration stays valid without a remap. That is why this seam reaches entity IDENTITY
// (sparse/dense/generation, the two record words, the allocator cursors) and the component-id
// high-water mark — state a snapshot never ships, because a receiver re-mints both. What an image
// captures, what it deliberately omits, and the remaining guards live with the mechanism in
// @ecsia/rollback.
//
// Everything here is serial / main-thread; @ecsia/rollback asserts `world.phase === 'serial'`.

import type { Bitmask } from './bitmask/index.js'
import type { EntityStore } from './entity/index.js'
import type { ChangeVersionStore } from './reactivity/index.js'
import type { ArchetypeStore } from './storage/index.js'

/**
 * The relation topology an image must carry, captured/restored by @ecsia/relations itself. Core
 * never learns its shape: `capture()` returns an opaque blob the image stores and hands back.
 *
 * WHY relations need their own leg: pair membership rides ordinary archetype signatures (already in
 * the image), but the JS maps that MINT those signature bits — and the monotonic synthetic-id
 * counter behind them — do not. Rewinding the world without them re-mints different pair ids for the
 * same logical pairs, so a re-simulation diverges by archetype signature rather than by value.
 * Installed via `RelationsHost.setRollbackProvider`; absent in a relation-free world.
 */
export interface RelationsRollbackProvider {
  /** A structural clone of the live relation topology. Must not alias state a later mutation reaches. */
  capture(): unknown
  /** REPLACE (never merge) the live topology with a blob `capture()` produced for this world. */
  restore(state: unknown): void
}

/** The core-private state a rollback image must reach. Not user API. */
export interface RollbackHost {
  /** Entity identity + records: captureIdentity / restoreIdentity and the allocator cursors. */
  readonly entities: EntityStore
  /** Membership words + the out-of-stride sparse overflow (no rebuild-from-archetypes path exists). */
  readonly bitmask: Bitmask
  /**
   * The FULL archetype census (`byId`) + the occupancy setter a restore commits through. An image
   * covers `[0, count + held)` of every row list / column: the deferred-dead HELD rows carry the
   * values onRemove handlers read at the drain, so restoring the occupancy words without them would
   * hand observers post-checkpoint bytes.
   */
  readonly archetypes: ArchetypeStore
  /** Late-bound: reactivity is wired after storage, and the stamp column is allocated lazily. */
  changeVersion(): ChangeVersionStore
  /**
   * The component-id high-water mark. Reading it is free; ASSIGNING it is restore-only — it rewinds
   * the synthetic (pair/presence/overflow) minting counter so a re-simulation reproduces the same
   * pair ids, and therefore the same archetype signatures.
   */
  readonly registry: { nextComponentId: number; readonly registeredDefCount: number }
  /** The installed relations capture/restore leg, or undefined in a relation-free world. */
  relations(): RelationsRollbackProvider | undefined
  /** RESTORE-ONLY tick assignment (`world.tick` is otherwise increment-only via advanceTick). */
  setTick(tick: number): void
  /** Rebuild live-query membership from the restored archetype tables. */
  resyncQueries(): void
}
