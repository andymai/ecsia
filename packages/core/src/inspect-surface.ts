// The read-only introspection seam @ecsia/devtools (P5) reads through, exposed on World as `__inspect`.
// Keeps the dependency direction acyclic: devtools imports @ecsia/core for this surface; core NEVER
// imports devtools. Everything here is serial / main-thread, read-only, and side-effect-free — a pure
// view over already-live state.
//
// WHY a NEW seam (not `__serialize`): the existing SerializationSurface deliberately exposes ONLY the
// data a snapshot needs — its `archetypes()` skips COLD and EMPTY archetypes (world.ts §4.3), and there
// is no live-query enumeration anywhere on the public/`__` surface (the QueryEngine's `liveQueries`
// getter is class-private to core). Those two data are genuinely unreachable for an inspector that wants
// the FULL archetype census (with the hot/cold flag) and the active query set. Everything else the
// inspector reports (component metadata, rich fields, relations, alive/capacity counts) is already
// reachable via `__serialize` + `world.options`, so this seam stays minimal: just the two gaps.

import type { ComponentId } from '@ecsia/schema'

/** One archetype's identity census — INCLUDING cold + empty archetypes (the `__serialize` gap). */
export interface InspectArchetype {
  readonly id: number
  /** The sorted canonical signature (ComponentIds, including tag/pair/presence ids). */
  readonly signature: readonly ComponentId[]
  readonly count: number
  /** false = hot (column-backed tables); true = cold (lazily-materialized, archetype-storage §10). */
  readonly cold: boolean
}

/** One live (compiled, cached) query's introspectable shape — the QueryEngine enumeration gap. */
export interface InspectQuery {
  /** The raw QueryTerm[] the query was compiled from (read/write/has/without/optional terms). */
  readonly terms: readonly unknown[]
  /** Number of archetypes the query currently matches. */
  readonly matchedArchetypes: number
  /** Current live match count (entities satisfying the query). */
  readonly size: number
}

/** The read-only datum surface @ecsia/devtools drives. All members are serial / main-thread, pure reads. */
export interface InspectSurface {
  /** Every archetype (hot AND cold, including empty), in id-ascending order. */
  archetypes(): readonly InspectArchetype[]
  /** Every live (cached) query, in creation order. Empty before the first `world.query(...)`. */
  queries(): readonly InspectQuery[]
}
