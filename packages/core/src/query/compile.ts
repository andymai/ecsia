// Query compilation: turn a readonly QueryTerm[] into a CompiledQuery with
// packed withWords / notWords signature masks, the optional value terms, the residual large-pair-ID
// terms, and a canonical order-independent hash that encodes pair-target ids and role tags.
//
// classifyTerm reads the `__term` discriminant on the typed wrappers and the
// PairDef shape; a bare ComponentDef is treated as read. Pair-term resolution (presence id /
// pair id / exclusivity) is the relations module's contract; compiles the component/with/
// without/optional terms in full and the pair terms via the resolver hook the world supplies.

import type { ComponentDef, ComponentId, QueryTerm, Schema } from '@ecsia/schema'

/** One packed membership-bit reference within the fixed-stride signature words. */
export interface Word {
  readonly wordIndex: number
  readonly mask: number
}

/** A residual (large pair-ID) term tested by sigHas binary search, not a sigWords AND. */
export interface ResidualTerm {
  readonly componentId: ComponentId
  readonly negate: boolean
}

export type ValueRole = 'read' | 'write' | 'optional' | 'pairRead' | 'pairWrite'

/**
 * An exclusive-relation specific-target term (relations ): the target is a
 * COLUMN value, not a signature bit, so the archetype is matched by `presenceId(R)` and iteration
 * filters rows by `targetColumn[row] === target`. Carried on the CompiledQuery; the engine applies it.
 */
export interface RowFilterTerm {
  readonly presenceId: ComponentId
  /** The full target EntityHandle (encoded eid value stored in the column) to compare each row against. */
  readonly targetEid: number
  /** Field index of the exclusive `eid` target column within the presence component's ColumnSet. */
  readonly targetFieldIndex: number
}

/**
 * The relations-owned resolution of a Pair(...) term to a concrete ComponentId.
 * Injected by relations into the world's CompileContext (core never imports relations).: a
 * query must NOT mint — `mintedOnly` resolution returns `unsatisfiable` when the pair never existed.
 */
export interface ResolvedPair {
  /** The signature bit to AND-match (presence id for wildcard/exclusive; pair id for tag/overflow). */
  readonly componentId: ComponentId
  /** True iff the pair id was never minted → the query matches nothing without mutating the id space. */
  readonly unsatisfiable: boolean
  /** Present for exclusive specific-target pairs: the post-presence row filter. */
  readonly rowFilter?: RowFilterTerm
}

/** Value terms in declaration order (drives the pooled element + cursor binding). */
export interface CompiledValueTerm {
  readonly componentId: ComponentId
  readonly role: ValueRole
  readonly key: string
}

export interface CompiledQuery {
  readonly withWords: readonly Word[]
  readonly notWords: readonly Word[]
  readonly optionalIds: readonly ComponentId[]
  readonly residualWith: readonly ResidualTerm[]
  readonly valueTerms: readonly CompiledValueTerm[]
  readonly referencedIds: readonly ComponentId[]
  /** Exclusive specific-target pair filters: match by presence bit, then filter rows by target. */
  readonly rowFilters: readonly RowFilterTerm[]
  readonly hash: string
  /** True iff a specific-pair term resolved to a never-minted pair id → matches nothing. */
  readonly unsatisfiable: boolean
}

/** The seam the compiler uses to resolve component (and, later, pair) ids — owned by the world. */
export interface CompileContext {
  /** ComponentId for a registered ComponentDef, or throws if the def is not in this world. */
  idOf(def: ComponentDef<Schema>): ComponentId
  /** Fixed bitmask bit count: ids below this go in the packed words, larger pair ids are residual. */
  readonly fixedBitCount: number
  /**
   * Resolve a Pair(R, target | Wildcard) term to a ComponentId. Injected by the
   * relations module via the world; absent in a relation-free world (every pair term is then
   * unsatisfiable, the behavior).: this NEVER mints — it only looks up already-minted ids.
   */
  resolvePair?(relationId: number, target: number | symbol): ResolvedPair
  /**
   * The `Prefab` tag's id when the world was created with `prefabs: true`; undefined otherwise.
   * When set, compilation injects this bit into `notWords` (default prefab exclusion) unless the
   * query mentions Prefab in any term or passes `{ matchPrefabs: true }`. Zero per-row cost — one
   * more bit in a mask that is already ANDed.
   */
  readonly prefabId?: ComponentId
}

