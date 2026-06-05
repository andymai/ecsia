# ecsia Competitive Analysis

> Scope: ecsia (local, unpublished, MIT) vs. the active and historically-significant TypeScript/JavaScript ECS libraries.
> Popularity and maintenance figures are **as of each library's research date (mid-2025 to June 2026)** and are cited inline. Treat all download/star counts as point-in-time snapshots, not steady-state.

---

## 1. Executive Summary

The JavaScript ECS landscape splits cleanly into three camps:

1. **Data-oriented performance leaders** — bitECS, wolf-ecs, becsy — which prioritize SoA/TypedArray storage and raw iteration throughput. bitECS is the only one of these that is both fast *and* actively maintained ([bitECS v0.4.0, Dec 2025](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md)); wolf-ecs is explicitly a benchmark reference, not a product, and was archived Sept 2022 ([wolf-ecs README](https://github.com/EnderShadow8/wolf-ecs)); becsy has promised multithreading since 2021 but still ships single-threaded ([becsy guide](https://lastolivegames.github.io/becsy/guide/introduction)).
2. **DX / React-ergonomics leaders** — miniplex, koota — which prioritize TypeScript inference and React bindings over raw throughput. koota carries active pmndrs-org momentum ([koota v0.6.5, Feb 2026](https://github.com/pmndrs/koota/releases)); miniplex is effectively stalled since mid-2023 ([miniplex commits](https://github.com/hmans/miniplex/commits/main)).
3. **Abandoned / dormant** — javelin, ecsy (archived Apr 2025), ape-ecs, tick-knock, thyseus — feature-rich in places but carrying high bus-factor and abandonment risk.

**Where ecsia genuinely leads:** ecsia is the only library in this set that delivers an **automatic, serial-equivalent, worker-thread parallel scheduler** built on real `worker_threads` over `SharedArrayBuffer` with Atomics wave-sync and a property-tested bit-identical-to-single-thread guarantee. Every competitor either has *no* parallelism (miniplex, koota, wolf-ecs, javelin, ecsy, ape-ecs, tick-knock), *manual-only* parallelism (bitECS, thyseus), or *promised-but-unshipped* parallelism (becsy). ecsia also uniquely combines (a) archetype + SoA TypedArray storage, (b) first-class integer-encoded relations that survive cross-worker (JS-object pair identity cannot — bitECS's relations cannot cross workers either), (c) full TS inference with no codegen/decorators/build transformer, and (d) built-in bit-exact + delta serialization. No other single library has all four.

**Where others genuinely lead:**
- **Adoption & ecosystem:** bitECS (Phaser 4, Enchantment Engine [formerly Ethereal Engine], Mozilla Hubs; ~1.4k stars), koota (pmndrs backing; ~4.3k weekly downloads). ecsia has **zero** — it is unpublished.
- **Raw single-thread iteration:** wolf-ecs and bitECS top the [noctjs/ecs-benchmark](https://github.com/noctjs/ecs-benchmark/blob/main/README.md). ecsia's ergonomic `.each` (~28ns/entity) is slower; even its new `eachChunk` cursor is self-measured at ~2x behind bitECS iteration.
- **React bindings:** koota (`@koota/react`) and miniplex (`miniplex-react`) ship typed hooks. ecsia has none.
- **Maturity signals:** editor/devtools, published docs sites, real-world production validation — ecsia has none of these yet.

**The market gap ecsia fills:** a *correctness-first, batteries-included* ECS that makes **multi-core CPU parallelism the default rather than a manual escape hatch**, with deterministic serial-equivalence so parallelism never changes results. Every actively-maintained competitor leaves parallelism to the user (bitECS), never shipped it (becsy), or never attempted it (koota, miniplex). ecsia targets the workload nobody else serves well: a single TS codebase that scales across worker threads *and* maintains relations, reactivity, and snapshotting across that thread boundary.

---

## 2. Feature Comparison Matrix

| Library | Storage model | SoA / TypedArray | TS typing quality | Worker parallelism | Relations | Reactivity | Serialization | Maintenance (as of research) | Popularity (as of research) |
|---|---|---|---|---|---|---|---|---|---|
| **ecsia** (subject) | Archetype tables + SoA columns; main-thread bitmask index | Yes (SAB-capable TypedArray columns) | Full inference, no codegen/decorators; typed read/write split; 1..8 query arity | **Auto-parallel** scheduler; real `worker_threads` + SAB + Atomics; serial-equivalent (property-tested); postMessage fallback | First-class integer-encoded pairs; exclusive re-target = 0 migrations; wildcard; cross-worker pair identity | Dual: write-log ring (`.changed`) + per-row changeVersion (`changedSince`); deferred observers | Bit-exact snapshot + version-stamp delta; id/pair remap; zero-copy SAB bootstrap | Pre-1.0, unpublished; ~446 tests, ~90% line cov, frozen public API, spec-first | **None** (unpublished, MIT) |
| **bitECS** | Sparse-set + bitmask queries; no archetype | User-provided (SoA recommended) [[src]](https://bitecs.dev/docs/introduction) | v0.4 removed typed `defineComponent`; component types user-declared; any-leakage risk [[notes]](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md) | **Manual** (SAB read-parallel; structural mutation main-thread only) [[multithreading]](https://github.com/NateTheGreatt/bitECS/blob/main/docs/Multithreading.md) | First-class v0.4: exclusive, IsA, wildcard, hierarchy [[API]](https://github.com/NateTheGreatt/bitECS/blob/main/docs/API.md) | Observer-based (`onAdd/onRemove/onSet`); `Changed()` removed to legacy [[API]](https://github.com/NateTheGreatt/bitECS/blob/main/docs/API.md) | Dedicated `bitecs/serialization`: SoA/AoS/observer/snapshot, diff mode, id remap, epsilon for floats [[serialization]](https://github.com/NateTheGreatt/bitECS/blob/main/docs/Serialization.md) | **Active**; v0.4.0 Dec 6 2025 (full TS rewrite) [[releases]](https://github.com/NateTheGreatt/bitECS) | ~1.4k stars; ~8k wk dl (June 2026); Phaser 4, Enchantment Engine [formerly Ethereal Engine], Hubs [[readme]](https://github.com/NateTheGreatt/bitECS) |
| **miniplex** | Object AoS; lazy archetype "bucket" index | No | TS-first; auto-narrowing archetypes; weakens with optional-heavy base types [[repo]](https://github.com/hmans/miniplex) | None | None (manual via component refs) | Event-based (`onEntityAdded/Removed`); no value-mutation tracking [[react]](https://github.com/hmans/miniplex/blob/main/packages/react/README.md) | None (JSON.stringify only) | **Stalled**; last release Jul 2023; two dependency-update chore commits Apr 2026, no feature work [[commits]](https://github.com/hmans/miniplex/commits/main) | ~1k stars; ~3.6k wk dl (June 2026) [[npm]](https://api.npmjs.org/downloads/point/last-week/miniplex) |
| **becsy** | Sparse-array SoA via ArrayBuffers; 3 storage strategies | Yes [[overview]](https://lastolivegames.github.io/becsy/guide/architecture/overview) | Decorator-based (`experimentalDecorators`); schema duplication; `object`/`weakObject` untyped [[components]](https://lastolivegames.github.io/becsy/guide/architecture/components.html) | **Planned, NOT shipped** (top priority, still single-threaded at v0.16.0) [[systems]](https://lastolivegames.github.io/becsy/guide/architecture/systems) | `@field.ref` + `backrefs` (bidirectional, referential integrity); not Flecs-style primitive | Reactive queries; read/write entitlements; `trackWrites` [[systems]](https://lastolivegames.github.io/becsy/guide/architecture/systems) | None [[changelog]](https://github.com/LastOliveGames/becsy/blob/main/CHANGELOG.md) | **Slow/active**; v0.16.0 Mar 2025; solo maintainer | ~294 stars; ~500 wk dl [[libraries.io]](https://libraries.io/npm/@lastolivegames%2Fbecsy) |
| **koota** | Sparse-set (plain `number[]`); hybrid SoA/AoS per-trait | Partial (plain JS arrays, **no** TypedArrays) [[sparse-set]](https://github.com/pmndrs/koota/blob/main/packages/collections/src/sparse-set.ts) | Strong generics; no any-leakage by design; interface `Pick` workaround [[trait.ts]](https://github.com/pmndrs/koota/blob/main/packages/core/src/trait/trait.ts) | None [[repo]](https://github.com/pmndrs/koota) | First-class: exclusive, auto-destroy, wildcard, ordered (experimental) [[query.ts]](https://github.com/pmndrs/koota/blob/main/packages/core/src/query/query.ts) | `onChange/onAdd/onRemove`; `Added/Removed/Changed`; shallow compare + manual `changed()` [[README]](https://github.com/pmndrs/koota/blob/main/README.md) | None (manual via `getStore`) | **Active**; v0.6.5 Feb 2026; pmndrs org [[releases]](https://github.com/pmndrs/koota/releases) | ~694 stars; ~4.3k wk dl [[npm API]](https://api.npmjs.org/downloads/point/last-week/koota) |
| **thyseus** | Archetype + SoA (plain JS object arrays) | No (plain object arrays) [[Table.ts]](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/src/components/Table.ts) | Build-time TS transformer (Bevy-like injection); minimal any-leakage [[Query.ts]](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/src/queries/Query.ts) | **Manual** (Thread RPC over postMessage/structured-clone; no SAB; sequential scheduler) [[Schedule.ts]](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/src/world/Schedule.ts) | None | None (structural filters only; no `Changed`) | None first-class (primitive ser/deser helpers only) [[changelog]](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/CHANGELOG.md) | **Dormant**; last commit May 2024; marked 🔴 Stale | ~86 stars; ~0 CDN reqs [[jsdelivr]](https://www.jsdelivr.com/package/npm/thyseus) |
| **javelin** | Archetype (AoS default; binary cols prototyped, unshipped) | Optional, never shipped | Generic query inference; schema-object [[ecs]](https://javelin.games/ecs/) | None (user-space `useWorker` effect only) | None | Coarse `useMonitor`; `observe()` proxy for net patches [[effects]](https://javelin.games/ecs/effects/) | Binary via `@javelin/pack`/`@javelin/net`; delta patching [[protocol]](https://javelin.games/networking/protocol/) | **Abandoned** since Jul 2022; perpetual alpha | ~211 stars; ~100–200 wk dl [[repo]](https://github.com/3mcd/javelin) |
| **wolf-ecs** | Hybrid archetype + sparse-set; global TypedArrays | Yes (pure SoA) [[component.ts]](https://github.com/EnderShadow8/wolf-ecs/blob/main/src/component.ts) | Structural inference, no codegen; `types.any` escape hatch | None | None | None (structural caching only) | None | **Archived** Sept 2022; "benchmark reference, not for production" [[repo]](https://github.com/EnderShadow8/wolf-ecs) | ~142 stars; ~29–49 wk dl [[libraries.io]](https://libraries.io/npm/wolf-ecs) |
| **ape-ecs** | Object AoS; per-type component pools | No | Community `.d.ts`, shallow; significant any-leakage [[Component]](https://github.com/fritzy/ape-ecs/blob/master/docs/Component.md) | None | `EntityRef`/`EntitySet`/`EntityObject`; null-on-destroy; reverse queries [[Entity]](https://github.com/fritzy/ape-ecs/blob/master/docs/Entity.md) | Tick-based; manual `component.update()`; persisted queries [[Query]](https://github.com/fritzy/ape-ecs/blob/master/docs/Query.md) | Built-in `getObject()`/restore; per-field control [[World]](https://github.com/fritzy/ape-ecs/blob/master/docs/World.md) | **Dormant** since early 2021; 14 issues/18 PRs ignored | ~313 stars; ~303 wk dl [[npm API]](https://api.npmjs.org/downloads/point/last-week/ape-ecs) |
| **tick-knock** | Object AoS; components on entity map | No | Class-based generics; permissive "any class" [[README]](https://github.com/mayakwd/tick-knock/blob/develop/README.md) | None | None (`LinkedComponent` ≠ relation) | `onEntityAdded/Removed`; manual `entity.invalidate()` | None | **Inactive** since Aug 2024 (last substantive commit); Snyk 45/100 [[snyk]](https://security.snyk.io/package/npm/tick-knock) | ~151 stars; ~31–186 wk dl |
| **ecsy** | Object-per-entity AoS; object pools | No | JS + handwritten `.d.ts`; `getComponent` generics OK; schema not TS-checked [[Entity.d.ts]](https://github.com/ecsyjs/ecsy/blob/master/src/Entity.d.ts) | None (noted as future aspiration only) | None (`Types.Ref` unmanaged pointer) | `ENTITY_ADDED/REMOVED/COMPONENT_CHANGED`; manual `getMutableComponent()` [[Query.js]](https://github.com/ecsyjs/ecsy/blob/master/src/Query.js) | None (planned, never shipped) | **Archived** Apr 13 2025; last release Sept 2020 [[repo]](https://github.com/ecsyjs/ecsy) | ~1.2k stars; ~97 wk dl [[npm API]](https://api.npmjs.org/downloads/point/last-week/ecsy) |

---

## 3. Per-Competitor Analysis

### 3.1 bitECS — the one to beat

**What it does well.** bitECS is the strongest *active* competitor: lean core (~5kb minzipped, zero deps), bitmask query evaluation that can test 64 entities per CPU instruction, and a SoA + TypedArray storage pattern verified in production by Phaser 4, Enchantment Engine (formerly Ethereal Engine), and Mozilla Hubs ([Phaser devlog](https://phaser.io/devlogs/260); [Hubs docs](https://docs.hubsfoundation.org/dev-client-gameplay.html)). The Dec 2025 v0.4.0 rewrite added a genuinely full-featured **relations** system (exclusive, IsA inheritance, wildcard, hierarchy ordering, prefabs) ([API](https://github.com/NateTheGreatt/bitECS/blob/main/docs/API.md)) and a comprehensive **serialization** module with diff mode, observer-delta sync, and entity-ID remapping ([Serialization](https://github.com/NateTheGreatt/bitECS/blob/main/docs/Serialization.md)). It ranks 2nd among SoA JS ECS libs in packed and fragmented iteration in [noctjs/ecs-benchmark](https://github.com/noctjs/ecs-benchmark/blob/main/README.md).

**Where ecsia differs.** (1) ecsia ships an **automatic** parallel scheduler; bitECS leaves parallelism entirely manual — TypedArray stores can sit on a SAB for *read-parallel* iteration, but `addEntity/removeEntity/addComponent/removeComponent` are main-thread-only, so structural mutation must be queued and flushed on the main thread ([multithreading docs](https://bitecs.dev/docs/multithreading)). (2) bitECS's relations use JS-reference component identity and **cannot cross workers**; ecsia's integer-encoded `(relation, target)` pairs have cross-worker identity by construction. (3) bitECS v0.4 **removed** the typed `defineComponent()` schema — component field types are now user-declared and library-unenforced, a real any-leakage risk ([release notes](https://github.com/NateTheGreatt/bitECS/blob/main/docs/RELEASE_NOTES_0.4.0.md)); ecsia keeps full schema-to-type inference with no codegen. (4) bitECS has no system scheduler at all — all ordering is user responsibility.

**What ecsia should learn (steal).**
- **The serialization module is the gold standard to match or beat.** Diff mode with configurable `epsilon`, an observer serializer for structural deltas, and the optional `Map<number,number>` for entity-ID remapping across worlds/peers are exactly the right primitives for networking. ecsia's delta story should explicitly support an epsilon/quantization mode and document a network-replication recipe.
- **Relation ergonomics:** IsA/inheritance relations and prefab templates (`addPrefab` + `IsA`) are a powerful authoring pattern. ecsia's integer-encoded pairs can support this; the prefab/inheritance *API surface* is worth copying.
- **Lean-core discipline.** bitECS's ~5kb signal-to-noise ratio is a selling point. ecsia is "batteries-included," but should ensure tree-shaking lets users pay only for what they import (workers, serialization, reactivity as opt-in).
- **Operational honesty about COOP/COEP.** bitECS users hit the cross-origin-isolation burden for SAB in browsers. ecsia already plans a non-silent postMessage fallback — document the COOP/COEP requirement prominently, as bitECS's experience shows it surprises people.

### 3.2 miniplex — the DX bar

**What it does well.** miniplex has the lowest adoption friction in the field: entities are plain objects, no registration ceremony, no numeric IDs required, and archetype "bucket" queries deliver automatic TypeScript narrowing with no codegen or decorators ([repo](https://github.com/hmans/miniplex)). Its `miniplex-react` package is a first-class React integration well-suited to react-three-fiber ([react README](https://github.com/hmans/miniplex/blob/main/packages/react/README.md)).

**Where ecsia differs.** ecsia is SoA/archetype/TypedArray and parallel; miniplex is object-AoS, single-threaded, with no SAB compatibility, no relations, and no serialization. miniplex's AoS layout shows poor cache behavior (e.g. entity-cycle ~310 ops/s vs. thousands for data-oriented libs in noctjs). Critically, miniplex has **no value-mutation reactivity** — `entity.position.x = 5` fires no event and predicate archetypes need a manual `world.update(entity)`. ecsia's write-log ring + per-row changeVersion handle this automatically and worker-safely.

**What ecsia should learn (steal).**
- **The "plain object" ergonomic feel without paying the AoS tax.** miniplex's appeal is that querying *feels* like working with objects. ecsia's typed read/write split (`entity.write(C).x = 5`) is already close; make sure the ergonomic path reads as cleanly as miniplex's narrowed objects so the SoA backing stays invisible.
- **Archetype-derivation (bucket tree).** Composing a narrower query from a broader one is a nice API affordance worth offering on ecsia's query DSL.
- **Lesson on maintenance:** miniplex's stall (no feature release since Jul 2023, 24 open issues; two dependency-chore commits appeared Apr 2026 but no feature work — [commits](https://github.com/hmans/miniplex/commits/main)) shows that great DX without sustained maintenance loses momentum. ecsia's spec-first rigor and test depth are the counter-strategy; keep them visible.

### 3.3 becsy — ecsia's closest *ambition* twin

**What it does well.** becsy is the only other library that made lock-free multithreading its headline goal, and its architecture is built for it: declarative ordering constraints form a precedence graph mappable to threads ([systems](https://lastolivegames.github.io/becsy/guide/architecture/systems)). It has genuine SoA-via-ArrayBuffers with three selectable storage strategies (sparse/packed/compact), an ergonomic OO API, reactive queries with read/write entitlements, bidirectional refs with referential integrity, and coroutines.

**Where ecsia differs.** **becsy's multithreading is still not implemented after 4+ years** (v0.16.0, Mar 2025, still single-threaded — [introduction](https://lastolivegames.github.io/becsy/guide/introduction)). ecsia *ships* it. becsy also requires `experimentalDecorators` (legacy decorator spec) and forces schema duplication (TS type + `@field` decorator); ecsia needs neither. becsy has no serialization and no Flecs-style relation primitive (only `ref`/`backrefs`). becsy's `object`/`weakObject` field types are explicitly threading-incompatible and untyped — a coupling ecsia avoids by encoding everything into TypedArray-friendly representations.

**What ecsia should learn (steal).**
- **Read/write entitlements declared per-component on the query chain.** This is the same `{read, write}` declaration ecsia's scheduler relies on — becsy's surfacing of it at the *query* level (`.read`/`.write`) is good prior art for an ergonomic API and validates ecsia's conflict-DAG approach.
- **Selectable per-component storage strategy.** becsy's sparse/packed/compact choice is a useful escape valve. ecsia already has cold-store fragmentation fallback; consider exposing a hint for singleton/rare components (becsy's "compact").
- **Coroutines for multi-stage system workflows** — a nice ergonomic ecsia could add later.
- **The cautionary lesson:** announcing parallelism as the headline feature and not shipping it for years is corrosive to trust. ecsia's advantage is that the feature *exists and is property-tested for serial-equivalence* — lead with proof (benchmarks: 3.2x@4w, ~5.6x@8w; bit-identical results), not promise.

### 3.4 koota — the momentum threat

**What it does well.** koota has the field's best *combination* of active maintenance and modern DX: pmndrs-org backing (zustand/jotai/drei authors), v0.6.5 Feb 2026, ~4.3k weekly downloads ([releases](https://github.com/pmndrs/koota/releases); [npm API](https://api.npmjs.org/downloads/point/last-week/koota)). It pairs a first-class React integration (`@koota/react`: `useQuery`, `useTrait`, `useTarget`, typed hooks) with a sophisticated relations system (exclusive, auto-destroy, wildcard, ordered) and strong generic inference with no any-leakage by design ([trait.ts](https://github.com/pmndrs/koota/blob/main/packages/core/src/trait/trait.ts)). Hybrid SoA/AoS storage lets Three.js objects (Vector3 etc.) be stored without wrapping.

**Where ecsia differs.** koota uses **plain JS `number[]` sparse sets — no TypedArrays** ([sparse-set.ts](https://github.com/pmndrs/koota/blob/main/packages/collections/src/sparse-set.ts)), giving a lower raw-throughput ceiling than ecsia's TypedArray columns, and it has **no worker parallelism, no SAB, no serialization**. koota's change detection is shallow-compare with manual `entity.changed()` for object mutations; ecsia's write-log ring + changeVersion is automatic and worker-safe. ecsia's relations cross worker boundaries; koota's do not exist across threads at all (single-threaded only).

**What ecsia should learn (steal).**
- **`@koota/react` is the template for the React bindings ecsia is missing.** The hook set (`useQuery`/`useTrait`/`useTarget`/`useTargets`/`useTag`/`useHas`) is a strong, copyable API surface. This is ecsia's single biggest ergonomics gap relative to a *currently-growing* competitor.
- **Auto-destroy relation modes** (`'orphan'` destroys sources when target dies; `'target'` destroys targets). ecsia has back-ref index + iterative cascade; expose the *policy* as a declarative modifier the way koota does.
- **Zero-cost tag traits** — ecsia should ensure tag/marker components truly cost nothing (koota makes this explicit).
- **Hybrid SoA/AoS for foreign objects.** koota's ability to store a Three.js Vector3 without wrapping is a real-world ergonomics win. ecsia's SoA-first model is harder here; consider a documented AoS/opaque-column escape hatch (note: such columns won't cross workers — be explicit, like becsy is about `weakObject`).
- **Strategic lesson:** koota is the competitor most likely to *grow into* ecsia's space via pmndrs reach. Differentiate hard on parallelism and serialization, which koota lacks.

### 3.5 thyseus — the parallel-Bevy aspirant that stalled

**What it does well.** thyseus has the best *typing automation* idea in the field: a build-time TypeScript transformer that reads system signatures and auto-generates parameter injection, Bevy-style, with no runtime reflection or decorators ([transformer](https://github.com/JaimeGensler/thyseus/blob/main/packages/typescript-transformer/src/index.ts); [Query.ts](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/src/queries/Query.ts)). It has an archetype + SoA structure and a first-class, eval-free Web Worker abstraction (`Thread`/`Threads`/`expose`).

**Where ecsia differs.** thyseus's worker support is **RPC over postMessage/structured-clone, not SAB zero-copy**, and its scheduler is strictly **sequential** (a `for-await` loop with no dependency graph — [Schedule.ts](https://github.com/JaimeGensler/thyseus/blob/main/packages/thyseus/src/world/Schedule.ts)); real parallelism is fully manual. ecsia has a conflict-DAG wave scheduler over SAB. thyseus's storage is plain JS object arrays (not TypedArrays), has no relations, no change detection, and no first-class serialization. It is also **dormant** (last commit May 2024, marked 🔴 Stale).

**What ecsia should learn (steal).**
- **The build-time-transformer DX is worth *understanding* even though ecsia explicitly rejects codegen.** thyseus's mandatory bundler plugin is a real friction point (incompatible with plugin-less bundlers) — this *validates* ecsia's no-codegen positioning. ecsia achieves typed accessors via monomorphic factory closures instead; lean into "no build step required" as a differentiator against thyseus's transformer requirement.
- **Bevy `SystemParam`-style ergonomics** for declaring system inputs is a clean mental model; ecsia's `{read, write}` declaration could borrow the readability without borrowing the transformer.
- **Lesson:** thyseus had the right *foundations* (archetype + SoA + workers + Bevy DX) but never unified them into automatic parallelism and then went dormant. ecsia's job is to be the library thyseus aimed to be — and to stay maintained.

### 3.6 javelin — the networking pioneer

**What it does well.** javelin's standout is its **binary multiplayer/networking** story (`@javelin/pack`, `@javelin/net`) with delta patching via an `observe()` proxy cache and a transport-agnostic protocol ([protocol](https://javelin.games/networking/protocol/)) — rare among JS ECS libraries. Its Topics system (typed FIFO inter-system queues) and effects system are thoughtful designs.

**Where ecsia differs.** javelin is **abandoned** (no commits since Jul 2022, perpetual alpha), object-AoS by default (the binary/SoA columns were prototyped but never shipped — [storage post](https://javelin.hashnode.dev/ecs-in-js-storage-mechanisms)), has no relations, and no real parallelism (`useWorker` is a user-space effect). The author explicitly notes AoS is incompatible with SAB zero-copy — exactly the constraint ecsia's SoA design sidesteps.

**What ecsia should learn (steal).**
- **The networking protocol design.** Serializing ECS *operations* (attach/update/patch/detach/destroy) into compact ArrayBuffer messages, with both full-state and delta-only modes, is a proven pattern. ecsia's version-stamp delta + structural-since-T journal should explicitly target a network-replication use case, and a `@javelin/net`-style ops protocol is a good reference.
- **Topics (typed inter-system message queues)** avoid component-mutation overhead for one-off events — a clean complement to ecsia's deferred-observer reactivity.

### 3.7 wolf-ecs — the speed ceiling

**What it does well.** wolf-ecs is the **raw-speed reference**: top of noctjs fragmented iteration (~535k ops/s) and competitive in packed (~378k ops/s) via pure SoA TypedArray storage and hybrid archetype + sparse-set indexing, with full TS inference and no codegen ([component.ts](https://github.com/EnderShadow8/wolf-ecs/blob/main/src/component.ts)).

**Where ecsia differs.** wolf-ecs is **archived (Sept 2022) and self-describes as "not for production"** — it exists to show the speed upper bound. It has no relations, no parallelism, no reactivity, no serialization. ecsia is the inverse: full feature set, maintained, with parallelism as the throughput lever rather than single-thread micro-optimization.

**What ecsia should learn (steal).**
- **wolf-ecs is the single-thread benchmark target.** Its numbers define the ceiling ecsia's `eachChunk` cursor should chase. Use wolf-ecs (and bitECS) as the explicit baselines in ecsia's published iteration benchmarks, and be honest that ecsia trades some single-thread speed for features + parallelism.
- **Deferred add/remove with backward-iteration** to avoid mid-loop double-counting is a known SoA footgun wolf-ecs documents; ensure ecsia's command-buffer model makes this a non-issue (it appears to, via deferred merges).
- **The `types.any` escape-hatch cautionary tale:** wolf-ecs offers it but it bypasses type safety entirely. ecsia should avoid shipping an unchecked escape hatch, or sandbox it loudly.

### 3.8 ape-ecs — the feature-rich AoS reference

**What it does well.** Despite object-AoS storage, ape-ecs packs a lot: `EntityRef`/`EntitySet`/`EntityObject` references with automatic null-on-destroy and **reverse queries**, persisted queries with add/remove tracking, tick-based change detection, and **built-in serialization** with per-component field-level control (`serialize=false`, `serializeFields`, `skipSerializeFields`) ([World docs](https://github.com/fritzy/ape-ecs/blob/master/docs/World.md)).

**Where ecsia differs.** ape-ecs is **dormant since early 2021**, object-AoS (poor cache behavior, benchmarked ~1376% slower than the fastest on add/remove stress), single-threaded, with shallow community `.d.ts` typing and significant any-leakage. Change detection requires manual `component.update()` — easy to silently break. ecsia's SoA, parallelism, and full inference are categorical improvements.

**What ecsia should learn (steal).**
- **Field-level serialization control** (`serialize=false`, whitelist/blacklist fields per component). ecsia's bit-exact snapshot should offer this granularity for save-games where some components (e.g. transient caches) shouldn't persist.
- **Reverse queries on references.** ape-ecs lets you find all components referencing a given entity. ecsia already has a back-ref index for relations; expose it as a first-class reverse-query API.

### 3.9 tick-knock — minimal Ash-lineage

**What it does well.** Clean fluent `QueryBuilder`, low boilerplate (plain classes as components), `LinkedComponent` for multiple same-type components (buff/inventory stacking), and built-in `IterativeSystem`/`ReactionSystem` base classes ([README](https://github.com/mayakwd/tick-knock/blob/develop/README.md)).

**Where ecsia differs.** Object-AoS, single-threaded, no relations (the `LinkedComponent` linked-list is not a relation primitive), no serialization, inactive since Aug 2024 (last substantive commit; Snyk 45/100), reactivity needs manual `entity.invalidate()`. ecsia leads on every data-oriented and concurrency axis.

**What ecsia should learn (steal).**
- **`LinkedComponent`-style multiple-instances-per-entity** is a real pattern (stacked buffs, multiple colliders). ecsia's archetype model typically allows one component instance per type per entity; consider a documented pattern or API for multi-instance components.
- **Built-in system base classes** (`IterativeSystem`, `ReactionSystem`) reduce lifecycle boilerplate — a nice convenience layer ecsia could offer atop its scheduler.

### 3.10 ecsy — the archived elder

**What it does well.** ecsy's historical contribution was an approachable OO API, a practical reactive query system (`ENTITY_ADDED`/`ENTITY_REMOVED`/`COMPONENT_CHANGED`), component + entity object pooling to cut GC pauses, and a comprehensive docs site for its era. Mozilla Reality origin gave it early WebXR visibility.

**Where ecsia differs.** ecsy is **archived (Apr 13 2025)**, last released Sept 2020, object-per-entity AoS with **worst-in-class** benchmark numbers (packed ~7,822 ops/s vs. miniplex ~109k; entity-cycle ~120 ops/s). No parallelism (only noted as a "future aspiration" — and becsy was created specifically to fix that gap), no relations, no shipped serialization. ecsia supersedes it on every dimension.

**What ecsia should learn (steal).**
- **Object/entity pooling to control GC.** ecsia's TypedArray columns avoid per-entity GC pressure already, but for cold-store/AoS fallback paths, pooling is worth keeping in mind.
- **ecsy's architecture-doc note that "automatic schedulers could analyze the code to parallelize it"** is, in effect, ecsia's thesis statement — ecsy aspired to it in 2020 and never built it. ecsia is the realization of that idea; cite the lineage.
- **The deferred-removal-to-end-of-frame pattern** (so same-tick systems can still read removed components) is a useful determinism guarantee to confirm ecsia matches via its command buffers.

---

## 4. Positioning

### 4.1 Defensible differentiators (where ecsia is genuinely unique)

1. **Auto-parallel, serial-equivalent worker scheduler.** This is the moat. Systems declare `{read, write}`; a conflict DAG yields wave-level topological parallelism on a real `worker_threads` pool over `SharedArrayBuffer` with Atomics wave-sync; per-worker command buffers merge deterministically by fixed index; multi-worker output is **bit-identical to single-thread** and property-tested for serial-equivalence. Measured 3.2x@4w, ~5.6x@8w on heavy disjoint workloads. **No competitor ships this** — bitECS and thyseus are manual, becsy is unshipped after 4+ years, everyone else is single-threaded. The serial-equivalence guarantee specifically removes the usual reason teams avoid ECS parallelism (nondeterminism / heisenbugs).

2. **Cross-worker relations.** Integer-encoded `(relation, target)` pairs as archetype members have identity that survives the worker boundary; JS-object pair identity (bitECS, koota) does not. Exclusive re-target is an in-place eid write with **zero migrations**; per-relation presence bit gives O(archetypes) wildcard; back-ref index + iterative cascade is 100k-deep safe. This is the only relations system in the field designed for a multi-threaded world.

3. **Typed accessors without codegen, decorators, or a build transformer.** Full TS inference from `defineComponent` schemas, a typed read/write split, 1..8 fully-inferred query arity with typed degradation, via monomorphic factory-closure accessors (no ES Proxy). Contrast: becsy needs `experimentalDecorators` + schema duplication; thyseus needs a mandatory bundler transformer; bitECS v0.4 *dropped* schema typing. ecsia gets the strongest typing with the lowest build/runtime cost.

4. **Spec-first rigor.** ~446 tests (unit + fast-check property + type-level + real-worker), ~90% line coverage, strict TS, frozen public API, 13 module specs + cited design research. In a field littered with abandoned alphas (javelin, thyseus, ecsy), demonstrable correctness discipline is itself a differentiator — especially backing a serial-equivalence claim that *requires* property testing to be credible.

5. **Batteries included across the thread boundary.** Reactivity (write-log ring + changeVersion, deferred observers that never fire mid-system — safe under workers) and serialization (bit-exact snapshot + version-stamp delta + zero-copy SAB worker bootstrap) are both designed to be correct *under parallelism*. Competitors that have these features (bitECS serialization, koota reactivity) have them only in a single-threaded context.

### 4.2 Gaps (honest weaknesses)

1. **Unpublished, zero adoption.** ecsia has no stars, no downloads, no production users, no third-party integrations. bitECS has Phaser 4 / Enchantment Engine (formerly Ethereal Engine) / Mozilla Hubs; koota has pmndrs reach. This is the single biggest liability — every technical advantage is moot without distribution.
2. **Single-thread raw iteration is ~2x behind bitECS.** Even the new opt-in `eachChunk` column cursor is self-measured at ~2x slower than bitECS iteration (and far behind the wolf-ecs ceiling); the ergonomic `.each` is ~28ns/entity. ecsia's throughput story *depends on* the parallel path — on a single core it does not win.
3. **No React bindings.** miniplex (`miniplex-react`) and koota (`@koota/react`) both ship typed hooks; ecsia ships none. For the large R3F/react-three-fiber segment, this is a hard adoption blocker today.
4. **No editor / devtools.** No inspector, no timeline, no live entity browser. Mature competitors and game frameworks increasingly expect tooling.
5. **Browser deployment friction for the headline feature.** SAB-backed parallelism requires cross-origin isolation (COOP/COEP). ecsia's fallback is a non-silent postMessage path — but in non-isolated contexts the differentiator degrades to what thyseus/bitECS already offer.
6. **Unproven at scale.** All performance and serial-equivalence numbers are self-measured. Without external benchmarks (e.g. inclusion in noctjs/ecs-benchmark) and real workloads, the claims are credible but not independently validated.

---

## 5. Threats & Recommendations

### Threats

1. **koota's momentum (highest threat).** koota is the only competitor that is *both* actively growing *and* in an adjacent space, with pmndrs distribution (zustand/jotai/drei). If koota adds TypedArray storage and any form of worker support, it could close the gap while keeping its React-ecosystem advantage. ecsia must establish a clear parallelism + serialization lead *before* koota expands. ([koota releases](https://github.com/pmndrs/koota/releases))
2. **bitECS closing the convenience gap.** bitECS already has relations, serialization, and SoA, plus real adoption. If it ever adds an automatic scheduler (its data structures are worker-friendly today), it would directly contest ecsia's moat from a position of established distribution. ([bitECS multithreading](https://bitecs.dev/docs/multithreading))
3. **becsy/thyseus shipping or reviving their parallel ambitions.** Both share ecsia's auto-parallel thesis. becsy could finally ship multithreading; a thyseus revival could complete its Bevy-style scheduler. Either would erode ecsia's "only one that ships it" claim — though both are years behind today. ([becsy systems](https://lastolivegames.github.io/becsy/guide/architecture/systems))
4. **Network effects / ecosystem lock-in.** Game frameworks pick an ECS once (Phaser 4 → bitECS) and stay. Every month ecsia is unpublished, the integration slots narrow.

### Recommendations

1. **Publish now, lead with the moat.** Ship to npm with a benchmark page that proves the parallel claim (3.2x@4w, ~5.6x@8w, bit-identical-to-serial) against bitECS and wolf-ecs baselines, and **be honest about the single-thread ~2x gap**. The serial-equivalence property test is the headline — it's what no one else can claim.
2. **Build React bindings (`ecsia/react`) modeled on `@koota/react`.** This closes the biggest adoption blocker for the largest active segment (R3F). Prioritize over further core micro-optimization.
3. **Get into noctjs/ecs-benchmark.** External, third-party numbers convert self-measured claims into credible ones and force an apples-to-apples comparison ecsia can frame around the parallel axis.
4. **Match bitECS's serialization surface, then extend it cross-worker.** Add epsilon/quantized diff mode and an ops-protocol (javelin-style) network-replication recipe. Serialization + cross-worker is a combination no competitor has.
5. **Steal koota's relation modifiers and bitECS's IsA/prefab inheritance** to reach feature parity on relations while keeping the cross-worker advantage.
6. **Document COOP/COEP and the postMessage fallback prominently.** Turn the operational burden into a trust signal by being explicit (the fallback is never silent) — bitECS users' COOP/COEP friction shows this surprises people.
7. **Invest in minimal devtools early** (live entity/archetype inspector, scheduler wave visualizer). A wave-visualizer in particular *showcases the differentiator* and has no competitor equivalent.
8. **Keep the rigor visible.** The ~446 tests / ~90% coverage / spec-first discipline is the antidote to the field's abandonment pattern (javelin, thyseus, ecsy). Make it part of the pitch, not just the codebase.

---

*All popularity and maintenance figures are point-in-time as of each library's cited research date (mid-2025 to June 2026) and will drift. Performance figures for ecsia are self-measured and pending independent validation.*
