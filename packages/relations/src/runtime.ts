// @ecsia/relations runtime. First-class integer-encoded (relationId, targetIndex)
// pairs as ordinary archetype members: eager O(1) pair-id minting, the per-relation presence bit for
// O(1) wildcard match, the exclusivity storage split, the main-thread back-ref index,
// and the iterative-BFS cascade. Attaches to a world through the core RelationsHost seam — this
// module imports @ecsia/core; @ecsia/core NEVER imports it (the acyclic boundary).

import type {
  ComponentDef,
  ComponentId,
  EntityHandle,
  PairDef,
  ReadView,
  RelationDef,
  RelationId,
  RelationOptions,
  Schema,
  SpawnArg,
  SpawnArgFor,
  WildcardToken,
  WriteView,
} from '@ecsia/schema'
import {
  defineComponent,
  buildColumnSet,
  bindAccessorRow,
  decodeEid,
  encodeEid,
  IS_DEV,
  NO_ENTITY,
} from '@ecsia/core'
import type {
  Column,
  ColumnSet,
  RelationsHost,
  ResolvedPair,
  SerializePair,
  SerializeRelationProvider,
  World,
} from '@ecsia/core'
import { pairKey64, overflowKey64 } from './pair-key.js'

const WILDCARD = Symbol.for('ecsia.query.wildcard')
/** The wildcard target sentinel: `Pair(R, Wildcard)` matches every R-pair via the presence bit. */
export const Wildcard: WildcardToken = WILDCARD as never as WildcardToken

export type StorageKind = 'tag' | 'exclusive-column' | 'overflow-table'

/** resolveStorageKind: payload-free → tag; payload+exclusive → column; else overflow. */
function resolveStorageKind(hasPayload: boolean, exclusive: boolean): StorageKind {
  if (!hasPayload) return 'tag'
  return exclusive ? 'exclusive-column' : 'overflow-table'
}

/** The payload schema carried by a relation def, or `void` for a payload-free relation. */
type PayloadOf<R extends RelationDef<Schema | void>> = R extends RelationDef<infer P> ? P : never

/**
 * A typed payload accessor over the exclusive subject column or the overflow row. The read/write
 * views are forked from the relation's payload schema (Item 7); a payload-free relation yields an empty
 * accessor.
 */
export interface PairAccessor<R extends RelationDef<Schema | void> = RelationDef<Schema | void>> {
  read(): PayloadOf<R> extends Schema ? ReadView<PayloadOf<R>> : Record<never, never>
  write(): PayloadOf<R> extends Schema ? WriteView<PayloadOf<R>> : Record<never, never>
}

/**
 * The `addPair` payload argument, threaded from the relation's payload schema (Item 7): a payloaded
 * relation accepts a partial write view; a payload-free relation accepts no payload argument at all.
 */
type AddPairPayloadArg<R extends RelationDef<Schema | void>> = PayloadOf<R> extends Schema
  ? [payload?: Partial<WriteView<PayloadOf<R>>>]
  : []

/** The first argument of `definePrefab`: name one base prefab to extend (single inheritance). */
export interface DefinePrefabOptions {
  /**
   * An already-defined prefab handle whose flattened components (and values) the new prefab
   * starts from; this prefab's own inits win on overlap. Because the base must already exist,
   * inheritance chains form a DAG by construction.
   */
  readonly extends: EntityHandle
}

interface OverflowTable {
  readonly overflowComponentId: ComponentId
  readonly def: ComponentDef<Schema>
  readonly columnSet: ColumnSet
  readonly rowByPairKey: Map<bigint, number>
  readonly pairByRow: Map<number, { subjectIndex: number; targetIndex: number }>
  freeRows: number[]
  count: number
}

interface RelationRuntime {
  readonly def: RelationDef<Schema | void>
  readonly relationId: RelationId
  readonly presenceId: ComponentId
  readonly presenceDef: ComponentDef<Schema>
  readonly exclusive: boolean
  readonly cascade: 'none' | 'deleteSubject' | 'removeRelation'
  readonly storageKind: StorageKind
  /** Field index of the exclusive `eid` target column within presenceDef's ColumnSet (-1 otherwise). */
  readonly subjectTargetFieldIndex: number
  readonly overflow: OverflowTable | null
  /** targetIndex → subject handles. */
  readonly backref: Map<number, Set<EntityHandle>>
  /** Lazily-allocated depth cache, exclusive relations only. Entries are valid only while their
   * stamp matches `gen`; ANY structural change to the relation bumps `gen` (O(1) whole-cache
   * invalidation). A per-subject dirty set is NOT enough: re-targeting or detaching a mid-chain
   * subject changes the depth of its whole subtree, and descendants are not enumerable here
   * without an eager reverse index. */
  depth: { depth: Int32Array; stamp: Float64Array; gen: number } | null
}

interface RelationsApi {
  defineRelation<P extends Schema>(payload: P, options?: RelationOptions): RelationDef<P>
  defineRelation(payload: null, options?: RelationOptions): RelationDef<void>
  addPair<R extends RelationDef<Schema | void>>(
    subject: EntityHandle,
    relation: R,
    target: EntityHandle,
    ...payload: AddPairPayloadArg<R>
  ): void
  removePair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): void
  hasPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): boolean
  hasRelation(subject: EntityHandle, relation: RelationDef<Schema | void>): boolean
  getPair<R extends RelationDef<Schema | void>>(subject: EntityHandle, relation: R, target: EntityHandle): PairAccessor<R>
  /**
   * Reverse query: every entity that points AT `target` (each one a "subject" — the pointing
   * end of a pair) through `relation`. Pass `Wildcard` as the relation to ask across ALL
   * registered relations at once — "who points at this entity via anything?" — handy before a
   * despawn to see what a removal would touch. Each subject is yielded once, even when it
   * points at `target` through several relations. Reads the same target→subjects index the
   * despawn cascade uses — the typed form is O(1) to the subject set; the wildcard form is
   * O(R) bucket lookups (R = registered relations) — never an entity scan. When the loop body
   * mutates pairs (despawn / removePair / exclusive re-target), snapshot first
   * (`[...rel.subjectsOf(Wildcard, t)]`), then mutate — the cascade discipline.
   */
  subjectsOf(relation: RelationDef<Schema | void> | WildcardToken, target: EntityHandle): Iterable<EntityHandle>
  targetsOf(subject: EntityHandle, relation: RelationDef<Schema | void>): Iterable<EntityHandle>
  /**: the single current target of an exclusive relation (eid column read, O(1)); null if absent. Throws on a non-exclusive relation. */
  targetOf(subject: EntityHandle, relation: RelationDef<Schema | void>): EntityHandle | null
  depthOf(subject: EntityHandle, relation: RelationDef<Schema | void>): number
  /**
   * Build a relation-pair query term usable directly in `query(...)`: `query(rel.Pair(ChildOf, parent))`
   * or `query(rel.Pair(ChildOf, Wildcard))`. Returns a typed `PairDef<R>` — the query compiler resolves
   * its concrete (presence/pair) ComponentId via the relations resolver at compile time.
   */
  readonly Pair: <R extends RelationDef<Schema | void>>(relation: R, target: EntityHandle | WildcardToken) => PairDef<R>

  // --- prefabs (createWorld({ prefabs: true })) ------------------------------

  /**
   * The built-in `IsA` relation (a payload-free, non-exclusive tag relation). Every instance
   * spawned by `spawnFrom` records one `Pair(IsA, ancestor)` per prefab in its inheritance chain,
   * so `query(rel.Pair(IsA, Goblin))` matches every goblin-family instance — subtypes included —
   * as a plain signature match. Throws unless the world was created with `prefabs: true`.
   */
  readonly IsA: RelationDef<void>
  /**
   * The built-in `Prefab` tag carried by every template `definePrefab` creates. Queries skip
   * Prefab-tagged entities by default; use `query(has(Prefab))` for the templates themselves or
   * `{ matchPrefabs: true }` for both. Throws unless the world was created with `prefabs: true`.
   */
  readonly Prefab: ComponentDef<Record<never, never>>
  /**
   * Create a prefab: an ordinary entity tagged `Prefab` that acts as a spawn template. Inits use
   * the `spawnWith` tuple form. With `{ extends: Base }` the new prefab starts from Base's full
   * flattened component set and values, applies its own inits on top (the child wins), and records
   * `Pair(IsA, Base)` plus Base's own IsA pairs — the full ancestor set, flattened at define time.
   * Editing a prefab later affects FUTURE spawns only. Inside an observer handler the define
   * STAGES: the returned handle is reserved-alive but materializes at the next flush, and a base
   * despawned before that flush degrades to defaulted values with its IsA pair dropped.
   * Serial-phase, main-thread.
   */
  definePrefab<const T extends readonly SpawnArg[]>(
    opts: DefinePrefabOptions,
    ...inits: { [I in keyof T]: SpawnArgFor<T[I]> }
  ): EntityHandle
  definePrefab<const T extends readonly SpawnArg[]>(...inits: { [I in keyof T]: SpawnArgFor<T[I]> }): EntityHandle
  /**
   * Spawn an instance of a prefab: one migration to the target archetype, then a per-field copy
   * of the prefab's values (a stamp — later prefab edits do NOT retro-update instances), then the
   * overrides on top. Overrides use the `spawnWith` tuple form and may both override copied values
   * and add components the prefab lacks. The instance records `Pair(IsA, ancestor)` for the full
   * chain. The prefab's own non-IsA relation pairs are NOT copied. A despawned/stale prefab handle
   * throws in dev and returns NO_ENTITY in production. Inside an observer handler the spawn
   * STAGES to the next flush; a source despawned before that flush degrades the instance to
   * defaulted values (dev warn), and a dead ancestor drops its IsA pair. Serial-phase, main-thread.
   */
  spawnFrom<const T extends readonly SpawnArg[]>(
    prefab: EntityHandle,
    ...overrides: { [I in keyof T]: SpawnArgFor<T[I]> }
  ): EntityHandle
}

