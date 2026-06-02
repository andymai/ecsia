# ecsia Implementation Spec — Module: World & `createWorld` (KEYSTONE)

> **This is the keystone module.** Every other spec defers to it for the cross-cutting
> facts that have no other home: the `createWorld` option shape and validation order, the
> `World` object surface, the `world.phase` state machine, the reserved-`ComponentId` set
> and `FIRST_USER_COMPONENT_ID`, the `maxEntities` default and how it sizes the bounded
> flat structures, the module wiring/initialization order, and the `Tick` ownership
> contract. It resolves punch-list gap **G-6** and pins the cross-spec seams the coherence
> pass flagged (G-7, phase ownership, Tick ownership, `changeVersion` growth).
>
> This module **owns the assembly**: it allocates the bounded global buffers, instantiates
> and wires the seven owning modules in a fixed order, runs option validation fail-fast,
> seeds `world.phase`, owns `world.tick`, and returns a frozen `World` facade. The
> *mechanisms* live in the lower modules (entity-model, memory-buffers, type-system /
> component-schema, archetype-storage, relations, reactivity) plus the optional scheduler;
> this spec is **normative for the contracts between them**.
>
> Provenance is cited inline as `DESIGN-RESEARCH.md §x.y` (the report) and as the owning
> module spec. Where this spec restates a lower module's signature, that module remains the
> normative implementation; this spec is normative for the *wiring and the shared constants*.
>
> **Relationship to public-api.md.** `public-api.md` fixes the *end-user ergonomic surface*
> (the umbrella re-export, the worked example, the read/write split as the user sees it).
> **world.md** fixes the *authoritative internal contract* the public surface compiles down
> to. Where the two restate the same option or verb, **world.md is canonical** for the
> option-key shape, defaults, validation order, and the reserved-id / phase / tick
> invariants; public-api.md is canonical for ergonomics and re-export naming. The few
> places where an earlier draft of another spec used a different default (notably
> `maxEntities`) are reconciled here in §6 and §11 — **world.md wins**.

---

## 0. Scope & Non-Goals

**In scope (this module owns these — they have no other normative home):**

- `createWorld(options)` — the full `WorldOptions` shape (CANON nesting), the resolved
  defaults, and the **deterministic validation + wiring order**. §2, §6, §7.
- The `World` object surface: entity spawn/despawn delegation, `query()`, scheduler
  delegation (`addSystem` / `update`), `world.tick` / `currentTick()`, serialization entry
  points. §3.
- The `world.phase ∈ {'serial','wave'}` state machine: ownership, initial value, who
  flips it, single-thread and kernel-only behavior. §4.
- The **reserved `ComponentId` set**, `NO_COMPONENT = 0`, and `FIRST_USER_COMPONENT_ID = 1`.
  §5.
- The canonical **`maxEntities` default `1 << 20`** and how it sizes the bounded flat
  structures (entity records, id-pool, bitmask words, reactivity rings). §6.
- The **module wiring / initialization order** (registry → buffers → storage → reactivity
  → queries → scheduler → serialization). §7.
- The **`Tick` ownership contract**: world owns `world.tick`; reactivity advances it at
  frame reset; everyone reads `world.tick`. §8.
- The shared numeric constants other specs cite: the structural-op ordinals, the bit-vector
  stride rule, the log-entry-width selection rule, `observerCadence` literal set, the
  `trackWrite` signature. §9 (the canonical-constant registry).

**Out of scope (owned elsewhere; this spec only wires/asserts them):**

- Handle bit-layout, liveness, the two-word record, the ID-reservation handshake —
  **entity-model.md**.
- Field-token → column layout, SAB vs AB backing, length-tracking views, `.grow()`,
  capability probe — **memory-buffers.md**.
- `defineComponent` / `defineRelation` schema inference, `ReadView` / `WriteView`, the
  query DSL types, arity cap, branded IDs — **type-system.md** / **component-schema.md**.
- Archetype tables, edge graph, migration, the bitmask membership index, the cold-archetype
  fallback — **archetype-storage.md**.
- Pair minting, exclusivity split, presence bit, back-ref index, cascade — **relations.md**.
- Change logs, version stamps, observers, the spill list, frame-loop lifecycle calls —
  **reactivity.md**.
- The conflict DAG, wave extraction, worker dispatch, command buffers, Atomics sync —
  **scheduler.md** + **command-buffer.md** (an **opt-in** layer; the kernel runs without it).
- Snapshot/delta wire format, zero-copy SAB sharing, `ColumnsAdded` handshake —
  **serialization.md**.

---

## 1. Locked decisions this module pins

