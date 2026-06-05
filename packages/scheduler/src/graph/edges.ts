// Conflict-edge derivation. Produces the resolved max-weight directed edge
// set `A → B` ("A must run before B") from four sources: EXPLICIT before/after (5), DENY suppression
// (4, removes IMPLICIT only), CLASS_HINT coarse helpers (3), and the auto IMPLICIT conflict edges (1).

import type { ComponentId, Schema, SystemId } from '@ecsia/schema'
import type { TopicDef } from '@ecsia/core'
import type { AccessMaps } from '../planner/index.js'
import type { OrderingHint, SystemBox, SystemDef } from '../planner/index.js'
import { EdgeWeight } from './weights.js'

/** A resolved directed edge with the diagnostic cause(s) that produced its winning weight. */
export interface Edge {
  readonly from: SystemId
  readonly to: SystemId
  readonly weight: EdgeWeight
  /** Human-readable cause used in cycle reporting. */
  readonly cause: string
}

function key(from: number, to: number): number {
  // Pack an ordered (from,to) pair into one number; system counts are well under 2^16.
  return from * 0x10000 + to
}

/** A DENY between A and B suppresses an IMPLICIT edge in BOTH directions. Keyed on the unordered pair. */
function denyKey(a: number, b: number): number {
  const lo = a < b ? a : b
  const hi = a < b ? b : a
  return lo * 0x10000 + hi
}

interface EdgeBuilders {
  /** Maximum weight seen per ordered (from,to). */
  readonly best: Map<number, Edge>
}

function offer(b: EdgeBuilders, edge: Edge): void {
  if (edge.from === edge.to) return
  const k = key(edge.from as unknown as number, edge.to as unknown as number)
  const prev = b.best.get(k)
  if (prev === undefined || edge.weight > prev.weight) {
    b.best.set(k, edge)
  } else if (edge.weight === prev.weight && edge.cause !== prev.cause) {
    b.best.set(k, { ...prev, cause: `${prev.cause}; ${edge.cause}` })
  }
}

/**
 * Resolve before/after declarations to SystemIds, returning a new SystemBox set with `before`/`after`
 * populated (the lowered boxes start with empty arrays — they need the full def→id map).
 */
export function resolveOrdering(
  systems: readonly SystemBox[],
  defs: readonly SystemDef[],
): SystemBox[] {
  const idByDef = new Map<SystemDef, SystemId>()
  defs.forEach((d, i) => idByDef.set(d, i as unknown as SystemId))
  const resolve = (list: readonly SystemDef[] | undefined, owner: string): SystemId[] => {
    if (list === undefined) return []
    return list.map((d) => {
      const id = idByDef.get(d)
      if (id === undefined) {
        throw new Error(`system '${owner}' references an unregistered system in before/after`)
      }
      return id
    })
  }
  return systems.map((sb) =>
    Object.freeze({
      ...sb,
      before: resolve(sb.def.before, sb.name),
      after: resolve(sb.def.after, sb.name),
    }),
  )
}

/**
 * Collect the unordered pairs the user denied any implicit ordering between. Endpoints resolve
 * by SystemDef identity first, then by `name` (unique per world) — name-matching tolerates the common
 * spread-copy pattern `defineSystem({ ...a, order: [inAnyOrderWith(a, b)] })` where the registered def
 * is a copy of the hint endpoint.
 */
function collectDenials(systems: readonly SystemBox[], defs: readonly SystemDef[]): Set<number> {
  const idByDef = new Map<SystemDef, SystemId>()
  const idByName = new Map<string, SystemId>()
  defs.forEach((d, i) => {
    idByDef.set(d, i as unknown as SystemId)
    idByName.set(d.name, i as unknown as SystemId)
  })
  const resolve = (d: SystemDef): SystemId | undefined => idByDef.get(d) ?? idByName.get(d.name)
  const denied = new Set<number>()
  for (const sb of systems) {
    for (const hint of sb.def.order ?? []) {
      if (hint.kind === 'deny') {
        const a = resolve(hint.a)
        const b = resolve(hint.b)
        if (a !== undefined && b !== undefined) {
          denied.add(denyKey(a as unknown as number, b as unknown as number))
        }
      }
    }
  }
  return denied
}

function nameOf(systems: readonly SystemBox[], id: SystemId): string {
  return systems[id as unknown as number]?.name ?? `#${id as unknown as number}`
}

/** Does system `id` write component `c`? Tested against the packed write words. */
function writes(systems: readonly SystemBox[], id: SystemId, c: number): boolean {
  const words = systems[id as unknown as number]!.writeWords
  return (words[c >>> 5]! & (1 << (c & 31))) !== 0
}

/**: IMPLICIT conflict edges. Reader–reader pairs never conflict; direction = registration order. */
function deriveImplicit(
  systems: readonly SystemBox[],
  access: AccessMaps,
  denied: Set<number>,
  b: EdgeBuilders,
): void {
  const allIds = new Set<ComponentId>([...access.readers.keys(), ...access.writers.keys()])
  for (const c of allIds) {
    const cn = c as unknown as number
    const W = access.writers.get(c) ?? new Set<SystemId>()
    if (W.size === 0) continue // a pure reader-reader set on `c` never conflicts
    const R = access.readers.get(c) ?? new Set<SystemId>()
    const members = [...new Set<SystemId>([...W, ...R])]
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!
        const bb = members[j]!
        const an = a as unknown as number
        const bn = bb as unknown as number
        // At least one must WRITE `c` (a reader-reader pair drawn from R does not conflict).
        if (!writes(systems, a, cn) && !writes(systems, bb, cn)) continue
        if (denied.has(denyKey(an, bn))) continue
        const lo = an < bn ? a : bb // earlier-registered runs first
        const hi = an < bn ? bb : a
        const loVerb = writes(systems, lo, cn) ? 'writes' : 'reads'
        const hiVerb = writes(systems, hi, cn) ? 'writes' : 'reads'
        offer(b, {
          from: lo,
          to: hi,
          weight: EdgeWeight.IMPLICIT,
          cause: `both access component#${cn}: ${nameOf(systems, lo)} ${loVerb}, ${nameOf(systems, hi)} ${hiVerb}`,
        })
      }
    }
  }
}

