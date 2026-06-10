// The archetype store: signature interning, the lazy edge graph, swap-pop row alloc/removal, and
// migration. All run serial / main-thread. The
// store owns archetype identity + columns; it CALLS the entity record's commitRecord (the two-word
// structural commit point) and drives the per-entity bitmask delta after each
// migration commit. It never owns the handle codec or the free-list (entity module).

import type { ComponentId, ComponentDef, Schema } from '@ecsia/schema'
import type { ArchetypeId } from '@ecsia/schema'
import type { Buffers, Column } from '../memory/index.js'
import type { AccessorWorld, ColumnSet, ComponentRuntime } from '../component/index.js'
import { initColumnSetRow } from '../component/index.js'
import type { Bitmask } from '../bitmask/index.js'
import type { Signature } from './signature.js'
import {
  canonicalize,
  sigEquals,
  sigHas,
  sigHash,
  sigWithAdded,
  sigWithRemoved,
} from './signature.js'
import type { Archetype } from './archetype.js'
import { attachHotColumns, makeArchetype } from './archetype.js'
import { makeColdStore, coldAllocRow, coldRowOf, coldReclaim } from './cold-store.js'
import type { ColdStore } from './cold-store.js'

// EMPTY_ARCHETYPE_ID is dense id 0: a REAL archetype (the empty signature), distinct from the
// ARCHETYPE_NONE record sentinel. This module is the normative definer.
export const EMPTY_ARCHETYPE_ID = 0 as ArchetypeId
export const ARCHETYPE_NONE = 0xffffffff as ArchetypeId

const INITIAL_ROWS = 64

// ShapeKind ordinals used at the structural commit points.
const SHAPE_ADD = 2

/** The two-word record surface the store commits through. */
export interface RecordSurface {
  commitRecord(index: number, archetypeId: number, row: number): void
  archetypeIdOf(index: number): number
  rowOf(index: number): number
}

export interface StorageDeps {
  readonly buffers: Buffers
  readonly accessorWorld: AccessorWorld
  readonly bitmask: Bitmask
  readonly record: RecordSurface
  readonly maxHotArchetypes: number
  /** Bitmask/sigWords stride = ceil(N/32) ( C4). */
  readonly stride: number
  /** Mint ceiling; clamps a new column's initial reservation so it never exceeds the world cap. */
  readonly maxEntities: number
  /** Removal-reactivity hook for components in fromArch \ toArch ( fills the body). */
  enqueueRemoveLog(index: number, c: ComponentId): void
  /**
   * Shape-log hook: emit a structural entry at the commit point. Optional so a
   * query-less harness (unit tests) constructs the store directly; the world wires it to reactivity.
   */
  trackShape?(index: number, c: ComponentId, kind: number): void
  /**
   * Single-entity incremental query maintenance: called once per component in the
   * symmetric difference of a migration AFTER the bitmask delta is applied, so matchesEntityNow reads
   * a coherent shape. Optional so a query-less harness ( unit tests) constructs the store directly.
   * re-routes this through reactivity's MAINTAIN_STRUCTURAL shape-log drain.
   */
  maintainEntity?(index: number, c: ComponentId): void
  tick(): number
  defOf(c: ComponentId): ComponentDef<Schema> | undefined
  handleIndex(handle: number): number
  /**
   * A held deferred-dead row was relocated (allocRow evicting it to keep [0,count) dense): tell the
   * observer-window location stash its new row, so a dead-tenant ref still resolves the right slot.
   * Optional — a query-less harness omits it (no observer window to update).
   */
  relocateHeld?(handle: number, archId: number, newRow: number): void
}

