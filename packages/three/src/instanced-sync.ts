// Instanced sync system ( deliverable 3): write a THREE.InstancedMesh's instanceMatrix from the ECS
// transform columns. One draw call for the whole matched set. Like the transform sync this is a hot
// per-frame bridge, so it iterates with the SoA fast path (`eachChunk`) and declares READ-ONLY access.
//
// SLOT STABILITY (documented contract): instance slots are assigned by ITERATION ORDER, not by entity
// identity. Slot `i` holds the i-th matched entity in archetype-walk order. When an entity despawns the
// archetype swap-compacts (the last row fills the hole), so the entity that WAS in the last slot moves
// to the despawned entity's slot — i.e. slots are NOT stable across despawns. This is fine for a pure
// visual instanced mesh (every slot is rewritten every frame from live columns, so no stale transform
// survives) but means you must NOT cache "entity X is instance i" across frames. If you need a stable
// entity→slot mapping, store the slot in a component and write it yourself. The swap-compaction
// behaviour is the archetype storage's, and the test asserts it.
//
// COUNT: the mesh's `count` is set to the number of matched entities each frame (capped at the mesh's
// allocated `instanceMatrix` capacity). Entities beyond capacity are dropped (documented; size the mesh
// for your peak). instanceMatrix.needsUpdate is set so three re-uploads the buffer.

import type { ComponentDef, QueryChunk, QueryTerm, Schema } from '@ecsia/core'
import { read } from '@ecsia/core'
import { Matrix4, Quaternion, Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import type { PositionDef, RotationDef, ScaleDef, SystemDefLike } from './schema.js'

export interface InstancedSyncOptions {
  /** The instanced mesh whose `instanceMatrix` is written. Its capacity caps the synced entity count. */
  readonly mesh: InstancedMesh
  /** Position component (`{ x, y, z }` f32). */
  readonly position: PositionDef
  /** Optional rotation quaternion (`{ x, y, z, w }` f32; identity when omitted). */
  readonly rotation?: RotationDef
  /** Optional scale (`{ x, y, z }` f32; (1,1,1) when omitted). */
  readonly scale?: ScaleDef
  /** Extra query terms to narrow the matched set (e.g. `has(Renderable)`, `without(Hidden)`). */
  readonly where?: readonly QueryTerm[]
  /** System name (default 'three:instancedSync'). */
  readonly name?: string
}

export function makeInstancedSyncSystem(opts: InstancedSyncOptions): SystemDefLike {
  const { mesh, position, rotation, scale } = opts
  const name = opts.name ?? 'three:instancedSync'
  const where = opts.where ?? []

  const readDefs: ComponentDef<Schema>[] = [position as unknown as ComponentDef<Schema>]
  if (rotation !== undefined) readDefs.push(rotation as unknown as ComponentDef<Schema>)
  if (scale !== undefined) readDefs.push(scale as unknown as ComponentDef<Schema>)
  // `where` terms participate in matching, so their components belong in the declared read set —
  // the scheduler's conflict detection sees what the query actually touches.
  for (const t of where) {
    const def = (t as { def?: ComponentDef<Schema> }).def
    if (def && !readDefs.includes(def)) readDefs.push(def)
  }

  const m = new Matrix4()
  const p = new Vector3()
  const qt = new Quaternion()
  const s = new Vector3(1, 1, 1)

  return {
    name,
    read: readDefs,
    write: [],
    run({ query }) {
      const terms: QueryTerm[] = [read(position)]
      if (rotation !== undefined) terms.push(read(rotation))
      if (scale !== undefined) terms.push(read(scale))
      for (const t of where) terms.push(t)
      const q = query(...terms)

      const capacity = mesh.instanceMatrix.count
      let slot = 0

      q.eachChunk((chunk: QueryChunk) => {
        if (slot >= capacity) return
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

        for (let row = 0; row < count && slot < capacity; row++, slot++) {
          p.set(px[row] as number, py[row] as number, pz[row] as number)
          if (hasRot) {
            qt.set(
              (rx as ArrayLike<number>)[row] as number,
              (ry as ArrayLike<number>)[row] as number,
              (rz as ArrayLike<number>)[row] as number,
              (rw as ArrayLike<number>)[row] as number,
            )
          } else {
            qt.identity()
          }
          if (hasScale) {
            s.set(
              (sx as ArrayLike<number>)[row] as number,
              (sy as ArrayLike<number>)[row] as number,
              (sz as ArrayLike<number>)[row] as number,
            )
          } else {
            s.set(1, 1, 1)
          }
          m.compose(p, qt, s)
          mesh.setMatrixAt(slot, m)
        }
      })

      mesh.count = slot
      mesh.instanceMatrix.needsUpdate = true
    },
  }
}