/**: CLASS_HINT coarse helpers add weight-3 edges to all current writers/readers of `c`. */
function applyClassHints(systems: readonly SystemBox[], access: AccessMaps, b: EdgeBuilders): void {
  for (const sb of systems) {
    for (const hint of sb.def.order ?? []) {
      if (hint.kind === 'deny') continue
      const cid = hint.component.id as unknown as number
      if (hint.kind === 'beforeWritersOf') {
        const writers = access.writers.get(cid as unknown as ComponentId)
        if (writers === undefined) continue
        for (const w of writers) {
          offer(b, {
            from: sb.id,
            to: w,
            weight: EdgeWeight.CLASS_HINT,
            cause: `${sb.name}.beforeWritersOf(${hint.component.name})`,
          })
        }
      } else {
        const readers = access.readers.get(cid as unknown as ComponentId)
        if (readers === undefined) continue
        for (const r of readers) {
          offer(b, {
            from: r,
            to: sb.id,
            weight: EdgeWeight.CLASS_HINT,
            cause: `${sb.name}.afterReadersOf(${hint.component.name})`,
          })
        }
      }
    }
  }
}

/**: EXPLICIT before/after edges (weight 5). */
function applyExplicit(systems: readonly SystemBox[], b: EdgeBuilders): void {
  for (const sb of systems) {
    for (const after of sb.after) {
      // sb runs AFTER `after` ⇒ edge after → sb
      offer(b, { from: after, to: sb.id, weight: EdgeWeight.EXPLICIT, cause: `${sb.name}.after = [${nameOf(systems, after)}]` })
    }
    for (const before of sb.before) {
      // sb runs BEFORE `before` ⇒ edge sb → before
      offer(b, { from: sb.id, to: before, weight: EdgeWeight.EXPLICIT, cause: `${sb.name}.before = [${nameOf(systems, before)}]` })
    }
  }
}

/**
 * Topic edges: publishing derives an IMPLICIT publisher → consumer edge per shared topic, so a
 * consumer lands in a later wave and same-frame delivery is the default (without the edge, a
 * publish creates a hidden ordering dependency the user discovers as a mysterious one-frame lag).
 * The direction is publisher → consumer (NOT registration order — the topic behaves like a written
 * component with the consumer as reader); DENY suppresses it like any implicit edge. Co-publishers
 * and co-consumers of one topic get NO edge between each other — their relative event order is
 * fixed by the SystemId canonicalization, not by execution order.
 */
function deriveTopicEdges(systems: readonly SystemBox[], denied: Set<number>, b: EdgeBuilders): void {
  const publishers = new Map<TopicDef<Schema>, SystemId[]>()
  const consumers = new Map<TopicDef<Schema>, SystemId[]>()
  for (const sb of systems) {
    for (const t of sb.publishTopics) {
      const list = publishers.get(t) ?? []
      list.push(sb.id)
      publishers.set(t, list)
    }
    for (const t of sb.consumeTopics) {
      const list = consumers.get(t) ?? []
      list.push(sb.id)
      consumers.set(t, list)
    }
  }
  for (const [topic, pubs] of publishers) {
    const cons = consumers.get(topic)
    if (cons === undefined) continue
    for (const p of pubs) {
      for (const c of cons) {
        if (p === c) continue
        const pn = p as unknown as number
        const cn = c as unknown as number
        if (denied.has(denyKey(pn, cn))) continue
        offer(b, {
          from: p,
          to: c,
          weight: EdgeWeight.IMPLICIT,
          cause: `${nameOf(systems, p)} publishes topic '${topic.name}' consumed by ${nameOf(systems, c)}`,
        })
      }
    }
  }
}

/** Build the resolved max-weight edge set (DENY-suppressed IMPLICIT removed by construction). */
export function buildEdges(
  systems: readonly SystemBox[],
  defs: readonly SystemDef[],
  access: AccessMaps,
): Edge[] {
  const b: EdgeBuilders = { best: new Map() }
  const denied = collectDenials(systems, defs)
  // Order matters only for cause-merge readability; max-weight resolution is order-independent.
  applyExplicit(systems, b)
  applyClassHints(systems, access, b)
  deriveImplicit(systems, access, denied, b)
  deriveTopicEdges(systems, denied, b)
  // Opposite-direction resolution: a STRICTLY stronger declaration overrides a weaker inferred
  // edge pointing the other way (e.g. an explicit `consumer before publisher` beats the implicit
  // publisher → consumer topic edge — the user opted into next-frame delivery). Equal weights keep
  // both edges, and the cycle detector reports the contradiction with its inAnyOrderWith suggestion.
  for (const [k, edge] of [...b.best]) {
    const reverse = b.best.get(key(edge.to as unknown as number, edge.from as unknown as number))
    if (reverse !== undefined && reverse.weight > edge.weight) b.best.delete(k)
  }
  return [...b.best.values()]
}
