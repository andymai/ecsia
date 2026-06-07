// System registration & access aggregation. Lowers each declared `SystemDef` into
// an immutable `SystemBox`, resolving the declared `{read,write}` ComponentDefs to dense ComponentIds
// and packing them into fixed-width access signature words for the O(words) disjointness test.
//
// Pair IDs are component IDs: a declared read/write of a relation expands to the relation's
// presence id, an ordinary ComponentId in the same dense space. The defs a user passes carry their
// registered `.id` already, so resolution here is a `.id` read — no registry handle required.

import type { ComponentDef, ComponentId, Schema, SystemId } from '@ecsia/schema'
import type { TopicDef } from '@ecsia/core'
import { DEFAULT_MAX_SPAWNS_PER_WAVE } from './types.js'
import type { SystemBox, SystemDef } from './types.js'

export interface AccessMaps {
  /** Who reads each id. */
  readonly readers: Map<ComponentId, Set<SystemId>>
  /** Who writes each id. */
  readonly writers: Map<ComponentId, Set<SystemId>>
}

const UNREGISTERED = -1

function idOf(def: ComponentDef<Schema>): ComponentId {
  const id = def.id as unknown as number
  if (id === UNREGISTERED) {
    throw new Error(
      `system declares access to component '${def.name}' which is not registered with this world`,
    )
  }
  return id as unknown as ComponentId
}

/** Sorted-ascending, de-duped ComponentIds for a declared access set. */
function resolveIds(defs: readonly ComponentDef<Schema>[] | undefined): ComponentId[] {
  if (defs === undefined || defs.length === 0) return []
  const seen = new Set<number>()
  for (const def of defs) seen.add(idOf(def) as unknown as number)
  return [...seen].sort((a, b) => a - b) as unknown as ComponentId[]
}

/**
 * A system is worker-ineligible if any declared component carries a non-shareable (object) field.
 * Topic publishers AND consumers are both eligible: publishes ride OP_PUBLISH on the command
 * buffer, and consumers read the topic's frozen SAB ring mid-wave (cursor window from the shared
 * cursor table; advance reported back via OP_CONSUMED). A threaded consumer needs a worker kernel
 * in the kernel module like any other worker-run system.
 */
function computeWorkerEligible(def: SystemDef): boolean {
  const all = [...(def.read ?? []), ...(def.write ?? [])]
  for (const c of all) {
    for (const f of c.fields) {
      if (!f.shareable) return false
    }
  }
  return true
}

/** De-duped topic list in declaration order (object identity — topics are module-scope defs). */
function resolveTopics(defs: readonly TopicDef<Schema>[] | undefined): readonly TopicDef<Schema>[] {
  if (defs === undefined || defs.length === 0) return []
  return [...new Set(defs)]
}

function packWords(ids: readonly ComponentId[], strideWords: number): Uint32Array {
  const words = new Uint32Array(strideWords)
  for (const c of ids) {
    const i = c as unknown as number
    words[i >>> 5] = (words[i >>> 5]! | (1 << (i & 31))) >>> 0
  }
  return words
}

/**
 * Lower the registered SystemDefs into immutable SystemBoxes. `strideWords` is the single canonical
 * fixed-component-id width (= accessStrideWords = ceil(registeredComponentCount/32)) shared with
 * the bitmask and registry; it does NOT add a separate `+ numRelations` term ( C4)
 * because presence ids are already counted.
 */
export function lowerSystems(defs: readonly SystemDef[], strideWords: number): SystemBox[] {
  return defs.map((def, i) => {
    const readIds = resolveIds(def.read)
    const writeIds = resolveIds(def.write)
    return Object.freeze({
      id: i as unknown as SystemId,
      name: def.name,
      def,
      run: def.run,
      readIds,
      writeIds,
      readWords: packWords(readIds, strideWords),
      writeWords: packWords(writeIds, strideWords),
      // Topic access is carried as defs, NOT packed into the access words: topics derive DAG edges
      // but are excluded from WAVE-CONFLICT (no physical race to exclude).
      publishTopics: resolveTopics(def.publish),
      consumeTopics: resolveTopics(def.consume),
      // `before`/`after` resolved to SystemIds in graph/edges.ts (needs the full id map).
      before: [],
      after: [],
      maxSpawnsPerWave: def.maxSpawnsPerWave ?? DEFAULT_MAX_SPAWNS_PER_WAVE,
      workerEligible: computeWorkerEligible(def),
    }) satisfies SystemBox
  })
}

/** Aggregate the per-id reader/writer sets from the lowered systems' declared access only. */
export function aggregateAccess(systems: readonly SystemBox[]): AccessMaps {
  const readers = new Map<ComponentId, Set<SystemId>>()
  const writers = new Map<ComponentId, Set<SystemId>>()
  const getOrInit = (m: Map<ComponentId, Set<SystemId>>, c: ComponentId): Set<SystemId> => {
    let s = m.get(c)
    if (s === undefined) {
      s = new Set()
      m.set(c, s)
    }
    return s
  }
  for (const sb of systems) {
    for (const c of sb.readIds) getOrInit(readers, c).add(sb.id)
    for (const c of sb.writeIds) getOrInit(writers, c).add(sb.id)
  }
  return { readers, writers }
}
