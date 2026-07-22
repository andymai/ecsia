// The capture/restore mechanism: read the whole live world into a reusable image and write it back
// IN PLACE, handle-stably. Drives `world.__installRollback()`; @ecsia/core never imports this.
//
// Growth discipline mirrors core's buffer layer: image buffers double, are reused across captures,
// and NEVER alias a live column view (a fallback grow re-creates those).

import { snapshotInto } from '@ecsia/core'
import type { Archetype, Column, EntityIdentityImage, RollbackHost, TypedArray, World } from '@ecsia/core'

/**
 * Opaque, reusable capture buffer. Allocate one per rollback-ring slot and reuse it: a capture only
 * allocates when the live set outgrows the image's buffers (doubling), so a steady-state ring
 * allocates nothing per frame. An image holds the world's Column references and is NOT portable to
 * another world.
 */
declare const rollbackImageBrand: unique symbol
export interface RollbackImage {
  readonly [rollbackImageBrand]: true
}

/**
 * The capture/restore handle for one world.
 *
 * WHAT AN IMAGE COVERS
 *   • per-archetype SoA columns + the dense row→handle list over `[0, count + held)`, plus both
 *     occupancy words. The HELD range (deferred-dead rows an onRemove observer has yet to read) is
 *     part of the image: `world.phase === 'serial'` is equally true before the observer drain, so a
 *     capture can legitimately see `held > 0` — restoring the occupancy without those rows' bytes
 *     would fire removal observers with whatever the live world wrote there since.
 *   • the five entity identity/record regions + the four allocator cursors (handle stability)
 *   • the component bitmask: the u32 words AND the out-of-stride sparse overflow
 *   • the changeVersion stamps, when stamping is enabled
 *   • world.tick
 *
 * WHAT IT DELIBERATELY OMITS: the frame-transient reactivity structures — the write/shape log rings,
 * the Changed lists, the per-frame added/removed query flavors and the topic rings. A rollback ring
 * checkpoints between frames, where those are empty; not capturing them is what keeps the image small.
 *
 * CONSEQUENCE — the EVENT STREAM is not rewound, only the STATE. Capturing mid-frame (serial phase is
 * equally true before the observer drain) leaves those rings outside the image, so a despawn journaled
 * after the capture still drains after a restore: the observer fires for an entity the restore brought
 * back. Held rows ARE captured, so such an event reports its at-capture values rather than a live
 * entity's — the values are sound, the event count/identity is not. Checkpoint at a frame boundary
 * (after the drain) if a client must not observe revoked events.
 */
export interface RollbackSurface {
  /** A fresh, empty image (its buffers grow on first capture). */
  newImage(): RollbackImage
  /**
   * Capture the ENTIRE live world into `img`, overwriting whatever it held. Serial-phase only.
   *
   * THROWS on the v1 limitations, deliberately fail-fast rather than silently restoring a partial
   * world: a world with a relation defined (relation state lives in JS maps behind a MONOTONIC
   * synthetic pair-id counter, so re-simulating mints different pair ids and different archetype
   * signatures), entities resident in the cold-archetype overflow store (per-TYPE blocks, outside
   * the per-archetype hot walk), or a registered rich (`'string'` / `object<T>`) field (sidecar
   * values the image cannot reach).
   */
  captureImage(img: RollbackImage): void
  /**
   * Restore `img` over the live world IN PLACE and HANDLE-STABLY. Every entity alive at capture is
   * alive again at its ORIGINAL handle; entities spawned after the capture are gone; archetypes
   * created after the capture are emptied. Serial-phase only; same guards as `captureImage`.
   */
  restoreImage(img: RollbackImage): void
  /** RESTORE-ONLY tick assignment (`world.tick` is otherwise increment-only). */
  setTick(tick: number): void
}

/** One captured column: the live Column (identity is stable; only its view re-points) + its bytes. */
interface ColumnCell {
  col: Column
  data: TypedArray
  /** Elements written ((count + held) * stride). */
  length: number
}

interface ArchetypeCell {
  /** The capture this entry was last written by; older entries are absent from the image. */
  seq: number
  count: number
  held: number
  rows: Uint32Array
  cells: ColumnCell[]
}