type TermKind = 'component' | 'without' | 'optional' | 'pairWildcard' | 'pairSpecific' | 'options'

interface Classified {
  readonly kind: TermKind
  readonly def: ComponentDef<Schema> | null
  readonly pair: PairLike | null
  readonly role: 'read' | 'write' | 'bare' | 'none'
}

interface PairLike {
  readonly relation: { readonly name: string; readonly id: number }
  readonly target: number | symbol
  readonly id: number
}

const WILDCARD_TAG = Symbol.for('ecsia.query.wildcard')

function isPairDef(t: QueryTerm): t is QueryTerm & PairLike {
  return typeof t === 'object' && t !== null && 'relation' in t && 'target' in t
}

function isQueryOptions(t: QueryTerm): t is QueryTerm & { matchPrefabs: boolean } {
  return (
    typeof t === 'object' &&
    t !== null &&
    'matchPrefabs' in t &&
    !('relation' in t) &&
    !('__term' in t) &&
    !('fields' in t)
  )
}

function classifyTerm(t: QueryTerm): Classified {
  if (isQueryOptions(t)) return { kind: 'options', def: null, pair: null, role: 'none' }
  if (isPairDef(t)) {
    const pair = t as unknown as PairLike
    const isWildcard = typeof pair.target === 'symbol'
    return {
      kind: isWildcard ? 'pairWildcard' : 'pairSpecific',
      def: null,
      pair,
      role: 'none',
    }
  }
  const term = t as { __term?: string; c?: ComponentDef<Schema> }
  switch (term.__term) {
    case 'read':
      return { kind: 'component', def: term.c ?? null, pair: null, role: 'read' }
    case 'write':
      return { kind: 'component', def: term.c ?? null, pair: null, role: 'write' }
    case 'has':
      return { kind: 'component', def: term.c ?? null, pair: null, role: 'none' }
    case 'without':
      return { kind: 'without', def: term.c ?? null, pair: null, role: 'none' }
    case 'optional':
      return { kind: 'optional', def: term.c ?? null, pair: null, role: 'read' }
    default:
      // bare ComponentDef == read.
      return { kind: 'component', def: t as ComponentDef<Schema>, pair: null, role: 'bare' }
  }
}

function addWithBit(withWords: Word[], residual: ResidualTerm[], c: number, fixedBitCount: number): void {
  if (c < fixedBitCount) withWords.push({ wordIndex: c >>> 5, mask: (1 << (c & 31)) >>> 0 })
  else residual.push({ componentId: c as ComponentId, negate: false })
}

function addNotBit(notWords: Word[], residual: ResidualTerm[], c: number, fixedBitCount: number): void {
  if (c < fixedBitCount) notWords.push({ wordIndex: c >>> 5, mask: (1 << (c & 31)) >>> 0 })
  else residual.push({ componentId: c as ComponentId, negate: true })
}

function keyOf(def: ComponentDef<Schema>): string {
  return def.name
}

/** (R,p1) and Pair(R,p2) are distinct keys. */
function pairHashId(pair: PairLike): string {
  if (typeof pair.target === 'symbol') return 'W' + pair.relation.id
  // exclusivity (the X-tag) is the relations module's contract; uses the tag/overflow form.
  return 'p' + pair.relation.id + '.' + (pair.target as number)
}

function canonicalHash(terms: readonly QueryTerm[], ctx: CompileContext, excludePrefabs: boolean): string {
  const parts: string[] = []
  // The injected Prefab exclusion is part of the matching constraint, so it must be part of the
  // hash: query(A) and query(A, { matchPrefabs: true }) are distinct cache entries. An explicit
  // without(Prefab) hashes to the same part — same constraint, same LiveQuery.
  if (excludePrefabs) parts.push('N:' + (ctx.prefabId as number))
  for (const t of terms) {
    const cl = classifyTerm(t)
    if (cl.kind === 'options') continue
    let cid: number | string
    if (cl.pair !== null) cid = pairHashId(cl.pair)
    else cid = ctx.idOf(cl.def as ComponentDef<Schema>) as number
    // Role tags keep has (membership) distinct from read; read/write/bare collapse to one P tag
    // (same matching constraint, same `current`); without → N; optional → O.
    const roleTag =
      cl.kind === 'without'
        ? 'N'
        : cl.kind === 'optional'
          ? 'O'
          : cl.kind === 'component' && cl.role === 'none'
            ? 'M'
            : 'P'
    parts.push(roleTag + ':' + cid)
  }
  parts.sort()
  // Adjacent dedupe (post-sort): duplicate-tolerant hashing — [read(A), write(A)] hashes identical
  // to [write(A)] (same matching constraint, same `current`; the read/write role split stays
  // per value-signature binding), so both alias one shared LiveQuery.
  let hash = ''
  let prev = ''
  for (const p of parts) {
    if (p === prev) continue
    hash = hash === '' ? p : hash + '|' + p
    prev = p
  }
  return hash
}

