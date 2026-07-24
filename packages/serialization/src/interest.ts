// Interest management: per-client FILTERED replication. A StateView is defined by a LiveQuery over
// the producer world (the entities that client may see) plus an opt-in per-component concealment mask
// (hidden-information layer). The host gathers a shared changeset ONCE per tick (replication.ts) and
// each view MASKS it — never a per-client re-scan. See docs/spec/interest-management.md.
//
// v1 NON-GOALS (documented, not implemented):
//   - Field-level concealment (the grain is entity + component).
//   - RICH ('string' / object<T>) field replication in a filtered stream: a filtered delta/baseline
//     carries COLUMN (numeric) fields only. A concealed component drops its rich fields too, so this
//     never leaks; visible rich fields simply do not replicate through a view yet.
//   - Synthesizing NON-exclusive relation-pair edges for an ENTERING pre-existing entity (there is no
//     per-entity live-pairs seam). Exclusive relations ride the eid column and reconstruct fine.
//   - Entities living in COLD archetypes (evicted from the hot set under memory pressure) — a view
//     assumes its matched entities are hot, which holds whenever a system iterates them.
//   - DANGLING references on leave: an eid/relation edge from a still-visible entity to one that LEAVES
//     the view is masked to NO_ENTITY the moment the target is hidden, but if the target leaves LATER
//     (while the referencing entity stays visible and otherwise unchanged) the client's copy is not
//     re-cleared — the referrer didn't change, so no update is sent, and there is no reverse-reference
//     index for arbitrary eid fields to drive a compensating write. The stale handle cannot alias a
//     live entity (generation bits), and reading it resolves to a dead handle. Conceal the referencing
//     component (or re-touch the referrer) if a client must observe the clear promptly.

import type { ComponentId, EntityHandle } from '@ecsia/schema'
import { ShapeKind } from '@ecsia/core'
import type { SerializeArchetype, SerializeStructuralRecord, World } from '@ecsia/core'
import { WriteCursor } from './cursor.js'
import {
  FLAG_FIELD_GRANULAR,
  FLAG_HAS_RELATIONS,
  FLAG_HAS_STRUCTURAL,
  FLAG_IS_DELTA,
  FLAG_IS_FILTERED,
  NO_ENTITY_U32,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
  createPersistedColumnsCache,
  elementOrdinal,
} from './format.js'
import type { PersistedComponentColumns } from './format.js'
import { collectChangedRows, writeFieldGranularBlocks, writeValueArchBlock } from './delta.js'
import type { EpsilonSelection } from './delta.js'
import { emitComponentAdd, emitComponentRemove, emitEntityDestroy, emitStructuralRecord, synthEntityAdd } from './structural.js'
import { writeRegistrySection } from './snapshot.js'
import { writePairPayload } from './payload.js'
import type { ReplicationMessage } from './replication.js'

/** The minimal query surface a view needs: enumerate the currently-visible entity handles. Both the
 * fully-typed `Query<Terms>` and the `LooseQuery` from `world.query(...)` satisfy it (their iterator
 * elements carry `.handle`), and it is covariant enough to accept either without the generic. */
export interface VisibilityQuery {
  [Symbol.iterator](): Iterator<{ readonly handle: EntityHandle }>
}

export interface StateViewOptions {
  /** The entities this client may see — a `world.query(...)` result. A non-matching entity is
   * invisible: absent from the view's baseline, its changes dropped, its enter/leave synthesized. */
  readonly visible: VisibilityQuery
  /** Component ids this view must NEVER receive, even on visible entities (hidden-information layer).
   * Empty ⇒ pure entity-level visibility. */
  readonly hideComponents?: readonly ComponentId[]
  /** Per-entity component concealment, layered over `hideComponents`. MUST be pure and deterministic
   * (invariant IM-4). Called for a visible entity's real components only. */
  readonly conceal?: (entity: EntityHandle, component: ComponentId) => boolean
  /** #166 PROTOTYPE: `'field'` emits only the fields that changed since this client last saw the entity
   * (via a view-owned exact shadow), instead of the whole component. No-conceal / no-eid path only.
   * Default `'component'` (unchanged). */
  readonly granularity?: 'component' | 'field'
  /** #167 PROTOTYPE: maintain membership incrementally via enter()/leave() instead of re-scanning
   * `visible` each delta(). `visible` seeds the initial set at baseline(); after that the caller drives
   * transitions. Default false (per-tick query re-scan, unchanged). */
  readonly incremental?: boolean
}

