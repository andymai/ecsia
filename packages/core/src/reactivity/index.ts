// @ecsia/core reactivity subsystem (reactivity.md). Owns the write log + shape log (the ring-log
// infrastructure driving the Changed query filter with no per-field atomic), the per-row
// changeVersion stamps (the public .changed predicate + delta serializer), and the deferred
// observers. Wired by the world: fills the M2 trackWrite stub, the M3 enqueueRemoveLog stub, and the
// M4 LiveQuery.changed()/eachChanged() stubs.

export { Reactivity } from './reactivity.js'
export type { ReactivityDeps } from './reactivity.js'

export { LogRing, WriteCorral, ShapeKind, OVERFLOW_SENTINEL, nextPow2 } from './log.js'
export type { LogPointer } from './log.js'

export { ChangeVersionStore } from './change-version.js'

export { StructuralJournal } from './structural-journal.js'
export type { StructuralRecord } from './structural-journal.js'

export { ObserverCommandBuffer } from './observer-commands.js'
export type { ObserverCommandApply } from './observer-commands.js'

export { ObserverRegistry, onAdd, onRemove, onChange } from './observers.js'
export type {
  ObserverKind,
  ObserverHandle,
  ObserverTerm,
  ObserverContext,
  ObserverHandler,
  ObserverDeps,
} from './observers.js'