export class ArchetypeStore {
  readonly #deps: StorageDeps
  readonly byId: Archetype[] = []
  readonly #byHash = new Map<number, Archetype[]>()
  #hotCount = 0
  readonly cold: ColdStore = makeColdStore()
  /** Archetypes with held > 0 — the release set (avoids scanning byId at flushPending). */
  readonly #archesWithHeld = new Set<Archetype>()
  readonly #initialRows: number
  /** archetypeCreated subscribers: tested against each new archetype once. */
  readonly #onCreated: Array<(arch: Archetype) => void> = []

  constructor(deps: StorageDeps) {
    this.#deps = deps
    // A new column reserves its address space from initialCapacity; never reserve past the world's
    // mint ceiling or the resizable backing's maxByteLength is invalid for tiny maxEntities.
    this.#initialRows = Math.max(1, Math.min(INITIAL_ROWS, deps.maxEntities))
    // EMPTY_ARCHETYPE_ID = 0 is created eagerly so spawn always has a hot archetype to land in.
    this.getOrCreateArchetype(canonicalize([]))
  }

  get hotCount(): number {
    return this.#hotCount
  }

  get emptyArchetype(): Archetype {
    return this.byId[EMPTY_ARCHETYPE_ID as number] as Archetype
  }

  // --- (signature interning) ---------------------------

  getOrCreateArchetype(sig: Signature): Archetype {
    const h = sigHash(sig)
    const bucket = this.#byHash.get(h)
    if (bucket !== undefined) {
      for (const a of bucket) if (sigEquals(a.signature, sig)) return a
    }
    return this.#createArchetype(sig, h)
  }

  #createArchetype(sig: Signature, hash: number): Archetype {
    const id = this.byId.length as ArchetypeId
    const isCold = this.#hotCount >= this.#deps.maxHotArchetypes
    const arch = makeArchetype(id, sig, hash, this.#deps.stride, this.#deps.tick(), isCold)
    if (!isCold) {
      attachHotColumns(arch, {
        buffers: this.#deps.buffers,
        accessorWorld: this.#deps.accessorWorld,
        initialCapacity: this.#initialRows,
        defOf: (c) => this.#deps.defOf(c),
      })
      this.#hotCount += 1
    }
    this.byId.push(arch)
    let bucket = this.#byHash.get(hash)
    if (bucket === undefined) {
      bucket = []
      this.#byHash.set(hash, bucket)
    }
    bucket.push(arch)
    // Each registered query AND-tests this new archetype's sigWords once and, on
    // match, appends it to its matchingArchetypes. Emitted AFTER the archetype is fully interned.
    for (const fn of this.#onCreated) fn(arch)
    return arch
  }

  /** Subscribe to archetypeCreated. Serial-phase only. */
  onArchetypeCreated(fn: (arch: Archetype) => void): void {
    this.#onCreated.push(fn)
  }

  // --- (both directions cached on a miss) ---------------

  edgeAdd(arch: Archetype, c: ComponentId): Archetype {
    const e = arch.edges.get(c)
    if (e !== undefined && e.add !== undefined) return e.add
    const targetSig = sigWithAdded(arch.signature, c)
    const target = this.getOrCreateArchetype(targetSig)
    this.#setEdge(arch, c, 'add', target)
    this.#setEdge(target, c, 'remove', arch)
    return target
  }

  edgeRemove(arch: Archetype, c: ComponentId): Archetype {
    const e = arch.edges.get(c)
    if (e !== undefined && e.remove !== undefined) return e.remove
    const targetSig = sigWithRemoved(arch.signature, c)
    const target = this.getOrCreateArchetype(targetSig)
    this.#setEdge(arch, c, 'remove', target)
    this.#setEdge(target, c, 'add', arch)
    return target
  }

  #setEdge(arch: Archetype, c: ComponentId, dir: 'add' | 'remove', target: Archetype): void {
    let e = arch.edges.get(c)
    if (e === undefined) {
      e = {}
      arch.edges.set(c, e)
    }
    e[dir] = target
  }

  // --- / swap-pop removal ---------------------------------------

