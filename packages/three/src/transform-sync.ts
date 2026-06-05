// Transform sync system (P4 deliverable 2): copy ECS transform columns → bound Object3D each frame.
// This is the per-frame hot bridge, so it iterates with the SoA fast path (`eachChunk`): one reused
// chunk per matched archetype, raw typed column views, no per-row accessor decode. The system declares
// ALL transform components as READ access (it never writes the ECS, only the THREE objects), so the
// scheduler can run it concurrently with anything that doesn't write the transform columns.
//
// Object3D writes: position.set / quaternion.set / scale.set, then matrixWorldNeedsUpdate is implicit
// the next time three reads the matrix (we leave matrixAutoUpdate to three; the renderer/driver flushes
// world matrices). Rotation is a quaternion (cheap direct write, no euler conversion). Scale defaults to
// (1,1,1) for every frame — only overwritten when a scale term is configured.

import type { ComponentDef, EntityHandle, QueryChunk, QueryTerm, Schema } from '@ecsia/core'
import { read } from '@ecsia/core'
import type { ThreeBindings } from './bindings.js'
import type { PositionDef, RotationDef, ScaleDef, SystemDefLike } from './schema.js'

export interface TransformSyncOptions {
  /** Position component (`{ x, y, z }` f32). Required — translation is the minimum the renderer needs. */
  readonly position: PositionDef
  /** Optional rotation quaternion (`{ x, y, z, w }` f32). Omit for objects that never rotate. */
  readonly rotation?: RotationDef
  /** Optional scale (`{ x, y, z }` f32). Omit to leave each object's scale untouched. */
  readonly scale?: ScaleDef
  /** The registry mapping entity handles → Object3D. */
  readonly bindings: ThreeBindings
  /** System name (default 'three:transformSync'). */
  readonly name?: string
}

export function makeTransformSyncSystem(opts: TransformSyncOptions): SystemDefLike {
  const { position, rotation, scale, bindings } = opts
  const name = opts.name ?? 'three:transformSync'

  // READ-ONLY access declarations: the system reads transform columns and writes THREE objects, never
  // the ECS — so every term is a read. This lets the scheduler parallelize it freely.
  const readDefs: ComponentDef<Schema>[] = [position as unknown as ComponentDef<Schema>]
  if (rotation !== undefined) readDefs.push(rotation as unknown as ComponentDef<Schema>)
  if (scale !== undefined) readDefs.push(scale as unknown as ComponentDef<Schema>)

  return {
    name,
    read: readDefs,
    write: [],
    run({ query }) {
      // Query EVERY configured transform component so each matched archetype carries all columns the
      // loop reads — querying only `position` would match archetypes lacking rotation/scale and the
      // `chunk.column(rotation, …)` lookup would throw.
      const terms: QueryTerm[] = [read(position)]
      if (rotation !== undefined) terms.push(read(rotation))
      if (scale !== undefined) terms.push(read(scale))
      const q = query(...terms)
      q.eachChunk((chunk: QueryChunk) => {
        const entities = chunk.entities
        const count = chunk.count

        const px = chunk.column(position, 'x')
        const py = chunk.column(position, 'y')
        const pz = chunk.column(position, 'z')

        const hasRot = rotation !== undefined
        const rx = hasRot ? chunk.column(rotation, 'x') : undefined
        const ry = hasRot ? chunk.column(rotation, 'y') : undefined
        const rz = hasRot ? chunk.column(rotation, 'z') : undefined
        const rw = hasRot ? chunk.column(rotation, 'w') : undefined

        const hasScale = scale !== undefined
        const sx = hasScale ? chunk.column(scale, 'x') : undefined
        const sy = hasScale ? chunk.column(scale, 'y') : undefined
        const sz = hasScale ? chunk.column(scale, 'z') : undefined

        for (let row = 0; row < count; row++) {
          const handle = entities[row] as unknown as EntityHandle
          const obj = bindings.objectOf(handle)
          if (obj === undefined) continue
          obj.position.set(px[row] as number, py[row] as number, pz[row] as number)
          if (hasRot) {
            obj.quaternion.set(
              (rx as ArrayLike<number>)[row] as number,
              (ry as ArrayLike<number>)[row] as number,
              (rz as ArrayLike<number>)[row] as number,
              (rw as ArrayLike<number>)[row] as number,
            )
          }
          if (hasScale) {
            obj.scale.set(
              (sx as ArrayLike<number>)[row] as number,
              (sy as ArrayLike<number>)[row] as number,
              (sz as ArrayLike<number>)[row] as number,
            )
          }
        }
      })
    },
  }
}
