// @ecsia/three — the THREE.js bridge. An OPT-IN package: it is deliberately NOT re-exported from
// the ecsia umbrella. The umbrella is the renderer-agnostic core cohort; pulling `three` (a large
// peer dependency with WebGL/DOM assumptions) into everyone's bundle would be wrong. A game that wants
// the bridge installs `three` + `@ecsia/three` explicitly. This package depends ONLY on @ecsia/core +
// @ecsia/schema (and `three` as a PEER dep) and is NEVER imported by them — the dependency arrow points
// one way (core ← three), keeping the kernel free of any renderer coupling.
//
// What it provides, all over the PUBLIC @ecsia/core surface (world.query/observe/entity, the query DSL,
// onRemove, the eachChunk SoA fast path):
// • createThreeBindings — EntityHandle → THREE.Object3D registry; OPT-IN auto-unbind via autoUnbindOn(anchor) + sweep()
// • makeTransformSyncSystem — copy transform columns → bound Object3D each frame (read-only system)
// • makeInstancedSyncSystem — write a THREE.InstancedMesh's instanceMatrix from columns
// • createThreeDriver — rAF loop (browser) / manual .tick(dt) (Node), with a fixed-timestep option

export { createThreeBindings } from './bindings.js'
export type { ThreeBindings } from './bindings.js'

export { Position, Rotation, Scale } from './schema.js'
export type { PositionDef, RotationDef, ScaleDef, SystemDefLike, SystemContextLike } from './schema.js'

export { makeTransformSyncSystem } from './transform-sync.js'
export type { TransformSyncOptions } from './transform-sync.js'

export { makeInstancedSyncSystem } from './instanced-sync.js'
export type { InstancedSyncOptions } from './instanced-sync.js'

export { createThreeDriver } from './driver.js'
export type { ThreeDriver, ThreeDriverOptions } from './driver.js'
