# Changelog

All notable changes to ecsia are documented here. The project follows
[semantic versioning](https://semver.org), honestly applied at 0.x: breaking changes land in
minor bumps and are documented until 1.0.

## 0.1.0 — unreleased

First public, feature-complete release. The kernel surface is API-frozen.

Ships as the umbrella package `ecsia` plus the
power-user scoped packages `@ecsia/core`, `@ecsia/schema`, `@ecsia/relations`,
`@ecsia/scheduler`, `@ecsia/serialization`, `@ecsia/three`, and `@ecsia/devtools` — all at
`0.1.0`.

### Features

- **Archetype / SoA kernel** (`@ecsia/core`) — archetype tables with structure-of-arrays
  columns, a serial-only per-entity bitmask membership index, and monomorphic typed
  accessors (no Proxy). Live queries with `each` / `eachChunk` (SoA fast path), `has` /
  `without` / `optional`, and a 1..8 arity type-inferred query DSL.
- **Schema** (`@ecsia/schema`) — type-level field tokens (`f32`, vectors, `staticString`,
  `object<T>`, `field(...)`) and compile-time query-arity inference.
- **Rich fields** — `'string'` and `object<T>` components backed by a generation-stamped,
  migration-invariant sidecar store, with `createStableIndex` for id→entity lookup.
- **First-class relations** (`@ecsia/relations`) — integer-encoded relation pairs as
  archetype members, exclusive/overflow storage, presence-bit wildcard matching
  (`O(archetypes)`), payloaded relations, and despawn cascades (`deleteSubject` /
  `removeRelation` / `none`).
- **Reactivity** — `onAdd` / `onRemove` / `onChange` observer builders registered via
  `world.observe(...)`, draining at a deferred serial slot (never mid-system, even under
  workers); plus an opt-in `.changed()` change-tracking query flavor.
- **Wave scheduler** (`@ecsia/scheduler`) — an access-graph conflict DAG derived from each
  system's `{read, write}` set, executed as waves.
- **Auto-parallel worker execution** — a real `node:worker_threads` + `Atomics` pool that
  splits each wave's disjoint-write work across threads over `SharedArrayBuffer` columns. The
  parallel result is **bit-identical** to the single-threaded result (entity set, component
  values, reactivity deltas), guaranteed by a fixed worker-index command-buffer merge and
  verified by a serial-equivalence property test. Without `SharedArrayBuffer` (in browsers:
  without cross-origin isolation), ecsia logs a warning and runs single-threaded — never
  silently. **Columns that grow past their initial address-space
  reservation re-back onto a new `SharedArrayBuffer`; the pool drains a re-backing notice at the
  wave fence and re-wraps every worker's view before the next dispatch (one generation check per
  wave when nothing grew), so threaded worlds stay serial-equivalent at any column size.**
- **Serialization** (`@ecsia/serialization`) — bit-exact world snapshots, version-stamped
  deltas carrying value + structural changes since a tick (no shadow map), entity-id and
  relation-target remap on load, and a zero-copy worker bootstrap.
- **THREE.js bridge** (`@ecsia/three`) — drive `three` objects from ecsia components;
  `three` is a peer dependency (`>=0.169 <1`). Not re-exported from the umbrella.
- **Devtools** (`@ecsia/devtools`) — world inspection + text/HTML reports. Not re-exported
  from the umbrella and imported by nothing in the framework, so it never ships in a consumer
  bundle unless explicitly pulled in.
- **Cross-runtime + browser smokes** — the shipped dist is exercised on Node, Bun, and Deno,
  and in a real Chromium tab.
- **Performance** — single-thread `.each` at ~10 ns/entity, `eachChunk` at ~1.46 ns/entity
  (~1.39x bitECS), and a worker-pool speedup curve reaching **6.48x at 8 workers** on the
  heavy macro-bench (8,192 entities × 512 sub-steps × 60 frames). Full numbers, methodology,
  and the comparison table are on the docs site's performance page.

### Packaging

- The umbrella package is published under the **bare name `ecsia`** (the npm identity users
  type). The scoped packages keep their `@ecsia/*` names for power users composing the layers
  by hand.
- Every publishable package is ESM-only, ships only `dist/` (plus README + LICENSE),
  declares `sideEffects: false` (the import graph of each package entry has no module-scope
  side effects), and requires Node `>=22.13`.

### Changed

- **`scheduler.workers: 'postMessage-fallback'` is now `'no-sab'`.** The old name promised a
  postMessage worker transport that does not exist; the value's actual behavior is "use plain
  (non-shared) `ArrayBuffer` backing" — i.e. single-threaded execution. The new name says so.
- **Bare `threaded: true` now auto-detects `SharedArrayBuffer`.** Previously it silently
  selected non-shared backing unless `scheduler.workers` was set; it now uses SAB-capable
  backing when the runtime supports it and logs a warning (then runs single-threaded) when it
  doesn't. Pass `scheduler: { workers: 'no-sab' }` to force non-shared backing explicitly.

### Fixed

- **WorkerPool wide-column growth (>1024 rows-per-column).** A threaded column that grew past
  its initial reservation (`INITIAL_ROWS 64 × GROWTH_RESERVE_FACTOR 16 = 1024` rows) re-backed
  onto a new `SharedArrayBuffer`, but the workers' manifest-captured views kept reading the
  abandoned backing — diverging every row from single-thread at exactly 1025. The buffer layer
  now journals each re-backing (a monotonic generation + the new SAB handles), and the worker
  pool drains and applies those notices to every worker **at the wave fence before the next
  dispatch**, each worker re-wrapping the new backing and ACKing on the wave counter. In-place
  `.grow()` within the reservation is unchanged (length-tracking views auto-widen) and steady
  state costs a single generation check per wave. Threaded worlds are now serial-equivalent at
  any column size. Boundary-tested by
  `packages/scheduler/test/worker-growth-boundary.test.ts` (1024 in-place grow + 1025/1040
  re-backing) and the above-reservation case in the heavy-pool smoke.

### Known issues

These are documented limitations in 0.1.0, not regressions:

- **RF-NOREMAP.** Rich-field (`object<T>` / `'string'`) values are carried by entity-index-keyed
  sidecar storage and are **not** entity-id-remapped through every cross-world path the way
  numeric columns are. Round-trip rich fields through the documented snapshot/delta paths,
  which do remap; do not assume rich sidecar values follow an ad-hoc manual remap.
- **Worker pool is Node-only.** The pool is `node:worker_threads` + `Atomics` based and
  requires `SharedArrayBuffer` + cross-origin isolation. There is **no browser Web-Worker
  pool** yet — a browser pool is future work. The browser smoke deliberately does not claim
  threaded-pool support; it runs the single-threaded kernel in-tab.
- **Tracked-write cost.** Attaching a `.changed()` reactive consumer opts you into the
  write-log: the same `.each` integrator measures ~128 ns/entity with an active `.changed()`
  filter (vs ~10 ns/entity ungated). This is the deliberate cost of reactivity, not overhead
  on the default path — a single boolean gate keeps the non-reactive write path free.