| Locked decision (report / CANON) | How world.md pins it |
|---|---|
| Bitmask is **main-thread / serial-phase only**; no concurrent structural writes (Must-Fix #1, T2) | `world.phase` is the gate; this module seeds it `'serial'` and documents that only the scheduler flips it. §4. |
| Scheduler-visible write-intent is **declared**, not inferred; `.changed` is driven separately by the write log (Must-Fix #2) | `trackWrite(index, componentId, fieldIndex?)` canonical signature pinned in §9; the scheduler reads `SystemDef.write` only. §3.4, §9.1. |
| Command-buffer layout / flush; deterministic merge; drop-if-dead (Must-Fix #3) | World provides the serial flush slot and the bounded id-pool the reservation handshake draws from (§6.3); structural-op ordinals pinned in §9.4. |
| Relation payload split by exclusivity; combined migration primitives required (Must-Fix #4, P1) | World requires storage to expose `migrateAddingMany`/`migrateRemovingMany`; §3.3, §9.7. |
| Length-tracking views over resizable SABs primary; grow-and-patch fallback (Must-Fix #5) | World allocates bounded flat regions as resizable SABs sized by `maxEntities`; §6. |
| Generational handle, configurable split, default 22/10 (§3 #3) | `generationBits` option; `indexBits = 32 - generationBits`; default 10/22. §2.2, §6.1. |
| `maxEntities` default `1 << 20`; nested feature knobs (CANON) | `WorldOptions` with nested `reactivity` / `scheduler` sub-objects; `maxEntities` default `1 << 20`. §2.2, §6, §11. |
| All runtimes + workers via SAB with **postMessage fallback**; never silent (§3 #9, §6.3) | Capability probe at construction; non-isolated `threaded` request downgrades with a startup diagnostic. §2.4, §7 step 2. |

---

## 2. `createWorld` — the single entry point

### 2.1 Signature

```ts
import { createWorld } from '@ecsia/ecsia';

const world: World = createWorld(options?: WorldOptions);
```

`createWorld` is the **only** world constructor. It (a) resolves and validates options
fail-fast, (b) runs the capability probe (`probeCapabilities`, memory-buffers.md §4),
(c) allocates the bounded global buffers sized by `maxEntities` (§6), (d) instantiates and
**wires the seven owning modules in the fixed order of §7**, (e) registers all components,
relations, and systems passed in `options`, (f) seeds `world.phase = 'serial'` (§4) and
`world.tick = 0` (§8), (g) builds the conflict DAG if a scheduler is present, and (h)
returns a **frozen** `World` facade. Any invalid configuration is a `ConfigError` thrown
synchronously at construction (§7, validation order).

### 2.2 `WorldOptions` (CANON — feature knobs nested under feature keys)

```ts
interface WorldOptions {
  // --- registration (validated at construction; fail-fast — report §2.8) ---
  components?: readonly ComponentDef<any>[];   // pre-registered; also auto-registered on first use
  relations?:  readonly RelationDef<any>[];
  systems?:    readonly SystemDef[];           // ordered; scheduler derives the DAG from declared access

  // --- entity identity (entity-model.md §2; report §2.3, §3 #3) ---
  maxEntities?:    number;   // CANON default 1 << 20 (1_048_576); sizes index width + every fixed region
  generationBits?: number;   // default 10; indexBits = 32 - generationBits; must sum to 32 (§6.1)

  // --- threading / backing (memory-buffers.md §4; report §6.3) ---
  threaded?: boolean;                          // default false — ship a correct single-threaded executor first (§3 #5)

  // --- archetype fragmentation cap (archetype-storage.md FRAG-1; report §6.4) ---
  maxHotArchetypes?: number;                   // default sized from maxEntities; overflow → cold store

  // --- reactivity knobs (reactivity.md ReactivityOptions) — NESTED, never flat ---
  reactivity?: {
    maxWritesPerFrame?:       number;          // default maxEntities * 4; ring size, spills (never throws) past it
    maxShapeChangesPerFrame?: number;          // default maxEntities * 2
    observerCadence?:         ObserverCadence;  // 'frame-end' | 'per-system'; default 'frame-end' (§9.5)
    changeTrackingDefault?:   'component' | 'field';   // default 'component' (report T3, Q-CD1)
    logEntryWords?:           1 | 2;            // default 2 if any relation registered, else 1 (§9.6)
    shrinkRings?:             boolean;          // default false (reactivity.md §8.3)
  };

  // --- scheduler knobs (scheduler.md SchedulerOptions) — NESTED, never flat ---
  scheduler?: {
    workers?: number | 'postMessage-fallback'; // worker pool size; or force the no-SAB transport (report §6.3)
    // additional scheduler tuning (graph algorithm threshold, etc.) lives here — scheduler.md §SchedulerOptions
  };
}
```

> **CANON nesting rule.** Every feature knob lives **under its feature key**. The reactivity
> knobs (`maxWritesPerFrame`, `maxShapeChangesPerFrame`, `observerCadence`,
> `changeTrackingDefault`, `logEntryWords`, `shrinkRings`) live under `reactivity:{}`; the
> worker/scheduler knobs live under `scheduler:{}`. There are **no flat top-level
> reactivity or scheduler keys.** Only identity/backing/fragmentation knobs
> (`maxEntities`, `generationBits`, `threaded`, `maxHotArchetypes`) and the registration
> arrays sit at the top level. This reconciles the punch-list "createWorld reactivity
> options" nesting mismatch — reactivity.md's flat keys are **re-homed under
> `reactivity:{}`** and world.md is canonical.

Every option has a workload-safe default; a zero-argument `createWorld()` produces a correct
single-threaded world at default capacity. `threaded` defaults to `false` because the report
mandates shipping a correct single-threaded executor first (§3 #5); flipping `threaded: true`
changes no user code — the same systems, queries, and accessors run under the wave scheduler.

### 2.3 Resolved defaults

```ts
const DEFAULTS = {
  maxEntities:      1 << 20,          // 1_048_576 (CANON)
  generationBits:   10,               // indexBits = 22
  threaded:         false,
  maxHotArchetypes: /* sized from maxEntities, archetype-storage.md FRAG-1 */,
  reactivity: {
    maxWritesPerFrame:       maxEntities * 4,
    maxShapeChangesPerFrame: maxEntities * 2,
    observerCadence:         'frame-end',
    changeTrackingDefault:   'component',
    logEntryWords:           /* 2 if relations.length > 0 else 1 — §9.6 */,
    shrinkRings:             false,
  },
  scheduler: { workers: /* derived from threaded + capability probe */ },
} as const;
```

### 2.4 Capability probe & threading downgrade (never silent)

At construction, after option resolution, `createWorld` calls
`probeCapabilities(resolved.scheduler.workers)` (memory-buffers.md §4) to detect SAB
availability and cross-origin isolation. The resolution rule (report §6.3, §3 #9):

- `threaded: false` → single-thread mode; `world.phase` is permanently `'serial'` (§4).
- `threaded: true` **and** `crossOriginIsolated === true` and SAB present → SAB worker mode;
  archetype column SABs are shared zero-copy; scheduler dispatches waves.
- `threaded: true` **and not** cross-origin-isolated (or no SAB), **and**
  `scheduler.workers === 'postMessage-fallback'` → postMessage transfer mode (plain
  `ArrayBuffer`s transferred per wave).
- `threaded: true` **and not** cross-origin-isolated and `workers` is numeric → **emit a
  clear startup diagnostic and downgrade to single-thread.** **Never silent** (report §6.3
  removes the "silently fails when headers are missing" hazard).

The chosen mode is frozen into the returned `World` and never changes for that world's life.

---

## 3. The `World` object surface

```ts
interface World {
  // ----- entity lifecycle (delegates to entity-model.md + archetype-storage.md) -----
  spawn(): EntityHandle;                                   // empty archetype
  spawnWith(...inits: ComponentInit[]): EntityHandle;      // single migration EMPTY → target signature
  despawn(handle: EntityHandle): void;                     // idempotent; cascades relations (relations.md P4/P5)
  isAlive(handle: EntityHandle): boolean;                  // main-thread; NEVER reads the bitmask (Must-Fix #1)
  entity(handle: EntityHandle): EntityRef;                 // pooled-per-world ref; do NOT store across systems

  // ----- queries (type-system.md DSL; archetype-storage.md per-archetype matching) -----
  query<T extends readonly QueryTerm[]>(...terms: T): Query<T>;

  // ----- scheduler delegation (scheduler.md — OPTIONAL layer; see §3.4) -----
  addSystem(def: SystemDef): void;                         // register a system after construction (re-plans on next update)
  update(dt?: number): void;                               // run one wave-scheduled tick of all systems

  // ----- tick (OWNED by world; see §8) -----
  readonly tick: Tick;                                     // number getter: current frame tick
  currentTick(): Tick;                                     // === world.tick (method form for callers that hold the verb)

  // ----- phase (OWNED by world; written only by scheduler; see §4) -----
  readonly phase: WorldPhase;                              // 'serial' | 'wave'

  // ----- relations (relations.md) -----
  addPair<R>(subject: EntityHandle, relation: RelationDef<R>, target: EntityHandle, payload?: R): void;
  removePair(subject: EntityHandle, relation: RelationDef<any>, target: EntityHandle): void;
  hasPair(subject: EntityHandle, relation: RelationDef<any>, target?: EntityHandle): boolean;
  getPair<R>(subject: EntityHandle, relation: RelationDef<R>, target: EntityHandle): PairAccessor<R>;
  subjectsOf(relation: RelationDef<any>, target: EntityHandle): Iterable<EntityHandle>;

  // ----- reactivity (reactivity.md) -----
  observe(term: ObserverTerm, handler: (e: EntityRef, ctx: ObserverContext) => void): ObserverHandle;
  changedSince(handle: EntityHandle, since: Tick): boolean;
  changedRows(archetypeId: ArchetypeId, since: Tick): Iterable<number>;   // for the delta serializer
  trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void;   // §9.1 — CANON signature

  // ----- serialization entry points (serialization.md) -----
  createSnapshot(): ArrayBuffer;                           // copy, detached (persistence / network)
  loadSnapshot(buf: ArrayBuffer): void;                    // entity-ID remap on deserialize
  createDeltaSerializer(sinceTick: Tick): DeltaSerializer; // copy, changeVersion-driven (no shadow map)
  exportSharedHandles(): SharedHandleManifest;             // zero-copy, intra-process (memory-buffers.md)

  // ----- introspection / tuning -----
  warm(sig: readonly ComponentDef<any>[]): void;           // explicit cold→hot promotion (archetype-storage FRAG-1)
  readonly handleLayout: HandleLayout;                     // frozen; entity-model.md §2.2
  handleStats(): HandleStats;
}
```

### 3.1 Entity spawn/despawn delegation

`spawn` / `spawnWith` / `despawn` / `isAlive` / `entity` are **thin facades** that delegate
to entity-model.md (handle alloc/free, the two-word record commit) and archetype-storage.md
(migration). `spawnWith` computes the target signature once and performs a **single
migration** EMPTY → target (entity-model spawnWith; archetype `migrateAddingMany`). All five
are **main-thread / serial-phase** verbs (the single-writer invariant, §4; entity-model I10;
Must-Fix #1). Inside a worker-dispatched system the same-named verbs on the worker-side proxy
stage to the command buffer and apply between waves — the **public signature is identical**
in both modes.

### 3.2 `query()`

`query(...terms)` delegates to type-system.md (term typing, arity cap) and archetype-storage.md
(per-archetype matching). Iteration is **per-archetype** (O(A) matching), never per-entity
bitmask scanning (report §2.4 correction). The same `query()` is handed to systems through the
`SystemContext`, scoped for the wave (scheduler.md §6).

### 3.3 Relations

`addPair` / `removePair` / `getPair` / `hasPair` / `subjectsOf` delegate to relations.md. World
**requires** storage to expose `migrateAddingMany(handle, componentIds[])` /
`migrateRemovingMany(handle, componentIds[])` — single combined migrations computing one target
signature — because relations atomicity (relations.md P1) needs to add a pair id and its
relation-presence id (or remove both) in **one** migration, not two. This requirement is pinned
in §9.7. Exclusivity selects the payload-storage kind (exclusive → subject `eid` column,
re-target is a field write, no migration; non-exclusive payload → pair-keyed overflow table);
the split is invisible at this surface (Must-Fix #4).

### 3.4 Scheduler delegation (`addSystem` / `update`) — the opt-in layer

The scheduler is an **opt-in layer** (report §5.1: the kernel must run single-threaded
*without* `@ecsia/scheduler`). World therefore delegates as follows:

- **`addSystem(def)`** registers a system; the conflict DAG is (re-)derived from declared
  `{ read, write }` access on the next `update`. Systems passed in `options.systems` are
  registered at construction (§7 step 6).
- **`update(dt?)`** runs one tick. Its fixed internal order (public-api.md §6; scheduler.md
  §6.3; reactivity.md lifecycle) is:
  1. `reactivity.frameReset()` — **advance `world.tick`** (§8) and reset per-frame transient
     query lists.
  2. For each wave in topological order: dispatch the wave's batches (serially in v1
     single-thread mode; to the worker pool under `threaded: true`). Workers read archetype
     columns directly and stage structural intent to per-worker command buffers (report §6.1).
  3. Between waves (serial slot): merge corrals + apply command buffers in **fixed
     worker-index order** with **validate-then-apply, drop-if-dead** (report §6.1), then run
     incremental query maintenance.
  4. `observerDrain()` at the serial slot (`observerCadence`).
  5. `flushLogs()` — advance ring heads, drain the spill list (overflow is recoverable, never
     a throw).

- **Kernel-only mode (no scheduler package).** If `@ecsia/scheduler` is absent, `addSystem`
  and `update` are **not present** on the `World` facade (the umbrella does not pull the
  scheduler into a single-threaded bundle — public-api.md Q-PA6). The kernel exposes `spawn`,
  `query`, accessors, relations, reactivity, and serialization, and the user drives the frame
  loop manually (calling `reactivity.frameReset()` / `flushLogs()` directly or via a thin
  helper). In this mode **`world.phase` stays `'serial'` permanently** (§4) so direct-apply
  works for every structural op. The world still **owns and advances `world.tick`** (§8).

### 3.5 Tick & serialization

`world.tick` / `currentTick()` are covered in §8; the serialization entry points are
delegated verbatim to serialization.md (the two disjoint paths: copy-based
snapshot/delta vs zero-copy `exportSharedHandles`). The world guarantees serialization reads
quiescent state by only permitting `createSnapshot` / `delta()` at a serial slot
(`world.phase === 'serial'`; serialization.md asserts this).

---

## 4. The `world.phase` state machine

```ts
type WorldPhase = 'serial' | 'wave';
```

### 4.1 Ownership and initial value (CANON)

- **`world.phase` is OWNED by the world and is initialized to `'serial'` by the world** at
  `createWorld`, **before any system runs and whether or not a scheduler is present** (resolves
  the punch-list "who initializes `world.phase` when the scheduler is absent" gap — scheduler.md
  §8 ownership note). Every storage/entity/bitmask/serialization primitive that asserts on the
  phase therefore has a defined value from construction.
- **The scheduler is the only component that flips `world.phase` to `'wave'`** — and only
  during parallel waves in threaded mode (scheduler.md §2.1 "sole writer"). The world *seeds*
  the value; the scheduler *transitions* it. No other module ever writes it.

### 4.2 The state machine

```
                 scheduler.runWave (threaded)        scheduler flush slot
  ┌──────────┐  ───────────────────────────────▶  ┌──────────┐
  │ 'serial' │                                      │  'wave'  │
  │ (default)│  ◀───────────────────────────────   │          │
  └──────────┘        wave fence / flush            └──────────┘
       │
       └── stays 'serial' FOREVER in single-thread mode and kernel-only mode
```

- **`'serial'`** — the default and the only phase in which structural mutation is legal.
  Spawn/despawn/add/remove/addPair, bitmask reads/writes, the entity-record commit, and
  serialization all assert `world.phase === 'serial'`. The world enters and exits every
  `update` in `'serial'`, and every flush slot (command-buffer apply, observer drain, log
  flush) runs in `'serial'`.
- **`'wave'`** — set by the scheduler **only** in threaded mode, **only** for the interval
  between a round's dispatch and its fence, during which workers execute systems. Structural
  mutation is illegal in `'wave'`; workers stage intent to command buffers.

### 4.3 Single-thread and kernel-only behavior (CANON)

- **Single-thread mode** (`threaded: false`): the scheduler runs waves serially on the main
  thread and **does not flip the phase** — it stays `'serial'` for the entire `update`
  (scheduler.md PHASE-1). Every structural op a system performs takes the synchronous
  **direct-apply fast path**.
- **Kernel-only mode** (no scheduler package): nothing ever sets `'wave'`; the world's seeded
  `'serial'` is permanent. Direct-apply works for all structural ops.

### 4.4 The direct-apply guard (CANON)

command-buffer.md routes a structural op to the **direct-apply fast path** iff:

```
world.phase === 'serial' && isMainThread()
```

…else it defers to the per-worker command buffer (command-buffer.md §2.2). This guard is
correct as written precisely because (a) the world seeds `'serial'`, (b) single-thread and
kernel-only modes keep it `'serial'` forever, and (c) the scheduler only sets `'wave'` while
workers (`!isMainThread()`) execute and the main coordinator runs no user system. Therefore
no main-thread direct-apply ever happens mid-`'wave'`.

---

## 5. Reserved `ComponentId` set & `FIRST_USER_COMPONENT_ID`

### 5.1 The reserved prefix (CANON)

The low `ComponentId`s are a fixed reserved prefix for synthetic internals so they never
collide with user components and have stable positions (component-schema.md §7.1):

```ts
const NO_COMPONENT          = 0 as ComponentId;   // "no component" sentinel — NEVER a user component
const CHANGEVERSION_COMPONENT_ID = 1 as ComponentId; // reactivity's hidden changeVersion column id
const FIRST_USER_COMPONENT_ID    = /* first id after the reserved prefix; see §5.3 */;
```

- **`ComponentId 0 = NO_COMPONENT` is the canonical "no component" sentinel** and is **never**
  a user component (resolves punch-list C3 — deletes the contradictory "component id 0 is a
  normal user component" sentence). It is simultaneously:
  - the **CREATE/DESTROY shape-log "no component" marker**: reactivity packs `componentId = 0`
    into shape-log word A for `CREATE`/`DESTROY` entries, where the `kind` field disambiguates
    them; a `componentId = 0` in a shape-log word always means "entity-lifecycle event, no
    component" (reactivity.md §4.1/§4.2);
  - the **`changeVersion` sentinel**: an unstamped row reads `changeVersion = 0`, so a query
    `changeVersion[row] > sinceTick` never spuriously matches a never-written row at tick 0.
- **`CHANGEVERSION_COMPONENT_ID`** is the reserved synthetic id reactivity uses to register its
  per-archetype `changeVersion` column via `buildColumnSet` as a **hidden, non-query-matching**
  column (archetype-storage.md §5.3.1). It never appears in a signature and is never a user
  component.

> **`EMPTY_ARCHETYPE_ID = 0` is a different space.** `ArchetypeId 0` (the empty archetype) is in
> the *ArchetypeId* namespace, unrelated to `NO_COMPONENT` in the *ComponentId* namespace
> (archetype-storage.md §3.1). They do not interact.

### 5.2 `FIRST_USER_COMPONENT_ID = 1` (CANON)

Per CANON, **`FIRST_USER_COMPONENT_ID = 1`**: `ComponentId 0` is the `NO_COMPONENT` sentinel
and the first user component is minted at id 1. The `changeVersion` column does **not** consume
a *user* id — it is a hidden synthetic component whose id is reserved internally and excluded
from the user space, so user ids begin densely at 1. The registry mints user components from
`FIRST_USER_COMPONENT_ID` upward in `createWorld({components})` declaration order
(component-schema.md §7.2), giving reproducible ids across runs (required for the canonical
query hash and snapshot compatibility).

### 5.3 The canonical "fixed component-id count" (resolves C4)

```ts
// after createWorld registration completes:
registry.registeredComponentCount === registry.nextComponentId
```

`registry.nextComponentId` **after `createWorld` registration** is the **single canonical
"fixed component-id count."** It already includes:

- the reserved prefix (`NO_COMPONENT` + `CHANGEVERSION_COMPONENT_ID`),
- all **user components**,
- **one relation-presence id per registered relation** (relations.md §2.2),
- any **overflow / synthetic column ids** allocated at construction.

**Every bit-vector and signature stride is `ceil(nextComponentId / 32)`.** All three of
component-schema.md §7.4, archetype-storage.md §3.3, and **scheduler.md §3.3 derive the stride
from this one value** — scheduler.md **drops its separate `+ numRelations` term** (resolves
punch-list C4; scheduler.md §3.3 already cites `registeredComponentCount`). Runtime pair-id
mints (`mintPair`, relations.md §2.2) push `nextComponentId` *past* this fixed count; they are
handled by the log-entry-width rule (§9.6) and the lazily-grown sparse pair-bit region
(archetype-storage.md), **not** by re-sizing the fixed stride.

---

## 6. `maxEntities` and the bounded flat structures

### 6.1 Default and identity interlock (CANON)

```ts
maxEntities    default = 1 << 20  (1_048_576)   // CANON
generationBits default = 10  →  indexBits = 32 - generationBits = 22
```

> **Reconciliation note (world.md is canonical).** Earlier drafts of public-api.md and
> entity-model.md cited `maxEntities` default `2**22 (4,194,304)`. **CANON pins the default at
> `1 << 20 (1,048,576)`**; world.md is authoritative. `generationBits` default stays 10
> (`indexBits = 22`), so the *index field* can still address up to `2**22 - 1` slots — the
> default `maxEntities = 1 << 20` simply sizes the allocated regions below that ceiling, and
> users may raise `maxEntities` up to `2**indexBits` (validated in §7).

Validation (entity-model.md §2.2): `indexBits + generationBits === 32`; `generationBits === 0`
(generation-less) is permitted **only** when `threaded === false`; `maxEntities <= 2**indexBits`.

### 6.2 Sizing the bounded flat structures (CANON)

The bounded **flat per-entity structures** are pre-allocated once at `createWorld`, sized by
`maxEntities`, as resizable SABs (threaded) or `ArrayBuffer`s (single-thread) — report §4 T4
("pre-allocate the flat per-entity structures sized by `maxEntities`"; memory-buffers.md §6):

| Region | Element | Length | Sized by |
|---|---|---|---|
| `entity.archetypeId` | `u32` | `maxEntities` | first record word |
| `entity.archetypeRow` | `u32` | `maxEntities` | second record word — structural commit point |
| `entity.generation` | `u32` | `maxEntities` | generation per index slot |
| `idpool.dense` | `u32` | `maxEntities` | bitECS free-list dense |
| `idpool.sparse` | `u32` | `maxEntities` | bitECS free-list sparse |
| `bitmask.words` | `u32` | `maxEntities * bmStride` | membership index; `bmStride = ceil(nextComponentId/32)` (§5.3); **main-thread-only** (Must-Fix #1) |

These are the **fixed** regions: they never grow during the world's life (the entity-record
and id-pool regions are sized at the `maxEntities` ceiling; the bitmask's fixed component
region is sized by §5.3 and only its lazily-grown sparse pair-bit region extends).

### 6.3 Reactivity rings and the id-pool reservation block

- The reactivity rings are sized from `maxEntities`: `maxWritesPerFrame` default
  `maxEntities * 4`, `maxShapeChangesPerFrame` default `maxEntities * 2` (§2.3). They are
  recoverable (spill, never throw — reactivity.md R-5).
- The bounded id-pool (`idpool.dense`/`sparse`, sized `maxEntities`) is the source the
  **command-buffer entity-ID reservation handshake** draws from: before each wave the main
  thread hands each worker a pre-reserved block via `Atomics.sub` (report §6.1). This is why
  the id-pool must be a bounded, pre-allocated SAB region.

---

## 7. Module wiring & initialization order (CANON)

`createWorld` instantiates and wires the seven owning modules in this **fixed order**. The
order is load-bearing: each step depends on the constants/regions established by the prior
steps. Validation is interleaved fail-fast — the first violation throws `ConfigError` and no
partially-constructed world escapes.

```
createWorld(options):
  # --- step 0: resolve + validate options (fail-fast) ---
  resolved := resolveDefaults(options)                       # §2.3
  assert resolved.generationBits >= 1 || !resolved.threaded  # generation-less only when single-thread (§6.1)
  indexBits := 32 - resolved.generationBits
  assert indexBits + resolved.generationBits === 32
  assert resolved.maxEntities <= (1 << indexBits)            # capacity fits the index field (§6.1)
  layout := makeHandleLayout(resolved.generationBits)        # entity-model.md §2.2 — frozen

  # --- step 1: REGISTRY (component-schema.md §7) ---
  registry := newRegistry()
  reserveLowIds(registry)                                    # NO_COMPONENT=0, CHANGEVERSION_COMPONENT_ID; FIRST_USER_COMPONENT_ID=1 (§5)
  registerComponents(registry, resolved.components ?? [])    # mint user ids densely from FIRST_USER_COMPONENT_ID (§5.2)
  registerRelations(registry, resolved.relations ?? [])      # mint one presence id per relation (§5.3)
  registry.registeredComponentCount := registry.nextComponentId   # the canonical fixed count (§5.3)
  bmStride := ceil(registry.nextComponentId / 32)            # the ONE stride all bit-vectors use (C4)
  logEntryWords := resolveLogEntryWords(resolved, registry)  # §9.6: 2 if any relation registered (else 1), unless overridden

  # --- step 2: BUFFERS + capability probe (memory-buffers.md §4/§6) ---
  caps := probeCapabilities(resolved.scheduler.workers)      # SAB? cross-origin-isolated? → §2.4 downgrade
  mode := resolveThreadingMode(resolved.threaded, caps)      # may emit startup diagnostic, NEVER silent (§2.4)
  buffers := createBuffers(mode.backing)                     # SAB vs ArrayBuffer chosen ONCE here
  allocFixedRegions(buffers, resolved.maxEntities, bmStride) # entity records, id-pool, bitmask words (§6.2)

  # --- step 3: STORAGE (archetype-storage.md) ---
  storage := createStorage(registry, buffers, layout, resolved.maxHotArchetypes)
  # storage exposes migrate / migrateAddingMany / migrateRemovingMany / buildColumnSet / ensureRowCapacity (§9.7)
  storage.createEmptyArchetype()                             # EMPTY_ARCHETYPE_ID = 0

  # --- step 4: REACTIVITY (reactivity.md) — attaches its hidden changeVersion column ---
  reactivity := createReactivity(registry, buffers, storage, resolved.reactivity, logEntryWords)
  storage.onArchetypeCreated(reactivity.registerChangeVersionColumn)  # §9.8 — hidden, non-query-matching column
  world.tick := 0                                            # WORLD owns the tick; reactivity advances it (§8)

  # --- step 5: QUERIES (queries.md) ---
  queries := createQueryEngine(registry, storage, reactivity, bmStride)

  # --- step 6: SCHEDULER (scheduler.md) — OPTIONAL ---
  world.phase := 'serial'                                    # WORLD seeds it, BEFORE the scheduler exists (§4.1)
  if @ecsia/scheduler present:
     scheduler := createScheduler(registry, storage, queries, reactivity, resolved.scheduler, mode)
     for sys in (resolved.systems ?? []): scheduler.addSystem(sys)
     scheduler.buildConflictDAG()                            # fail-fast on cycles (named-chain report)
  else:
     assert (resolved.systems ?? []).length === 0            # systems require the scheduler layer (ConfigError otherwise)

  # --- step 7: SERIALIZATION (serialization.md) — entry points only ---
  serialization := createSerialization(registry, storage, reactivity, buffers)

  # --- assemble + freeze ---
  return freeze(assembleWorldFacade(...))                    # §3 surface; frozen
```

**Why this order (CANON, load-bearing):**

1. **registry first** — it mints the reserved ids and `nextComponentId`, which fixes `bmStride`
   and `logEntryWords`. Every later module needs the stride/count.
2. **buffers** — backing (SAB vs AB) is chosen once after the capability probe; the fixed
   regions are sized by `maxEntities` and `bmStride`. Nothing can allocate before backing is
   chosen.
3. **storage** — needs the registry (signatures) and buffers (columns). Creates the empty
   archetype.
4. **reactivity** — needs storage to attach its hidden `changeVersion` column via the
   archetype-creation hook (§9.8). The world sets `world.tick = 0` here and hands reactivity the
   advance hook (§8).
5. **queries** — need the registry (stride), storage (matching), reactivity (the `Changed`
   filter / version stamps).
6. **scheduler (optional)** — the world seeds `world.phase = 'serial'` **before** the scheduler
   exists, then (if present) the scheduler registers systems and builds the DAG. Kernel-only
   mode skips this; the seeded `'serial'` is permanent (§4.3).
7. **serialization** — entry points only; needs registry/storage/reactivity/buffers, all built.

---

## 8. The `Tick` ownership contract (CANON)

```ts
type Tick = number;   // monotonically increasing u32 frame counter (branded in type-system.md)
```

- **The world OWNS `world.tick`.** It is initialized to `0` at `createWorld` (§7 step 4) and is
  exposed as a `number` getter `world.tick` (current frame tick) and equivalently as the method
  `world.currentTick()` (same value — the method form exists for callers that hold the verb,
  e.g. a `SystemContext.tick` snapshot).
- **Reactivity advances the tick at frame reset** by calling into the world: `frameReset()`
  (reactivity.md §3.7, called by `scheduler.update` step 1 or by the user in kernel-only mode)
  invokes `world.advanceTick()`, which increments `world.tick`. Reactivity does **not** own the
  counter — it triggers the advance; the world holds the value.
- **All readers use `world.tick`** (or the snapshot passed in `SystemContext.tick`):
  accessors/setters stamp `changeVersion[row] = world.tick`; queries compare against
  `world.tick`; the delta serializer reads `world.changedRows(arch, sinceTick)` against
  `world.tick`; observers stamp `ctx.tick = world.tick`. There is **one** counter; no module
  keeps a private frame counter (resolves the punch-list "Tick ownership never pinned" gap).
- **Wrap handling.** On the rare `world.tick` u32 wrap (`0xFFFFFFFF` → `0`), the world resets all
  `changeVersion` columns to `0` and the tick to `0` at the serial flush before reuse
  (reactivity.md §wrap), so the `changeVersion[row] > sinceTick` predicate never gives a false
  positive across a wrap.

---

## 9. Canonical-constant registry (the values every other spec MUST match)

This section is the authoritative home for the cross-cutting constants and signatures the
coherence pass found drifting. Each lower spec **cites this section** and states it shares the
value.

### 9.1 `trackWrite` signature (resolves C1, completes Must-Fix #2 runtime)

```ts
world.trackWrite(index: EntityIndex, componentId: ComponentId, fieldIndex?: number): void;
```

- The **first argument is the LOW handle bits (the entity index), NOT the full handle.**
- Accessor / type-system / component-schema setters **MUST** pass `handleIndex(this.__eid)`
  (entity-model.md `handleIndex`), **never** the raw handle, so the generation bits are stripped
  before packing into the write-log word (reactivity.md §3.1 packs `(componentId << indexBits) |
  (index & indexMask)`). Passing the raw handle would corrupt the log index.
- Field-granular setters (`vec` axes, opt-in field-granularity) **MUST forward `fieldIndex`**
  so reactivity can stamp `changeVersion[row*fieldCount + fieldIndex]` (reactivity.md §6.2) and
  the field-granular delta serializer (serialization.md §6.3) has a live caller. Component-granular
  setters omit `fieldIndex`. This is the canonical signature in reactivity.md §3.3 (owner),
  accessors.md §4.1/§4.4, type-system.md I-ACC-4, component-schema.md §8.2.

### 9.2 Handle/index width interlock

`ENTITY_INDEX_BITS + COMPONENT_ID_BITS === 32` where `ENTITY_INDEX_BITS = handleLayout.indexBits`
(default 22) and `COMPONENT_ID_BITS = 32 - indexBits` (default 10). The write/shape log packs a
`componentId` into `COMPONENT_ID_BITS` in the one-word layout (reactivity.md §3.1) — see §9.6 for
how the two-word layout removes the 1023-id ceiling.

### 9.3 Bit-vector / signature stride (resolves C4)

`stride = ceil(registry.nextComponentId / 32)`, computed once after `createWorld` registration
(§5.3). **All** bit-vectors and archetype signatures use this one stride. scheduler.md drops its
`+ numRelations` term.

### 9.4 Structural-op ordinals (SHARED — numeric values MUST be identical)

These ordinals are **shared across command-buffer `Op`, serialization `DeltaOp`, and reactivity
`ShapeKind`** (names may differ per spec; the **numeric values MUST be identical**):

```ts
CREATE      = 0
DESTROY     = 1
ADD         = 2
REMOVE      = 3
ADD_PAIR    = 4
REMOVE_PAIR = 5
SET_PAYLOAD = 6
```

Each of command-buffer.md, serialization.md, and reactivity.md states it shares this numbering
(resolves the punch-list "Op enum ordinal drift" item; enables the shared apply path).

### 9.5 `observerCadence` literal set (CANON)

```ts
type ObserverCadence = 'frame-end' | 'per-system';   // default 'frame-end'
```

These are the **only** two public literals. The scheduler maps `'per-system'` to its per-wave
serial-slot dispatch **internally**; **no `'per-wave'` or `'end-of-frame'` literal survives in
the public API** (resolves the punch-list observerCadence vocab mismatch; reactivity.md and
scheduler.md re-home to this set).

### 9.6 Write/shape-log entry width (resolves C2)

```ts
logEntryWords = (anyRelationRegistered ? 2 : 1)   // unless explicitly overridden in reactivity:{ logEntryWords }
```

- **If ANY relation type is registered**, the log uses **two-word entries** with a full 32-bit
  `componentId` field. This is selected at `createWorld` (§7 step 1) based on whether
  `defineRelation` was used.
- The **one-word fast path** (10-bit `componentId`, ≤1023 ids) is used **ONLY in relation-free
  worlds**, where `nextComponentId` is bounded by the user-component count and pair ids are never
  minted.
- This removes the runtime overflow against unbounded synthetic pair ids: a relation-bearing
  world's log can address any `nextComponentId` value the lazily-minted pair ids reach. The
  creation-time fail-fast guard (reactivity.md) is replaced by this selection. A user who forces
  `logEntryWords: 1` in a relation-bearing world does so at their own risk (dev-mode asserts
  `nextComponentId < 2**COMPONENT_ID_BITS` on every `mintPair`).

### 9.7 Combined-migration storage primitives (required — relations atomicity P1)

Storage **MUST** provide:

```ts
storage.migrateAddingMany(handle: EntityHandle, componentIds: readonly ComponentId[]): Row;
storage.migrateRemovingMany(handle: EntityHandle, componentIds: readonly ComponentId[]): Row;
```

Each computes **one** target signature and performs a **single** migration adding/removing all
the listed ids together (archetype-storage.md §5.6a). Relations rely on this to add a pair id and
its relation-presence id (or remove both) atomically in one archetype move (relations.md P1). The
single-id `migrateAdding`/`migrateRemoving` are specializations. All run serial-phase only.

### 9.8 `changeVersion` column growth (CANON — pin this path, not an either/or)

`archetype-storage.ensureRowCapacity` grows **ALL** columns registered for the archetype,
**INCLUDING** reactivity's `changeVersion` column. Reactivity registers `changeVersion` via
`buildColumnSet` (keyed on `CHANGEVERSION_COMPONENT_ID`, §5.1) as a **hidden,
non-query-matching** column on each hot archetype at creation (the §7 step 4 hook). Because it is
registered under the archetype's keys, `ensureRowCapacity` grows it in lockstep with the data
columns — there is **no** "reactivity attaches it" vs "reactivity grows it separately" either/or.
A row written past its `changeVersion` capacity is a bug; this path prevents it (resolves the
punch-list `changeVersion` growth seam; archetype-storage.md §5.3.1).

### 9.9 G-7 worker column handshake (CANON — state normatively in scheduler + serialization)

When columns are lazily created (a new archetype minted during a flush), serialization emits a
`ColumnsAdded` postMessage notice (serialization.md §3.4). **The notice is drained AND applied by
each worker during the inter-wave barrier BEFORE the next wave dispatches.**
`scheduler.prepareWave` **guarantees notice-applied-before-dispatch** (no worker touches a new
column before it has re-wrapped it). This is stated normatively in **scheduler.md §prepareWave**
and **serialization.md §applyColumnsAdded** (resolves punch-list G-7).

---

## 10. Cross-module invariants this module guarantees

- **W-1 (phase seed):** `world.phase === 'serial'` at construction, before any system runs,
  whether or not a scheduler is present. Only the scheduler flips it to `'wave'`. §4.
- **W-2 (single-writer):** every public verb that mutates structure executes on the main thread
  at a serial flush point (`world.phase === 'serial' && isMainThread()`); worker-side calls stage
  to command buffers and apply in fixed worker-index order with drop-if-dead. §3.1, §4.4;
  Must-Fix #1/#3.
- **W-3 (one tick):** there is exactly one frame counter, `world.tick`, owned by the world,
  advanced by reactivity at frame reset, read by everyone. §8.
- **W-4 (reserved ids):** `ComponentId 0 = NO_COMPONENT` is never a user component;
  `FIRST_USER_COMPONENT_ID = 1`; `changeVersion` is a hidden synthetic column id. §5.
- **W-5 (one stride):** every bit-vector/signature stride is `ceil(nextComponentId / 32)` from
  the post-registration count; scheduler has no separate `+ numRelations` term. §5.3, §9.3.
- **W-6 (log width):** two-word log entries iff any relation is registered; one-word only in
  relation-free worlds. §9.6.
- **W-7 (shared ordinals):** CREATE/DESTROY/ADD/REMOVE/ADD_PAIR/REMOVE_PAIR/SET_PAYLOAD =
  0..6 across command-buffer / serialization / reactivity. §9.4.
- **W-8 (trackWrite index):** `trackWrite`'s first arg is `handleIndex(__eid)` (low bits), and
  field-granular setters forward `fieldIndex`. §9.1; Must-Fix #2 runtime.
- **W-9 (changeVersion growth):** `ensureRowCapacity` grows the `changeVersion` column with the
  data columns; never an either/or. §9.8.
- **W-10 (column handshake):** `ColumnsAdded` notices are applied before the next wave
  dispatches; `prepareWave` guarantees it. §9.9; G-7.
- **W-11 (never silent downgrade):** a `threaded: true` request in a non-isolated context emits a
  startup diagnostic and downgrades deterministically; never a silent failure. §2.4.
- **W-12 (frozen facade):** the returned `World` is frozen; construction is fail-fast; no
  partially-constructed world escapes. §2.1, §7.

---

## 11. Reconciliation log (what world.md changes in other specs)

This keystone resolves the punch-list items by pinning the canonical value here and requiring the
named specs to cite it. The required edits (to be applied per the punch-list resume plan):

- **C1 — `trackWrite` signature:** canonical in §9.1. accessors.md / type-system.md /
  component-schema.md pass `handleIndex(this.__eid)` and forward `fieldIndex`.
- **C2 — log entry width:** §9.6. reactivity.md selects `logEntryWords = 2` whenever any relation
  is registered (else 1); the creation-time fail-fast guard is replaced.
- **C3 — reserved id 0:** §5. component-schema.md §7.1 deletes the "component id 0 is a normal
  user component" sentence; `FIRST_USER_COMPONENT_ID = 1`.
- **C4 — stride:** §5.3, §9.3. scheduler.md §3.3 drops `+ numRelations`; all three derive stride
  from `registry.nextComponentId`.
- **`maxEntities` default:** §6.1 pins `1 << 20`. public-api.md §2.2 and entity-model.md update
  their `2**22` mention to cite world.md (`maxEntities` default `1 << 20`; index field still 22
  bits).
- **createWorld nesting:** §2.2. reactivity.md's flat keys re-home under `reactivity:{}`; worker
  count moves under `scheduler:{}`.
- **observerCadence:** §9.5. reactivity.md / scheduler.md adopt `'frame-end' | 'per-system'`.
- **Op ordinals:** §9.4. command-buffer.md / serialization.md / reactivity.md state they share
  0..6.
- **Phase ownership:** §4. scheduler.md §8 ownership note cites world.md as the seeder; storage
  asserts the seeded value.
- **Tick ownership:** §8. reactivity.md advances `world.tick`; scheduler / accessors / queries /
  serialization read it.
- **changeVersion growth:** §9.8. archetype-storage.md §5.3.1 keeps only the
  `ensureRowCapacity`-grows-it path.
- **G-7 handshake:** §9.9. scheduler.md `prepareWave` + serialization.md `applyColumnsAdded`
  state the apply-before-dispatch guarantee normatively.
- **README.md:** regenerate the index to include world.md as the keystone (13 specs total).

---

## 12. Open questions (non-blocking; deferred to gated milestones)

- **Q-W1 (addSystem post-construction re-plan cost):** whether `addSystem` after `createWorld`
  forces a full DAG rebuild on the next `update` or supports incremental insertion. Settle at M6.
- **Q-W2 (maxHotArchetypes default formula):** the exact function of `maxEntities` for the
  cold-archetype cap (archetype-storage.md FRAG-1). Tune at M8.
- **Q-W3 (kernel-only frame-loop helper):** whether the kernel ships a thin
  `runFrame(world, dt)` helper (calling `frameReset`/maintenance/`flushLogs`) for users without
  the scheduler, or leaves the loop fully manual. Confirm at M5.
- **Q-W4 (generation-less validation surface):** whether `generationBits === 0` is a hard
  `ConfigError` under `threaded: true` (current) or a downgrade-with-diagnostic. Current: hard
  error (§6.1, §7 step 0).
- **Q-W5 (world disposal):** an explicit `world.dispose()` to release SABs / terminate workers
  vs GC-only. Leaning explicit for the worker pool. Settle at M7.
