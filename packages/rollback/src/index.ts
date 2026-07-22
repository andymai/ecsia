// @ecsia/rollback — handle-stable whole-world capture/restore: the checkpoint substrate a rollback
// netcode / prediction loop re-simulates from. An OPT-IN package that attaches to @ecsia/core
// through the `__installRollback` seam; core never imports it, so a world that never rolls back
// bundles none of this.
//
// The opposite of @ecsia/serialization: a snapshot re-mints entities on the receiver and hands back
// a remap table, while a restore rewrites the live world IN PLACE — every entity keeps its ORIGINAL
// handle, every stored `eid` still resolves, and query iteration stays valid without a remap.

export { createRollbackSurface } from './rollback.js'
export type { RollbackSurface, RollbackImage } from './rollback.js'
export { createRollbackSession } from './session.js'
export type {
  Frame,
  FrameInputs,
  InputImage,
  PlayerId,
  PredictionPolicy,
  RollbackOptions,
  RollbackSession,
  UnrecoverableRollback,
} from './session.js'
