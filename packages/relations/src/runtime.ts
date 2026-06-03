// @ecsia/relations runtime (relations.md). First-class integer-encoded (relationId, targetIndex)
// pairs as ordinary archetype members: eager O(1) pair-id minting, the per-relation presence bit for
// O(1) wildcard match, the exclusivity storage split (Must-Fix #4), the main-thread back-ref index,
// and the iterative-BFS cascade. Attaches to a world through the core RelationsHost seam — this
// module imports @ecsia/core; @ecsia/core NEVER imports it (the acyclic boundary, M8).

import type {
  ComponentDef,
  ComponentId,
  EntityHandle,
  RelationDef,
  RelationId,
  RelationOptions,
  Schema,
} from '@ecsia/schema'
import {
  defineComponent,
  buildColumnSet,
  bindAccessorRow,
  decodeEid,
  encodeEid,
} from '@ecsia/core'
import type { Column, ColumnSet, RelationsHost, ResolvedPair, World } from '@ecsia/core'
import { pairKey64, overflowKey64 } from './pair-key.js'

const WILDCARD = Symbol.for('ecsia.query.wildcard')
/** The wildcard target sentinel: `Pair(R, Wildcard)` matches every R-pair via the presence bit (§3). */
export const Wildcard: unique symbol = WILDCARD as never as typeof Wildcard

export type StorageKind = 'tag' | 'exclusive-column' | 'overflow-table'

/** resolveStorageKind (relations.md §4): payload-free → tag; payload+exclusive → column; else overflow. */
function resolveStorageKind(hasPayload: boolean, exclusive: boolean): StorageKind {
  if (!hasPayload) return 'tag'
  return exclusive ? 'exclusive-column' : 'overflow-table'
}

/** A monomorphic payload accessor over the exclusive subject column or the overflow row (§4.4). */
export interface PairAccessor {
  read(): Record<string, unknown>
  write(): Record<string, unknown>
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
  /** targetIndex → subject handles (relations.md §6). */
  readonly backref: Map<number, Set<EntityHandle>>
  /** Lazily-allocated depth cache (relations.md §9), exclusive relations only. */
  depth: { depth: Int32Array; dirty: Set<number> } | null
}

interface RelationsApi {
  defineRelation<P extends Schema>(payload: P, options?: RelationOptions): RelationDef<P>
  defineRelation(payload: null, options?: RelationOptions): RelationDef<void>
  addPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle, payload?: Record<string, unknown>): void
  removePair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): void
  hasPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): boolean
  hasRelation(subject: EntityHandle, relation: RelationDef<Schema | void>): boolean
  getPair(subject: EntityHandle, relation: RelationDef<Schema | void>, target: EntityHandle): PairAccessor
  subjectsOf(relation: RelationDef<Schema | void>, target: EntityHandle): Iterable<EntityHandle>
  targetsOf(subject: EntityHandle, relation: RelationDef<Schema | void>): Iterable<EntityHandle>
  depthOf(relation: RelationDef<Schema | void>, subject: EntityHandle): number
  readonly Pair: (relation: RelationDef<Schema | void>, target: EntityHandle | typeof Wildcard) => unknown
}

const EMPTY_SET: ReadonlySet<EntityHandle> = new Set()

