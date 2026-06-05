// The worker-side (and main-thread-mirror) zero-copy view over the shared buffer set. It
// re-wraps every column + region SAB by reference (LENGTH-TRACKING views) so a worker
// reads/writes Position.x as a direct indexed load on the SAME
// Float32Array the main thread uses — no value copy. Workers read ARCHETYPE TABLES ONLY here: an
// entity's (archetypeId, row) comes from the shared entity-record regions, never the bitmask

import { elementCtor } from '@ecsia/core'
import type { ColumnGrowthNotice, ColumnKey, ElementKind, RegionKey, SharedHandleManifest, TypedArray } from '@ecsia/core'
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
  /**
   * Re-wrap re-backed columns onto their new SAB. The
   * pool drains the main thread's re-backing journal at the wave fence and delivers the new backings
   * here BEFORE the next dispatch, so the worker stops reading the abandoned buffer. In-place `.grow()`
   * never produces a notice — those views length-track automatically.
   */
  applyColumnGrowth(notices: readonly ColumnGrowthNotice[]): void
}

/**
 * Worker write-corral writer. Wraps the per-worker corral SAB. `push`
 * stages one `(index, componentId)` value-write entry: word [0] is the running entry count, entries
 * follow as `[index, componentId]` pairs. Single-writer (this worker only), no atomics — the main
 * thread reads it only after the wave fence. On overflow the corral caps (the merge would read past
 * the SAB otherwise); the cap is diagnosed at merge time by the pool.
 */
export interface WriteCorralWriter {
  push(index: number, componentId: number): void
  reset(): void
}

const CORRAL_COUNT_WORD = 0
const CORRAL_HEADER_WORDS = 1

export function makeWriteCorralWriter(sab: SharedArrayBuffer): WriteCorralWriter {
  const view = new Uint32Array(sab)
  const capacityPairs = (view.length - CORRAL_HEADER_WORDS) >>> 1
  return {
    push(index, componentId) {
      const n = view[CORRAL_COUNT_WORD]!
      if (n >= capacityPairs) return // capped; pool diagnoses on merge
      const base = CORRAL_HEADER_WORDS + n * 2
      view[base] = index >>> 0
      view[base + 1] = componentId >>> 0
      view[CORRAL_COUNT_WORD] = n + 1
    },
    reset() {
      view[CORRAL_COUNT_WORD] = 0
    },
  }
}

export function buildWorkerWorldView(
  manifest: SharedHandleManifest,
  indexBitsMask: number,
  commands: CommandEncoder,
  writeCorral?: WriteCorralWriter,
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
      // Stage the value write into this worker's corral so the serial merge feeds the write log
      // (drives onChange + `.changed` for worker writes). fieldIndex collapses to component granularity
      // — matching the main-thread trackWrite default.
      writeCorral?.push(index, componentId)
    },
    commands,
    applyColumnGrowth(notices) {
      for (const n of notices) {
        columns.set(n.key as unknown as string, { view: wrap(n.backing, n.layout.element), stride: n.layout.stride })
      }
    },
  }
  // indexBitsMask reserved for handle→index narrowing in callers; kept for API symmetry.
  void indexBitsMask
}

export { REC_ARCH_ID, REC_ARCH_ROW }