class Image {
  /** The surface that minted this image — an image is not portable between worlds. */
  owner: object | null = null
  seq = 0
  tick = 0
  readonly identity: EntityIdentityImage = {
    sparse: new Uint32Array(0),
    dense: new Uint32Array(0),
    generation: new Uint32Array(0),
    recordArchetypeId: new Uint32Array(0),
    recordArchetypeRow: new Uint32Array(0),
    aliveCount: 0,
    denseLen: 0,
    spawned: 0,
    despawned: 0,
  }
  bitmaskWords: Uint32Array = new Uint32Array(0)
  bitmaskWordCount = 0
  bitmaskIndexCount = 0
  readonly bitmaskSparse = new Map<number, Set<number>>()
  changeVersion: Uint32Array = new Uint32Array(0)
  changeVersionCount = 0
  readonly archetypes = new Map<number, ArchetypeCell>()
}

/**
 * `arr` when it already holds `length` elements, else a fresh doubled one. Contents are NOT
 * preserved — a capture rewrites the whole prefix it later reads back.
 */
function ensureU32(arr: Uint32Array, length: number): Uint32Array {
  if (arr.length >= length) return arr
  let cap = arr.length > 0 ? arr.length : 1
  while (cap < length) cap *= 2
  return new Uint32Array(cap)
}

function scratchFor(col: Column, elements: number): TypedArray {
  const Ctor = col.view.constructor as new (length: number) => TypedArray
  let cap = 1
  while (cap < elements) cap *= 2
  return new Ctor(cap)
}

function writeBack(col: Column, data: TypedArray, length: number): void {
  const src = (data as unknown as { subarray(s: number, e: number): ArrayLike<number> }).subarray(0, length)
  ;(col.view as unknown as { set(a: ArrayLike<number>, o: number): void }).set(src, 0)
}

function sizeIdentity(img: EntityIdentityImage, n: number): void {
  img.sparse = ensureU32(img.sparse, n)
  img.dense = ensureU32(img.dense, n)
  img.generation = ensureU32(img.generation, n)
  img.recordArchetypeId = ensureU32(img.recordArchetypeId, n)
  img.recordArchetypeRow = ensureU32(img.recordArchetypeRow, n)
}

/**
 * Attach the rollback surface to `world`. Call once per world and keep the returned handle; each
 * call re-installs the seam and mints a fresh image-ownership identity.
 */
