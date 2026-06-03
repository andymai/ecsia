// The reactivity facade (reactivity.md): owns the write log + shape log, the per-row changeVersion
// columns, the deferred observers, and the query-flavor hooks. It fills the M2 trackWrite stub, the
// M3 enqueueRemoveLog stub, and the M4 LiveQuery.changed()/eachChanged() stubs — wiring the dual
// mechanism the spec mandates (Must-Fix #2 / R-2):
//   - the WRITE LOG drives the `.changed` query FILTER (drainChanged);
//   - the per-row changeVersion drives the PUBLIC changedSince predicate + delta serializer.
// They never read each other's mechanism.

import type { Buffers } from '../memory/index.js'
import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/schema'
import type { EntityRef } from '../entity/index.js'
import type { LiveQuery } from '../query/index.js'
import { LogRing, OVERFLOW_SENTINEL, ShapeKind, WriteCorral } from './log.js'
import type { LogPointer } from './log.js'
import { ChangeVersionStore } from './change-version.js'
import { ObserverRegistry } from './observers.js'
import type { ObserverDeps, ObserverHandle, ObserverHandler, ObserverTerm } from './observers.js'

export interface ReactivityDeps {
  readonly buffers: Buffers
  readonly maxEntities: number
  readonly indexBits: number
  readonly logEntryWords: 1 | 2
  readonly maxWritesPerFrame: number
  readonly maxShapeChangesPerFrame: number
  readonly shrinkRings: boolean
  readonly dev: boolean
  /** index → its (archetypeId, row) — for changeVersion stamping + the public predicate. */
  resolveLocation(index: number): { archetypeId: number; row: number }
  /** The world frame tick (world owns it; reactivity reads it, never holds it). */
  tick(): number
  /** Advance the world frame tick (world.advanceTick, world.md §8). Called at frameReset. */
  advanceTick(): void
  /** Resolve a registered def's dense id. */
  idOf(def: ComponentDef<Schema>): ComponentId
  /** Does `index` currently hold ALL of `componentIds`? */
  holdsAll(index: number, componentIds: readonly ComponentId[]): boolean
  /** The pooled EntityRef bound to the current (index, generation) for `index` (observer dispatch). */
  refOf(index: number): EntityRef
}

/** Per-query write-log flavor state (reactivity.md §5.1): a LogPointer + a per-frame dedup bitset. */
interface ChangedFlavor {
  readonly ptr: LogPointer
  dedup: Uint8Array
  out: Uint32Array
  /** The component ids this query filters the changed-set on (the value/with set). */
  readonly componentIds: ReadonlySet<number>
}


export class Reactivity {
  readonly #deps: ReactivityDeps
  readonly #writeLog: LogRing
  readonly #shapeLog: LogRing
  readonly #changeVersion: ChangeVersionStore
  readonly #observers: ObserverRegistry
  readonly #corral: WriteCorral
  /** One per LiveQuery that declares the `changed` flavor (lazily allocated, §5.1). */
  readonly #changedFlavors = new WeakMap<LiveQuery, ChangedFlavor>()
  /** Strong list of every changed-flavor pointer, so frame-recycle can rewind lagging cursors. */
  readonly #changedPointers: LogPointer[] = []
  readonly #indexMask: number
  readonly #componentIdBits: number
  readonly #wide: boolean

  // Saved consumer pointers for the serial drains.
  readonly #maintainShapePtr: LogPointer
  readonly #observerShapePtr: LogPointer
  readonly #observerWritePtr: LogPointer

  // Filled by the world wiring so MAINTAIN_STRUCTURAL + observer "all present" can re-test entities.
  #maintainHook: ((index: number, componentId: number) => void) | null = null
  #currentMembers: (() => Iterable<number>) | null = null
  #spilledThisFrame = false