export interface StateView {
  /** Emit a filtered delta masking the host's shared changeset (kind:'delta', FLAG_IS_FILTERED). A
   * journal gap degrades to a filtered baseline, mirroring the unfiltered stream's G3 auto-resync. */
  delta(): ReplicationMessage
  /** A full filtered baseline for a (re)joining client: only the currently-visible entities, with
   * concealed components stripped (kind:'baseline'). Resets this view's `prevVisible`. */
  baseline(): ReplicationMessage
  /** #167 incremental membership (only meaningful when the view was created `incremental`): the caller
   * pushes AOI transitions instead of the view re-scanning a query each tick. No-op otherwise. */
  enter(handle: EntityHandle): void
  leave(handle: EntityHandle): void
  /** The entity set the view emitted as visible on its last delta()/baseline(). */
  readonly visibleEntities: ReadonlySet<EntityHandle>
}

/** The once-per-tick shared changeset the stream computes and every view masks (invariant IM-5). */
export interface SharedChangeset {
  readonly since: number
  readonly target: number
  readonly gap: boolean
  readonly records: readonly SerializeStructuralRecord[]
  readonly realCreated: ReadonlySet<number>
  readonly realDestroyed: ReadonlySet<number>
  readonly changedRowsByArch: ReadonlyMap<number, number[]>
  readonly realComponentIds: ReadonlySet<number>
  /** (arch, row) for a HOT entity handle, lazily indexed on first need (enter/leave synthesis). */
  resolveArch(handle: number): { readonly arch: SerializeArchetype; readonly row: number } | undefined
}

// Gather the shared changeset covering (since, currentTick]. drainStructuralSince and changedRows are
// each read ONCE here; the caller memoizes this per tick so N views share it. Non-destructive reads.
export function gatherSharedChangeset(world: World, since: number): SharedChangeset {
  const s = world.__serialize
  const target = world.currentTick()
  const drained = s.drainStructuralSince(since)
  const changedRowsByArch = collectChangedRows(world, since)
  const realCreated = new Set<number>()
  const realDestroyed = new Set<number>()
  if (!drained.gap) {
    for (const rec of drained.records) {
      if ((rec.kind as number) === ShapeKind.Create) realCreated.add(rec.handle)
      else if ((rec.kind as number) === ShapeKind.Destroy) realDestroyed.add(rec.handle)
    }
  }
  const realComponentIds = new Set<number>()
  for (const c of s.components()) realComponentIds.add(c.id as number)

  let archIndex: Map<number, { arch: SerializeArchetype; row: number }> | undefined
  return {
    since,
    target,
    gap: drained.gap,
    records: drained.records,
    realCreated,
    realDestroyed,
    changedRowsByArch,
    realComponentIds,
    resolveArch(handle: number) {
      if (archIndex === undefined) {
        archIndex = new Map()
        for (const a of s.archetypes()) {
          for (let r = 0; r < a.count; r++) archIndex.set(a.rows[r] as number, { arch: a, row: r })
        }
      }
      return archIndex.get(handle)
    },
  }
}

/** The stream-side wiring a view needs, so interest.ts stays free of the envelope/cursor bookkeeping
 * that lives in replication.ts (which owns the shared-changeset memoization). */
export interface StateViewDeps {
  gatherShared(): SharedChangeset
  currentTick(): number
  schemaHash(): number
  nextSeq(): number
  /** A view took a filtered baseline at `tick`: align the shared cursor so its next delta chains. */
  noteBaseline(tick: number): void
  /** #166+shared-shadow: per-tick field-change masks over the WORLD's changed rows, computed ONCE by
   * the stream (one shared shadow) and masked per view (invariant IM-5). Keyed by archetype id. */
  sharedFieldMasks(): ReadonlyMap<number, EpsilonSelection>
}

