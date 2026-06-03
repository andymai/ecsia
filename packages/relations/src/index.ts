// @ecsia/relations — first-class integer-encoded pairs (relations.md). Implemented at M8.
// Attaches to a world via createRelations(world), which drives the core RelationsHost seam (synthetic
// id minting, migrate-many, preDespawn cascade, the Pair(...) query resolver, and the OP_ADD_PAIR
// apply path). @ecsia/core never imports this package — the dependency direction stays acyclic.

export { createRelations, Wildcard } from './runtime.js'
export type { PairAccessor, StorageKind } from './runtime.js'
export { pairKey64, overflowKey64 } from './pair-key.js'

export const RELATIONS_PACKAGE = 'relations' as const
