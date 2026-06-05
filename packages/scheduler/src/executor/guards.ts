// Dev-mode access guards (declared-intent contract). A system's
// scoped `query` warns when a term references a component outside the system's declared
// `read ∪ write`, and when a `write(C)` term names a C absent from `writeIds`. The declaration stays
// authoritative — an undeclared access is a scheduling BUG the user must fix, not blocked (production
// silent). Guards compile out when `dev` is false so the hot path is unaffected.

import type { ComponentDef, QueryTerm, Schema } from '@ecsia/schema'
import type { World } from '@ecsia/core'
import type { SystemBox } from '../planner/index.js'

function defOfTerm(term: QueryTerm): { def: ComponentDef<Schema> | null; role: 'read' | 'write' | 'other' } {
  const t = term as { __term?: string; c?: ComponentDef<Schema>; relation?: unknown }
  if (t.relation !== undefined) return { def: null, role: 'other' } // Pair term — pair ids checked at
  switch (t.__term) {
    case 'write':
      return { def: t.c ?? null, role: 'write' }
    case 'read':
    case 'optional':
      return { def: t.c ?? null, role: 'read' }
    case 'has':
    case 'without':
      return { def: t.c ?? null, role: 'other' }
    default:
      // bare ComponentDef == read
      return { def: term as ComponentDef<Schema>, role: 'read' }
  }
}

function warn(message: string): void {
  if (typeof console !== 'undefined') console.warn(`[ecsia:scheduler] ${message}`)
}

/**
 * Wrap `world.query` so each term's component is asserted against the system's declared access.
 * Returns the world's own query result unchanged; only the dev-mode diagnostic is added.
 */
export function makeScopedQuery(world: World, sb: SystemBox, dev: boolean): World['query'] {
  if (!dev) return world.query
  const readSet = new Set<number>(sb.readIds as unknown as number[])
  const writeSet = new Set<number>(sb.writeIds as unknown as number[])
  const scoped = (...terms: QueryTerm[]): unknown => {
    for (const term of terms) {
      const { def, role } = defOfTerm(term)
      if (def === null) continue
      const id = def.id as unknown as number
      if (id < 0) continue // unregistered — the world's compiler reports it
      if (role === 'write') {
        if (!writeSet.has(id)) {
          warn(
            `system '${sb.name}' issues a write(${def.name}) term but '${def.name}' is not in its declared write set — ` +
              `add it to the system's write access so parallel scheduling can serialize conflicting writers`,
          )
        }
      } else if (role === 'read' && !readSet.has(id) && !writeSet.has(id)) {
        // `has`/`without` are presence FILTERS (role 'other'), not data access — declaring the
        // filtered component would be spurious, so only genuine read terms are access-checked.
        warn(
          `system '${sb.name}' references ${def.name} in a query but it is not in the system's declared read/write set`,
        )
      }
    }
    return (world.query as (...t: QueryTerm[]) => unknown)(...terms)
  }
  return scoped as unknown as World['query']
}
