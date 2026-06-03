// Query compilation (queries.md §3, §4): turn a readonly QueryTerm[] into a CompiledQuery with
// packed withWords / notWords signature masks, the optional value terms, the residual large-pair-ID
// terms, and a canonical order-independent hash that encodes pair-target ids and role tags.
//
// classifyTerm reads the `__term` discriminant on the typed wrappers (type-system.md §5.1) and the
// PairDef shape (§7.2); a bare ComponentDef is treated as read. Pair-term resolution (presence id /
// pair id / exclusivity) is the relations module's contract (M8); M4 compiles the component/with/
// without/optional terms in full and the pair terms via the resolver hook the world supplies.

import type { ComponentDef, ComponentId, QueryTerm, Schema } from '@ecsia/schema'

/** One packed membership-bit reference within the fixed-stride signature words (§3.1). */
export interface Word {
  readonly wordIndex: number
  readonly mask: number
}

/** A residual (large pair-ID) term tested by sigHas binary search, not a sigWords AND (§3.1). */
export interface ResidualTerm {
  readonly componentId: ComponentId
  readonly negate: boolean
}

export type ValueRole = 'read' | 'write' | 'optional' | 'pairRead' | 'pairWrite'

/**
 * An exclusive-relation specific-target term (queries.md §10.2 / relations §8.2): the target is a
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
 * The relations-owned resolution of a Pair(...) term to a concrete ComponentId (queries.md §10).
 * Injected by relations into the world's CompileContext (core never imports relations). Q-R2: a
 * query must NOT mint — `mintedOnly` resolution returns `unsatisfiable` when the pair never existed.
 */
export interface ResolvedPair {
  /** The signature bit to AND-match (presence id for wildcard/exclusive; pair id for tag/overflow). */
  readonly componentId: ComponentId
  /** True iff the pair id was never minted → the query matches nothing without mutating the id space. */
  readonly unsatisfiable: boolean
  /** Present for exclusive specific-target pairs: the post-presence row filter (§10.2 strategy a). */
  readonly rowFilter?: RowFilterTerm
}

/** Value terms in declaration order (drives the pooled element + cursor binding, §3.1). */
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
  /** Exclusive specific-target pair filters: match by presence bit, then filter rows by target (§10.2). */
  readonly rowFilters: readonly RowFilterTerm[]
  readonly hash: string
  /** True iff a specific-pair term resolved to a never-minted pair id → matches nothing (§10.2). */
  readonly unsatisfiable: boolean
}

/** The seam the compiler uses to resolve component (and, later, pair) ids — owned by the world. */
export interface CompileContext {
  /** ComponentId for a registered ComponentDef, or throws if the def is not in this world. */
  idOf(def: ComponentDef<Schema>): ComponentId
  /** Fixed bitmask bit count: ids below this go in the packed words, larger pair ids are residual. */
  readonly fixedBitCount: number
  /**
   * Resolve a Pair(R, target | Wildcard) term to a ComponentId (queries.md §10). Injected by the
   * relations module via the world; absent in a relation-free world (every pair term is then
   * unsatisfiable, the M4 behavior). Q-R2: this NEVER mints — it only looks up already-minted ids.
   */
  resolvePair?(relationId: number, target: number | symbol): ResolvedPair
}

type TermKind = 'component' | 'without' | 'optional' | 'pairWildcard' | 'pairSpecific'

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

function classifyTerm(t: QueryTerm): Classified {
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
    case 'with':
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

/** §4.2 — fold the pair target index into the hash so Pair(R,p1) and Pair(R,p2) are distinct keys. */
function pairHashId(pair: PairLike): string {
  if (typeof pair.target === 'symbol') return 'W' + pair.relation.id
  // exclusivity (the X-tag) is the relations module's contract (M8); M4 uses the tag/overflow form.
  return 'p' + pair.relation.id + '.' + (pair.target as number)
}

function canonicalHash(terms: readonly QueryTerm[], ctx: CompileContext): string {
  const parts: string[] = []
  for (const t of terms) {
    const cl = classifyTerm(t)
    let cid: number | string
    if (cl.pair !== null) cid = pairHashId(cl.pair)
    else cid = ctx.idOf(cl.def as ComponentDef<Schema>) as number
    // Role tags keep With (membership) distinct from read; read/write/bare collapse to one P tag
    // (same matching constraint, same `current`); without → N; optional → O (§4.1).
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
  return parts.join('|')
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

  for (const t of terms) {
    const cl = classifyTerm(t)
    switch (cl.kind) {
      case 'component': {
        const def = cl.def as ComponentDef<Schema>
        const cid = ctx.idOf(def) as number
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
        referenced.add(cid)
        addNotBit(notWords, residualWith, cid, ctx.fixedBitCount)
        break
      }
      case 'optional': {
        const def = cl.def as ComponentDef<Schema>
        const cid = ctx.idOf(def) as number
        referenced.add(cid)
        optionalIds.push(cid as ComponentId)
        valueTerms.push({ componentId: cid as ComponentId, role: 'optional', key: keyOf(def) })
        break
      }
      case 'pairWildcard':
      case 'pairSpecific': {
        // queries.md §10 / relations §8: relations injects `resolvePair`; without it (relation-free
        // world, the M4 case) every pair term matches nothing. Q-R2: resolvePair NEVER mints.
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

  return Object.freeze({
    withWords,
    notWords,
    optionalIds,
    residualWith,
    valueTerms,
    referencedIds: [...referenced] as ComponentId[],
    rowFilters,
    hash: canonicalHash(terms, ctx),
    unsatisfiable,
  })
}

export { WILDCARD_TAG }
