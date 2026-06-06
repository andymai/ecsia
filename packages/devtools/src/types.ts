// @ecsia/devtools — the DATA LAYER report shapes. Every report is a PLAIN, serializable object
// (no class instances, no functions, no live handles) so it can be JSON-stringified, snapshotted, diffed,
// and asserted headless. The renderers (renderText / renderHTML) are PURE functions over exactly these
// shapes — they never touch a live world.

/** One component type's storage census (inspector ). */
export interface ComponentReport {
  readonly name: string
  readonly id: number
  /** Total declared field count (column-backed + rich). */
  readonly fields: number
  /** Rich (sidecar-backed: 'string' / object<T>) field names, in declaration order. */
  readonly richFields: readonly string[]
  /** Bytes one row of this component's COLUMN-backed fields occupies (rich fields contribute 0). */
  readonly bytesPerRow: number
  /** bytesPerRow × (live rows across all hot archetypes holding this component). */
  readonly totalBytes: number
}

/** One archetype's census (inspector ). Includes cold + empty archetypes. */
export interface ArchetypeReport {
  readonly id: number
  /** Component names in this archetype's signature (synthetic pair/presence ids rendered as `#id`). */
  readonly signature: readonly string[]
  readonly count: number
  /** 'hot' = column-backed; 'cold' = lazily-materialized (archetype-storage ). */
  readonly temperature: 'hot' | 'cold'
}

/** One live (compiled, cached) query's census (inspector ). */
export interface QueryReport {
  /** Human-rendered terms, e.g. `read(position)`, `write(velocity)`, `without(frozen)`. */
  readonly terms: readonly string[]
  readonly matchedArchetypes: number
  readonly size: number
}

/** One relation's live-pair census (inspector ). */
export interface RelationReport {
  readonly name: string
  readonly pairCount: number
}

/** The whole-world inspection report — a plain serializable snapshot (inspector ). */
export interface WorldReport {
  readonly entities: {
    readonly alive: number
    readonly capacity: number
  }
  readonly archetypes: readonly ArchetypeReport[]
  readonly components: readonly ComponentReport[]
  readonly queries: readonly QueryReport[]
  readonly memory: {
    /** Sum of every component's totalBytes (live column bytes across hot archetypes). */
    readonly columnsBytes: number
    /** Number of rich (sidecar) field columns registered across all components. */
    readonly sidecarEntries: number
  }
  readonly relations: readonly RelationReport[]
}

// --- watch mode -------------------------------------------------------

/** One frame's deltas vs the previous observed frame (watch ). */
export interface FrameDelta {
  /** 0-based frame index since watch start. */
  readonly frame: number
  /** Entities spawned since the previous sample — real lifecycle (handleStats totals diff), not
   * component churn: add() on a living entity contributes 0; a bare spawn() contributes 1. */
  readonly spawned: number
  /** Entities despawned since the previous sample (same lifecycle source). */
  readonly despawned: number
  /** Net alive change; always equals spawned − despawned. */
  readonly aliveDelta: number
  /** Archetypes created since the previous sample (archetype churn). */
  readonly archetypesCreated: number
  /** Components whose `.changed` write-log fired this frame, keyed by component name → count. */
  readonly changedComponents: Readonly<Record<string, number>>
  /** Total change-tracked writes observed this frame. */
  readonly changedTotal: number
}

// --- wave visualizer --------------------------------------------------

/** One system's per-wave introspection (waves ). */
export interface SystemExplain {
  readonly name: string
  readonly reads: readonly string[]
  readonly writes: readonly string[]
  /** Topic names this system publishes / consumes — the cause of a topic-derived wave separation. */
  readonly publishes: readonly string[]
  readonly consumes: readonly string[]
  readonly workerEligible: boolean
}

/** One batch (concurrent round member set) within a wave (waves ). */
export interface BatchExplain {
  readonly systems: readonly SystemExplain[]
}

/** One wave: an ordered set of batches (rounds) that run after the previous wave (waves ). */
export interface WaveExplain {
  readonly index: number
  readonly batches: readonly BatchExplain[]
}

/**
 * An access overlap that the schedule ACTUALLY enforced — two systems with overlapping write-write or
 * read-write access that the plan placed in different waves/rounds (waves ). Pairs whose overlap the
 * scheduler suppressed via `inAnyOrderWith` (kept concurrent, same round) are NOT reported here.
 */
export interface ConflictExplain {
  readonly a: string
  readonly b: string
  readonly on: string
  readonly kind: 'write-write' | 'read-write'
}

/** A system pinned to the main thread, with the reason it cannot run on a worker (waves ). */
export interface PinExplain {
  readonly system: string
  /**
   * 'rich-fields' = reads/writes an object<T>/'string' component (structural, permanent);
   * 'topic-consumer' = consumes a topic (worker-side consume is the deferred transport leg);
   * 'main-thread' = worker-eligible but placed on the main thread by the plan.
   * A system with BOTH ineligibility causes reports 'rich-fields' — the data constraint is
   * permanent, while the consume pin lifts when worker-side consume ships.
   */
  readonly reason: 'rich-fields' | 'topic-consumer' | 'main-thread'
}

/** The whole-plan explanation — the WHY of the schedule, plain + serializable (waves ). */
export interface PlanExplain {
  readonly waves: readonly WaveExplain[]
  readonly conflicts: readonly ConflictExplain[]
  readonly pinned: readonly PinExplain[]
}