export function createRollbackSurface(world: World): RollbackSurface {
  const host: RollbackHost = world.__installRollback()
  const owner = {}

  const assertSerial = (verb: string): void => {
    if (world.phase !== 'serial') {
      throw new Error(
        `rollback ${verb}() must run while the world is in its serial phase (between frames, outside scheduler.update / worker waves)`,
      )
    }
  }

  const assertOwned = (verb: string, img: Image): void => {
    if (img.owner !== owner) {
      throw new Error(
        `rollback ${verb}(): this image belongs to a different rollback surface — an image holds that world's column references, so it is not portable`,
      )
    }
  }

  const unsupported = (verb: string, what: string, remedy: string): Error =>
    new Error(`rollback ${verb}(): ${what} — rollback would silently restore a partial world. ${remedy}`)

  const coldResidents = (): number => {
    let n = 0
    for (const arch of host.archetypes.byId) if (arch.cold) n += arch.count
    return n
  }

  const assertCoverable = (verb: string): void => {
    const relations = world.__serialize.relations()
    if (relations !== undefined && relations.relations().length > 0) {
      throw unsupported(
        verb,
        'relation state (JS maps behind a MONOTONIC synthetic pair-id counter) is not in the image, so re-simulating mints different pair ids and different archetype signatures',
        'Relation-aware rollback is a follow-up; checkpoint relation-free worlds until then.',
      )
    }
    const cold = coldResidents()
    if (cold > 0) {
      throw unsupported(
        verb,
        `${cold} entities live in the cold-archetype overflow store, outside the per-archetype hot walk the image captures`,
        'Raise maxHotArchetypes so every archetype stays hot, or world.warm() the cold signatures before checkpointing.',
      )
    }
    if (world.__serialize.richFields().length > 0) {
      throw unsupported(
        verb,
        "rich ('string' / object<T>) field values live in the main-thread sidecar, which the image cannot reach",
        'Rich-field rollback is a follow-up; checkpoint worlds with numeric-only components until then.',
      )
    }
  }

  const cellFor = (img: Image, arch: Archetype): ArchetypeCell => {
    let cell = img.archetypes.get(arch.id as number)
    if (cell === undefined) {
      cell = { seq: 0, count: 0, held: 0, rows: new Uint32Array(0), cells: [] }
      img.archetypes.set(arch.id as number, cell)
    }
    return cell
  }

  const captureArchetype = (img: Image, arch: Archetype): void => {
    const entry = cellFor(img, arch)
    entry.seq = img.seq
    entry.count = arch.count
    entry.held = arch.held
    // The held (deferred-dead) rows sit directly above the live region and are part of the image:
    // their column bytes are what onRemove handlers read when the drain finally releases them.
    const rowCount = arch.count + arch.held
    entry.rows = ensureU32(entry.rows, rowCount)
    entry.rows.set(arch.rows.subarray(0, rowCount), 0)
    let i = 0
    for (const set of arch.columnSets.values()) {
      for (const col of set.columns) {
        const elements = rowCount * col.layout.stride
        let cell = entry.cells[i]
        // Re-resolve per capture: a cold→hot warm promotion attaches columns to an archetype that
        // had none, so the cell list is not fixed for an archetype id.
        if (cell === undefined || cell.col !== col) {
          cell = { col, data: scratchFor(col, elements), length: 0 }
          entry.cells[i] = cell
        } else if (cell.data.length < elements) {
          cell.data = scratchFor(col, elements)
        }
        cell.length = snapshotInto(col, rowCount, cell.data, 0)
        i += 1
      }
    }
    entry.cells.length = i
  }

  const restoreArchetype = (img: Image, arch: Archetype): void => {
    const entry = img.archetypes.get(arch.id as number)
    if (entry === undefined || entry.seq !== img.seq) {
      // Not in the image: an archetype the re-sim created (or filled) after the checkpoint. Leaving
      // it populated is silent cross-frame corruption — its rows reference entities that, post
      // restore, live elsewhere or are dead.
      host.archetypes.rollbackSetOccupancy(arch, 0, 0)
      return
    }
    arch.rows.set(entry.rows.subarray(0, entry.count + entry.held), 0)
    for (const cell of entry.cells) writeBack(cell.col, cell.data, cell.length)
    host.archetypes.rollbackSetOccupancy(arch, entry.count, entry.held)
  }

  return {
    newImage(): RollbackImage {
      const img = new Image()
      img.owner = owner
      return img as unknown as RollbackImage
    },

    captureImage(image): void {
      assertSerial('captureImage')
      assertCoverable('captureImage')
      const img = image as unknown as Image
      assertOwned('captureImage', img)
      img.seq += 1
      img.tick = world.tick

      const indexCount = host.entities.index.denseLen
      sizeIdentity(img.identity, indexCount)
      host.entities.captureIdentity(img.identity)

      for (const arch of host.archetypes.byId) {
        if (arch.cold) continue
        captureArchetype(img, arch)
      }

      img.bitmaskWords = ensureU32(img.bitmaskWords, indexCount * host.bitmask.stride)
      img.bitmaskIndexCount = indexCount
      img.bitmaskWordCount = host.bitmask.captureInto(img.bitmaskWords, indexCount, img.bitmaskSparse)

      img.changeVersion = ensureU32(img.changeVersion, indexCount)
      img.changeVersionCount = host.changeVersion().captureInto(img.changeVersion, indexCount)
    },

    restoreImage(image): void {
      assertSerial('restoreImage')
      assertCoverable('restoreImage')
      const img = image as unknown as Image
      assertOwned('restoreImage', img)
      if (img.seq === 0) throw new Error('rollback restoreImage(): the image has never been captured into')

      // Widest index the bitmask must be coherent over: the checkpoint's, or the current denseLen
      // when the re-sim minted past it (those slots must lose their bits).
      const clearThrough = Math.max(img.bitmaskIndexCount, host.entities.index.denseLen)

      for (const arch of host.archetypes.byId) {
        if (arch.cold) continue
        restoreArchetype(img, arch)
      }
      host.entities.restoreIdentity(img.identity)
      host.bitmask.restoreFrom(img.bitmaskWords, img.bitmaskIndexCount, clearThrough, img.bitmaskSparse)
      host.changeVersion().restoreFrom(img.changeVersion, img.changeVersionCount)
      host.setTick(img.tick)
      host.resyncQueries()
    },

    setTick(tick): void {
      assertSerial('setTick')
      host.setTick(tick >>> 0)
    },
  }
}