export function createRelations(world: World): RelationsApi {
  const host: RelationsHost = world.__installRelations()
  // §2.1: pair keys index by the WORLD's target-index width (= 32 - generationBits). Captured once
  // from the host so a non-default generationBits keys the SAME targetIndex host.handleIndex produces.
  const indexBits = host.indexBits

  let nextRelationId = 0
  const relations: RelationRuntime[] = []
  const byDef = new Map<RelationDef<Schema | void>, RelationRuntime>()
  const byRelationId = new Map<number, RelationRuntime>()

  // §2.2 mint map: logical pairKey64 → synthetic pair ComponentId, plus the reverse + refcount.
  const pairIdByKey = new Map<bigint, ComponentId>()
  const pairKeyById = new Map<ComponentId, { relationId: RelationId; targetIndex: number }>()
  const pairDefById = new Map<ComponentId, ComponentDef<Schema>>()
  const pairsByRelation = new Map<number, Set<ComponentId>>()
  const pairRefCount = new Map<ComponentId, number>()

  // §3.3 per-subject relation-pair counter: subjectIndex → (relationId → count).
  const relationPairCount = new Map<number, Map<number, number>>()
  // §6.3 forward index (subject → targets), allocated per relation on first targetsOf use.
  const forwardIndex = new Map<number, Map<number, Set<number>>>()

  let overflowArchetypeSeq = -1000000 // synthetic archetypeId namespace for overflow ColumnSets (never a real archetype)

  // --- presence/pair/overflow def construction -------------------------------

  function makePresenceDef(name: string, exclusive: boolean, payload: Schema | null): ComponentDef<Schema> {
    if (exclusive) {
      // §4.2: an exclusive relation's presence id ALWAYS carries the eid target column (field 0) so
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
    // (§4.3) or, for exclusive, in the presence column (§4.2). The pair id is pure signature membership.
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

  // --- §2.2 mintPair (eager, O(1), idempotent, index-keyed) ------------------

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

  // --- §3.3 relation-pair counter --------------------------------------------

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

  // --- §6 back-ref index -----------------------------------------------------

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
    if (fwd === undefined) return // not active → not maintained (pay-for-what-you-use, §6.3)
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

  // --- §4 overflow row alloc/free --------------------------------------------

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

  // --- exclusive subject target column access (§4.2) -------------------------

  function exclusiveTargetCol(rt: RelationRuntime, subject: EntityHandle): { col: Column; row: number } | null {
    const r = host.columnSetFor(subject, rt.presenceDef)
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
    const r = host.columnSetFor(subject, rt.presenceDef)
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

  // --- §5 structural operations ----------------------------------------------

  function addPair(
    subject: EntityHandle,
    relation: RelationDef<Schema | void>,
    target: EntityHandle,
    payload?: Record<string, unknown>,
  ): void {
    if (!host.isAlive(subject)) return
    if (!host.isAlive(target)) return
    // M9 (reactivity.md §7.4): if an observer drain is in flight, stage this op to the world's deferred
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
      // idempotent re-add: only refresh the overflow payload.
      if (rt.overflow !== null && payload !== undefined) {
        const row = overflowRowFor(rt.overflow, sIdx, tIdx, true)
        writeOverflowPayload(rt.overflow, row, subject, payload)
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

  // §5.4 exclusive re-target: the T1 valve — in-place eid column write, NO migration.
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
      backrefRemove(rt, host.handleIndex(oldTarget), subject)
    }
    backrefAdd(rt, tIdx, subject)
    writeExclusiveTarget(rt, subject, target) // THE VALVE — no archetype move on re-target
    if (payload !== undefined) writeExclusivePayload(rt, subject, payload)
    // re-target is a write, not a structural change → write-log push (not shape-log).
    host.trackWrite(sIdx, rt.presenceId)
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
    if (!host.isAlive(subject)) return false
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
    const sIdx = host.handleIndex(subject)
    const tIdx = host.handleIndex(target)
    if (rt.exclusive) {
      const bind = (): Record<string, unknown> => {
        const view = bindPresenceAccessor(rt, subject)
        if (view === null) throw new Error('getPair: subject does not hold the exclusive relation')
        return view
      }
      return { read: bind, write: bind }
    }
    if (rt.overflow !== null) {
      const ov = rt.overflow
      // re-resolve the overflow row per access (it can move on re-add, §4.4).
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

  function* subjectsOf(relation: RelationDef<Schema | void>, target: EntityHandle): Iterable<EntityHandle> {
    const rt = requireRuntime(relation)
    const set = rt.backref.get(host.handleIndex(target)) ?? EMPTY_SET
    for (const s of set) if (host.isAlive(s)) yield s
  }

  function* targetsOf(subject: EntityHandle, relation: RelationDef<Schema | void>): Iterable<EntityHandle> {
    const rt = requireRuntime(relation)
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

  // --- §9 lazy hierarchy depth -----------------------------------------------

  function markDepthDirty(rt: RelationRuntime, sIdx: number): void {
    if (rt.depth !== null) rt.depth.dirty.add(sIdx)
  }

  function depthOf(relation: RelationDef<Schema | void>, subject: EntityHandle): number {
    const rt = requireRuntime(relation)
    if (!rt.exclusive) throw new Error('depthOf: only valid for exclusive (single-parent) relations')
    if (rt.depth === null) rt.depth = { depth: new Int32Array(host.maxEntities).fill(-1), dirty: new Set() }
    const cache = rt.depth
    const idx = host.handleIndex(subject)
    if (cache.depth[idx] !== -1 && !cache.dirty.has(idx)) return cache.depth[idx] as number
    let d = 0
    let cur: EntityHandle | null = subject
    const visited: number[] = []
    while (cur !== null) {
      const parent = readExclusiveTarget(rt, cur)
      if (parent === null) break
      const pIdx = host.handleIndex(parent)
      if ((cache.depth[pIdx] as number) !== -1 && !cache.dirty.has(pIdx)) {
        d += 1 + (cache.depth[pIdx] as number)
        cur = null
        break
      }
      visited.push(host.handleIndex(cur))
      d += 1
      cur = parent
      if (d > host.maxEntities) throw new Error('depthOf: hierarchy cycle detected')
    }
    let depthFromTop = d
    for (const v of visited) {
      cache.depth[v] = depthFromTop
      cache.dirty.delete(v)
      depthFromTop -= 1
    }
    cache.depth[idx] = d
    cache.dirty.delete(idx)
    return d
  }

  // --- §7 cascade-on-delete (iterative BFS, registered as preDespawn) ---------

  // §7.2: ONE cascade is in flight at a time (despawn is serial/main-thread). The queue + visited set
  // are hoisted to module scope so the re-entrant onPreDespawn that host.despawn fires for each victim
  // appends to the SAME frontier and returns immediately — the OUTERMOST call owns the drain loop. This
  // keeps cascade DEPTH iterative (constant native stack: outer loop → host.despawn → re-entrant
  // processDespawn → return), so a 100k-deep deleteSubject chain unwinds without recursion (P5).
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
      // (B) dying is a SUBJECT: drop its outgoing pairs / back-ref contributions.
      if (rt.exclusive) {
        const t = readExclusiveTarget(rt, dying)
        if (t !== null) backrefRemove(rt, host.handleIndex(t), dying)
        // the columns vanish with the row removal in storage.onDespawn; no migration needed.
      } else {
        for (const tIdx of outgoingTargets(rt, dIdx)) {
          const cid = lookupPairId(rt.relationId, tIdx)
          if (cid !== undefined) pairRefCount.set(cid, (pairRefCount.get(cid) ?? 1) - 1)
          backrefRemove(rt, tIdx, dying)
          if (rt.overflow !== null) {
            const row = overflowRowFor(rt.overflow, dIdx, tIdx, false)
            if (row !== -1) releaseOverflowRow(rt.overflow, row)
          }
        }
      }
      relationPairCount.delete(dIdx)
      forwardIndex.get(rt.relationId as number)?.delete(dIdx)
      if (rt.depth !== null) rt.depth.dirty.add(dIdx)
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

  // --- §8 / queries.md §10 pair-term resolver (Q-R2: NEVER mints) ------------

  function resolvePair(relationId: number, target: number | symbol): ResolvedPair {
    const rt = byRelationId.get(relationId)
    if (rt === undefined) return { componentId: 0 as ComponentId, unsatisfiable: true }
    if (typeof target === 'symbol') {
      // Pair(R, Wildcard) → the per-relation presence bit, O(1) per archetype (§8.1).
      return { componentId: rt.presenceId, unsatisfiable: false }
    }
    const targetIndex = host.handleIndex(target as EntityHandle)
    if (rt.exclusive) {
      // §8.2: target is a column value → match presence archetypes, then row-filter by the eid column.
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
    if (nextRelationId > 65535) throw new Error('defineRelation: numRelations exceeds the u16 ceiling (65535)')
    const relationId = nextRelationId++ as RelationId
    const exclusive = options?.exclusive ?? false
    const cascade = options?.cascade ?? 'none'
    const storageKind = resolveStorageKind(payload !== null, exclusive)
    const name = `Relation${relationId as number}`

    const presenceDef = makePresenceDef(name, exclusive, payload)
    const presenceId = host.allocSyntheticId()
    host.registerSynthetic(presenceDef, presenceId)

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
    if (rt === undefined) throw new Error(`relation '${relation.name}' is not registered with this world`)
    return rt
  }

  function Pair(relation: RelationDef<Schema | void>, target: EntityHandle | typeof Wildcard): unknown {
    // The query-term PairDef shape (type-system §7.2): { relation, target, id }. id is UNREGISTERED;
    // the compiler resolves the concrete pair/presence id via the injected resolver (Q-R2).
    return { relation, target, id: -1 }
  }

  // --- install seams ---------------------------------------------------------

  host.setPreDespawn(onPreDespawn)
  host.setPairResolver(resolvePair)
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
    addPair,
    removePair,
    hasPair,
    hasRelation,
    getPair,
    subjectsOf,
    targetsOf,
    depthOf,
    Pair,
  }
}