export function createStateView(world: World, opts: StateViewOptions, deps: StateViewDeps, fieldGranular = false, incremental = false): StateView {
  assertPlatformLittleEndian()
  const s = world.__serialize
  const hide = new Set<number>((opts.hideComponents ?? []) as readonly number[])
  const conceal = opts.conceal
  const persistedColumnsOf = createPersistedColumnsCache()
  // #167: incremental membership. Instead of rebuilding a Set from `opts.visible` every delta()
  // (O(members)/tick), keep a persistent member set the caller mutates via enter()/leave(), and carry
  // the tick's transitions in pending sets — so per-tick membership work is O(changes), not O(members).
  const memberSet = new Set<number>()
  const pendingEntered = new Set<number>()
  const pendingLeft = new Set<number>()
  let seeded = false
  // Visibility bitmap keyed by the handle's slot index (incremental mode only): the field-granular
  // filter tests visibility once per world-changed row per view — a dense byte array read beats the
  // Set hash lookup that dominated the profile. Maintained O(1) on enter()/leave(); no per-tick
  // rebuild. Costs maxEntities bytes/view (the memory-for-speed trade of the incremental path).
  const indexMask = world.handleLayout.indexMask
  const visibleBits = incremental ? new Uint8Array(indexMask + 1) : undefined
  function seedMembers(): void {
    memberSet.clear()
    visibleBits?.fill(0)
    for (const e of opts.visible) {
      const h = e.handle as number
      memberSet.add(h)
      if (visibleBits !== undefined) visibleBits[(h & indexMask) >>> 0] = 1
    }
    seeded = true
  }
  const deltaCur = new WriteCursor(8 * 1024)
  const baselineCur = new WriteCursor(16 * 1024)
  let prevVisible = new Set<number>()
  // Per still-tracked visible entity, the REAL component ids concealed as of its last emitted message
  // (SPARSE — absent ⇒ nothing concealed). Drives component reveal/conceal transitions across ticks;
  // only needed when `conceal` is dynamic, since a static `hideComponents` set never flips for a
  // stably-present component. Left empty (and never consulted) when `conceal` is undefined.
  const concealedByEntity = new Map<number, Set<number>>()
  const dynamicConceal = conceal !== undefined

  function isConcealed(handle: number, componentId: number): boolean {
    return hide.has(componentId) || (conceal !== undefined && conceal(handle as EntityHandle, componentId as ComponentId))
  }

  function concealedSetOf(arch: SerializeArchetype, handle: number, realComponentIds: ReadonlySet<number>): Set<number> {
    const set = new Set<number>()
    for (const cid of arch.signature) if (realComponentIds.has(cid) && isConcealed(handle, cid)) set.add(cid)
    return set
  }
  function trackConcealed(handle: number, concealed: Set<number>): void {
    if (concealed.size > 0) concealedByEntity.set(handle, concealed)
    else concealedByEntity.delete(handle)
  }

  function materializeVisible(): Set<number> {
    const set = new Set<number>()
    for (const e of opts.visible) set.add(e.handle as number)
    return set
  }

  function writeFilteredDelta(
    shared: SharedChangeset,
    nowVisible: Set<number>,
    precomputed?: { entered: Set<number>; left: Set<number> },
    reuse = false,
  ): Uint8Array {
    // #167: query mode diffs prev↔now (O(members) every tick); incremental mode takes entered/left
    // from the caller's enter()/leave() and never rebuilds or snapshots the membership set.
    let entered: Set<number>
    let left: Set<number>
    if (precomputed !== undefined) {
      entered = precomputed.entered
      left = precomputed.left
    } else {
      entered = new Set<number>()
      for (const h of nowVisible) if (!prevVisible.has(h)) entered.add(h)
      left = new Set<number>()
      for (const h of prevVisible) if (!nowVisible.has(h)) left.add(h)
    }
    // "Was visible last tick" for a still-alive destroy: prevVisible in query mode; in incremental
    // mode an entity visible last tick is either still a member or in `left`.
    const wasVisibleLastTick = (h: number): boolean =>
      precomputed !== undefined ? nowVisible.has(h) || left.has(h) : prevVisible.has(h)

    const cur = deltaCur
    cur.reset()
    // --- HEADER (32 bytes, mirroring the delta header; richOff stays 0 — no filtered RICH section) ---
    cur.u32(SNAPSHOT_MAGIC)
    cur.u16(SERIALIZATION_FORMAT_VERSION)
    cur.u8(1)
    const flagsAt = cur.pos
    cur.u8(FLAG_IS_DELTA | FLAG_IS_FILTERED)
    cur.u32(s.schemaHash())
    cur.u32(shared.since)
    cur.u32(shared.target)
    const structOffAt = cur.pos
    cur.u32(0)
    const valueOffAt = cur.pos
    cur.u32(0)
    cur.u32(0) // richSectionOffset — always 0 (filtered v1 carries no RICH section)

    // --- SECTION S: ONE coherent structural section (real ops, then synth enters, then synth leaves) ---
    cur.patchU32(structOffAt, cur.pos)
    const structStart = cur.pos
    const rel = s.relations()
    // An eid field carries the target's RAW producer handle; a visible entity pointing at a hidden one
    // would disclose its existence. The emit paths mask any eid lane whose target is not visible.
    const isHidden = (handle: number): boolean => !nowVisible.has(handle)
    // (1) Real journaled ops, filtered by visibility + concealment. An entity synthesized this tick
    // (entered-not-created / left-not-destroyed) is fully rebuilt/torn-down below, so its real ops are
    // dropped here to avoid emitting an op for an entity the receiver has not spawned yet / will drop.
    for (const rec of shared.records) {
      const h = rec.handle
      const k = rec.kind as number
      const destroyLike = k === ShapeKind.Destroy || k === ShapeKind.Remove || k === ShapeKind.RemovePair
      const visible = nowVisible.has(h) || (destroyLike && wasVisibleLastTick(h))
      if (!visible) continue
      if ((entered.has(h) && !shared.realCreated.has(h)) || (left.has(h) && !shared.realDestroyed.has(h))) continue
      // A real destroy tears the whole entity down, so its own component removes this tick are moot.
      if (destroyLike && k !== ShapeKind.Destroy && shared.realDestroyed.has(h)) continue
      // Never emit a pair edge whose OTHER end is hidden from this client — the op carries the target
      // handle (structural.ts), so emitting it would leak the concealed entity. A pair the client
      // should keep always has both ends visible; when the hidden end despawns on the client (its own
      // conceal-leave), the relation cascade drops the edge, so skipping the op here loses nothing.
      const pairLike = k === ShapeKind.AddPair || k === ShapeKind.SetPayload || k === ShapeKind.RemovePair
      if (pairLike && !nowVisible.has(rec.target)) continue
      if ((k === ShapeKind.Add || k === ShapeKind.Remove) && isConcealed(h, rec.componentId)) continue
      emitStructuralRecord(cur, world, rec, rel, isHidden)
    }
    // (2) Enter: a full per-client baseline for each pre-existing entity that became visible.
    for (const h of sortedAsc(entered)) {
      if (shared.realCreated.has(h)) continue
      const loc = shared.resolveArch(h)
      if (loc === undefined) continue // cold archetype — v1 limitation
      synthEntityAdd(cur, world, loc.arch, h, shared.realComponentIds, isConcealed, isHidden)
      if (dynamicConceal) trackConcealed(h, concealedSetOf(loc.arch, h, shared.realComponentIds))
    }
    // (3) Leave: a conceal-flagged destroy for each still-alive entity that left the view.
    for (const h of sortedAsc(left)) {
      if (dynamicConceal) concealedByEntity.delete(h)
      if (shared.realDestroyed.has(h)) continue
      emitEntityDestroy(cur, h, true)
    }
    // (4) Component-level transitions on STILL-VISIBLE entities whose per-entity conceal state flipped
    // this tick: a REVEALED component needs an explicit add (its unchanged value isn't in SECTION V),
    // a NEWLY-CONCEALED one an explicit remove (else stale data lingers on the client). Only reachable
    // when `conceal` is dynamic. Deterministic: entities by handle, components in signature order.
    if (dynamicConceal) {
      const stillVisible: number[] = []
      for (const h of nowVisible) if (prevVisible.has(h) && !entered.has(h)) stillVisible.push(h)
      stillVisible.sort((a, b) => a - b)
      for (const h of stillVisible) {
        const loc = shared.resolveArch(h)
        if (loc === undefined) continue
        const nowConcealed = concealedSetOf(loc.arch, h, shared.realComponentIds)
        const prev = concealedByEntity.get(h)
        for (const cid of loc.arch.signature) {
          const was = prev?.has(cid) ?? false
          const now = nowConcealed.has(cid)
          if (was && !now) emitComponentAdd(cur, world, h, cid, isHidden) // revealed → full current values
          else if (!was && now) emitComponentRemove(cur, h, cid) // newly concealed → drop on the client
        }
        trackConcealed(h, nowConcealed)
      }
    }
    let flags = FLAG_IS_DELTA | FLAG_IS_FILTERED
    if (cur.pos > structStart) flags |= FLAG_HAS_STRUCTURAL

    // --- SECTION V: changed values, masked to visible-non-entered rows and non-concealed columns ---
    cur.patchU32(valueOffAt, cur.pos)
    const archCountAt = cur.pos
    cur.u32(0)
    let changedArchetypeCount = 0
    // #166 PROTOTYPE: field-granular filtered SECTION V. Per archetype, take the shared changed rows,
    // keep only visible-non-entered, then selectByEpsilon(perField) against this view's own shadow to
    // emit ONLY the fields that changed since this client last saw them. Encode-only; gated on
    // !dynamicConceal (writeFieldGranularBlocks omits the per-entity concealment grouping and the eid
    // hide-masking writeValueArchBlock applies, so it is correct only for the no-conceal, no-eid case —
    // which is exactly the movement workload this measures).
    if (fieldGranular && !dynamicConceal) {
      // The field-change masks are computed ONCE by the stream over the world's changed rows (shared
      // shadow); each view only MASKS that shared selection down to its visible rows — no per-view
      // shadow diff. Correct for continuously-visible entities (all live views share the window);
      // enters get a full baseline in the structural section above, not a masked delta.
      const sharedMasks = deps.sharedFieldMasks()
      for (const a of s.archetypes()) {
        const sel = sharedMasks.get(a.id)
        if (sel === undefined || sel.rows.length === 0) continue
        const persisted = persistedColumnsOf(a)
        if (persisted.length === 0) continue
        const visibleRows: number[] = []
        if (visibleBits !== undefined) {
          const bits = visibleBits
          for (const r of sel.rows) {
            const h = a.rows[r] as number
            if (bits[(h & indexMask) >>> 0] === 1 && !entered.has(h)) visibleRows.push(r)
          }
        } else {
          for (const r of sel.rows) {
            const h = a.rows[r] as number
            if (nowVisible.has(h) && !entered.has(h)) visibleRows.push(r)
          }
        }
        if (visibleRows.length === 0) continue
        changedArchetypeCount += writeFieldGranularBlocks(cur, a, { rows: visibleRows, masks: sel.masks, words: sel.words }, persisted)
      }
      flags |= FLAG_FIELD_GRANULAR
    } else {
      for (const a of s.archetypes()) {
        const allRows = shared.changedRowsByArch.get(a.id)
        if (allRows === undefined) continue
        const persisted = persistedColumnsOf(a)
        if (persisted.length === 0) continue
        // Group the kept rows by their concealment mask so each emitted block has a UNIFORM column set
        // (a component may be concealed per-entity). No concealment ⇒ one group, the whole archetype.
        const groups = new Map<string, { rows: number[]; keptPersisted: PersistedComponentColumns[] }>()
        for (const r of allRows) {
          const h = a.rows[r] as number
          if (!nowVisible.has(h) || entered.has(h)) continue
          let key = ''
          const kept: PersistedComponentColumns[] = []
          for (const pc of persisted) {
            const comp = a.components[pc.compIndex]
            if (comp === undefined) continue
            if (isConcealed(h, comp.componentId as number)) {
              key += (comp.componentId as number) + ','
              continue
            }
            kept.push(pc)
          }
          let g = groups.get(key)
          if (g === undefined) {
            g = { rows: [], keptPersisted: kept }
            groups.set(key, g)
          }
          g.rows.push(r)
        }
        for (const g of groups.values()) {
          if (g.keptPersisted.length === 0) continue
          changedArchetypeCount += 1
          writeValueArchBlock(cur, a, g.rows, g.keptPersisted, isHidden)
        }
      }
    }
    cur.patchU32(archCountAt, changedArchetypeCount)
    cur.patchU8(flagsAt, flags)

    if (precomputed === undefined) prevVisible = nowVisible
    // #167 opt: the streaming host sends each view's bytes before the next tick, so the incremental
    // path returns a view into the reused cursor buffer instead of allocating a per-view copy. Valid
    // until this view's next delta(); each view owns its own deltaCur, so sibling views are unaffected.
    return reuse ? cur.bytesView() : cur.bytesCopy()
  }

  function writeFilteredSnapshot(nowVisible: Set<number>): Uint8Array {
    const relProvider = s.relations()
    const hasRelations = relProvider !== undefined
    const realComponentIds = new Set<number>()
    for (const c of s.components()) realComponentIds.add(c.id as number)

    // Group visible HOT entities by (real archetype, concealment mask). Each group becomes a synthetic
    // archetype in the image — the deserializer keys membership off the emitted signature, so a
    // concealed component simply never appears in the reduced signature (never materializes on the
    // client), and the arch id is an opaque grouping key we assign freely.
    interface Group {
      readonly groupId: number
      readonly arch: SerializeArchetype
      readonly signature: number[]
      readonly persisted: PersistedComponentColumns[]
      readonly handles: number[]
      readonly rows: number[]
    }
    const groups: Group[] = []
    const groupByKey = new Map<string, Group>()
    let aliveCount = 0
    // A baseline is a full resync: rebuild the concealment tracking from scratch so the next delta
    // chains from exactly the non-concealed components this image emits.
    if (dynamicConceal) concealedByEntity.clear()
    for (const a of s.archetypes()) {
      for (let r = 0; r < a.count; r++) {
        const h = a.rows[r] as number
        if (!nowVisible.has(h)) continue
        const concealed = new Set<number>()
        for (const cid of a.signature) {
          if (realComponentIds.has(cid) && isConcealed(h, cid)) concealed.add(cid)
        }
        if (dynamicConceal) trackConcealed(h, concealed)
        const key = a.id + '|' + [...concealed].sort((x, y) => x - y).join(',')
        let g = groupByKey.get(key)
        if (g === undefined) {
          // Real components only — dropping synthetic pair/presence ids (they are never in
          // realComponentIds), matching synthEntityAdd. Emitting them would leak the existence and
          // cardinality of a visible entity's relations to HIDDEN targets through its signature.
          const signature = a.signature.filter((cid) => realComponentIds.has(cid) && !concealed.has(cid))
          const persisted = persistedColumnsOf(a).filter((pc) => {
            const comp = a.components[pc.compIndex]
            return comp !== undefined && !concealed.has(comp.componentId as number)
          })
          g = { groupId: groups.length, arch: a, signature, persisted, handles: [], rows: [] }
          groups.push(g)
          groupByKey.set(key, g)
        }
        g.handles.push(h)
        g.rows.push(r)
        aliveCount += 1
      }
    }

    const cur = baselineCur
    cur.reset()
    // --- SECTION 0: HEADER (36 bytes; offsetRich stays 0 — no filtered RICH section) ---
    cur.u32(SNAPSHOT_MAGIC)
    cur.u16(SERIALIZATION_FORMAT_VERSION)
    cur.u8(1)
    cur.u8((hasRelations ? FLAG_HAS_RELATIONS : 0) | FLAG_IS_FILTERED)
    cur.u32(s.schemaHash())
    cur.u32(world.currentTick())
    cur.u32(aliveCount)
    cur.u32(groups.length)
    const offRegistryAt = cur.pos
    cur.u32(0)
    const offStructureAt = cur.pos
    cur.u32(0)
    cur.u32(0) // sectionRichOffset

    // --- SECTION 1: REGISTRY (world-global, verbatim) ---
    cur.patchU32(offRegistryAt, cur.pos)
    writeRegistrySection(cur, s, relProvider)

    // --- SECTION 2: STRUCTURE (entity list then per-group signature) ---
    cur.patchU32(offStructureAt, cur.pos)
    for (const g of groups) for (const h of g.handles) {
      cur.u32(h >>> 0)
      cur.u32(g.groupId)
    }
    for (const g of groups) {
      cur.u32(g.groupId)
      cur.u32(g.handles.length)
      cur.u16(g.signature.length)
      for (const cid of g.signature) cur.u32(cid)
    }

    // --- SECTION 3: SoA (per group, per non-concealed persisted column, values gathered per entity) ---
    cur.alignTo4()
    for (const g of groups) {
      const a = g.arch
      cur.u32(g.groupId)
      cur.u16(g.persisted.length)
      for (const pc of g.persisted) {
        const comp = a.components[pc.compIndex]
        if (comp === undefined) continue
        cur.u32(comp.componentId as number)
        cur.u16(pc.colIndices.length)
        for (const ci of pc.colIndices) {
          const col = comp.columns[ci]
          if (col === undefined) continue
          const stride = col.layout.stride
          cur.u8(elementOrdinal(col.layout.element))
          cur.u8(stride)
          cur.u32(g.rows.length * stride * col.layout.elementBytes)
          // An eid lane holds the target's raw handle; mask any target not in this view to NO_ENTITY
          // so a visible entity never discloses a hidden one it references.
          if (comp.fields[ci]?.token === 'eid') {
            const eview = col.view as unknown as { [i: number]: number }
            for (const r of g.rows) {
              for (let lane = 0; lane < stride; lane++) {
                const stored = eview[r * stride + lane] as number
                cur.u32(stored !== -1 && !nowVisible.has(stored >>> 0) ? NO_ENTITY_U32 : stored >>> 0)
              }
            }
            cur.alignTo4()
            continue
          }
          const view = col.view as unknown as { subarray(s: number, e: number): ArrayBufferView }
          for (const r of g.rows) cur.copyBytes(view.subarray(r * stride, (r + 1) * stride))
          cur.alignTo4()
        }
      }
    }

    // --- SECTION 4: RELATIONS (pairs whose subject AND target are both visible) ---
    if (hasRelations && relProvider !== undefined) {
      cur.alignTo4()
      const pairs = relProvider
        .livePairs()
        .filter((p) => nowVisible.has(p.subject as number) && (p.target === null || nowVisible.has(p.target as number)))
      cur.u32(pairs.length)
      for (const p of pairs) {
        cur.u32((p.subject as number) >>> 0)
        cur.u16(p.relationId as number)
        cur.u32(p.target === null ? NO_ENTITY_U32 : (p.target as number) >>> 0)
        writePairPayload(cur, p.payload)
      }
    }

    return cur.bytesCopy()
  }

  function assertSerial(op: string): void {
    if (world.phase !== 'serial') {
      throw new Error(`${op} must run while the world is in its serial phase (outside scheduler.update / worker waves)`)
    }
  }

  function makeBaseline(nowVisible: Set<number>): ReplicationMessage {
    const bytes = writeFilteredSnapshot(nowVisible)
    const tick = deps.currentTick()
    prevVisible = nowVisible
    deps.noteBaseline(tick)
    return { seq: deps.nextSeq(), kind: 'baseline', schemaHash: deps.schemaHash(), baselineTick: 0, tick, bytes }
  }

  return {
    delta(): ReplicationMessage {
      assertSerial('StateView.delta()')
      const shared = deps.gatherShared()
      if (incremental) {
        if (!seeded) seedMembers()
        // A journal gap degrades to a filtered baseline (G3); a baseline reseeds and clears pending.
        if (shared.gap) {
          pendingEntered.clear()
          pendingLeft.clear()
          return makeBaseline(memberSet)
        }
        const bytes = writeFilteredDelta(shared, memberSet, { entered: pendingEntered, left: pendingLeft }, true)
        pendingEntered.clear()
        pendingLeft.clear()
        return { seq: deps.nextSeq(), kind: 'delta', schemaHash: deps.schemaHash(), baselineTick: shared.since, tick: shared.target, bytes }
      }
      const nowVisible = materializeVisible()
      // A producer-side journal gap means (since, target] cannot be structurally reconstructed — the
      // view degrades to a filtered baseline, exactly as the unfiltered stream's tick() does (G3).
      if (shared.gap) return makeBaseline(nowVisible)
      const bytes = writeFilteredDelta(shared, nowVisible)
      return { seq: deps.nextSeq(), kind: 'delta', schemaHash: deps.schemaHash(), baselineTick: shared.since, tick: shared.target, bytes }
    },
    baseline(): ReplicationMessage {
      assertSerial('StateView.baseline()')
      if (incremental) {
        seedMembers()
        pendingEntered.clear()
        pendingLeft.clear()
        return makeBaseline(memberSet)
      }
      return makeBaseline(materializeVisible())
    },
    // #167 incremental membership. The caller (which already computes AOI enter/leave) pushes changes
    // here instead of the view re-scanning a query each tick. No-op unless the view is incremental.
    enter(handle: EntityHandle): void {
      const h = handle as number
      memberSet.add(h)
      pendingEntered.add(h)
      pendingLeft.delete(h)
      if (visibleBits !== undefined) visibleBits[(h & indexMask) >>> 0] = 1
    },
    leave(handle: EntityHandle): void {
      const h = handle as number
      memberSet.delete(h)
      pendingLeft.add(h)
      pendingEntered.delete(h)
      if (visibleBits !== undefined) visibleBits[(h & indexMask) >>> 0] = 0
    },
    get visibleEntities(): ReadonlySet<EntityHandle> {
      return prevVisible as ReadonlySet<number> as ReadonlySet<EntityHandle>
    },
  }
}

function sortedAsc(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b)
}