  #ensureRowCapacity(arch: Archetype, need: number): void {
    const rowsColumn = arch.rowsColumn
    if (rowsColumn === null) return // cold archetype: rows live in the overflow store
    if (need > rowsColumn.capacity()) {
      this.#deps.buffers.grow(rowsColumn, need)
      arch.rows = rowsColumn.view as Uint32Array
    }
    for (const cs of arch.columnSets.values()) {
      for (const col of cs.columns) {
        if (need > col.capacity()) this.#deps.buffers.grow(col, need)
      }
    }
  }

  /** Reserve a row in `arch` for `handle`; records the occupant. Caller writes column values. */
  allocRow(arch: Archetype, handle: number): number {
    if (arch.cold) return this.#coldAllocRow(arch, handle)
    if (arch.held > 0) {
      // The alloc slot `count` is occupied by a held deferred-dead row. Evict it to the top of the
      // held region (above all held rows) to free `count` while keeping the held region contiguous
      // — [0,count) stays dense and the dead row's data survives until flushPending.
      const evict = arch.count
      const top = arch.count + arch.held // first free slot above the held region
      this.#ensureRowCapacity(arch, top + 1)
      for (const cs of arch.columnSets.values()) {
        for (const col of cs.columns) copyRowWithinColumn(col, evict, top)
      }
      const deadHandle = arch.rows[evict] as number
      arch.rows[top] = deadHandle >>> 0
      // The held region shifts up by one as `count` advances below; its size (held) is unchanged.
      this.#deps.relocateHeld?.(deadHandle, arch.id as number, top)
    } else {
      this.#ensureRowCapacity(arch, arch.count + 1)
    }
    const row = arch.count
    arch.rows[row] = handle >>> 0
    arch.count = row + 1
    arch.lastAccessTick = this.#deps.tick()
    return row
  }

  /**
   * Release every archetype's held deferred-dead rows back to the allocatable region. Called at the
   * observer drain's flushPending (after onRemove handlers have read the dying values): held → 0, so
   * the next allocRow reuses [count, …) and overwrites the abandoned dead data. Iteration is
   * unaffected (the rows were always above count); only allocation reclaims them.
   */
  releaseHeldRows(): void {
    if (this.#archesWithHeld.size === 0) return
    for (const arch of this.#archesWithHeld) arch.held = 0
    this.#archesWithHeld.clear()
  }

  #coldAllocRow(arch: Archetype, handle: number): number {
    const index = this.#deps.handleIndex(handle)
    this.cold.archOf.set(index, arch.id)
    this.cold.handleOf.set(index, handle >>> 0)
    for (let i = 0; i < arch.signature.length; i++) {
      const c = arch.signature[i] as number as ComponentId
      // Cold rows are keyed per (entityIndex, componentId), NOT per archetype. A cold→cold migration
      // that keeps a component must REUSE the entity's existing row for it — reallocating would orphan
      // the prior value and the source-side reclaim would then delete the fresh mapping. Only allocate
      // a row for a component the entity does not already hold.
      if (coldRowOf(this.cold, index, c) >= 0) continue
      coldAllocRow(this.cold, index, c, {
        buffers: this.#deps.buffers,
        accessorWorld: this.#deps.accessorWorld,
        initialCapacity: this.#initialRows,
        defOf: (cc) => this.#deps.defOf(cc),
      })
    }
    // Cold rows are addressed per-component via cold.rowOf; the record stores the entityIndex itself
    // as the "row" so resolveLocation round-trips through the cold store.
    arch.count += 1
    arch.lastAccessTick = this.#deps.tick()
    return index
  }

  /**
   * Swap-pop removal: move the last live row into `row`, then fix the moved sibling's record via
   * the callback. `fixSibling` fires exactly once iff row !== count-1 (I6). Serial only.
   *
   *: when `relocateDying` is supplied (a remove-observer subscribes to a
   * held component), the dying entity's column data must survive intact until after observerDrain so
   * an onRemove handler can read its last value. Instead of a one-way overwrite of the dying row, we
   * SWAP it with the last live row: the sibling's data lands in `row` (record fixed), and the dying
   * entity's data lands at the now-excluded `last` slot (record relocated via `relocateDying`). The
   * dying row is naturally reclaimed — it sits at/above `count`, outside every `[0,count)` iteration,
   * and is overwritten by the next allocRow (which only happens next frame, since observer mutations
   * stage to command buffers). For hot rows this needs no per-frame stale-row list.
   */
  removeRow(
    arch: Archetype,
    row: number,
    fixSibling: (movedIndex: number, newRow: number) => void,
    relocateDying?: (newRow: number) => void,
  ): void {
    if (arch.cold) {
      // Cold "row" is the entity index (the record row word for cold entities). Reclaim its
      // overflow rows so blocks don't leak and stale (index,componentId) mappings can't survive a
      // generational index reuse. Cold blocks are keyed per (entityIndex, componentId), so the dying
      // entity's values are addressed by its own index and survive the count decrement regardless —
      // the deferral concern (sibling overwrite) does not arise. Reclaim runs as usual.
      coldReclaim(this.cold, row, arch.signature as unknown as Iterable<number>)
      arch.count -= 1
      return
    }
    const last = arch.count - 1
    if (row !== last) {
      const defer = relocateDying !== undefined
      for (const cs of arch.columnSets.values()) {
        for (const col of cs.columns) {
          if (defer) swapRowWithinColumn(col, last, row)
          else copyRowWithinColumn(col, last, row)
        }
      }
      const movedHandle = arch.rows[last] as number
      const dyingHandle = arch.rows[row] as number
      arch.rows[row] = movedHandle
      fixSibling(this.#deps.handleIndex(movedHandle), row)
      if (defer) {
        // The dying entity's data now lives at `last`; keep its record pointing there so a leniently
        // bound EntityRef reads its own pre-removal values during the drain.
        arch.rows[last] = dyingHandle
        relocateDying(last)
      }
    }
    arch.count = last
    if (relocateDying !== undefined) {
      // HOLD the dying row (now at `last` = the new count) above the live region until flushPending,
      // so a same-archetype re-mint before the drain cannot overwrite its column data. The dying row
      // abuts any existing held rows (they sit at [oldCount, …)); held stays contiguous above count.
      arch.held += 1
      this.#archesWithHeld.add(arch)
    } else if (arch.held > 0) {
      // A NON-deferred removeRow (migration-out, or a non-deferred despawn) lowered count but did not
      // add a held row, so the held region [oldCount, oldCount+held) no longer abuts the new count —
      // the vacated slot `count` sits below it. Slide the TOP held row down into that slot (O(1)) so
      // held stays contiguous at [count, count+held); otherwise the next allocRow eviction would copy
      // the stale vacated slot over a real held dead row and corrupt it.
      const top = arch.count + arch.held // physical top held row (one above the vacated slot's region)
      for (const cs of arch.columnSets.values()) {
        for (const col of cs.columns) copyRowWithinColumn(col, top, arch.count)
      }
      const moved = arch.rows[top] as number
      arch.rows[arch.count] = moved >>> 0
      this.#deps.relocateHeld?.(moved, arch.id as number, arch.count)
    }
  }

  // ---

  /** Move one entity from fromArch to toArch: K-shared copy + init-added + shuffle-pop + commit. */
  migrate(handle: number, fromArch: Archetype, toArch: Archetype): number {
    const index = this.#deps.handleIndex(handle)
    const oldRow = this.#deps.record.rowOf(index)

    // Snapshot the source field locations BEFORE allocRow. A cold target reallocates this entity's
    // per-type cold rows (cold.rowOf), which for a cold→cold migration would clobber the source row
    // mapping of shared components before we copy them.
    const srcLocs = new Map<number, { set: ColumnSet; row: number }>()
    for (let i = 0; i < toArch.signature.length; i++) {
      const c = toArch.signature[i] as number as ComponentId
      if (!sigHas(fromArch.signature, c)) continue
      const src = this.#fieldLocation(fromArch, c, index, oldRow)
      if (src !== null) srcLocs.set(c as number, src)
    }

    const newRow = this.allocRow(toArch, handle)

    // Shared-column copy: for every column-bearing component in the DESTINATION, copy
    // its field values from the source (hot row OR cold block) or initialize if newly added. This
    // holds in all four hot/cold combinations — the column-copy is NOT skipped for cold targets,
    // which would silently drop shared field data.
    for (let i = 0; i < toArch.signature.length; i++) {
      const c = toArch.signature[i] as number as ComponentId
      const dst = this.#fieldLocation(toArch, c, index, newRow)
      if (dst === null) continue // tag / no def: pure membership, no columns
      const src = srcLocs.get(c as number)
      if (src !== undefined) {
        for (let f = 0; f < dst.set.columns.length; f++) {
          copyRowAcrossColumns(src.set.columns[f] as Column, src.row, dst.set.columns[f] as Column, dst.row)
        }
      } else {
        this.#initColumnRow(dst.set, dst.row, c)
      }
    }

    // Removal reactivity for components in fromArch \ toArch, BEFORE the source row is overwritten.
    for (let i = 0; i < fromArch.signature.length; i++) {
      const c = fromArch.signature[i] as number as ComponentId
      if (!sigHas(toArch.signature, c)) this.#deps.enqueueRemoveLog(index, c)
    }

    if (fromArch.cold) {
      // Reclaim only the cold rows the entity no longer keeps in the COLD store: components removed
      // outright, plus shared components that moved into a hot target's columns. Shared components
      // that stay cold (cold→cold) retain their existing row (reused by #coldAllocRow above).
      const toReclaim: number[] = []
      for (let i = 0; i < fromArch.signature.length; i++) {
        const c = fromArch.signature[i] as number
        const stillCold = sigHas(toArch.signature, c) && toArch.cold
        if (!stillCold) toReclaim.push(c)
      }
      coldReclaim(this.cold, index, toReclaim, !toArch.cold)
      fromArch.count -= 1
    } else {
      this.removeRow(fromArch, oldRow, (movedIndex, newSrcRow) => {
        this.#deps.record.commitRecord(movedIndex, fromArch.id as number, newSrcRow)
      })
    }

    this.#deps.record.commitRecord(index, toArch.id as number, newRow)
    this.#deps.bitmask.bitmaskApplyDelta(index, fromArch.signature, toArch.signature)

    // /: one shape-log Add per component in toArch \ fromArch (NOT per copied
    // column). Removes were emitted via enqueueRemoveLog above, before the source row was overwritten.
    const trackShape = this.#deps.trackShape
    if (trackShape !== undefined) {
      for (let i = 0; i < toArch.signature.length; i++) {
        const c = toArch.signature[i] as number as ComponentId
        if (!sigHas(fromArch.signature, c)) trackShape(index, c, SHAPE_ADD)
      }
    }

    // Re-test this one entity against the queries
    // referencing each component in the symmetric difference (added OR removed). Runs AFTER the
    // bitmask delta so matchesEntityNow sees the coherent post-migration shape.
    const maintain = this.#deps.maintainEntity
    if (maintain !== undefined) {
      for (let i = 0; i < toArch.signature.length; i++) {
        const c = toArch.signature[i] as number as ComponentId
        if (!sigHas(fromArch.signature, c)) maintain(index, c)
      }
      for (let i = 0; i < fromArch.signature.length; i++) {
        const c = fromArch.signature[i] as number as ComponentId
        if (!sigHas(toArch.signature, c)) maintain(index, c)
      }
    }
    return newRow
  }

  /**
   * Resolve the (ColumnSet, row) holding component `c`'s fields for `index` in `arch`, whether hot
   * (per-archetype columnSet, addressed by `hotRow`) or cold (per-type block, addressed by the
   * entity's cold row). Returns null for tags / unregistered ids that carry no columns.
   */
  #fieldLocation(arch: Archetype, c: ComponentId, index: number, hotRow: number): { set: ColumnSet; row: number } | null {
    if (arch.cold) {
      const set = this.cold.blocks.get(c)
      if (set === undefined) return null
      const row = coldRowOf(this.cold, index, c)
      if (row < 0) return null
      return { set, row }
    }
    const set = arch.columnSets.get(c)
    if (set === undefined) return null
    return { set, row: hotRow }
  }

  #initColumnRow(cs: ColumnSet, row: number, c: ComponentId): void {
    const def = this.#deps.defOf(c)
    if (def === undefined) return
    initColumnSetRow(cs, def, row)
  }

  // --- /

  /** entity.add(C): single-id add via the cached edge. */
  migrateAdding(handle: number, c: ComponentId): number {
    const index = this.#deps.handleIndex(handle)
    const fromArch = this.byId[this.#deps.record.archetypeIdOf(index)] as Archetype
    if (sigHas(fromArch.signature, c)) return this.#deps.record.rowOf(index) // idempotent
    const toArch = this.edgeAdd(fromArch, c)
    return this.migrate(handle, fromArch, toArch)
  }

  /** entity.remove(C): single-id remove via the cached edge. */
  migrateRemoving(handle: number, c: ComponentId): number {
    const index = this.#deps.handleIndex(handle)
    const fromArch = this.byId[this.#deps.record.archetypeIdOf(index)] as Archetype
    if (!sigHas(fromArch.signature, c)) return this.#deps.record.rowOf(index) // idempotent
    const toArch = this.edgeRemove(fromArch, c)
    return this.migrate(handle, fromArch, toArch)
  }

  /** Multi-id atomic add — ONE target signature, one migration (relations atomicity). */
  migrateAddingMany(handle: number, addIds: readonly ComponentId[]): number {
    const index = this.#deps.handleIndex(handle)
    const fromArch = this.byId[this.#deps.record.archetypeIdOf(index)] as Archetype
    const effective = addIds.filter((c) => !sigHas(fromArch.signature, c))
    if (effective.length === 0) return this.#deps.record.rowOf(index)
    const targetSig = canonicalize([...(fromArch.signature as unknown as Iterable<number>), ...(effective as unknown as number[])])
    const toArch = this.getOrCreateArchetype(targetSig)
    return this.migrate(handle, fromArch, toArch)
  }

  /** Multi-id atomic remove — symmetric to migrateAddingMany. */
  migrateRemovingMany(handle: number, removeIds: readonly ComponentId[]): number {
    const index = this.#deps.handleIndex(handle)
    const fromArch = this.byId[this.#deps.record.archetypeIdOf(index)] as Archetype
    const effective = removeIds.filter((c) => sigHas(fromArch.signature, c))
    if (effective.length === 0) return this.#deps.record.rowOf(index)
    const removeSet = new Set<number>(effective as unknown as number[])
    const kept: number[] = []
    for (let i = 0; i < fromArch.signature.length; i++) {
      const c = fromArch.signature[i] as number
      if (!removeSet.has(c)) kept.push(c)
    }
    const toArch = this.getOrCreateArchetype(canonicalize(kept))
    return this.migrate(handle, fromArch, toArch)
  }

  /** spawnWith fast path: compute the target signature up front and migrate ONCE. */
  spawnWith(handle: number, defs: readonly ComponentDef<Schema>[]): number {
    const ids: number[] = []
    for (const d of defs) ids.push((d as ComponentRuntime<Schema>).id as number)
    const toArch = this.getOrCreateArchetype(canonicalize(ids))
    // Zero specs (or all-duplicate ids resolving to the empty signature) would self-migrate
    // empty→empty: allocRow appends a DUPLICATE row for the handle, then removeRow + commitRecord
    // strand the record outside the live range — the guard every sibling entry point already has.
    if (toArch === this.emptyArchetype) return this.#deps.record.rowOf(this.#deps.handleIndex(handle))
    return this.migrate(handle, this.emptyArchetype, toArch)
  }

  // ---

  /** Promote a cold archetype (by signature) to hot: allocate columns, migrate its rows out. */
  warm(sig: Signature): void {
    const arch = this.getOrCreateArchetype(sig)
    if (!arch.cold) return

    // Snapshot the resident cold entities BEFORE flipping the flag — their data lives in the shared
    // overflow blocks keyed (entityIndex, componentId), addressed via cold.rowOf.
    const residents: number[] = []
    for (const [entityIndex, archId] of this.cold.archOf) {
      if ((archId as number) === (arch.id as number)) residents.push(entityIndex)
    }

    attachHotColumns(arch, {
      buffers: this.#deps.buffers,
      accessorWorld: this.#deps.accessorWorld,
      initialCapacity: this.#initialRows,
      defOf: (c) => this.#deps.defOf(c),
    })
    arch.count = 0
    arch.cold = false
    this.#hotCount += 1

    // Migrate each resident out of the overflow store into a contiguous hot row, copying field
    // values from the cold blocks, fixing its record, then reclaiming its cold rows.
    for (const entityIndex of residents) {
      const newRow = arch.count
      this.#ensureRowCapacity(arch, newRow + 1)
      const handle = this.cold.handleOf.get(entityIndex) ?? entityIndex
      arch.rows[newRow] = handle >>> 0
      arch.count = newRow + 1
      for (let i = 0; i < arch.signature.length; i++) {
        const c = arch.signature[i] as number as ComponentId
        const dstSet = arch.columnSets.get(c)
        if (dstSet === undefined) continue
        const srcSet = this.cold.blocks.get(c)
        const srcRow = coldRowOf(this.cold, entityIndex, c)
        if (srcSet === undefined || srcRow < 0) {
          this.#initColumnRow(dstSet, newRow, c)
          continue
        }
        for (let f = 0; f < dstSet.columns.length; f++) {
          copyRowAcrossColumns(srcSet.columns[f] as Column, srcRow, dstSet.columns[f] as Column, newRow)
        }
      }
      coldReclaim(this.cold, entityIndex, arch.signature as unknown as Iterable<number>)
      this.#deps.record.commitRecord(entityIndex, arch.id as number, newRow)
    }
  }
}

/** Copy one row's stride elements from srcRow to dstRow within the SAME column. */
function copyRowWithinColumn(col: Column, srcRow: number, dstRow: number): void {
  const s = col.layout.stride
  const v = col.view
  ;(v as unknown as { copyWithin(t: number, s: number, e: number): void }).copyWithin(
    dstRow * s,
    srcRow * s,
    srcRow * s + s,
  )
}

/** Swap two rows' stride elements within the same column. */
function swapRowWithinColumn(col: Column, a: number, b: number): void {
  const s = col.layout.stride
  const v = col.view as unknown as { [i: number]: number }
  const ab = a * s
  const bb = b * s
  for (let i = 0; i < s; i++) {
    const t = v[ab + i] as number
    v[ab + i] = v[bb + i] as number
    v[bb + i] = t
  }
}

/** Copy one row from a source column to a same-layout destination column (cross-archetype). */
function copyRowAcrossColumns(src: Column, srcRow: number, dst: Column, dstRow: number): void {
  const s = src.layout.stride
  dst.view.set(
    (src.view as unknown as { subarray(a: number, b: number): ArrayLike<number> }).subarray(srcRow * s, srcRow * s + s),
    dstRow * s,
  )
}
