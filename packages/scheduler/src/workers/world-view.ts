// The worker-side (and main-thread-mirror) zero-copy view over the shared buffer set (serialization.md
// §3.3 attachWorld). It re-wraps every column + region SAB by reference (LENGTH-TRACKING views,
// memory-buffers.md V-1) so a worker reads/writes Position.x as a direct indexed load on the SAME
// Float32Array the main thread uses — no value copy. Workers read ARCHETYPE TABLES ONLY here: an
// entity's (archetypeId, row) comes from the shared entity-record regions, never the bitmask
// (Must-Fix #1).

import { elementCtor } from '@ecsia/core'
import type { ColumnKey, ElementKind, RegionKey, SharedHandleManifest, TypedArray } from '@ecsia/core'
import type { CommandEncoder } from '../commands/index.js'

const REC_ARCH_ID = 'entity.archetypeId' as RegionKey
const REC_ARCH_ROW = 'entity.archetypeRow' as RegionKey

interface ColumnView {
  readonly view: TypedArray
  readonly stride: number
}

/** Re-wrap a manifest column/region SAB as a length-tracking view of its element kind. */
function wrap(backing: SharedArrayBuffer | ArrayBuffer, element: ElementKind): TypedArray {
  const Ctor = elementCtor(element)
  return new Ctor(backing)
}

export interface WorkerWorldView {
  /** (archetypeId, row) of an entity index, from the shared record regions. */
  locationOf(index: number): { archetypeId: number; row: number }
  /** Read field `fieldIndex` of component `componentId` for entity index `index`. */
  readField(index: number, componentId: number, fieldIndex: number): number
  /** Write field `fieldIndex` of component `componentId` for entity index `index` (disjoint SAB write). */
  writeField(index: number, componentId: number, fieldIndex: number, value: number): void
  /** The structural-op encoder for this worker (defers create/destroy/add/remove to the command buffer). */
  readonly commands: CommandEncoder
}

export function buildWorkerWorldView(
  manifest: SharedHandleManifest,
  indexBitsMask: number,
  commands: CommandEncoder,
): WorkerWorldView {
  // archetypeId:componentId.fieldIndex → column view.
  const columns = new Map<string, ColumnView>()
  for (const col of manifest.columns) {
    columns.set(col.key as unknown as string, { view: wrap(col.backing, col.layout.element), stride: col.layout.stride })
  }
  const regions = new Map<string, TypedArray>()
  for (const reg of manifest.regions) {
    regions.set(reg.key as unknown as string, wrap(reg.backing, reg.element))
  }
  const archIdRegion = regions.get(REC_ARCH_ID as unknown as string)
  const archRowRegion = regions.get(REC_ARCH_ROW as unknown as string)
  if (archIdRegion === undefined || archRowRegion === undefined) {
    throw new Error('worker view: entity-record regions missing from manifest (not SAB-backed?)')
  }

  function colKey(archetypeId: number, componentId: number, fieldIndex: number): string {
    return `${archetypeId}:${componentId}.${fieldIndex}`
  }

  return {
    locationOf(index) {
      return { archetypeId: archIdRegion[index]! >>> 0, row: archRowRegion[index]! >>> 0 }
    },
    readField(index, componentId, fieldIndex) {
      const { archetypeId, row } = this.locationOf(index)
      const col = columns.get(colKey(archetypeId, componentId, fieldIndex))
      if (col === undefined) return 0
      return col.view[row * col.stride] as number
    },
    writeField(index, componentId, fieldIndex, value) {
      const { archetypeId, row } = this.locationOf(index)
      const col = columns.get(colKey(archetypeId, componentId, fieldIndex))
      if (col === undefined) return
      ;(col.view as unknown as { [i: number]: number })[row * col.stride] = value
    },
    commands,
  }
  // indexBitsMask reserved for handle→index narrowing in callers; kept for API symmetry.
  void indexBitsMask
}

export { REC_ARCH_ID, REC_ARCH_ROW }