export function compileQuery(terms: readonly QueryTerm[], ctx: CompileContext): CompiledQuery {
  const withWords: Word[] = []
  const notWords: Word[] = []
  const optionalIds: ComponentId[] = []
  const residualWith: ResidualTerm[] = []
  const valueTerms: CompiledValueTerm[] = []
  const rowFilters: RowFilterTerm[] = []
  const referenced = new Set<number>()
  let unsatisfiable = false
  const prefabId = ctx.prefabId as number | undefined
  let matchPrefabs = false
  let mentionsPrefab = false

  for (const t of terms) {
    const cl = classifyTerm(t)
    switch (cl.kind) {
      case 'options': {
        if ((t as { matchPrefabs: boolean }).matchPrefabs) matchPrefabs = true
        break
      }
      case 'component': {
        const def = cl.def as ComponentDef<Schema>
        const cid = ctx.idOf(def) as number
        if (cid === prefabId) mentionsPrefab = true
        referenced.add(cid)
        addWithBit(withWords, residualWith, cid, ctx.fixedBitCount)
        if (cl.role === 'read' || cl.role === 'write' || cl.role === 'bare') {
          valueTerms.push({
            componentId: cid as ComponentId,
            role: cl.role === 'bare' ? 'read' : cl.role,
            key: keyOf(def),
          })
        }
        break
      }
      case 'without': {
        const cid = ctx.idOf(cl.def as ComponentDef<Schema>) as number
        if (cid === prefabId) mentionsPrefab = true
        referenced.add(cid)
        addNotBit(notWords, residualWith, cid, ctx.fixedBitCount)
        break
      }
      case 'optional': {
        const def = cl.def as ComponentDef<Schema>
        const cid = ctx.idOf(def) as number
        if (cid === prefabId) mentionsPrefab = true
        referenced.add(cid)
        optionalIds.push(cid as ComponentId)
        valueTerms.push({ componentId: cid as ComponentId, role: 'optional', key: keyOf(def) })
        break
      }
      case 'pairWildcard':
      case 'pairSpecific': {
        // / relations: relations injects `resolvePair`; without it (relation-free
        // world, the case) every pair term matches nothing.: resolvePair NEVER mints.
        const pair = cl.pair as PairLike
        const resolved = ctx.resolvePair?.(pair.relation.id, pair.target)
        if (resolved === undefined || resolved.unsatisfiable) {
          unsatisfiable = true
          break
        }
        const cid = resolved.componentId as number
        referenced.add(cid)
        addWithBit(withWords, residualWith, cid, ctx.fixedBitCount)
        if (resolved.rowFilter !== undefined) rowFilters.push(resolved.rowFilter)
        break
      }
    }
  }

  // Default prefab exclusion: a gameplay query must never iterate a prefab TEMPLATE. Skipped when
  // the query names Prefab itself (With/Without/optional/read) or opts in via matchPrefabs. The bit
  // joins referencedIds so adding/removing the Prefab tag re-tests the entity incrementally.
  const excludePrefabs = prefabId !== undefined && !matchPrefabs && !mentionsPrefab
  if (excludePrefabs) {
    referenced.add(prefabId)
    addNotBit(notWords, residualWith, prefabId, ctx.fixedBitCount)
  }

  return Object.freeze({
    withWords,
    notWords,
    optionalIds,
    residualWith,
    valueTerms,
    referencedIds: [...referenced] as ComponentId[],
    rowFilters,
    hash: canonicalHash(terms, ctx, excludePrefabs),
    unsatisfiable,
  })
}

export { WILDCARD_TAG }
