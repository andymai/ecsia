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
// (sparse/dense/generation, the two record words, the allocator cursors) — state a snapshot never
// ships. What an image captures, what it deliberately omits, and the v1 guards live with the
// mechanism in @ecsia/rollback.
//
// Everything here is serial / main-thread; @ecsia/rollback asserts `world.phase === 'serial'`.

import type { Bitmask } from './bitmask/index.js'
import type { EntityStore } from './entity/index.js'
import type { ChangeVersionStore } from './reactivity/index.js'
import type { ArchetypeStore } from './storage/index.js'

/** The core-private state a rollback image must reach. Not user API. */
export interface RollbackHost {
  /** Entity identity + records: captureIdentity / restoreIdentity and the allocator cursors. */
  readonly entities: EntityStore
  /** Membership words + the out-of-stride sparse overflow (no rebuild-from-archetypes path exists). */
  readonly bitmask: Bitmask
  /** The FULL archetype census (`byId`) + the occupancy setter a restore commits through. */
  readonly archetypes: ArchetypeStore
  /** Late-bound: reactivity is wired after storage, and the stamp column is allocated lazily. */
  changeVersion(): ChangeVersionStore
  /** RESTORE-ONLY tick assignment (`world.tick` is otherwise increment-only via advanceTick). */
  setTick(tick: number): void
  /** Rebuild live-query membership from the restored archetype tables. */
  resyncQueries(): void
}
