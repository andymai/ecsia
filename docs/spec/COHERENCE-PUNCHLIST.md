# ecsia Spec Coherence Punch-List

> Output of the coherence pass over the complete 12-module spec set (workflow `wf_37489890-e3b`).
> The automated **finalize step did not run** (session limit), so these fixes are **pending**.
> Verdict: *NOT COHERENT — ship-blocking issues remain.* All 12 module specs exist; the issues
> below are cross-spec seams plus the still-missing world spec.

## Cross-spec contradictions (must-fix before implementation)

### C1 — `world.trackWrite` signature mismatch (hottest seam; breaks Must-Fix #2 runtime)
- **Where:** reactivity.md §3.3/§6.2/§10 (owner) vs accessors.md §4.1/§4.4/§6.4 vs type-system.md §9 (I-ACC-4) vs component-schema.md §8.2.
- **Issue:** owner declares `trackWrite(index: EntityIndex, componentId, fieldIndex?)` (first arg = 22-bit index, packed verbatim). Callers invoke `trackWrite(this.__eid, def.id)` where `__eid` is the FULL handle (index ⊕ generation) and **never pass `fieldIndex`** → generation silently stripped (or wrong log index), and field-granular change stamping (reactivity §6.2, serialization §6.3) has no caller (dead).
- **Fix:** canonical signature = `trackWrite(index: EntityIndex, componentId, fieldIndex?)`. Update accessors/type-system/component-schema to pass `handleIndex(this.__eid)` (or carry `__idx`) and forward `fieldIndex` for field-granular setters.

### C2 — 10-bit componentId field vs unbounded synthetic pair IDs (runtime overflow)
- **Where:** reactivity.md §3.1/§3.5 vs relations.md §2.2 vs component-schema.md §7.6.
- **Issue:** write/shape log packs `componentId` into `32 - ENTITY_INDEX_BITS = 10` bits (≤1023 ids), validated **once at world creation**. But relations mint a NEW dense ComponentId per distinct `(relationId, targetIndex)` pair, **eagerly + unboundedly**, from the same id space. Thousands of relation targets blow past 1023 at runtime, after the fail-fast guard passed and the two-word fallback can no longer be selected → log corruption.
- **Fix (pick one):** (a) default log to two-word entries whenever any relation is registered; or (b) carve pair IDs out of the logged-componentId space (log pair writes against the bounded relation `presenceId`); or (c) auto-promote `logEntryWords→2` at the serial flush where `nextComponentId` crosses threshold. Replace the creation-time fail-fast guard; cross-reference relations §2.2 ↔ reactivity §3.1/§3.5.

### C3 — componentId 0 is both a user component and the CREATE/DESTROY sentinel
- **Where:** component-schema.md §7.1 vs reactivity.md §4.1/§4.2.
- **Issue:** §7.1 says both "component id 0 is a normal user component" AND reserves slot 0 (`FIRST_USER_COMPONENT_ID = 1`). reactivity packs CREATE/DESTROY shape-log entries with `componentId = 0` as "no component" sentinel.
- **Fix:** reserve ComponentId 0 as the "no component"/changeVersion sentinel (NEVER a user component), `FIRST_USER_COMPONENT_ID = 1`. Delete the contradictory sentence. Belongs in the world spec's reserved-id set (G-6).

### C4 — bit-vector stride width computed two different ways
- **Where:** scheduler.md §3.3 vs component-schema.md §7.4 vs archetype-storage.md §3.3.
- **Issue:** schema/storage use `ceil(registry.nextComponentId / 32)` (nextComponentId already includes user + relation-presence + overflow ids). scheduler uses `ceil((numComponentTypes + numRelations)/32)`, adding relations as a separate block → double-count or misaligned `presenceId(R)` bit index.
- **Fix:** single canonical "fixed component-id count" = registry `nextComponentId` post-registration; all three derive stride from it. Drop scheduler's `+ numRelations`.

## Gaps

- **G-6 (BLOCKER): no `world.md` / `createWorld` spec exists.** Everything defers to it: the `world.phase` (`serial`/`wave`) state machine, option-validation + module wiring order, the reserved-ComponentId set & `FIRST_USER_COMPONENT_ID`, `maxEntities` default, `createWorld` option-key shape. Blocks M0. **Must author this spec.**
- **G-7 (partial): worker startup handshake for lazily-created columns.** serialization §3.4 defines a `ColumnsAdded` postMessage notice but no spec normatively guarantees the notice is *delivered AND applied* before a worker's first system in a wave touches the new column.
- **Single-thread `world.phase` ownership:** scheduler §6.4 keeps phase `'serial'` all update (direct-apply) but §2.1/§10 call scheduler the "sole writer" of phase; kernel-only mode (scheduler §8, no scheduler package) leaves who initializes `world.phase = 'serial'` undefined though storage/accessors/queries/serialization all assert on it. Pin default in world spec.
- **`Tick` type / `world.tick` vs `world.currentTick()` ownership** never canonically pinned (reactivity advances it; scheduler/accessors/queries/serialization read it).
- **changeVersion column growth seam:** archetype-storage §5.3.1 leaves "reactivity attaches it via Buffers.column" vs "reactivity grows it via own Buffers.grow" as an either/or; a row written past its capacity is a bug if neither fires.

## Naming / encoding inconsistencies

- **README.md severely stale** — lists only 8 specs, still calls the 6 now-written ones "unwritten"/UNRESOLVED, checklist still "Blocked on missing spec." Must regenerate.
- **observerCadence vocab mismatch:** reactivity `'end-of-frame'|'per-system'` (also `'frame-end'` in §16) vs public-api `'frame-end'|'per-system'` vs scheduler `'frame-end'|'per-wave'`. Pick one literal set + default.
- **createWorld reactivity options:** public-api nests under `reactivity:{}`; reactivity.md exposes flat top-level keys. Reconcile nesting.
- **Op enum ordinal drift:** command-buffer `Op.*`, serialization `DeltaOp.*`, reactivity `ShapeKind.*`/`OP_KIND_*` use overlapping members with **different ordinals** (e.g. ShapeKind.Add=0, DeltaOp.ComponentAdd=2, Op.ADD=3). Either unify ordinals or drop the "shared op numbering / reusable apply path" claim.
- **corral vs command buffer:** mostly resolved; tabulate the three write destinations (disjoint SAB column direct / write-corral for `.changed` tracking / command-buffer for structure) in one place.

## Must-fix status
- **#2 (read/write split):** type-level read-only enforcement resolved; **runtime half broken by C1** (trackWrite signature) — fix C1 to compose.
- **#1, #3, #4, #5:** substantively resolved in dedicated specs and cross-referenced consistently (serial-only bitmask w/ phase asserts; command-buffer layout/merge/tombstones; relations exclusivity split; memory-buffers length-tracking + accessor `__rebind`). Only the C2 width interlock indirectly touches #3.

## Resume plan (when session limit resets)
1. Author **world.md (G-6)** — the central missing spec.
2. Apply **C1–C4** edits across the named specs.
3. Resolve gaps G-7, phase ownership, Tick ownership, changeVersion growth.
4. Reconcile naming (observerCadence, option nesting, Op ordinals).
5. **Regenerate README.md** as the authoritative index over all 13 specs + checklist mapped to build-plan milestones.
