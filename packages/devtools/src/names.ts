// Name resolution helpers shared by the inspector + wave visualizer. ComponentId → registered name is
// read from the world's `__serialize.components()` (the only place name↔id is exposed); query terms are
// rendered from their `__term` tag + the `.c` component def's `.name`.

import type { World } from '@ecsia/core'

/** Build a ComponentId → registered-name map from the world's serialization metadata. */
export function componentNameMap(world: World): Map<number, string> {
  const map = new Map<number, string>()
  for (const meta of world.__serialize.components()) map.set(meta.id as number, meta.name)
  return map
}

/** Best-effort `.name` off a query term's component/pair operand. */
function operandName(c: unknown): string {
  if (c !== null && typeof c === 'object' && 'name' in c && typeof (c as { name: unknown }).name === 'string') {
    return (c as { name: string }).name
  }
  return '?'
}

/** Render one raw QueryTerm as `read(position)` / `write(velocity)` / `has(x)` / `without(y)` / `optional(z)`. */
export function renderTerm(term: unknown): string {
  if (term === null || typeof term !== 'object' || !('__term' in term)) return String(term)
  const t = term as { __term: string; c?: unknown }
  return `${t.__term}(${operandName(t.c)})`
}
