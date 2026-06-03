// @ecsia/core query subsystem (queries.md). The query DSL runtime: compilation + canonical-hash
// dedup cache (compile.ts), the SAB-capable sparse-set result container (sparse-set.ts), the
// LiveQuery with the matchingArchetypes pointer cache and the .each iteration (live-query.ts), and
// the QueryEngine that owns matching, the archetypeCreated hook, and single-entity maintenance
// (engine.ts). world.query(...) delegates here; the query DSL TYPES live in @ecsia/schema.

export { QueryEngine } from './engine.js'
export type { QueryEngineDeps } from './engine.js'

export { LiveQuery } from './live-query.js'
export type { LiveQueryDeps, PooledElement, ReactivityQueryHooks } from './live-query.js'

export { SparseSetU32 } from './sparse-set.js'

export { compileQuery } from './compile.js'
export type {
  CompiledQuery,
  CompiledValueTerm,
  CompileContext,
  ResidualTerm,
  ValueRole,
  Word,
} from './compile.js'