  constructor(deps: ReactivityDeps) {
    this.#deps = deps
    this.#wide = deps.logEntryWords === 2
    this.#indexMask = deps.indexBits >= 32 ? 0xffffffff : ((1 << deps.indexBits) - 1) >>> 0
    this.#componentIdBits = 32 - deps.indexBits

    // §3.5: one-word write entry / two-word shape entry by default; wide worlds add a word each.
    const writeWords = this.#wide ? 2 : 1
    const shapeWords = this.#wide ? 3 : 2
    this.#writeLog = new LogRing({
      buffers: deps.buffers,
      kind: 'write',
      entryWords: writeWords,
      capacityEntries: deps.maxWritesPerFrame,
      keyPrefix: 'reactivity.log.write',
      shrinkRings: deps.shrinkRings,
    })
    this.#shapeLog = new LogRing({
      buffers: deps.buffers,
      kind: 'shape',
      entryWords: shapeWords,
      capacityEntries: deps.maxShapeChangesPerFrame,
      keyPrefix: 'reactivity.log.shape',
      shrinkRings: deps.shrinkRings,
    })
    this.#changeVersion = new ChangeVersionStore(deps.buffers, Math.min(64, deps.maxEntities))
    this.#corral = new WriteCorral()

    const obsDeps: ObserverDeps = {
      idOf: deps.idOf,
      holdsAll: deps.holdsAll,
      refOf: deps.refOf,
      tick: deps.tick,
    }
    this.#observers = new ObserverRegistry(obsDeps)

    this.#maintainShapePtr = this.#shapeLog.makePointer()
    this.#observerShapePtr = this.#shapeLog.makePointer()
    this.#observerWritePtr = this.#writeLog.makePointer()
  }

  /** Late-bind the single-entity maintenance hook (the query engine's maintainEntity). */
  setMaintainHook(fn: (index: number, componentId: number) => void): void {
    this.#maintainHook = fn
  }

  /** Late-bind a "current matching members across all queries" source for the conservative path. */
  setCurrentMembersSource(fn: () => Iterable<number>): void {
    this.#currentMembers = fn
  }

  // --- entry packing (§3.1 / §4.1) -------------------------------------------

  #packWriteEntry(index: number, componentId: number): number[] {
    if (this.#wide) return [index >>> 0, componentId >>> 0]
    return [(((componentId << this.#deps.indexBits) | (index & this.#indexMask)) >>> 0)]
  }

  #unpackWrite(source: Int32Array | Uint32Array | number[], base: number): { index: number; componentId: number } {
    if (this.#wide) {
      return { index: (source[base] as number) >>> 0, componentId: (source[base + 1] as number) >>> 0 }
    }
    const w = source[base] as number
    return { index: w & this.#indexMask, componentId: (w >>> this.#deps.indexBits) >>> 0 }
  }

  #packShapeEntry(index: number, componentId: number, kind: ShapeKind, targetIndex = 0): number[] {
    if (this.#wide) {
      const a = index >>> 0
      const c = (((targetIndex << 3) | (kind & 0x7)) >>> 0)
      return [a, componentId >>> 0, c]
    }
    const a = (((componentId << this.#deps.indexBits) | (index & this.#indexMask)) >>> 0)
    const b = (((targetIndex << 3) | (kind & 0x7)) >>> 0)
    return [a, b]
  }

  #unpackShape(
    source: Int32Array | Uint32Array | number[],
    base: number,
  ): { index: number; componentId: number; kind: ShapeKind; target: number } {
    if (this.#wide) {
      const a = source[base] as number
      const componentId = (source[base + 1] as number) >>> 0
      const c = source[base + 2] as number
      return { index: a >>> 0, componentId, kind: (c & 0x7) as ShapeKind, target: c >>> 3 }
    }
    const a = source[base] as number
    const b = source[base + 1] as number
    return {
      index: a & this.#indexMask,
      componentId: (a >>> this.#deps.indexBits) >>> 0,
      kind: (b & 0x7) as ShapeKind,
      target: b >>> 3,
    }
  }

  // --- hot-path hooks (§3.3, §4.2, §6.2) -------------------------------------

  /** §3.3 + §6.2: push the write entry (always) and stamp changeVersion (when enabled). Single-thread. */
  trackWrite(index: number, componentId: ComponentId, fieldIndex?: number): void {
    // Main thread: append directly to the ring. (Worker corrals merge at mergeCorrals — M7.)
    for (const w of this.#packWriteEntry(index, componentId as number)) this.#writeLog.pushWord(w)
    if (this.#changeVersion.enabled) {
      const { archetypeId, row } = this.#deps.resolveLocation(index)
      // fieldIndex affects only field-granular stamping (Q-CD1, deferred); component-granular default
      // stamps the whole-entity slot regardless of which component/field changed.
      void fieldIndex
      this.#changeVersion.stamp(archetypeId, row, this.#deps.tick())
    }
  }

  /** §4.2 structural commit hook: append one shape entry. Main thread only, O(1). */
  trackShape(index: number, componentId: ComponentId, kind: ShapeKind): void {
    this.#shapeLog.push(this.#packShapeEntry(index, componentId as number, kind))
  }

  /** §4.2 pair variant: carries the target index in word B/C. */
  trackShapePair(
    index: number,
    pairId: ComponentId,
    targetIndex: number,
    kind: ShapeKind.AddPair | ShapeKind.RemovePair,
  ): void {
    this.#shapeLog.push(this.#packShapeEntry(index, pairId as number, kind, targetIndex))
  }

  /**
   * The M3 enqueueRemoveLog stub body: storage calls this for each component in fromArch \ toArch at
   * a migration, and for each held component at despawn (BEFORE removeRow + identity invalidation,
   * R-8). It emits a shape-log Remove entry — the single source for onRemove dispatch + Removed
   * delta maintenance.
   */
  enqueueRemoveLog(index: number, componentId: ComponentId): void {
    this.trackShape(index, componentId, ShapeKind.Remove)
  }

  // --- public predicate + delta (§6.3) ---------------------------------------

  /** Enable per-row changeVersion stamping (a `.changed` predicate consumer / serializer exists). */
  enableChangeVersion(): void {
    this.#changeVersion.enabled = true
  }

  /** §6.3: "did any component on `handle` change since tick `since`?" (strict >). */
  changedSince(handle: EntityHandle, since: number): boolean {
    const index = handle & this.#indexMask
    const { archetypeId, row } = this.#deps.resolveLocation(index)
    return this.#changeVersion.changedSince(archetypeId, row, since)
  }

  /** §6.3 / Q-CD3: rows of `archetypeId` whose stamp is > since (the delta-serializer scan). */
  *changedRows(archetypeId: number, since: number, count: number): Iterable<number> {
    for (let row = 0; row < count; row++) {
      if (this.#changeVersion.changedSince(archetypeId, row, since)) yield row
    }
  }

  currentTick(): number {
    return this.#deps.tick()
  }

  // --- observers (§7) --------------------------------------------------------

  observe(term: ObserverTerm, handler: ObserverHandler): ObserverHandle {
    return this.#observers.observe(term, handler)
  }

  /** §7.4: is there a remove-observer on `componentId` (gates deferred row reclaim)? */
  hasRemoveObserver(componentId: number): boolean {
    return this.#observers.hasKindFor('remove', componentId)
  }

  // --- query-flavor hooks (§5, §10 ReactivityQueryHooks) ---------------------

  /**
   * §5.1: allocate the `changed` flavor's LogPointer + dedup bitset for `q`. `added`/`removed` lists
   * are owned by the LiveQuery itself (M4) and filled by maintenance; this hook wires only `changed`.
   */
  attachChangedFlavor(q: LiveQuery, componentIds: Iterable<number>): void {
    this.enableChangeVersion()
    if (this.#changedFlavors.has(q)) return
    const ptr = this.#writeLog.makePointer()
    this.#changedPointers.push(ptr)
    this.#changedFlavors.set(q, {
      ptr,
      dedup: new Uint8Array(Math.min(64, this.#deps.maxEntities)),
      out: new Uint32Array(64),
      componentIds: new Set(componentIds),
    })
  }

  /**
   * §5.3 DRAIN_CHANGED: drain `q`'s write-log pointer, returning this frame's changed indices (deduped,
   * intersected with `q.current` and the query's filtered components). Write-log driven (R-2) — never
   * consults changeVersion.
   */
  drainChanged(q: LiveQuery): Uint32Array {
    const flavor = this.#changedFlavors.get(q)
    if (flavor === undefined) return EMPTY_U32
    let count = 0
    const current = q.current
    // Size the dedup bitset to the current matching high-water (entity indices).
    const need = this.#maxIndexOf(current) + 1
    if (need > flavor.dedup.length) flavor.dedup = new Uint8Array(need)
    flavor.dedup.fill(0)

    const emit = (index: number): void => {
      if (count >= flavor.out.length) {
        const grown = new Uint32Array(flavor.out.length * 2)
        grown.set(flavor.out)
        flavor.out = grown
      }
      flavor.out[count++] = index
    }

    this.#writeLog.consume(flavor.ptr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) {
        // §3.6 conservative: treat every current match as changed.
        for (const index of current) {
          if (index < flavor.dedup.length && flavor.dedup[index] === 1) continue
          if (index < flavor.dedup.length) flavor.dedup[index] = 1
          emit(index)
        }
        return
      }
      const { index, componentId } = this.#unpackWrite(source, base)
      if (flavor.componentIds.size > 0 && !flavor.componentIds.has(componentId)) return
      if (!current.has(index)) return
      if (index < flavor.dedup.length && flavor.dedup[index] === 1) return
      if (index < flavor.dedup.length) flavor.dedup[index] = 1
      emit(index)
    })
    return flavor.out.subarray(0, count)
  }

  #maxIndexOf(set: { [Symbol.iterator](): Iterator<number> }): number {
    let max = 0
    for (const i of set) if (i > max) max = i
    return max
  }

  // --- lifecycle (§10.1 frame-loop call order) -------------------------------

  /** §3.7: start of frame — advance the world tick, snapshot peak, recycle the rings. */
  frameReset(): void {
    this.#deps.advanceTick()
    if (this.#deps.tick() === 0xffffffff) this.#changeVersion.resetAll() // §13.4 wrap recovery
    this.#spilledThisFrame = false
    this.#writeLog.frameReset(this.#minWriteCursor())
    this.#shapeLog.frameReset(this.#minShapeCursor())
    // §3.7: when the ring recycled to slot 0 (all consumers caught up), rewind every caught-up
    // consumer's cursor to 0 too, so it scans the new frame's entries from the head. A still-lagging
    // consumer (cursor below the now-zero head is impossible) keeps its cursor.
    this.#rewindCaughtUp(this.#writeLog.header[0] as number, [this.#observerWritePtr, ...this.#changedPointers])
    this.#rewindCaughtUp(this.#shapeLog.header[0] as number, [this.#observerShapePtr, this.#maintainShapePtr])
  }

  #rewindCaughtUp(head: number, pointers: readonly LogPointer[]): void {
    if (head !== 0) return // ring was not recycled (a lagging consumer pinned it)
    for (const ptr of pointers) {
      ptr.cursor = 0
      ptr.spillCursor = 0
    }
  }

  /** §9.2: merge per-worker write corrals into the shared ring (deterministic). No-op single-thread. */
  mergeCorrals(): void {
    const c = this.#corral
    for (let i = 0; i < c.count; i++) {
      this.#writeLog.pushWord(c.data[i] as number)
    }
    c.reset()
  }

  /**
   * §5.2 MAINTAIN_STRUCTURAL: drain the shape log, re-testing each affected entity against the queries
   * referencing the changed component. In single-thread mode M4 already maintains `current`
   * synchronously at the commit point, so this re-runs the same idempotent re-test off the log (the
   * drain is the spec's serial mechanism; the synchronous path is the M4 optimization that agrees with
   * it). Add/remove coalesce within the frame because the drain happens once (R-9).
   */
  maintainStructural(): void {
    const hook = this.#maintainHook
    if (hook === null) {
      this.#maintainShapePtr.cursor = this.#shapeLogHead()
      return
    }
    this.#shapeLog.consume(this.#maintainShapePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) return
      const { index, componentId, kind } = this.#unpackShape(source, base)
      if (kind === ShapeKind.Add || kind === ShapeKind.Remove) hook(index, componentId)
    })
  }

  /** §7.3 OBSERVER_DRAIN: fire deferred observers from the saved shape/write pointers. */
  observerDrain(): void {
    if (!this.#observers.hasObservers) {
      this.#observerShapePtr.cursor = this.#shapeLogHead()
      this.#observerWritePtr.cursor = this.#writeLogHead()
      return
    }
    this.#observers.resetChangeDedup()
    // Structural observers (add/remove) off the shape log.
    this.#shapeLog.consume(this.#observerShapePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) return
      const { index, componentId, kind } = this.#unpackShape(source, base)
      const okind =
        kind === ShapeKind.Add || kind === ShapeKind.AddPair
          ? 'add'
          : kind === ShapeKind.Remove || kind === ShapeKind.RemovePair || kind === ShapeKind.Destroy
            ? 'remove'
            : null
      if (okind === null) return // CREATE has no per-component observer
      this.#observers.dispatchStructural(okind, index, componentId)
    })
    // Change observers off the write log.
    this.#writeLog.consume(this.#observerWritePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) {
        if (this.#currentMembers !== null) this.#observers.fireAllChangeConservatively(this.#currentMembers())
        return
      }
      const { index, componentId } = this.#unpackWrite(source, base)
      this.#observers.dispatchChange(index, componentId)
    })
  }

  /** §8.2 FLUSH_LOGS: drain/merge spill (consumers already drained it), schedule next-frame resize. */
  flushLogs(): void {
    if (this.#writeLog.spill.length > 0 || this.#shapeLog.spill.length > 0) this.#spilledThisFrame = true
    this.#writeLog.observePeak()
    this.#shapeLog.observePeak()
    if (this.#deps.dev && this.#spilledThisFrame && typeof console !== 'undefined') {
      console.warn(
        `[ecsia] reactivity log overflowed its ring this frame; entries spilled to the main-thread ` +
          `array and the ring will grow next frame. Set createWorld({ reactivity: { maxWritesPerFrame / ` +
          `maxShapeChangesPerFrame } }) to pre-size.`,
      )
    }
  }

  // --- internals -------------------------------------------------------------

  #shapeLogHead(): number {
    return this.#shapeLog.header[0] as number
  }
  #writeLogHead(): number {
    return this.#writeLog.header[0] as number
  }

  #minWriteCursor(): number {
    let min = this.#writeLog.header[0] as number
    if (this.#observerWritePtr.cursor < min) min = this.#observerWritePtr.cursor
    // changed-flavor pointers are drained lazily; they pin the ring until read so the recycle never
    // overruns an unread consumer (§3.7 "ring is not recycled past a lagging pointer"). In the common
    // case every system reads its filter within the frame, so they equal head and the ring recycles.
    for (const ptr of this.#changedPointers) if (ptr.cursor < min) min = ptr.cursor
    return min
  }
  #minShapeCursor(): number {
    let min = this.#shapeLog.header[0] as number
    if (this.#observerShapePtr.cursor < min) min = this.#observerShapePtr.cursor
    if (this.#maintainShapePtr.cursor < min) min = this.#maintainShapePtr.cursor
    return min
  }
}

const EMPTY_U32 = new Uint32Array(0)
