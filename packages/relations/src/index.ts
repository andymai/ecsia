// @ecsia/relations — first-class integer-encoded pairs. Implemented at.
// Attaches to a world via createRelations(world), which drives the core RelationsHost seam (synthetic
// id minting, migrate-many, preDespawn cascade, the Pair(...) query resolver, and the OP_ADD_PAIR
// apply path). @ecsia/core never imports this package — the dependency direction stays acyclic.

// PUBLIC surface: the world-attach entry point + the wildcard sentinel + the two
// public accessor/storage types the umbrella re-exports. The integer pair-key encoders (pairKey64 /
// overflowKey64) are an internal encoding detail consumed only by ./runtime.js — they are NOT part of
// the published surface and are reached relatively.
export { createRelations, Wildcard } from './runtime.js'
// Relation-level observer terms — defined in core (the drain dispatches them), re-exported here
// because they are part of the relations story: observe pair membership per relation, any target.
export { onPairAdded, onPairRemoved } from '@ecsia/core'
export type { DefinePrefabOptions, PairAccessor, StorageKind } from './runtime.js'
