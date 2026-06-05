// @ecsia/devtools — the inspection + scheduling explanation + watch toolkit (P5). An OPT-IN package: it
// is deliberately NOT re-exported from the ecsia umbrella, and NOTHING in the framework imports
// it. It sits at the TOP of the dependency graph (like the umbrella): it depends on @ecsia/core +
// @ecsia/schema (the world surfaces) and @ecsia/scheduler (the plan introspection types), and the arrow
// points one way — core/scheduler never import devtools.
//
// DESIGN: a DATA LAYER first, renderers second. inspectWorld / explainPlan / watchWorld produce PLAIN,
// serializable reports (no live handles, no class instances) so everything is assertable headless;
// renderText / renderHTML are PURE functions over exactly those report shapes.

// --- 1. world inspector ---
export { inspectWorld } from './inspector.js'

// --- 2. watch mode ---
export { watchWorld } from './watch.js'
export type { WorldWatcher, WatchOptions } from './watch.js'

// --- 3. wave visualizer ---
export { explainPlan } from './waves.js'
export type { PlanLike } from './waves.js'

// --- 4. renderers (pure over the data layer) ---
export { renderText } from './render-text.js'
export { renderHTML } from './render-html.js'

// --- name helper (shared; useful to pass into explainPlan for component names) ---
export { componentNameMap } from './names.js'

// --- the data layer report shapes (everything assertable) ---
export type {
  WorldReport,
  ComponentReport,
  ArchetypeReport,
  QueryReport,
  RelationReport,
  FrameDelta,
  PlanExplain,
  WaveExplain,
  BatchExplain,
  SystemExplain,
  ConflictExplain,
  PinExplain,
} from './types.js'
