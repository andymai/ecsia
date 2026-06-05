# ecsia roadmap

> Posture: a serious OSS contender, developed solo in focused milestone bursts.
> Versioning: **0.x, semver-honest** — breaking changes land in minor bumps and are
> documented; **1.0 is gated on ecsia powering a real production rebuild** (the author's
> Corridor app), not on a calendar. Issues and discussions are open; PRs welcome.

## Where we are

The kernel is feature-complete and API-stable at the M12 freeze: archetype/SoA storage,
typed accessors, live queries, first-class relations, dual-mechanism reactivity,
snapshot/delta serialization, and the auto-parallel worker scheduler with property-tested
serial-equivalence. ~450 tests (unit + property + type-level + real-worker), ~90% line
coverage, strict TS, CI green. Unpublished.

## v0.1 milestone queue (in order)

| # | Milestone | What ships | Why it's in the launch |
|---|---|---|---|
| P1 | **Rich fields** | `object<T>` sidecar storage + a free-form `string` field token, wired through accessors, despawn/migration, `Changed` tracking; JSON sidecar section in snapshot/delta; epsilon (float-tolerance) diff mode; documented `stableId` pattern for external ids | The biggest ergonomics gap vs object-based libraries; components with titles, paths, and nested data must be first-class, serializable, and reactive |
| P2 | **Perf burst** | One focused optimization pass to close the `eachChunk`→bitECS single-thread gap (target ≤1.2×); bench regression guard | Public benchmark first impressions stick — close the gap *before* the numbers go up |
| P3 | **Runtime proof** | CI lanes: real Chromium (Playwright) with a COOP/COEP-isolated SAB worker test; Bun and Deno suites | "All runtimes" was a design goal — prove it in CI, don't claim it |
| P4 | **@ecsia/three** | `Object3D`↔component transform sync, a render-loop scheduler driver, instancing helpers; boids/scene-graph examples become real three.js demos | The bridge most game users need on day one |
| P5 | **Devtools** | World inspector (entity/archetype/query browser) + scheduler wave visualizer | The wave visualizer is the demo of the differentiator; the inspector is daily-driver DX |
| P6 | **Docs site** | Static docs site (GitHub Pages): getting started, core concepts, the parallelism guide (incl. COOP/COEP deployment), relations, serialization, three.js guide; generated API reference | Table stakes for a serious contender |
| P7 | **Benchmark page** | Reproducible public benchmark suite + results: honest single-thread comparisons vs bitECS/miniplex and the multi-worker speedup curve | The centerpiece credibility artifact — honest numbers, including where ecsia is behind |
| P8 | **Launch v0.1** | npm publish (`ecsia` = the batteries-included umbrella; `@ecsia/*` for tree-shaved installs); PR into `noctjs/ecs-benchmark`; technical deep-dive post on the serial-equivalent worker scheduler | Ship it |

## v0.2 fast-follow

- **@ecsia/react** — `useQuery` / `useChanged` / `useEntity` hooks built on the deferred
  observer layer, modeled on the best existing React⇄ECS bindings. Captures the
  react-three-fiber funnel while launch attention is warm.

## Beyond

- Demand-driven fixes and API refinement under 0.x.
- The author's long-term plan is to rebuild a real production app (Corridor — an
  Electron/three.js multi-agent mission control) on ecsia; **that rebuild is the 1.0 gate.**
  Roadmap items above (rich fields, @ecsia/three, devtools) are sequenced so the library
  is ready when that begins.

## Success criteria (~6 months post-launch)

Credibility over raw downloads: present in `noctjs/ecs-benchmark` with strong numbers,
the deep-dive circulating, a few hundred stars, real third-party issues being filed, and
"the parallel one" as ecsia's reflexive description in ECS discussions.

## Engineering principles (carried from the initial build)

- Every milestone runs implement → test → **independent adversarial review** → fix, and
  ends green (`tsc -b` clean, full suite passing) before merge.
- Property-based tests for invariants; every test must be able to fail (no
  coverage-gaming); benchmarks must be reproducible and honest — including the ones we lose.
- The public API changes deliberately: additive where possible, breaking changes
  documented per release.