const EMPTY_SET: ReadonlySet<EntityHandle> = new Set()

export function createRelations(world: World): RelationsApi {
  const host: RelationsHost = world.__installRelations()
  // Pair keys index by the WORLD's target-index width (= 32 - generationBits). Captured once
  // from the host so a non-default generationBits keys the SAME targetIndex host.handleIndex produces.
  const indexBits = host.indexBits

  let nextRelationId = 0
  const relations: RelationRuntime[] = []
  const byDef = new Map<RelationDef<Schema | void>, RelationRuntime>()
  const byRelationId = new Map<number, RelationRuntime>()

  // Logical pairKey64 → synthetic pair ComponentId, plus the reverse + refcount.
  const pairIdByKey = new Map<bigint, ComponentId>()
  const pairKeyById = new Map<ComponentId, { relationId: RelationId; targetIndex: number }>()
  const pairDefById = new Map<ComponentId, ComponentDef<Schema>>()
  const pairsByRelation = new Map<number, Set<ComponentId>>()
  const pairRefCount = new Map<ComponentId, number>()
  // Every relation's presence ComponentId — with pairKeyById, the filter that splits a prefab's
  // copyable components from its relation artifacts (spawnFrom copies components only).
  const presenceIds = new Set<number>()
  // presenceId -> relationId, for the pair-observer resolver: the exclusive valve journals its pair
  // events on the presence id (no per-target pair ids exist on that path).
  const relationIdByPresence = new Map<number, number>()

  // SubjectIndex → (relationId → count).
  const relationPairCount = new Map<number, Map<number, number>>()
  // (subject → targets), allocated per relation on first targetsOf use.
  const forwardIndex = new Map<number, Map<number, Set<number>>>()

  let overflowArchetypeSeq = -1000000 // synthetic archetypeId namespace for overflow ColumnSets (never a real archetype)

  // --- presence/pair/overflow def construction -------------------------------

  function makePresenceDef(name: string, exclusive: boolean, payload: Schema | null): ComponentDef<Schema> {
    if (exclusive) {
      // An exclusive relation's presence id ALWAYS carries the eid target column (field 0) so
      // re-target is an in-place column write (the T1 valve) and depth can walk the parent chain —
      // even for a payload-free exclusive relation (just the target column). Payload (if any) follows
      // as fields 1..|P|.
      const schema = { $t: 'eid', ...(payload ?? {}) } as Schema
      return defineComponent(schema, { brand: `${name}$presence` })
    }
    // non-exclusive tag / overflow-table: zero-field presence bit (pure signature membership).
    return defineComponent({}, { brand: `${name}$presence`, storage: 'sparse' })
  }

  function makePairDef(relationId: RelationId, targetIndex: number): ComponentDef<Schema> {
    // The per-target pair member is a zero-field tag — payload (if any) lives in the overflow table
    // or, for exclusive, in the presence column. The pair id is pure signature membership.
    return defineComponent({}, { brand: `pair$${relationId as number}.${targetIndex}`, storage: 'sparse' })
  }

  function buildOverflow(name: string, payload: Schema): OverflowTable {
    const id = host.allocSyntheticId()
    const def = defineComponent(payload, { brand: `${name}$overflow` })
    host.registerSynthetic(def, id)
    const columnSet = buildColumnSet({
      buffers: host.buffers,
      archetypeId: overflowArchetypeSeq--,
      def,
      world: host.accessorWorld,
      initialCapacity: 16,
    })
    return {
      overflowComponentId: id,
      def,
      columnSet,
      rowByPairKey: new Map(),
      pairByRow: new Map(),
      freeRows: [],
      count: 0,
    }
  }

  // --- (eager, O(1), idempotent, index-keyed) ------------------

  function mintPair(rt: RelationRuntime, targetIndex: number): ComponentId {
    const key = pairKey64(rt.relationId, targetIndex, indexBits)
    const existing = pairIdByKey.get(key)
    if (existing !== undefined) return existing
    const cid = host.allocSyntheticId()
    const def = makePairDef(rt.relationId, targetIndex)
    host.registerSynthetic(def, cid)
    pairIdByKey.set(key, cid)
    pairKeyById.set(cid, { relationId: rt.relationId, targetIndex })
    pairDefById.set(cid, def)
    let set = pairsByRelation.get(rt.relationId as number)
    if (set === undefined) {
      set = new Set()
      pairsByRelation.set(rt.relationId as number, set)
    }
    set.add(cid)
    pairRefCount.set(cid, 0)
    return cid
  }

  function lookupPairId(relationId: RelationId, targetIndex: number): ComponentId | undefined {
    return pairIdByKey.get(pairKey64(relationId, targetIndex, indexBits))
  }

  // ---

  function pairCountOf(sIdx: number, relationId: RelationId): number {
    return relationPairCount.get(sIdx)?.get(relationId as number) ?? 0
  }
  function incrPairCount(sIdx: number, relationId: RelationId): void {
    let inner = relationPairCount.get(sIdx)
    if (inner === undefined) {
      inner = new Map()
      relationPairCount.set(sIdx, inner)
    }
    inner.set(relationId as number, (inner.get(relationId as number) ?? 0) + 1)
  }
  function decrPairCount(sIdx: number, relationId: RelationId): void {
    const inner = relationPairCount.get(sIdx)
    if (inner === undefined) return
    const n = (inner.get(relationId as number) ?? 0) - 1
    if (n <= 0) inner.delete(relationId as number)
    else inner.set(relationId as number, n)
    if (inner.size === 0) relationPairCount.delete(sIdx)
  }

  // ---

  function backrefAdd(rt: RelationRuntime, tIdx: number, subject: EntityHandle): void {
    let set = rt.backref.get(tIdx)
    if (set === undefined) {
      set = new Set()
      rt.backref.set(tIdx, set)
    }
    set.add(subject)
  }
  function backrefRemove(rt: RelationRuntime, tIdx: number, subject: EntityHandle): void {
    const set = rt.backref.get(tIdx)
    if (set === undefined) return
    set.delete(subject)
    if (set.size === 0) rt.backref.delete(tIdx)
  }

  function forwardAdd(rt: RelationRuntime, sIdx: number, tIdx: number): void {
    const fwd = forwardIndex.get(rt.relationId as number)
    if (fwd === undefined) return // not active → not maintained (pay-for-what-you-use)
    let set = fwd.get(sIdx)
    if (set === undefined) {
      set = new Set()
      fwd.set(sIdx, set)
    }
    set.add(tIdx)
  }
  function forwardRemove(rt: RelationRuntime, sIdx: number, tIdx: number): void {
    const fwd = forwardIndex.get(rt.relationId as number)
    const set = fwd?.get(sIdx)
    if (set === undefined) return
    set.delete(tIdx)
    if (set.size === 0) fwd?.delete(sIdx)
  }

  // --- /free --------------------------------------------

  function overflowRowFor(ov: OverflowTable, sIdx: number, tIdx: number, create: boolean): number {
    const key = overflowKey64(sIdx, tIdx, indexBits)
    const row = ov.rowByPairKey.get(key)
    if (row !== undefined) return row
    if (!create) return -1
    const r = ov.freeRows.pop() ?? ov.count++
    // grow the columns if needed (length-tracking views auto-widen on grow)
    for (const col of ov.columnSet.columns) if (ov.count > col.capacity()) host.buffers.grow(col, ov.count)
    ov.rowByPairKey.set(key, r)
    ov.pairByRow.set(r, { subjectIndex: sIdx, targetIndex: tIdx })
    return r
  }
  function releaseOverflowRow(ov: OverflowTable, row: number): void {
    const meta = ov.pairByRow.get(row)
    if (meta === undefined) return
    ov.rowByPairKey.delete(overflowKey64(meta.subjectIndex, meta.targetIndex, indexBits))
    ov.pairByRow.delete(row)
    ov.freeRows.push(row)
  }

  // --- exclusive subject target column access -------------------------

  function exclusiveTargetCol(rt: RelationRuntime, subject: EntityHandle): { col: Column; row: number } | null {
    // fieldLocationFor (not columnSetFor): a COLD-resident subject must still resolve its target
    // column. columnSetFor is hot-only — using it here silently dropped the target read on a cold
    // subject, which masked an existing target (double-counting pairCount) and no-op'd re-targets.
    const r = host.fieldLocationFor(subject, rt.presenceDef)
    if (r === null) return null
    const col = r.set.columns[rt.subjectTargetFieldIndex]
    if (col === undefined) return null
    return { col, row: r.row }
  }
  function readExclusiveTarget(rt: RelationRuntime, subject: EntityHandle): EntityHandle | null {
    const ct = exclusiveTargetCol(rt, subject)
    if (ct === null) return null
    return decodeEid(ct.col.view[ct.row * ct.col.layout.stride] as number)
  }
  function writeExclusiveTarget(rt: RelationRuntime, subject: EntityHandle, target: EntityHandle | null): void {
    const ct = exclusiveTargetCol(rt, subject)
    if (ct === null) return
    ct.col.view[ct.row * ct.col.layout.stride] = target === null ? -1 : encodeEid(target)
  }

  function bindPresenceAccessor(rt: RelationRuntime, subject: EntityHandle): Record<string, unknown> | null {
    // fieldLocationFor (cold-capable) so getPair's accessor resolves a cold-resident subject too.
    const r = host.fieldLocationFor(subject, rt.presenceDef)
    if (r === null) return null
    return bindAccessorRow(r.set, r.row, subject) as unknown as Record<string, unknown>
  }
  function bindOverflowAccessor(ov: OverflowTable, row: number, subject: EntityHandle): Record<string, unknown> {
    return bindAccessorRow(ov.columnSet, row, subject) as unknown as Record<string, unknown>
  }

  function writeExclusivePayload(rt: RelationRuntime, subject: EntityHandle, payload: Record<string, unknown>): void {
    const view = bindPresenceAccessor(rt, subject)
    if (view === null) return
    for (const k of Object.keys(payload)) view[k] = payload[k]
  }
  function writeOverflowPayload(ov: OverflowTable, row: number, subject: EntityHandle, payload: Record<string, unknown>): void {
    const view = bindOverflowAccessor(ov, row, subject)
    for (const k of Object.keys(payload)) view[k] = payload[k]
  }

  // ---

  function addPair(
    subject: EntityHandle,
    relation: RelationDef<Schema | void>,
    target: EntityHandle,
    payload?: Record<string, unknown>,
  ): void {
    if (!host.isAlive(subject)) return
    if (!host.isAlive(target)) return
    // If an observer drain is in flight, stage this op to the world's deferred
    // command buffer and return — it applies at the next serial flush, never mutating mid-drain.
    if (host.deferRelationOp('add', subject, relation, target, payload)) return
    const rt = requireRuntime(relation)
    const sIdx = host.handleIndex(subject)
    const tIdx = host.handleIndex(target)

    if (rt.exclusive) {
      addPairExclusive(rt, subject, target, sIdx, tIdx, payload)
      return
    }

    const cid = mintPair(rt, tIdx)
    if (host.bitmaskHas(sIdx, cid)) {
      // idempotent re-add: only refresh the overflow payload.: an overflow payload change on an
      // already-live pair is journaled as an explicit SET_PAYLOAD structural op (it lives in no archetype
      // column the delta's changed-row scan covers), so a since-T delta carries the new payload.
      if (rt.overflow !== null && payload !== undefined) {
        const row = overflowRowFor(rt.overflow, sIdx, tIdx, true)
        writeOverflowPayload(rt.overflow, row, subject, payload)
        host.trackShapeSetPayload(sIdx, cid, tIdx)
      }
      return
    }

    const addDefs: ComponentDef<Schema>[] = [pairDefById.get(cid) as ComponentDef<Schema>]
    const firstOfRelation = pairCountOf(sIdx, rt.relationId) === 0
    if (firstOfRelation) addDefs.push(rt.presenceDef)
    host.migrateAddingMany(subject, addDefs)

    incrPairCount(sIdx, rt.relationId)
    pairRefCount.set(cid, (pairRefCount.get(cid) ?? 0) + 1)
    backrefAdd(rt, tIdx, subject)
    forwardAdd(rt, sIdx, tIdx)
    host.trackShapePair(sIdx, cid, tIdx, true)
    if (rt.overflow !== null && payload !== undefined) {
      const row = overflowRowFor(rt.overflow, sIdx, tIdx, true)
      writeOverflowPayload(rt.overflow, row, subject, payload)
    }
    markDepthDirty(rt, sIdx)
  }

  // The T1 valve — in-place eid column write, NO migration.
  function addPairExclusive(
    rt: RelationRuntime,
    subject: EntityHandle,
    target: EntityHandle,
    sIdx: number,
    tIdx: number,
    payload?: Record<string, unknown>,
  ): void {
    const oldTarget = readExclusiveTarget(rt, subject)
    if (oldTarget !== null && (oldTarget as number) === (target as number)) {
      if (payload !== undefined) writeExclusivePayload(rt, subject, payload)
      return
    }
    if (oldTarget === null) {
      // first attach: one migration adds the column-bearing presence id.
      host.migrateAddingMany(subject, [rt.presenceDef])
      incrPairCount(sIdx, rt.relationId)
    } else {
      const oldTIdx = host.handleIndex(oldTarget)
      backrefRemove(rt, oldTIdx, subject)
      // The retarget's REMOVE leg, as an observer-only carrier on the presence id (no per-target
      // pair ids exist on the valve): onPairRemoved(old) fires before onPairAdded(new) — shape-log
      // FIFO preserves the order. journal=false: exclusive pairs serialize via the eid column.
      host.trackShapePair(sIdx, rt.presenceId, oldTIdx, false, false)
    }
    backrefAdd(rt, tIdx, subject)
    writeExclusiveTarget(rt, subject, target) // THE VALVE — no archetype move on re-target
    if (payload !== undefined) writeExclusivePayload(rt, subject, payload)
    // re-target is a write, not a structural change → write-log push (not shape-log)...
    host.trackWrite(sIdx, rt.presenceId)
    // ...plus the ADD leg of the pair-observer carrier (both attach and retarget land here).
    host.trackShapePair(sIdx, rt.presenceId, tIdx, true, false)
    markDepthDirty(rt, sIdx)
  }

  function removePair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): void {
    if (!host.isAlive(subject)) return
    if (host.deferRelationOp('remove', subject, relation, target)) return
    const rt = requireRuntime(relation)
    const sIdx = host.handleIndex(subject)
    const tIdx = host.handleIndex(target)

    if (rt.exclusive) {
      const cur = readExclusiveTarget(rt, subject)
      if (cur === null || (cur as number) !== (target as number)) return
      backrefRemove(rt, tIdx, subject)
      writeExclusiveTarget(rt, subject, null)
      host.migrateRemovingMany(subject, [rt.presenceDef]) // last target removed → drop columns
      decrPairCount(sIdx, rt.relationId)
      host.trackShapePair(sIdx, rt.presenceId, tIdx, false, false) // observer-only carrier
      markDepthDirty(rt, sIdx)
      return
    }

    const cid = lookupPairId(rt.relationId, tIdx)
    if (cid === undefined || !host.bitmaskHas(sIdx, cid)) return
    backrefRemove(rt, tIdx, subject)
    forwardRemove(rt, sIdx, tIdx)
    pairRefCount.set(cid, (pairRefCount.get(cid) ?? 1) - 1)
    if (rt.overflow !== null) {
      const row = overflowRowFor(rt.overflow, sIdx, tIdx, false)
      if (row !== -1) releaseOverflowRow(rt.overflow, row)
    }
    const removeDefs: ComponentDef<Schema>[] = [pairDefById.get(cid) as ComponentDef<Schema>]
    if (pairCountOf(sIdx, rt.relationId) === 1) removeDefs.push(rt.presenceDef)
    host.migrateRemovingMany(subject, removeDefs)
    decrPairCount(sIdx, rt.relationId)
    host.trackShapePair(sIdx, cid, tIdx, false)
    markDepthDirty(rt, sIdx)
  }

  function hasPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): boolean {
    // (no-dangling): both endpoints must be the LIVE occupants of their indices. handleIndex strips
    // the generation, so a stale handle whose index was recycled would otherwise alias the live entity
    // now in that slot. isAlive checks the generation, closing the aliasing class.
    if (!host.isAlive(subject) || !host.isAlive(target)) return false
    const rt = requireRuntime(relation)
    const sIdx = host.handleIndex(subject)
    if (rt.exclusive) {
      const cur = readExclusiveTarget(rt, subject)
      return cur !== null && (cur as number) === (target as number)
    }
    const cid = lookupPairId(rt.relationId, host.handleIndex(target))
    return cid !== undefined && host.bitmaskHas(sIdx, cid)
  }

  function hasRelation(subject: EntityHandle, relation: RelationDef<Schema | void>): boolean {
    if (!host.isAlive(subject)) return false
    const rt = requireRuntime(relation)
    return host.bitmaskHas(host.handleIndex(subject), rt.presenceId)
  }

  function getPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): PairAccessor {
    const rt = requireRuntime(relation)
    // (no-dangling): a stale (recycled-index) endpoint must not alias the live occupant. Guard both
    // ends before resolving indices; an inert accessor is the safe answer for a dead pair.
    if (!host.isAlive(subject) || !host.isAlive(target)) {
      const inert = (): Record<string, unknown> => ({})
      return { read: inert, write: inert }
    }
    const sIdx = host.handleIndex(subject)
    const tIdx = host.handleIndex(target)
    if (rt.exclusive) {
      const bind = (): Record<string, unknown> => {
        const view = bindPresenceAccessor(rt, subject)
        if (view === null)
          throw new Error(
            `getPair: entity ${subject} does not hold the exclusive relation '${rt.def.name}' — addPair(...) it first, or check hasPair(...) before reading the pair`,
          )
        return view
      }
      return { read: bind, write: bind }
    }
    if (rt.overflow !== null) {
      const ov = rt.overflow
      // re-resolve the overflow row per access (it can move on re-add).
      const bind = (): Record<string, unknown> => {
        const row = overflowRowFor(ov, sIdx, tIdx, true)
        return bindOverflowAccessor(ov, row, subject)
      }
      return { read: bind, write: bind }
    }
    // tag relation: no payload.
    const inert = (): Record<string, unknown> => ({})
    return { read: inert, write: inert }
  }

  function* subjectsOf(relation: RelationDef<Schema | void> | WildcardToken, target: EntityHandle): Iterable<EntityHandle> {
    // (no-dangling): the back-ref index is keyed by bare entity INDEX (handleIndex strips generation),
    // so a despawned handle whose index was recycled would alias the live entity now in that slot. Guard
    // the queried target's liveness/generation FIRST — a dead handle has no subjects.
    if (!host.isAlive(target)) return
    const tIdx = host.handleIndex(target)
    if ((relation as unknown) !== WILDCARD) {
      const rt = requireRuntime(relation as RelationDef<Schema | void>)
      const set = rt.backref.get(tIdx) ?? EMPTY_SET
      for (const s of set) if (host.isAlive(s)) yield s
      return
    }
    // Wildcard relation: walk every registered relation's back-ref bucket for this target, yielding
    // each subject once. Pre-scan O(R) for relations holding a bucket; the dedup set is allocated
    // only when a SECOND one does — the common single-relation walk iterates the live bucket with
    // no allocation. `seen` records every actually-yielded handle BEFORE the yield (not a snapshot
    // of the first bucket), so dedup stays exact when the loop body mutates pairs mid-iteration.
    let holders = 0
    for (const rt of relations) if (rt.backref.has(tIdx)) holders++
    const seen: Set<EntityHandle> | null = holders >= 2 ? new Set() : null
    for (const rt of relations) {
      // Re-guard the target per relation: a target despawned mid-iteration whose slot was recycled
      // must not alias the new occupant's buckets (the bucket key is the bare index).
      if (!host.isAlive(target)) return
      const set = rt.backref.get(tIdx)
      if (set === undefined) continue
      for (const s of set) {
        if (!host.isAlive(s)) continue
        if (seen !== null) {
          if (seen.has(s)) continue
          seen.add(s)
        }
        yield s
      }
    }
  }

  function* targetsOf(subject: EntityHandle, relation: RelationDef<Schema | void>): Iterable<EntityHandle> {
    const rt = requireRuntime(relation)
    // (no-dangling): a stale (recycled-index) subject must not alias the live occupant of that slot.
    if (!host.isAlive(subject)) return
    const sIdx = host.handleIndex(subject)
    if (rt.exclusive) {
      const t = readExclusiveTarget(rt, subject)
      if (t !== null) yield t
      return
    }
    // activate the forward index lazily on first use, then backfill from the back-ref index.
    if (!forwardIndex.has(rt.relationId as number)) {
      const fwd = new Map<number, Set<number>>()
      forwardIndex.set(rt.relationId as number, fwd)
      for (const [tIdx, subjects] of rt.backref) {
        for (const s of subjects) {
          const si = host.handleIndex(s)
          let inner = fwd.get(si)
          if (inner === undefined) {
            inner = new Set()
            fwd.set(si, inner)
          }
          inner.add(tIdx)
        }
      }
    }
    const targets = forwardIndex.get(rt.relationId as number)?.get(sIdx)
    if (targets === undefined) return
    for (const tIdx of targets) {
      const h = host.handleOfIndex(tIdx)
      if (host.isAlive(h)) yield h
    }
  }

  function targetOf(subject: EntityHandle, relation: RelationDef<Schema | void>): EntityHandle | null {
    const rt = requireRuntime(relation)
    if (!rt.exclusive)
      throw new Error(
        `targetOf: relation '${rt.def.name}' is not exclusive (one target per entity) — use targetsOf(...) to read its many targets, or define it with { exclusive: true }`,
      )
    if (!host.isAlive(subject)) return null
    return readExclusiveTarget(rt, subject)
  }

  // ---

  function markDepthDirty(rt: RelationRuntime, _sIdx: number): void {
    if (rt.depth !== null) rt.depth.gen += 1
  }

  function depthOf(subject: EntityHandle, relation: RelationDef<Schema | void>): number {
    const rt = requireRuntime(relation)
    if (!rt.exclusive)
      throw new Error(
        `depthOf: relation '${rt.def.name}' is not exclusive (one parent per entity), so depth is undefined — define it with { exclusive: true } to use depthOf`,
      )
    if (rt.depth === null)
      rt.depth = {
        depth: new Int32Array(host.maxEntities).fill(-1),
        stamp: new Float64Array(host.maxEntities),
        gen: 1,
      }
    const cache = rt.depth
    const idx = host.handleIndex(subject)
    if (cache.depth[idx] !== -1 && cache.stamp[idx] === cache.gen) return cache.depth[idx] as number
    let d = 0
    let cur: EntityHandle | null = subject
    const visited: number[] = []
    while (cur !== null) {
      const parent = readExclusiveTarget(rt, cur)
      if (parent === null) break
      const pIdx = host.handleIndex(parent)
      if ((cache.depth[pIdx] as number) !== -1 && cache.stamp[pIdx] === cache.gen) {
        d += 1 + (cache.depth[pIdx] as number)
        cur = null
        break
      }
      visited.push(host.handleIndex(cur))
      d += 1
      cur = parent
      if (d > host.maxEntities)
        throw new Error(
          `depthOf: relation '${rt.def.name}' has a cycle in its parent chain (an entity is its own ancestor) — an exclusive parent relation must form a tree; check your addPair(...) calls`,
        )
    }
    let depthFromTop = d
    for (const v of visited) {
      cache.depth[v] = depthFromTop
      cache.stamp[v] = cache.gen
      depthFromTop -= 1
    }
    cache.depth[idx] = d
    cache.stamp[idx] = cache.gen
    return d
  }

  // --- (iterative BFS, registered as preDespawn) ---------

  // ONE cascade is in flight at a time (despawn is serial/main-thread). The queue + visited set
  // are hoisted to module scope so the re-entrant onPreDespawn that host.despawn fires for each victim
  // appends to the SAME frontier and returns immediately — the OUTERMOST call owns the drain loop. This
  // keeps cascade DEPTH iterative (constant native stack: outer loop → host.despawn → re-entrant
  // processDespawn → return), so a 100k-deep deleteSubject chain unwinds without recursion.
  let cascadeQueue: EntityHandle[] | null = null
  let cascadeVisited: Set<number> | null = null

  function onPreDespawn(dying: EntityHandle): void {
    if (cascadeQueue !== null) {
      // Re-entrant: a host.despawn(victim) from the drain loop below fired this hook. Tear down the
      // victim's pairs and enqueue ITS children onto the shared frontier, then unwind one frame.
      processDespawn(dying, cascadeQueue, cascadeVisited as Set<number>)
      return
    }
    const queue: EntityHandle[] = []
    const visited = new Set<number>()
    cascadeQueue = queue
    cascadeVisited = visited
    try {
      processDespawn(dying, queue, visited)
      while (queue.length > 0) {
        const victim = queue.shift() as EntityHandle
        if (host.isAlive(victim)) host.despawn(victim) // re-enters onPreDespawn (handled above) then frees the row
      }
    } finally {
      cascadeQueue = null
      cascadeVisited = null
    }
  }

  function processDespawn(dying: EntityHandle, cascadeQueue: EntityHandle[], visited: Set<number>): void {
    const dIdx = host.handleIndex(dying)
    if (IS_DEV && isaRt !== null && prefabDef !== null && host.bitmaskHas(dIdx, prefabDef.id)) {
      const instances = isaRt.backref.get(dIdx)
      if (instances !== undefined && instances.size > 0) {
        console.warn(
          `[ecsia] despawning a Prefab-tagged entity with ${instances.size} live subject(s) — instances and derived prefabs: ` +
            'they keep their copied values but lose Pair(IsA, prefab) queryability for this ancestor',
        )
      }
    }
    for (const rt of relations) {
      // (A) dying is a TARGET: every subject pointing at it loses that pair (cascade if deleteSubject).
      const subjects = rt.backref.get(dIdx)
      if (subjects !== undefined) {
        for (const s of Array.from(subjects)) {
          if (rt.cascade === 'deleteSubject' && !visited.has(host.handleIndex(s))) {
            visited.add(host.handleIndex(s))
            cascadeQueue.push(s)
          }
          removePair(s, rt.def, dying)
        }
        rt.backref.delete(dIdx)
      }
      // (B) dying is a SUBJECT: drop its outgoing pairs / back-ref contributions. Each torn-down
      // pair emits an observer-only carrier (journal=false — despawn serialization is the Destroy
      // record): onPairRemoved's contract covers the cascade in BOTH directions, and a react
      // TargetsStore watching this subject must wake or it renders the dead links forever.
      if (rt.exclusive) {
        const t = readExclusiveTarget(rt, dying)
        if (t !== null) {
          backrefRemove(rt, host.handleIndex(t), dying)
          host.trackShapePair(dIdx, rt.presenceId, host.handleIndex(t), false, false)
        }
        // the columns vanish with the row removal in storage.onDespawn; no migration needed.
      } else {
        for (const tIdx of outgoingTargets(rt, dIdx)) {
          const cid = lookupPairId(rt.relationId, tIdx)
          if (cid !== undefined) {
            pairRefCount.set(cid, (pairRefCount.get(cid) ?? 1) - 1)
            host.trackShapePair(dIdx, cid, tIdx, false, false)
          }
          backrefRemove(rt, tIdx, dying)
          if (rt.overflow !== null) {
            const row = overflowRowFor(rt.overflow, dIdx, tIdx, false)
            if (row !== -1) releaseOverflowRow(rt.overflow, row)
          }
        }
      }
      relationPairCount.delete(dIdx)
      forwardIndex.get(rt.relationId as number)?.delete(dIdx)
      if (rt.depth !== null) rt.depth.gen += 1
    }
  }

  /** The outgoing target indices `dying` holds for `rt` — from the forward index or the back-ref scan. */
  function outgoingTargets(rt: RelationRuntime, dIdx: number): number[] {
    const fwd = forwardIndex.get(rt.relationId as number)?.get(dIdx)
    if (fwd !== undefined) return [...fwd]
    // No forward index active: scan the back-ref buckets for this subject (cascade-time, serial).
    const out: number[] = []
    for (const [tIdx, subjects] of rt.backref) {
      const dyingHandle = host.handleOfIndex(dIdx)
      if (subjects.has(dyingHandle)) out.push(tIdx)
    }
    return out
  }

  // --- / (NEVER mints) ------------

  function resolvePair(relationId: number, target: number | symbol): ResolvedPair {
    const rt = byRelationId.get(relationId)
    if (rt === undefined) return { componentId: 0 as ComponentId, unsatisfiable: true }
    if (typeof target === 'symbol') {
      // Pair(R, Wildcard) → the per-relation presence bit, O(1) per archetype.
      return { componentId: rt.presenceId, unsatisfiable: false }
    }
    const targetIndex = host.handleIndex(target as EntityHandle)
    if (rt.exclusive) {
      // Target is a column value → match presence archetypes, then row-filter by the eid column.
      return {
        componentId: rt.presenceId,
        unsatisfiable: false,
        rowFilter: {
          presenceId: rt.presenceId,
          targetEid: encodeEid(target as EntityHandle) >>> 0,
          targetFieldIndex: rt.subjectTargetFieldIndex,
        },
      }
    }
    // tag / overflow-table: the specific pair id is a real signature bit. Never minted → matches nothing.
    const cid = lookupPairId(rt.relationId, targetIndex)
    if (cid === undefined) return { componentId: 0 as ComponentId, unsatisfiable: true }
    return { componentId: cid, unsatisfiable: false }
  }

  // --- defineRelation --------------------------------------------------------

  function defineRelation(payload: Schema | null, options?: RelationOptions): RelationDef<Schema | void> {
    return registerRelation(payload, options, undefined)
  }

  // The shared registration body. `fixedName` is the built-ins' stable serialization name
  // ("ecsia:IsA"); user relations keep the relation-id-derived name.
  function registerRelation(
    payload: Schema | null,
    options: RelationOptions | undefined,
    fixedName: string | undefined,
  ): RelationDef<Schema | void> {
    if (nextRelationId > 65535)
      throw new Error('defineRelation: too many relations — a world supports at most 65535 distinct relations')
    const relationId = nextRelationId++ as RelationId
    const exclusive = options?.exclusive ?? false
    const cascade = options?.cascade ?? 'none'
    const storageKind = resolveStorageKind(payload !== null, exclusive)
    const name = fixedName ?? `Relation${relationId as number}`

    const presenceDef = makePresenceDef(name, exclusive, payload)
    const presenceId = host.allocSyntheticId()
    host.registerSynthetic(presenceDef, presenceId)
    presenceIds.add(presenceId as number)
    relationIdByPresence.set(presenceId as number, relationId as number)

    const overflow = storageKind === 'overflow-table' ? buildOverflow(name, payload as Schema) : null

    const def = {
      id: relationId,
      name,
      payload: (payload ?? null) as RelationDef<Schema | void>['payload'],
      exclusive,
      cascade,
    } as RelationDef<Schema | void>

    const rt: RelationRuntime = {
      def,
      relationId,
      presenceId,
      presenceDef,
      exclusive,
      cascade,
      storageKind,
      subjectTargetFieldIndex: exclusive ? 0 : -1,
      overflow,
      backref: new Map(),
      depth: null,
    }
    relations.push(rt)
    byDef.set(def, rt)
    byRelationId.set(relationId as number, rt)
    return def
  }

  function requireRuntime(relation: RelationDef<Schema | void>): RelationRuntime {
    const rt = byDef.get(relation) ?? byRelationId.get(relation.id as number)
    if (rt === undefined)
      throw new Error(
        `relation '${relation.name}' is not registered with this world — define it with the same createRelations(world) runtime you're calling here`,
      )
    return rt
  }

  function Pair<R extends RelationDef<Schema | void>>(relation: R, target: EntityHandle | WildcardToken): PairDef<R> {
    // The query-term PairDef shape (type-system ): { relation, target, id }. id is UNREGISTERED;
    // the compiler resolves the concrete pair/presence id via the injected resolver.
    return { relation, target, id: -1 as PairDef<R>['id'] }
  }

  // --- prefabs: the IsA built-in + definePrefab / spawnFrom -------------------
  // Instantiation is a COPY (the bitECS model): spawnFrom stamps the prefab's values onto the
  // instance once; editing a prefab afterwards affects future spawns only. The IsA pair is still
  // recorded per ancestor (transitively), so subtype queries stay plain signature matches.

  const prefabDef = host.prefabDef
  // Registered FIRST (relationId 0) when the world opted in, so its id/name are deterministic for
  // serialization. Absent otherwise — the prefab API then throws with a pointer to the flag.
  const isaDef = prefabDef !== null ? (registerRelation(null, { cascade: 'none' }, 'ecsia:IsA') as RelationDef<void>) : null
  const isaRt = isaDef !== null ? requireRuntime(isaDef) : null

  const warnedObjectCopy = new Set<ComponentDef<Schema>>()

  function requirePrefabRuntime(): RelationRuntime {
    if (isaRt === null) {
      throw new Error('prefabs are not enabled on this world — create it with createWorld({ prefabs: true, ... })')
    }
    return isaRt
  }

  /** The IsA pair target indices recorded on the entity at `idx` (a direct signature read). */
  function isaTargetIndicesOf(idx: number): number[] {
    const rt = isaRt as RelationRuntime
    const out: number[] = []
    for (const cid of host.componentIdsOf(host.handleOfIndex(idx))) {
      const meta = pairKeyById.get(cid as ComponentId)
      if (meta !== undefined && (meta.relationId as number) === (rt.relationId as number)) out.push(meta.targetIndex)
    }
    return out
  }

  /**
   * The full ancestor index set, the spawned-from prefab first. definePrefab records ancestors
   * transitively, so for API-built chains this reads the direct signature; the walk + visited set
   * exist so a manually-created `addPair(e, IsA, t)` cycle terminates. Diamonds are normal under
   * transitive recording — only a true back-edge (a node still on the walk path) warns.
   */
  function collectAncestors(prefab: EntityHandle): number[] {
    const startIdx = host.handleIndex(prefab)
    const out: number[] = [startIdx]
    const visited = new Set<number>([startIdx])
    const onPath = new Set<number>([startIdx])
    const visit = (idx: number): void => {
      for (const tIdx of isaTargetIndicesOf(idx)) {
        if (onPath.has(tIdx)) {
          if (IS_DEV) {
            console.warn('[ecsia] spawnFrom: IsA cycle detected while collecting the ancestor set — the revisited edge is skipped')
          }
          continue
        }
        if (visited.has(tIdx)) continue
        visited.add(tIdx)
        out.push(tIdx)
        onPath.add(tIdx)
        visit(tIdx)
        onPath.delete(tIdx)
      }
    }
    visit(startIdx)
    return out
  }

  /**
   * The template's copyable component set S: its signature minus the Prefab tag and every
   * relation artifact (pair bits + presence bits). v1 instantiates components only — the
   * prefab's own non-IsA relation pairs are never copied onto instances.
   */
  function copyableDefsOf(handle: EntityHandle): ComponentDef<Schema>[] {
    const out: ComponentDef<Schema>[] = []
    for (const cid of host.componentIdsOf(handle)) {
      if (prefabDef !== null && cid === (prefabDef.id as number)) continue
      if (pairKeyById.has(cid as ComponentId)) continue
      if (presenceIds.has(cid)) continue
      const def = host.defOf(cid as ComponentId)
      if (def !== undefined) out.push(def)
    }
    return out
  }

  /** Split spawnWith-form args into membership defs + `[def, values]` initializers. */
  function splitInits(specs: readonly SpawnArg[]): {
    defs: ComponentDef<Schema>[]
    values: (readonly [ComponentDef<Schema>, Record<string, unknown>])[]
  } {
    const defs: ComponentDef<Schema>[] = []
    const values: (readonly [ComponentDef<Schema>, Record<string, unknown>])[] = []
    for (const spec of specs) {
      if (Array.isArray(spec)) {
        const [def, vals] = spec as readonly [ComponentDef<Schema>, Record<string, unknown>]
        defs.push(def)
        values.push([def, vals])
      } else {
        defs.push(spec as ComponentDef<Schema>)
      }
    }
    return { defs, values }
  }

  /**
   * Per-field copy of one component's values, src row → dst row. Numeric/vec/staticString fields
   * copy by column word; `eid` fields copy the stored handle VERBATIM (every instance aliases the
   * same target the prefab pointed at); rich fields ride the sidecar — 'string' by value,
   * object<T> by REFERENCE (dev warn: prefab and instances then share one object). Resolution is
   * cold-capable on both ends: a template (or instance) parked in a cold archetype copies through
   * its per-type cold block, never silently defaulting.
   */
  function copyComponentValues(src: EntityHandle, dst: EntityHandle, def: ComponentDef<Schema>): void {
    let copied = false
    const from = host.fieldLocationFor(src, def)
    const to = host.fieldLocationFor(dst, def)
    if (from !== null && to !== null && from.set.columns.length > 0) {
      copied = true
      for (let k = 0; k < from.set.columns.length; k++) {
        const sc = from.set.columns[k] as Column
        const dc = to.set.columns[k] as Column
        const stride = sc.layout.stride
        for (let j = 0; j < stride; j++) dc.view[to.row * stride + j] = sc.view[from.row * stride + j] as number
      }
    }
    let hasRich = false
    for (const f of def.fields) {
      if (f.rich !== undefined) {
        hasRich = true
        if (f.rich === 'object' && IS_DEV && !warnedObjectCopy.has(def)) {
          warnedObjectCopy.add(def)
          console.warn(
            `[ecsia] prefab copy: object<T> field '${def.name}.${f.name}' copies by REFERENCE — ` +
              'the template and its instances share one object; override it at spawn to detach',
          )
        }
      }
    }
    if (hasRich) {
      copied = true
      host.copyRichFields(src, dst, def.id)
    }
    if (copied) host.trackWrite(host.handleIndex(dst), def.id)
  }

  /**
   * The shared template-spawn body: ONE migration EMPTY → target signature (components ∪ override
   * additions ∪ the IsA pair set ∪ presence), then the per-field copy, then overrides on top, then
   * the addPair bookkeeping (back-ref, refcount, counter, shape log) the single migration folded in.
   *
   * Mid-drain (an observer handler calling definePrefab/spawnFrom) this STAGES like every other
   * structural op: the handle is reserved-alive and returned immediately (the spawnWith staging
   * model), and the build body runs at the next serial flush — never mutating the wave the drain
   * is replaying.
   */
  function buildFromTemplate(
    copySource: EntityHandle | null,
    copyDefs: readonly ComponentDef<Schema>[],
    extraDefs: readonly ComponentDef<Schema>[],
    values: readonly (readonly [ComponentDef<Schema>, Record<string, unknown>])[],
    ancestorIndices: readonly number[],
    prefabTag: ComponentDef<Schema> | null,
  ): EntityHandle {
    const rt = isaRt as RelationRuntime
    const ancestors: number[] = []
    const ancestorHandles: EntityHandle[] = []
    const seenAncestor = new Set<number>()
    for (const t of ancestorIndices) {
      if (!seenAncestor.has(t)) {
        seenAncestor.add(t)
        ancestors.push(t)
        ancestorHandles.push(host.handleOfIndex(t))
      }
    }

    const buildInto = (handle: EntityHandle): void => {
      // In the staged case this body runs at the NEXT serial flush, after earlier-staged ops — the
      // template or an ancestor may have been despawned in between. A dead copy source degrades to
      // defaulted values (the components still attach); a dead ancestor drops its IsA pair, exactly
      // as addPair would refuse a dead target.
      const liveSource = copySource !== null && host.isAlive(copySource) ? copySource : null
      if (IS_DEV && copySource !== null && liveSource === null) {
        console.warn(
          `[ecsia] prefab spawn: prefab ${copySource as number} was despawned before the staged build flushed — ` +
            'the instance materializes with DEFAULTED values and no IsA edge to it',
        )
      }
      const liveAncestors: number[] = []
      for (let i = 0; i < ancestors.length; i++) {
        const ancestor = ancestorHandles[i] as EntityHandle
        if (host.isAlive(ancestor)) {
          liveAncestors.push(ancestors[i] as number)
        } else if (IS_DEV && ancestor !== copySource) {
          console.warn(
            `[ecsia] prefab spawn: ancestor prefab ${ancestor as number} was despawned before the staged build flushed — ` +
              'its Pair(IsA, ancestor) is dropped from the instance',
          )
        }
      }

      const defs: ComponentDef<Schema>[] = []
      const seen = new Set<ComponentDef<Schema>>()
      const push = (def: ComponentDef<Schema>): void => {
        if (!seen.has(def)) {
          seen.add(def)
          defs.push(def)
        }
      }
      for (const d of copyDefs) push(d)
      for (const d of extraDefs) push(d)
      if (prefabTag !== null) push(prefabTag)
      const pairCids: ComponentId[] = []
      for (const tIdx of liveAncestors) {
        const cid = mintPair(rt, tIdx)
        pairCids.push(cid)
        push(pairDefById.get(cid) as ComponentDef<Schema>)
      }
      if (liveAncestors.length > 0) push(rt.presenceDef)

      host.migrateAddingMany(handle, defs)
      const sIdx = host.handleIndex(handle)
      if (liveSource !== null) for (const d of copyDefs) copyComponentValues(liveSource, handle, d)
      // Overrides write through the tracked accessor path, so onChange/write-log fire exactly as a
      // post-spawn write would — and they land AFTER the copy, which is what makes them win.
      for (const [def, vals] of values) {
        const view = world.entity(handle).write(def) as Record<string, unknown>
        for (const k of Object.keys(vals)) view[k] = vals[k]
      }
      // MUST mirror addPair's per-pair bookkeeping for a tag relation (counter, refcount, back-ref,
      // forward index, shape log) — the migration itself was folded into the single move above. If
      // addPair gains a side-effect, fold it in here too, or instances will silently lack it.
      for (let i = 0; i < liveAncestors.length; i++) {
        const tIdx = liveAncestors[i] as number
        const cid = pairCids[i] as ComponentId
        incrPairCount(sIdx, rt.relationId)
        pairRefCount.set(cid, (pairRefCount.get(cid) ?? 0) + 1)
        backrefAdd(rt, tIdx, handle)
        forwardAdd(rt, sIdx, tIdx)
        host.trackShapePair(sIdx, cid, tIdx, true)
      }
    }

    const reserved = host.deferTemplateSpawn(buildInto)
    if (reserved !== null) return reserved
    const handle = host.spawnEmpty()
    buildInto(handle)
    return handle
  }

  function definePrefab(...args: readonly (DefinePrefabOptions | SpawnArg)[]): EntityHandle {
    requirePrefabRuntime()
    const pDef = prefabDef as ComponentDef<Schema>
    let base: EntityHandle | null = null
    let initArgs = args as readonly SpawnArg[]
    const first = args[0]
    if (first !== undefined && typeof first === 'object' && !Array.isArray(first) && 'extends' in first) {
      base = (first as DefinePrefabOptions).extends
      initArgs = args.slice(1) as readonly SpawnArg[]
    }
    if (base !== null && !host.isAlive(base)) {
      if (IS_DEV) throw new Error('definePrefab: { extends } references a despawned prefab handle')
      return NO_ENTITY
    }
    if (IS_DEV && base !== null && prefabDef !== null && !host.bitmaskHas(host.handleIndex(base), prefabDef.id)) {
      if (host.componentIdsOf(base).length === 0 && host.hasPendingDeferred()) {
        throw new Error('definePrefab: { extends } target is a STAGED prefab that materializes at the next observer flush — extend it after the flush (e.g. next frame)')
      }
      throw new Error('definePrefab: { extends } target is not a Prefab-tagged entity — pass a handle returned by definePrefab()')
    }
    const { defs: initDefs, values: initValues } = splitInits(initArgs)
    // Flatten at define time: copy the base's full (already-flattened) set and values, apply this
    // prefab's inits on top (the child wins by copy order), and record Pair(IsA, base) plus the
    // base's own IsA pairs so the new prefab carries its full ancestor set.
    const copyDefs = base !== null ? copyableDefsOf(base) : []
    const ancestors = base !== null ? [host.handleIndex(base), ...isaTargetIndicesOf(host.handleIndex(base))] : []
    return buildFromTemplate(base, copyDefs, initDefs, initValues, ancestors, pDef)
  }

  function spawnFrom(prefab: EntityHandle, ...overrides: readonly SpawnArg[]): EntityHandle {
    requirePrefabRuntime()
    if (!host.isAlive(prefab)) {
      if (IS_DEV) throw new Error('spawnFrom: the prefab handle is dead (despawned or stale)')
      return NO_ENTITY
    }
    if (IS_DEV && prefabDef !== null && !host.bitmaskHas(host.handleIndex(prefab), prefabDef.id)) {
      if (host.componentIdsOf(prefab).length === 0 && host.hasPendingDeferred()) {
        throw new Error('spawnFrom: the prefab is STAGED and materializes at the next observer flush — spawn from it after the flush (e.g. next frame)')
      }
      throw new Error('spawnFrom: the source is not a Prefab-tagged entity — pass a handle returned by definePrefab()')
    }
    const { defs: overrideDefs, values: overrideValues } = splitInits(overrides)
    return buildFromTemplate(prefab, copyableDefsOf(prefab), overrideDefs, overrideValues, collectAncestors(prefab), null)
  }

  // --- serialization provider -----------------
  // Enumerate every live pair as a logical (subject, relationId, target, payload) triple — NEVER the
  // synthetic pair id (producer-local). Payload is read by field name so the receiver re-mints
  // its own pair id and re-writes the named fields. addPair re-establishes a pair on deserialize.

  function payloadFieldNames(rt: RelationRuntime): string[] {
    // The presence def's exclusive column is [eid target, ...payload]; the overflow def is [...payload].
    // persist:false payload fields are excluded — the name-keyed pair-payload wire simply omits them
    // and the receiver's addPair re-defaults the missing names.
    if (rt.storageKind === 'exclusive-column') {
      const names: string[] = []
      for (const f of rt.presenceDef.fields) if (f.name !== '$t' && f.persist) names.push(f.name)
      return names
    }
    if (rt.overflow !== null) return rt.overflow.def.fields.filter((f) => f.persist).map((f) => f.name)
    return []
  }

  // RECEIVER-side persist enforcement for the apply path: keep only the payload keys THIS world's
  // descriptors mark persisted, so a producer whose relation schema lacks the flag cannot plant
  // values into fields the receiver declared transient (they re-default via addPair instead).
  function filterPersistedPayload(rt: RelationRuntime, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (payload === undefined) return undefined
    const out: Record<string, unknown> = {}
    let any = false
    for (const n of payloadFieldNames(rt)) {
      if (n in payload) {
        out[n] = payload[n]
        any = true
      }
    }
    return any ? out : undefined
  }

  function readPairPayload(rt: RelationRuntime, subject: EntityHandle, target: EntityHandle): Record<string, unknown> | undefined {
    if (rt.storageKind === 'tag') return undefined
    const names = payloadFieldNames(rt)
    if (names.length === 0) return undefined
    const acc = getPair(subject, rt.def, target).read() as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const n of names) out[n] = acc[n]
    return out
  }

  const serializationProvider: SerializeRelationProvider = {
    relations() {
      return relations.map((rt) => ({
        name: rt.def.name,
        id: rt.relationId,
        exclusive: rt.exclusive,
        hasPayload: rt.storageKind !== 'tag',
        presenceId: rt.presenceId,
      }))
    },
    livePairs() {
      const out: SerializePair[] = []
      // Deterministic order: relationId asc, then subject index asc, then target index asc.
      for (const rt of [...relations].sort((a, b) => (a.relationId as number) - (b.relationId as number))) {
        const triples: { subject: EntityHandle; target: EntityHandle | null; sIdx: number; tIdx: number }[] = []
        if (rt.exclusive) {
          // The back-ref index maps targetIndex → subjects; the subject's single target is the eid column.
          for (const [tIdx, subjects] of rt.backref) {
            for (const s of subjects) {
              if (!host.isAlive(s)) continue
              const t = readExclusiveTarget(rt, s)
              if (t === null) continue
              triples.push({ subject: s, target: t, sIdx: host.handleIndex(s), tIdx })
            }
          }
        } else {
          for (const [tIdx, subjects] of rt.backref) {
            const tHandle = host.handleOfIndex(tIdx)
            for (const s of subjects) {
              if (!host.isAlive(s)) continue
              triples.push({ subject: s, target: tHandle, sIdx: host.handleIndex(s), tIdx })
            }
          }
        }
        triples.sort((a, b) => (a.sIdx - b.sIdx) || (a.tIdx - b.tIdx))
        for (const tr of triples) {
          out.push({
            subject: tr.subject,
            relationId: rt.relationId,
            target: tr.target,
            payload: tr.target === null ? undefined : readPairPayload(rt, tr.subject, tr.target),
          })
        }
      }
      return out
    },
    addPair(subject, relationId, target, payload) {
      const rt = byRelationId.get(relationId as number)
      if (rt === undefined) return
      if (target === null) return // a cleared exclusive target: nothing to re-establish
      addPair(subject, rt.def, target, filterPersistedPayload(rt, payload))
    },
    relationIdOfPair(pairId) {
      return pairKeyById.get(pairId)?.relationId
    },
    pairPayloadOf(subject, relationId, target) {
      const rt = byRelationId.get(relationId as number)
      if (rt === undefined || !host.isAlive(subject) || !host.isAlive(target)) return undefined
      if (!hasPair(subject, rt.def, target)) return undefined
      return readPairPayload(rt, subject, target)
    },
    removePair(subject, relationId, target) {
      const rt = byRelationId.get(relationId as number)
      if (rt === undefined) return
      removePair(subject, rt.def, target)
    },
  }

  // --- install seams ---------------------------------------------------------

  host.setPreDespawn(onPreDespawn)
  host.setSerializationProvider(serializationProvider)
  host.setPairResolver(resolvePair)
  // Relation-level pair observers (onPairAdded/onPairRemoved): the deferred drain hands us each
  // pair shape entry's synthetic ComponentId; this resolves it to its relation so core can dispatch
  // per-relation buckets without ever learning relation structure.
  host.setPairObserverResolver((pairComponentId) => {
    const viaPair = pairKeyById.get(pairComponentId as ComponentId)?.relationId as unknown as number | undefined
    if (viaPair !== undefined) return viaPair
    return relationIdByPresence.get(pairComponentId) ?? -1
  })
  host.setApplyPair(
    (subject, relationId, target, payload) => {
      const rt = byRelationId.get(relationId as number)
      if (rt === undefined) return
      addPair(subject, rt.def, target, payload)
    },
    (subject, relationId, target) => {
      const rt = byRelationId.get(relationId as number)
      if (rt === undefined) return
      removePair(subject, rt.def, target)
    },
  )

  return {
    defineRelation: defineRelation as RelationsApi['defineRelation'],
    addPair: addPair as unknown as RelationsApi['addPair'],
    removePair,
    hasPair,
    hasRelation,
    getPair: getPair as unknown as RelationsApi['getPair'],
    subjectsOf,
    targetsOf,
    targetOf,
    depthOf,
    Pair,
    get IsA(): RelationDef<void> {
      if (isaDef === null) {
        throw new Error('IsA is a prefab built-in — create the world with createWorld({ prefabs: true, ... })')
      }
      return isaDef
    },
    get Prefab(): ComponentDef<Record<never, never>> {
      if (prefabDef === null) {
        throw new Error('Prefab is a prefab built-in — create the world with createWorld({ prefabs: true, ... })')
      }
      return prefabDef as ComponentDef<Record<never, never>>
    },
    definePrefab: definePrefab as RelationsApi['definePrefab'],
    spawnFrom: spawnFrom as RelationsApi['spawnFrom'],
  }
}
