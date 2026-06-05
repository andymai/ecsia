// Transform schema conventions ( deliverables 2 & 3). The bridge is structural, not nominal: it
// reads named fields off whatever component you pass, so you can reuse your own Position/Velocity defs.
// The conventions below are what the sync systems EXPECT — define your components with these field
// names (all f32) and everything lines up with no adapter.
//
// position { x, y, z } world translation
// rotation { x, y, z, w } a quaternion (NOT euler — Object3D.quaternion is the cheap write)
// scale { x, y, z } per-axis scale; defaults to 1 when the scale term is omitted
//
// These are the canonical defs most apps will just import. They are plain `define*` descriptors with no
// world attached, so they can live at module scope and be shared across worlds.

import type { ComponentDef, EntityHandle, EntityIndex, Schema, WorldQuery } from '@ecsia/schema'
import type { ObserverHandle, ObserverTerm } from '@ecsia/core'
import { defineComponent } from '@ecsia/core'

/**
 * The narrow slice of the world surface the bridge actually uses, declared structurally so BOTH the
 * `@ecsia/core` `World` AND the `ecsia` umbrella's public `World` facade (which omits the
 * internal `__` wiring seams) satisfy it. Importing core's full `World` here would reject the umbrella
 * facade users actually pass, so we accept this minimal shape instead — the bridge never touches a seam.
 */
export interface WorldLike {
  query: WorldQuery
  isAlive(handle: EntityHandle): boolean
  // The bridge only reads `.index`; widen the return so both world impls (which also carry `generation`)
  // remain assignable to WorldLike.
  decodeHandle(handle: EntityHandle): { index: EntityIndex }
  observe(term: ObserverTerm, handler: (e: { readonly handle: EntityHandle }, ctx: unknown) => void): ObserverHandle
}

export type PositionDef = ComponentDef<{ x: 'f32'; y: 'f32'; z: 'f32' }>
export type RotationDef = ComponentDef<{ x: 'f32'; y: 'f32'; z: 'f32'; w: 'f32' }>
export type ScaleDef = ComponentDef<{ x: 'f32'; y: 'f32'; z: 'f32' }>

/** Canonical position component (`{ x, y, z }` f32). Define your own with the same fields to opt out. */
export const Position: PositionDef = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'position' })

/** Canonical rotation quaternion (`{ x, y, z, w }` f32, identity = (0,0,0,1)). */
export const Rotation: RotationDef = defineComponent(
  { x: 'f32', y: 'f32', z: 'f32', w: 'f32' },
  { name: 'rotation' },
)

/** Canonical scale component (`{ x, y, z }` f32, default 1 per axis). */
export const Scale: ScaleDef = defineComponent({ x: 'f32', y: 'f32', z: 'f32' }, { name: 'scale' })

/**
 * A `defineSystem`-compatible system descriptor. Declared structurally over @ecsia/core's public
 * `World` + `ComponentDef` rather than importing @ecsia/scheduler, so this bridge package keeps its
 * narrow dependency footprint (core + schema) and is never on the scheduler's import graph. The shape
 * is byte-compatible with `@ecsia/scheduler`'s `SystemDef` — pass the returned object straight into
 * `createScheduler(world, [...])`.
 */
export interface SystemDefLike {
  readonly name: string
  readonly read?: readonly ComponentDef<Schema>[]
  readonly write?: readonly ComponentDef<Schema>[]
  readonly run: (ctx: SystemContextLike) => void
}

/** The slice of the scheduler's `SystemContext` the sync systems use (the world's own `query`). */
export interface SystemContextLike {
  readonly world: WorldLike
  readonly dt: number
  readonly query: WorldQuery
}
