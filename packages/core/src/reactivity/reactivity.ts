// The reactivity facade: owns the write log + shape log, the per-row changeVersion
// columns, the deferred observers, and the query-flavor hooks. It fills the trackWrite stub, the
// enqueueRemoveLog stub, and the LiveQuery.changed()/eachChanged() stubs — wiring the dual
// mechanism the spec mandates:
// - the WRITE LOG drives the `.changed` query FILTER (drainChanged);
// - the per-row changeVersion drives the PUBLIC changedSince predicate + delta serializer.
// They never read each other's mechanism.

import type { Buffers } from '../memory/index.js'
import type { ComponentDef, ComponentId, EntityHandle, Schema } from '@ecsia/schema'
import type { EntityRef } from '../entity/index.js'
import type { LiveQuery } from '../query/index.js'
import { LogRing, OVERFLOW_SENTINEL, ShapeKind, WriteCorral } from './log.js'
import type { LogPointer } from './log.js'
import { ChangeVersionStore } from './change-version.js'
import { StructuralJournal } from './structural-journal.js'
import type { StructuralRecord } from './structural-journal.js'
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
  /** Advance the world frame tick (world.advanceTick). Called at frameReset. */
  advanceTick(): void
  /** Resolve a registered def's dense id. */
  idOf(def: ComponentDef<Schema>): ComponentId
  /** Does `index` currently hold ALL of `componentIds`? */
  holdsAll(index: number, componentIds: readonly ComponentId[]): boolean
  /** The pooled EntityRef an observer event at `index` dispatches with — the stashed dying handle
   * while a rich pending-clear window covers the index, else the current handle (see
   * ObserverDeps.eventRefOf). */
  eventRefOf(index: number): EntityRef
  /** A Destroy entry for `index` was drained — pairs the oldest rich pending-clear stash with its
   * dead tenant so a LATER Create can be recognized as a re-mint (see onCreateDrained). */
  onDestroyDrained(index: number): void
  /** A Create entry for `index` was drained AFTER a Destroy: the index was re-minted inside this
   * observer window, so the oldest pending-clear tenant's remove events are all behind the drain
   * cursor (log order) and its stash window closes. */
  onCreateDrained(index: number): void
  /** index → its current FULL (generational) handle — for the structural journal's portable handles. */
  resolveHandle(index: number): number
  /** The accessor's shared write-path fast-out cell. Reactivity flips `.active` whenever a write consumer
   * (changed-flavor pointer / change observer) or changeVersion stamping (de)registers, so the setter's
   * `track()` can skip the handleIndex decode + closure hops when no consumer is present. */
  readonly tracking: { active: boolean }
}

