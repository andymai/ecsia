// `defineSystem` (public-api.md §3.4) + the ordering-hint combinators (§4.2). `defineSystem` is
// identity + light validation; it returns a branded SystemDef the scheduler consumes. The scheduler
// never infers write-intent from runtime `entity.write(C)` calls — `read`/`write` here is the sole
// conflict-detection source (Must-Fix #2).

import type { ComponentDef, Schema } from '@ecsia/schema'
import type { OrderingHint, SystemDef } from './types.js'

export function defineSystem(def: SystemDef): SystemDef {
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new Error('defineSystem: `name` is required and must be a non-empty string')
  }
  if (typeof def.run !== 'function') {
    throw new Error(`defineSystem('${def.name}'): \`run\` must be a function`)
  }
  return Object.freeze({ ...def, __ecsiaSystem: true as const })
}

/**
 * Records a DENY (weight 4, §4.2): suppress any IMPLICIT (weight 1) edge between `a` and `b` in both
 * directions ("no implicit edge between these — the user knows it is safe"). Does NOT override an
 * EXPLICIT (5) edge.
 */
export function inAnyOrderWith(a: SystemDef, b: SystemDef): OrderingHint {
  return { kind: 'deny', a, b }
}

/** CLASS_HINT (weight 3, §4.2): this system runs before all current writers of `c`. */
export function beforeWritersOf(c: ComponentDef<Schema>): OrderingHint {
  return { kind: 'beforeWritersOf', component: c }
}

/** CLASS_HINT (weight 3, §4.2): this system runs after all current readers of `c`. */
export function afterReadersOf(c: ComponentDef<Schema>): OrderingHint {
  return { kind: 'afterReadersOf', component: c }
}
