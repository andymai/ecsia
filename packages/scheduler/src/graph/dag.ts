// Conflict DAG construction: adjacency from the resolved max-weight edges, DFS
// three-color cycle detection with NAMED-CHAIN reporting + a suggested break edge, and
// DFS-based transitive reduction so the topological layering produces the widest possible waves.

import type { SystemId } from '@ecsia/schema'
import type { SystemBox } from '../planner/index.js'
import type { Edge } from './edges.js'

export class CycleError extends Error {
  /** The cycle as a SystemId chain `[A, B, …, A]`. */
  readonly chain: readonly SystemId[]
  constructor(message: string, chain: readonly SystemId[]) {
    super(message)
    this.name = 'CycleError'
    this.chain = chain
  }
}

export interface DAG {
  readonly n: number
  /** succ[from] = list of `to` (transitively reduced). */
  readonly succ: readonly (readonly SystemId[])[]
}

type Color = 0 | 1 | 2 // white | gray | black

function adjacency(n: number, edges: readonly Edge[]): SystemId[][] {
  const succ: SystemId[][] = Array.from({ length: n }, () => [])
  for (const e of edges) succ[e.from as unknown as number]!.push(e.to)
  return succ
}

function edgeCause(edges: readonly Edge[], from: SystemId, to: SystemId): string {
  const fn = from as unknown as number
  const tn = to as unknown as number
  for (const e of edges) {
    if ((e.from as unknown as number) === fn && (e.to as unknown as number) === tn) return e.cause
  }
  return ''
}

/**
 *: a single DFS finds ANY cycle; the gray-stack gives the full chain. Throws CycleError with the
 * named chain and a suggested `inAnyOrderWith` break edge. Fail-fast at createWorld, never at
 * frame time.
 */
function detectCycle(systems: readonly SystemBox[], succ: readonly SystemId[][], edges: readonly Edge[]): void {
  const n = succ.length
  const color = new Uint8Array(n) as unknown as Color[]
  const stack: SystemId[] = []

  const dfs = (u: SystemId): void => {
    const un = u as unknown as number
    color[un] = 1
    stack.push(u)
    for (const v of succ[un]!) {
      const vn = v as unknown as number
      if (color[vn] === 1) {
        // Back edge → cycle. Slice the gray stack from v to u, then close it.
        const start = stack.findIndex((s) => (s as unknown as number) === vn)
        const cycle = [...stack.slice(start), v]
        throw new CycleError(reportChain(systems, edges, cycle), cycle)
      }
      if (color[vn] === 0) dfs(v)
    }
    color[un] = 2
    stack.pop()
  }

  for (let i = 0; i < n; i++) {
    if (color[i] === 0) dfs(i as unknown as SystemId)
  }
}

function reportChain(systems: readonly SystemBox[], edges: readonly Edge[], cycle: readonly SystemId[]): string {
  const name = (id: SystemId): string => systems[id as unknown as number]?.name ?? `#${id as unknown as number}`
  const lines: string[] = ['System cycle detected:']
  for (let i = 0; i + 1 < cycle.length; i++) {
    const from = cycle[i]!
    const to = cycle[i + 1]!
    const cause = edgeCause(edges, from, to)
    lines.push(`  ${name(from)} → ${name(to)}${cause ? `   (${cause})` : ''}`)
  }
  // Suggest breaking the first implicit-looking edge with inAnyOrderWith.
  const a = name(cycle[0]!)
  const b = name(cycle[1] ?? cycle[0]!)
  lines.push(
    `Break it by declaring inAnyOrderWith(${a}, ${b}) if the order is irrelevant, or remove one of the conflicting declarations.`,
  )
  return lines.join('\n')
}

/**: remove edge A→C if a path A→B→C exists (B ≠ C). DFS reachability excluding the direct edge. */
function transitiveReduction(succ: readonly SystemId[][]): SystemId[][] {
  const n = succ.length
  const reduced: SystemId[][] = Array.from({ length: n }, () => [])

  // reachExcludingDirect(u, target): is `target` reachable from `u` WITHOUT using the direct u→target edge?
  const reachableVia = (u: SystemId, target: SystemId): boolean => {
    const un = u as unknown as number
    const tn = target as unknown as number
    const seen = new Uint8Array(n)
    const visit = (x: number): boolean => {
      for (const w of succ[x]!) {
        const wn = w as unknown as number
        if (x === un && wn === tn) continue // skip ONLY the direct u→target edge
        if (wn === tn) return true
        if (seen[wn] === 0) {
          seen[wn] = 1
          if (visit(wn)) return true
        }
      }
      return false
    }
    return visit(un)
  }

  for (let u = 0; u < n; u++) {
    for (const v of succ[u]!) {
      // Keep u→v unless v is reachable from u through an intermediary (redundant transitive edge).
      if (!reachableVia(u as unknown as SystemId, v)) reduced[u]!.push(v)
    }
  }
  return reduced
}

/** Build the transitively-reduced DAG, failing fast on any cycle. */
export function buildDAG(systems: readonly SystemBox[], edges: readonly Edge[]): DAG {
  const n = systems.length
  const succ = adjacency(n, edges)
  detectCycle(systems, succ, edges)
  const reduced = transitiveReduction(succ)
  return { n, succ: reduced }
}