/** Per-query write-log flavor state: a LogPointer + a per-frame dedup bitset. */
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
  readonly #structuralJournal: StructuralJournal
  readonly #observers: ObserverRegistry
  readonly #corral: WriteCorral
  /** One per LiveQuery that declares the `changed` flavor (lazily allocated). */
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
  /** Relations-installed: synthetic pair ComponentId → RelationId (-1 = not a pair / unknown).
   * Drives relation-level pair observer dispatch; null in a relations-free world. */
  #pairObserverResolver: ((pairComponentId: number) => number) | null = null
  #spilledThisFrame = false
  /** True iff the write log has a consumer (a changed-flavor pointer or a change observer); else the
   * per-write push is dead (recomputed on (de)registration, not per write). */
  #writeLogActive = false

  constructor(deps: ReactivityDeps) {
    this.#deps = deps
    this.#wide = deps.logEntryWords === 2
    this.#indexMask = deps.indexBits >= 32 ? 0xffffffff : ((1 << deps.indexBits) - 1) >>> 0
    this.#componentIdBits = 32 - deps.indexBits

    // One-word write entry / two-word shape entry by default; wide worlds add a word each.
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
    this.#structuralJournal = new StructuralJournal(Math.max(1024, deps.maxShapeChangesPerFrame))
    this.#corral = new WriteCorral()

    const obsDeps: ObserverDeps = {
      idOf: deps.idOf,
      holdsAll: deps.holdsAll,
      eventRefOf: deps.eventRefOf,
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

  /** Late-bind the relations runtime's pairId→relationId resolver (createRelations installs it). */
  setPairObserverResolver(fn: (pairComponentId: number) => number): void {
    this.#pairObserverResolver = fn
  }

  // --- entry packing -------------------------------------------

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

  // --- hot-path hooks -------------------------------------

  /** +: push the write entry (when a consumer exists) and stamp changeVersion (when enabled).
   * Single-thread. The write log is read ONLY by changed-flavor query pointers and change observers; with
   * neither present every appended word is dead (rewound at frame-recycle), so the push is a pure cost on
   * the iteration hot path. Gate it on `#writeLogActive` (recomputed on flavor/observer (de)registration) —
   * a semantics-preserving fast-out, since a later-attached changed flavor's pointer starts at the live head
   * and sees only writes after it attaches. Pack the word inline (no per-write array). */
  trackWrite(index: number, componentId: ComponentId, fieldIndex?: number): void {
    if (this.#writeLogActive) {
      // Main thread: append directly to the ring. (Worker corrals merge at mergeCorrals — .)
      if (this.#wide) {
        this.#writeLog.pushWord(index >>> 0)
        this.#writeLog.pushWord(componentId as number >>> 0)
      } else {
        this.#writeLog.pushWord(((((componentId as number) << this.#deps.indexBits) | (index & this.#indexMask)) >>> 0))
      }
    }
    if (this.#changeVersion.enabled) {
      // fieldIndex affects only field-granular stamping (deferred); component-granular default
      // stamps the whole-entity slot regardless of which component/field changed. Keyed by entity INDEX
      // so the stamp follows the entity across any later relocation.
      void fieldIndex
      this.#changeVersion.stamp(index, this.#deps.tick())
    }
  }

  /**: append one shape entry. Main thread only, O(1). */
  trackShape(index: number, componentId: ComponentId, kind: ShapeKind): void {
    this.#shapeLog.push(this.#packShapeEntry(index, componentId as number, kind))
    // Persistent since-T mirror for the delta serializer. Resolve the
    // FULL handle NOW — for Destroy this hook runs BEFORE identity invalidation,
    // so the dying handle is still recoverable. No-op until a delta serializer enables journaling.
    if (this.#structuralJournal.enabled) {
      this.#structuralJournal.record(
        this.#deps.tick(),
        kind,
        this.#deps.resolveHandle(index),
        componentId as number,
        0,
      )
    }
  }

  /**: carries the target index in word B/C. `journal: false` marks an OBSERVER-ONLY carrier entry
   * (the exclusive valve's pair events ride the presence id) — it reaches the shape log (observers +
   * query maintenance) but NOT the structural journal: exclusive pairs serialize through the eid
   * column snapshot, and a presence-id pair record would corrupt the since-T delta replay. */
  trackShapePair(
    index: number,
    pairId: ComponentId,
    targetIndex: number,
    kind: ShapeKind.AddPair | ShapeKind.RemovePair,
    journal = true,
  ): void {
    // Observer-only carriers exist solely for pair observers — with none registered, skip the ring
    // push entirely (the trackWrite/#writeLogActive precedent): the exclusive valve's retarget
    // stays a zero-shape-entry write in pair-observer-free worlds, exactly its pre-carrier cost.
    if (!journal && !this.#observers.hasPairObservers) return
    this.#shapeLog.push(this.#packShapeEntry(index, pairId as number, kind, targetIndex))
    if (journal && this.#structuralJournal.enabled) {
      this.#structuralJournal.record(
        this.#deps.tick(),
        kind,
        this.#deps.resolveHandle(index),
        pairId as number,
        this.#deps.resolveHandle(targetIndex),
      )
    }
  }

  /**
   * _PAYLOAD: a non-exclusive overflow pair's payload changed on an already-live pair. This is
   * NOT a membership change (no shape-log entry, no add/remove observer), but it IS a structural delta
   * the since-T stream must carry, so we record it in the persistent journal only
   * (overflow payload changes are explicit OP_PAIR_PAYLOAD records).
   */
  trackShapeSetPayload(index: number, pairId: ComponentId, targetIndex: number): void {
    if (this.#structuralJournal.enabled) {
      this.#structuralJournal.record(
        this.#deps.tick(),
        ShapeKind.SetPayload,
        this.#deps.resolveHandle(index),
        pairId as number,
        this.#deps.resolveHandle(targetIndex),
      )
    }
  }

  /**
   * The enqueueRemoveLog stub body: storage calls this for each component in fromArch \ toArch at
   * a migration, and for each held component at despawn (BEFORE removeRow + identity invalidation,
   * ). It emits a shape-log Remove entry — the single source for onRemove dispatch + Removed
   * delta maintenance.
   */
  enqueueRemoveLog(index: number, componentId: ComponentId): void {
    this.trackShape(index, componentId, ShapeKind.Remove)
  }

  // --- public predicate + delta ---------------------------------------

  /** ROLLBACK-ONLY: the changeVersion column owner, so @ecsia/rollback can image its stamps. */
  get changeVersionStore(): ChangeVersionStore {
    return this.#changeVersion
  }

  /** Enable per-row changeVersion stamping (a `.changed` predicate consumer / serializer exists). */
  enableChangeVersion(): void {
    this.#changeVersion.enabled = true
    this.#deps.tracking.active = true
  }

  /**
   * Enable the persistent structural journal (the since-T STRUCTURAL source). A delta serializer
   * that includes the structural section calls this once at construction — it is the structural twin of
   * `enableChangeVersion`. Until then, zero record cost.
   */
  enableStructuralJournal(): void {
    this.#structuralJournal.enabled = true
  }

  /**
   * /: the structural ops committed with tick > since, in commit order, as portable full-handle
   * records. `gap` is true when `since` predates the bounded journal's live window (the caller must
   * resync from a fresh snapshot — the no-partial-apply delta-gap rule).
   */
  drainStructuralSince(since: number): { records: StructuralRecord[]; gap: boolean } {
    return this.#structuralJournal.drainSince(since)
  }

  /**: "did any component on `handle` change since tick `since`?" (strict >). */
  changedSince(handle: EntityHandle, since: number): boolean {
    const index = handle & this.#indexMask
    return this.#changeVersion.changedSince(index, since)
  }

  /**
   * /: rows of `archetypeId` whose ENTITY's stamp is > since (the delta-serializer scan).
   * `indexOfRow` maps a live row of the archetype to its entity index — the stamp is keyed by entity
   * index (it follows the entity across relocations), so we resolve each row's current occupant.
   */
  *changedRows(_archetypeId: number, since: number, count: number, indexOfRow: (row: number) => number): Iterable<number> {
    for (let row = 0; row < count; row++) {
      if (this.#changeVersion.changedSince(indexOfRow(row), since)) yield row
    }
  }

  currentTick(): number {
    return this.#deps.tick()
  }

  // --- observers --------------------------------------------------------

  /** Recompute the write-log fast-out flag after any consumer (de)registers. Also refreshes the
   * accessor's shared `tracking.active` cell: true iff trackWrite would do real work (a write-log
   * consumer exists OR changeVersion stamping is enabled). When false the setter skips the whole chain. */
  #refreshWriteLogActive(): void {
    this.#writeLogActive = this.#changedPointers.length > 0 || this.#observers.hasChangeObservers
    this.#deps.tracking.active = this.#writeLogActive || this.#changeVersion.enabled
  }

  observe(term: ObserverTerm, handler: ObserverHandler): ObserverHandle {
    const handle = this.#observers.observe(term, handler)
    this.#refreshWriteLogActive()
    const dispose = handle.dispose
    return {
      id: handle.id,
      dispose: (): void => {
        dispose()
        this.#refreshWriteLogActive()
      },
    }
  }

  /**: is there a remove-observer on `componentId` (gates deferred row reclaim)? */
  hasRemoveObserver(componentId: number): boolean {
    return this.#observers.hasKindFor('remove', componentId)
  }

  /** Any remove-observer at all — arms the deferred-despawn window (numeric location stash). */
  get hasAnyRemoveObserver(): boolean {
    return this.#observers.hasAnyRemoveObserver
  }

  // --- query-flavor hooks ---------------------

  /**
   *: allocate the `changed` flavor's LogPointer + dedup bitset for `q`. `added`/`removed` lists
   * are owned by the LiveQuery itself and filled by maintenance; this hook wires only `changed`.
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
    this.#refreshWriteLogActive()
  }

  /**
   * _CHANGED: drain `q`'s write-log pointer, returning this frame's changed indices (deduped,
   * intersected with `q.current` and the query's filtered components). Write-log driven — never
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
        // Treat every current match as changed.
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

  // --- lifecycle -------------------------------

  /**: start of frame — advance the world tick, snapshot peak, recycle the rings. */
  frameReset(): void {
    this.#deps.advanceTick()
    if (this.#deps.tick() === 0xffffffff) {
      this.#changeVersion.resetAll() //
      this.#structuralJournal.resetAll()
    }
    this.#spilledThisFrame = false
    this.#resetLog(this.#writeLog, [this.#observerWritePtr, ...this.#changedPointers])
    this.#resetLog(this.#shapeLog, [this.#observerShapePtr, this.#maintainShapePtr])
  }

  /** Recycle one log at the frame boundary, then realign its consumers. The reset discards the
   * spill, bumping the generation when any consumer had not drained it (LogRing.frameReset) — a
   * lagging consumer keeps its now-stale generation so its next consume takes the conservative
   * OVERFLOW_SENTINEL path. Fully-drained consumers absorb the bump (generation re-synced, spill
   * cursor rewound) so only laggards pay the sentinel; when the ring recycled to slot 0 their ring
   * cursors rewind too, so they scan the new frame's entries from the head. */
  #resetLog(log: LogRing, pointers: readonly LogPointer[]): void {
    const header = log.header
    const spillCount = header[2] as number
    const genBefore = header[1] as number
    let minCursor = header[0] as number
    let minSpill = spillCount
    // Consumers (e.g. changed-flavor pointers) are drained lazily; a lagging ring cursor pins the
    // ring so the recycle never overruns an unread consumer. In the common case every consumer
    // drains within the frame, so the mins equal head/spillCount and the ring recycles cleanly.
    for (const ptr of pointers) {
      if (ptr.cursor < minCursor) minCursor = ptr.cursor
      if (ptr.spillCursor < minSpill) minSpill = ptr.spillCursor
    }
    log.frameReset(minCursor, minSpill)
    const genAfter = header[1] as number
    const recycled = (header[0] as number) === 0
    for (const ptr of pointers) {
      // generation === genBefore excludes a consumer with a sentinel already pending from an
      // EARLIER reset — re-syncing it here would erase that sentinel before it ever drained.
      if (ptr.generation === genBefore && ptr.spillCursor >= spillCount) {
        ptr.generation = genAfter
        ptr.spillCursor = 0
        if (recycled) ptr.cursor = 0
      }
    }
  }

  /**: merge per-worker write corrals into the shared ring (deterministic). No-op single-thread. */
  mergeCorrals(): void {
    const c = this.#corral
    for (let i = 0; i < c.count; i++) {
      this.#writeLog.pushWord(c.data[i] as number)
    }
    c.reset()
  }

  /**
   * /+: merge ONE worker's staged value writes into the shared write log. `pairs` is a
   * flat `[index, componentId, index, componentId, …]` buffer (the worker's raw corral payload); the
   * caller drives this in ASCENDING worker-index order so the merged stream is deterministic. We
   * (re)pack each pair through the module's own packWrite so single/wide layout stays the single
   * source of truth — the worker never duplicates the packing scheme. Writes flow into the SAME ring
   * the main thread appends to, so `.changed` filters and onChange observers fire for worker writes
   * exactly as for single-thread writes.: when changeVersion is enabled we also
   * stamp each row here (the worker hot path stays atomic-free; the stamp lands at the serial merge).
   */
  mergeWorkerWrites(pairs: Int32Array | Uint32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      const index = (pairs[i * 2] as number) >>> 0
      const componentId = (pairs[i * 2 + 1] as number) >>> 0
      for (const w of this.#packWriteEntry(index, componentId)) this.#writeLog.pushWord(w)
      if (this.#changeVersion.enabled) {
        this.#changeVersion.stamp(index, this.#deps.tick())
      }
    }
  }

  /**
   * _STRUCTURAL: drain the shape log, re-testing each affected entity against the queries
   * referencing the changed component. In single-thread mode already maintains `current`
   * synchronously at the commit point, so this re-runs the same idempotent re-test off the log (the
   * drain is the spec's serial mechanism; the synchronous path is the optimization that agrees with
   * it). Add/remove coalesce within the frame because the drain happens once.
   */
  maintainStructural(): void {
    const hook = this.#maintainHook
    if (hook === null) {
      // Full sync (not just cursor): a stale spillCursor would mark this pointer as a spill
      // laggard at frameReset and force a spurious generation bump.
      this.#syncPointer(this.#shapeLog, this.#maintainShapePtr)
      return
    }
    this.#shapeLog.consume(this.#maintainShapePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) return
      const { index, componentId, kind } = this.#unpackShape(source, base)
      if (kind === ShapeKind.Add || kind === ShapeKind.Remove) hook(index, componentId)
    })
  }

  /** _DRAIN: fire deferred observers from the saved shape/write pointers. */
  observerDrain(): void {
    if (!this.#observers.hasObservers) {
      // Full sync (not just cursor): a stale spillCursor would mark these pointers as spill
      // laggards at frameReset and force a spurious generation bump.
      this.#syncPointer(this.#shapeLog, this.#observerShapePtr)
      this.#syncPointer(this.#writeLog, this.#observerWritePtr)
      return
    }
    this.#observers.resetChangeDedup()
    // Capture BOTH log heads at drain entry. A structural (add/remove) handler may
    // call entity.write(C), which appends to the write log; bounding the change consume to this snapshot
    // defers that observer-issued write to the NEXT drain — no intra-drain write-cascade (review #2).
    const writeHeadSnapshot = this.#writeLogHead()
    // Structural observers (add/remove) off the shape log.
    this.#shapeLog.consume(this.#observerShapePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) return
      const { index, componentId, kind } = this.#unpackShape(source, base)
      // A Create that follows a Destroy at the same index marks a re-mint: every remove/destroy
      // event of the tenant that died before it has already dispatched, so the sidecar's pending
      // window advances past it. The Destroy hook is what tells a re-mint Create apart from the
      // dying tenant's own same-window mint.
      if (kind === ShapeKind.Create) {
        this.#deps.onCreateDrained(index)
        return
      }
      if (kind === ShapeKind.Destroy) this.#deps.onDestroyDrained(index)
      const okind =
        kind === ShapeKind.Add || kind === ShapeKind.AddPair
          ? 'add'
          : kind === ShapeKind.Remove || kind === ShapeKind.RemovePair || kind === ShapeKind.Destroy
            ? 'remove'
            : null
      if (okind === null) return // CREATE has no per-component observer
      this.#observers.dispatchStructural(okind, index, componentId)
      // Relation-level pair observers (onPairAdded/onPairRemoved): a pair entry ALSO dispatches on
      // its relation, resolved from the synthetic pair id via the relations-installed resolver —
      // core never learns relation structure (the acyclic boundary). Gated so worlds without pair
      // observers pay one boolean per pair entry.
      if (
        (kind === ShapeKind.AddPair || kind === ShapeKind.RemovePair) &&
        this.#observers.hasPairObservers &&
        this.#pairObserverResolver !== null
      ) {
        const relationId = this.#pairObserverResolver(componentId)
        if (relationId >= 0) {
          this.#observers.dispatchPair(kind === ShapeKind.AddPair ? 'pair-add' : 'pair-remove', index, relationId, componentId)
        }
      }
    })
    // Change observers off the write log.
    this.#writeLog.consume(this.#observerWritePtr, (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) {
        if (this.#currentMembers !== null) this.#observers.fireAllChangeConservatively(this.#currentMembers())
        return
      }
      const { index, componentId } = this.#unpackWrite(source, base)
      this.#observers.dispatchChange(index, componentId)
    }, writeHeadSnapshot)
  }

  /**
   * Drop the rest of the in-flight observer window after a handler threw mid-drain. The consume
   * advances a pointer only AFTER its loop completes, so a throw leaves the cursor at the window's
   * start — but the sidecar's pending stashes and despawn ordinals are flushed in the caller's
   * finally regardless. Replaying the window's remainder next drain would then pair its Destroy
   * entries against the NEXT window's stashes (misattribution). The window is already lost (its
   * handlers partially ran); fast-forwarding both consumers to head keeps counters and cursors
   * consistent with the flushed sidecar state.
   */
  abandonObserverWindow(): void {
    this.#syncPointer(this.#shapeLog, this.#observerShapePtr)
    this.#syncPointer(this.#writeLog, this.#observerWritePtr)
  }

  #syncPointer(log: LogRing, ptr: LogPointer): void {
    const head = log.makePointer()
    ptr.cursor = head.cursor
    ptr.generation = head.generation
    ptr.spillCursor = head.spillCursor
  }

  /** _LOGS: drain/merge spill (consumers already drained it), schedule next-frame resize. */
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

  #writeLogHead(): number {
    return this.#writeLog.header[0] as number
  }
}

const EMPTY_U32 = new Uint32Array(0)
