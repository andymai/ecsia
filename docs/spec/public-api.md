# ecsia Implementation Spec — Module: Public API Surface

> Top-level module. This spec defines the **cohesive end-user API** of ecsia — the
> surface a consumer imports and calls: `createWorld`, `defineComponent` /
> `defineRelation` / `defineTag`, entity `spawn` / `despawn`, the
> `entity.write(Component)` vs read-shorthand split, `query(...)`, system definition
> with read/write access declarations, `world.update()` / scheduler run, observers, and
> serialization entry points.
>
> This module **owns no runtime mechanism**. It is the *assembly and re-export* layer:
> every type and function named here is implemented by one of the other twelve module
> specs — the keystone **world.md** (which owns the canonical `createWorld` option shape,
> defaults, reserved ids, phase/tick contracts) plus the eleven lower modules
> (entity-model, memory-buffers, type-system, component-schema, archetype-storage,
> relations, reactivity, scheduler, command-buffer, serialization, and the query DSL).
> This spec's job is to (a) fix the **exact public shape** a user sees, (b) prove that
> shape is **consistent with all module contracts (world.md is canonical for option
> shape/defaults) and the five must-fix decisions**, and (c) show a **complete, realistic,
> type-checkable usage example** that exercises components, relations, queries, a
> `Changed` filter, and two systems with a read/write conflict.
>
> Provenance is cited inline as `DESIGN-RESEARCH.md §x.y` (the report) and as the owning
> module spec (`entity-model.md`, `type-system.md`, etc.). Where a name is re-exported
> from a module, that module is the **normative** definition; this spec restates only the
> public-facing signature and its ergonomic contract.

---

## 0. Scope & Non-Goals

**In scope (this module owns these):**

- The single umbrella import surface (`@ecsia/ecsia`) and what it re-exports.
- `createWorld(options)` — the one constructor; its options object; the `World` facade.
- The end-user verbs on `World`: `spawn` / `spawnWith` / `despawn` / `isAlive` /
  `entity` / `query` / `update` / `observe` / serialization entry points.
- The **definition** functions a user calls at module scope: `defineComponent`,
  `defineTag`, `defineRelation`, `defineSystem`, plus the field-token constructors and
  query-term combinators re-exported for ergonomics.
- The **write-tracking contract** as the user experiences it: `entity.write(C)` is the
  only mutation path; `entity.read(C)` and the `entity.<comp>` shorthand are `Readonly`.
- The system-definition shape: a system **declares** `{ read, write }` access and
  receives a typed query + a `World` handle.
- The end-to-end worked example (§9) and its consistency proof against the module specs.

**Out of scope (owned by other modules; this spec only re-exports / assembles them):**

- Handle bit-layout, liveness, the two-word record, the ID-reservation handshake —
  **entity-model.md**. This spec re-exports `spawn` / `despawn` / `isAlive` /
  `EntityHandle` and never redefines their semantics.
- Field-token → column layout, SAB vs AB backing, length-tracking views, `.grow()` —
  **memory-buffers.md**. The user never sees a `Column`.
- `ComponentDef<S>`, `RelationDef<P>`, schema inference, `ReadView` / `WriteView`, query
  DSL types, arity cap, branded IDs — **type-system.md**. This spec re-exports the
  constructors and the inferred types.
- Archetype tables, edge graph, migration, bitmask, cold-archetype fallback —
  **archetype-storage.md**. `spawnWith` / `entity.add` / `entity.remove` are thin
  facades over `migrate` / `spawnWith`.
- Pair minting, exclusivity split, presence bit, back-ref index, cascade —
  **relations.md**. `addPair` / `getPair` / `subjectsOf` are re-exported.
- Change logs, version stamps, observers, the spill list — **reactivity.md**.
  `world.observe` / `world.changedSince` / the `Changed` query filter are re-exported.
- The conflict DAG, wave extraction, worker dispatch, command buffers, Atomics sync —
  **scheduler.md** + **command-buffer.md** (this module fixes only the *public*
  `defineSystem` / `world.update` shape the scheduler consumes).
- Snapshot/delta wire format, zero-copy SAB sharing — **serialization.md** (this module
  fixes only the *entry-point* names and their copy-vs-zero-copy contract).
- The `createWorld` option shape, defaults, reserved-`ComponentId` set, `world.phase` /
  `world.tick` contracts — **world.md** (the keystone; canonical where it and this spec
  restate the same option/default).

---

## 1. Locked Decisions This Module Surfaces

| Locked decision (report) | How the public API honors it |
|---|---|
| ESM-only, strict TS, batteries-included, all runtimes + workers via SAB with **postMessage fallback required** (§3 #9, §6.3) | Single ESM package `@ecsia/ecsia`; `createWorld` takes `{ threaded, scheduler: { workers } }`; capability probe runs at construction; non-cross-origin-isolated contexts transparently downgrade to single-thread or `'postMessage-fallback'` with a startup diagnostic, never a silent failure. §2, §7. |
| Public write API: `entity.position.x` is **READ-ONLY** shorthand; tracked mutation via `entity.write(Position).x = 5` (LOCKED, Must-Fix #2) | `EntityRef.write(C)` returns a mutable `WriteView<S>`; `EntityRef.read(C)` and the bare `entity.<comp>` getter return a deeply-`Readonly` view; assignment through the shorthand is a `TS2540` compile error. §4. |
| Scheduler: systems **declare** read/write access; conflict DAG + wave-level parallelism; **ship a correct single-threaded executor first**, parallel-ready (§2.5, §3 #5) | `defineSystem({ read, write, run })`; `world.update()` runs the wave schedule; v1 default executor is single-threaded and correct; worker dispatch is the same public API with `threaded: true`. §5, §6. |
| Type system: `defineComponent` with full TS inference, **no decorators, no codegen**; cap query arity + explicit-annotation escape hatch (§3 #6, §6.5) | Re-exports `defineComponent` (const type param), the field tokens, the query combinators; `query(...)` inference is capped at `MAX_QUERY_ARITY=8` with a `Has<C>`/`HasWrite<C>` annotation escape hatch. §3, §4.4. |
| Relations: first-class integer pairs; payload split by exclusivity; per-relation presence bit for O(1) wildcard; back-ref index for cascade (§2.6, Must-Fix #4) | Re-exports `defineRelation`, `Pair`, `Wildcard`, `addPair`/`removePair`/`getPair`/`hasPair`/`subjectsOf`; exclusivity is a `defineRelation` option; the user never sees the overflow table or presence bit. §3.3, §9. |
| Reactivity: ring-log + per-system pointers for the `Changed` **filter**; version stamps only for the public `.changed` predicate + delta serializer; observers **deferred** to a serial slot; recoverable overflow (§2.7, Must-Fix #2) | `Changed(C)` is a query term; `world.observe(...)` registers a deferred observer fired at the serial slot; `world.changedSince(handle, tick)` is the public predicate; overflow spills, never throws. §4.5, §4.6. |
| Generational handle: configurable split, default 22/10 (§3 #3) | `createWorld({ generationBits })`; default index 22 / generation 10; `EntityHandle` is opaque branded `u32`. §2.2. |
| Serialization: zero-copy SAB sharing separated from copy-based snapshot/delta; deltas driven by version stamps (§2.9, §3 #9) | `world.createSnapshot()` / `world.createDeltaSerializer(sinceTick)` (copy) are distinct from `world.exportSharedHandles()` (zero-copy, intra-process). §8. |

---

## 2. `createWorld` — the single entry point

### 2.1 Signature

```ts
import { createWorld } from '@ecsia/ecsia';

const world: World = createWorld(options?: WorldOptions);
```

`createWorld` is the **only** constructor in the public surface. It owns the capability
probe (`probeCapabilities`, memory-buffers.md), allocates the bounded global SABs
(idpool, entity-record, bitmask words; entity-model.md §EntityIndexLayout /
memory-buffers.md), wires the seven owning modules together, registers all components,
relations, and systems passed in `options`, builds the conflict DAG (scheduler), and
returns a frozen `World` facade. It **fails fast** at construction on any invalid
configuration (cyclic system dependency, generation-less mode requested while
`threaded: true`, arity/component-count interlock violation — reactivity.md
`ENTITY_INDEX_BITS + COMPONENT_ID_BITS === 32`).

### 2.2 `WorldOptions`

```ts
interface WorldOptions {
  // --- registration (validated at construction; fail-fast) ---
  components?: readonly ComponentDef<any>[];   // explicit pre-registration; also auto-registered on first use
  relations?:  readonly RelationDef<any>[];
  systems?:    readonly SystemDef[];           // ordered; scheduler derives the DAG from declared access

  // --- entity identity (entity-model.md §2; report §2.3, §3 #3) ---
  maxEntities?:    number;   // CANON default 1 << 20 (1_048_576); sets fixed region sizes (world.md §6.1)
  generationBits?: number;   // default 10; indexBits = 32 - generationBits; must sum to 32 (I2)
  // generationBits === 0 (generation-less) is permitted ONLY when threaded === false (entity-model open Q)

  // --- threading / backing (memory-buffers.md; report §6.3) ---
  threaded?: boolean;                          // default false — ship correct single-threaded first (§3 #5)
  // when threaded && !crossOriginIsolated: emit startup diagnostic, downgrade per scheduler.workers (§6.3, never silent)

  // --- archetype fragmentation cap (archetype-storage.md FRAG-1; report §6.4) ---
  maxHotArchetypes?: number;                   // default sized from maxEntities; overflow → cold store

  // --- reactivity knobs (reactivity.md ReactivityOptions) — NESTED, never flat (world.md §2.2) ---
  reactivity?: {
    maxWritesPerFrame?:       number;          // default maxEntities*4; ring size, spills (never throws) past it
    maxShapeChangesPerFrame?: number;          // default maxEntities*2
    observerCadence?:         ObserverCadence;  // 'frame-end' | 'per-system'; default 'frame-end' (world.md §9.5)
    logEntryWords?:           1 | 2;                         // default: 2 if any relation registered (world.md §9.6)
    shrinkRings?:             boolean;                       // default false (reactivity.md §8.3)
    changeTrackingDefault?:   'component' | 'field';        // default 'component' (report T3, Q-CD1)
  };

  // --- scheduler knobs (scheduler.md SchedulerOptions) — NESTED, never flat (world.md §2.2) ---
  scheduler?: {
    workers?: number | 'postMessage-fallback'; // worker pool size; or force the no-SAB transport (§6.3)
  };
}
```

Every option has a workload-safe default; a zero-argument `createWorld()` produces a
correct single-threaded world at default capacity. The `threaded` default is `false`
because the report mandates shipping **a correct single-threaded executor first**
(§3 #5); turning on `threaded: true` does not change any other line of user code — the
same systems, queries, and accessors run under the wave scheduler (§6).

### 2.3 The `World` facade (full public surface)

```ts
interface World {
  // --- entity lifecycle (entity-model.md) ---
  spawn(): EntityHandle;
  spawnWith(...defs: ComponentInit[]): EntityHandle;       // single migration EMPTY → target sig
  despawn(handle: EntityHandle): void;                     // idempotent (I8); cascades relations (P4/P5)
  isAlive(handle: EntityHandle): boolean;                  // main-thread; never reads the bitmask (I7)
  entity(handle: EntityHandle): EntityRef;                 // pooled-per-world ref (do NOT store across systems)

  // --- queries (type-system.md query DSL; archetype-storage.md matching) ---
  query<T extends readonly QueryTerm[]>(...terms: T): Query<T>;

  // --- frame / scheduler (scheduler) ---
  update(dt?: number): void;                               // run one wave-scheduled tick of all systems
  currentTick(): Tick;

  // --- relations (relations.md) ---
  addPair<R>(subject: EntityHandle, relation: RelationDef<R>, target: EntityHandle, payload?: R): void;
  removePair(subject: EntityHandle, relation: RelationDef<any>, target: EntityHandle): void;
  hasPair(subject: EntityHandle, relation: RelationDef<any>, target?: EntityHandle): boolean;
  getPair<R>(subject: EntityHandle, relation: RelationDef<R>, target: EntityHandle): PairAccessor<R>;
  subjectsOf(relation: RelationDef<any>, target: EntityHandle): Iterable<EntityHandle>;

  // --- reactivity (reactivity.md) ---
  observe(term: ObserverTerm, handler: (e: EntityRef, ctx: ObserverContext) => void): ObserverHandle;
  changedSince(handle: EntityHandle, since: Tick): boolean;

  // --- serialization (serialization) ---
  createSnapshot(): ArrayBuffer;                           // copy, detached, persistence/network
  loadSnapshot(buf: ArrayBuffer): void;
  createDeltaSerializer(sinceTick: Tick): DeltaSerializer; // copy, version-stamp driven (§2.9)
  exportSharedHandles(): SharedHandleManifest;             // zero-copy, intra-process (memory-buffers.md)

  // --- introspection / tuning ---
  warm(sig: readonly ComponentDef<any>[]): void;           // explicit cold→hot promotion (archetype-storage FRAG-1)
  handleStats(): HandleStats;                              // entity-model.md handle diagnostics
}
```

`spawnWith` and `despawn` are **main-thread / serial-phase** verbs (the single-writer
invariant, entity-model I10, Must-Fix #1). Inside a worker-dispatched system the user never
calls these directly; structural intent is staged to the command buffer by the same-named
verbs on the worker-side `World` proxy and applied between waves (scheduler/commands; report
§6.1). The **public signature is identical** in both modes — this is the load-bearing
parallel-readiness property.

> **Reconciliation note (M12 review — AS BUILT, normative §10 wins).** The relations verbs
> (`addPair`/`removePair`/`hasPair`/`getPair`/`subjectsOf`/`targetsOf`/`targetOf`), the
> scheduler frame loop (`update`), and the serialization verbs
> (`createSnapshot`/`loadSnapshot`/`createDeltaSerializer`/`exportSharedHandles`) are **not**
> methods on the core `World`. They are reached through small free functions the umbrella
> re-exports, each currying a world: `createRelations(world).addPair(...)`,
> `createScheduler(world, systems).update(dt)`,
> `createSnapshotSerializer(world).snapshot()` / `createSnapshotDeserializer(world).load(...)`
> / `createDeltaSerializer(world, sinceTick)`, and `bootstrapForWorker(world)` (the zero-copy
> handoff). This keeps `@ecsia/core` free of any import of relations/scheduler/serialization
> (the **acyclic** dependency direction), and matches the fact that relations/serialization
> mint world-scoped state at attach time. The `World` interface block above is retained as the
> *conceptual* surface; the executable surface is §10.

---

## 3. Definition functions (module scope)

These are pure, side-effect-light builders called once per component/relation/system,
typically at module top level. They produce opaque branded defs consumed by
`createWorld`. All are re-exported from `@ecsia/ecsia` (normative homes in parentheses).

### 3.1 `defineComponent` (type-system.md)

```ts
import { defineComponent, vec3, staticString, eid, object } from '@ecsia/ecsia';

const Position = defineComponent({ x: 'f32', y: 'f32', z: 'f32' });
const Velocity = defineComponent({ dx: 'f32', dy: 'f32', dz: 'f32' });
const Health   = defineComponent({ current: 'f32', max: 'f32' });
const Faction  = defineComponent({ side: staticString('red', 'blue', 'neutral') });
const Target   = defineComponent({ who: eid });                 // eid field → validated EntityHandle | null
```

- `defineComponent<const S extends Schema>(schema, options?) => ComponentDef<S>` — uses a
  `const` type parameter, so **no `as const`** is needed; field types infer directly
  (type-system.md providesApi).
- Field tokens are the scalar set (`bool|i8|u8|u8c|i16|u16|i32|u32|f32|f64|eid`) plus the
  constructors `vec`/`vec2`/`vec3`, `staticString(...choices)`, and `object<T>()` (the
  last is non-shareable / `restrictedToMainThread`; memory-buffers.md field-type table).
- Two `defineComponent` calls with identical schemas are **structurally interchangeable**
  unless an explicit brand literal is supplied — the documented v1 nominal-distinctness
  answer (type-system.md keyInvariants). `options.name` aids diagnostics; `options.brand`
  forces nominal distinctness.

### 3.2 `defineTag` (type-system.md)

```ts
const Enemy  = defineTag('Enemy');
const Frozen = defineTag('Frozen');
```

`defineTag(name?) => ComponentDef<{}>` — a zero-field component. Storage allocates **no
column**; presence is pure bitmask / archetype membership (archetype-storage.md: tag
components contribute no `ColumnSet`).

### 3.3 `defineRelation` (relations.md / type-system.md)

```ts
import { defineRelation, Pair, Wildcard } from '@ecsia/ecsia';

const ChildOf = defineRelation('ChildOf', { exclusive: true });          // tag, exclusive (one parent)
const Targets = defineRelation('Targets', { exclusive: true });          // exclusive eid retarget = field write
const Damages = defineRelation<{ amount: 'f32' }>(
  { amount: 'f32' }, { exclusive: false },                               // non-exclusive payload → overflow table
);
```

- `defineRelation(name?, opts?)` (tag) or `defineRelation<P>(payload, opts?)` (payload) →
  `RelationDef<P>`. `opts.exclusive` selects the storage kind (relations.md
  `resolveStorageKind`): **exclusive** → re-target is an in-place `eid` field write, **no
  migration** (the T1 churn valve, P3); **non-exclusive payload** → pair-keyed overflow
  table (Must-Fix #4); **tag** → presence + pair bits only, zero payload bytes.
- The user expresses a pair in a query with `Pair(relation, target | Wildcard)`.
  `Pair(R, Wildcard)` matches *any* target via the per-relation **presence bit** —
  O(archetypes), never O(distinct targets) (relations.md P6; report §6.4 mitigation 2).
- The exclusivity choice and the overflow table are **invisible** to the consumer; the
  only user-facing contract is "exclusive relations hold at most one target per subject."

> **Reconciliation note (M12 review — AS BUILT).** `defineRelation` is **not** a module-scope
> standalone; it is obtained per-world via `const rel = createRelations(world)` and then
> `rel.defineRelation(payload | null, opts?)` (it mints world-scoped synthetic ids). The pair
> query term is `rel.Pair(relation, target | Wildcard)`. The umbrella re-exports
> `createRelations` + `Wildcard`; the rest of the relations surface
> (`addPair`/`removePair`/`hasPair`/`getPair`/`subjectsOf`/`targetsOf`/`targetOf`/`depthOf`)
> lives on the object `createRelations(world)` returns.

### 3.4 `defineSystem` (scheduler; type-system.md `SystemAccess`)

```ts
import { defineSystem } from '@ecsia/ecsia';

const MovementSystem = defineSystem({
  name: 'Movement',
  read:  [Velocity],
  write: [Position],
  run({ query, dt }) {
    for (const e of query(read(Velocity), write(Position))) {
      const v = e.read(Velocity);
      const p = e.write(Position);          // mutable WriteView — the ONLY tracked mutation path
      p.x += v.dx * dt;
      p.y += v.dy * dt;
      p.z += v.dz * dt;
    }
  },
});
```

```ts
interface SystemDef {
  name: string;
  read?:  readonly ComponentDef<any>[];   // declared read access — scheduler conflict input
  write?: readonly ComponentDef<any>[];   // declared write access — the SOLE source of write-intent (Must-Fix #2)
  before?: readonly SystemDef[];          // explicit ordering (report §2.5 priority-weight 5)
  after?:  readonly SystemDef[];
  run(ctx: SystemContext): void;
}

interface SystemContext {
  world: World;
  dt: number;
  tick: Tick;
  query: World['query'];                  // same query() the world exposes, scoped for the wave
}

function defineSystem(def: SystemDef): SystemDef;   // identity + validation; returns a branded SystemDef
```

The `{ read, write }` declaration is the **contract** the scheduler trusts (Must-Fix #2,
report §2.8/§2.5). The scheduler **never** infers write-intent from runtime
`entity.write(C)` calls — `entity.write(C)` drives the `Changed` *reactivity* filter
(separate mechanism, §4.5), not the conflict DAG. A system whose `run` writes a component
not listed in `write` is a **scheduling bug** (it may race under `threaded: true`); a v1
dev-mode assertion can flag accessor writes to undeclared components, but the declaration
remains authoritative.

---

## 4. The entity surface: `EntityRef`, read/write split, queries, reactivity

### 4.1 `EntityRef` — pooled, never stored

```ts
const e: EntityRef = world.entity(handle);
```

`EntityRef` is a **pooled-per-world** identity carrier (entity-model.md `class
EntityRef`); the read/write accessors and the `entity.<comp>` getter shorthand are
installed on its prototype by the component module (entity-model.md dependsOn:
*component*). Users **must not** store an `EntityRef` across system / wave boundaries —
store the raw `EntityHandle` and re-resolve via `world.entity(handle)` (report §2.3).
Each call re-binds the pooled ref to the new handle (`__bind`).

### 4.2 The write/read split (Must-Fix #2 — LOCKED)

```ts
const p  = e.write(Position);   // WriteView<PositionSchema> — mutable; setter calls world.trackWrite (I-ACC-4)
p.x = 5;                        // OK: records the change to the write log

const r  = e.read(Position);    // ReadView<PositionSchema> — deeply Readonly
r.x = 5;                        // TS2540: Cannot assign to 'x' because it is a read-only property

const s  = e.position;          // shorthand — also Readonly (same singleton, type-only narrowing)
s.x = 5;                        // TS2540 — the locked read-only shorthand
const xs = e.position.x;        // OK: number, no `any`
```

- `e.write(C)` returns the mutable `WriteView<S>`; **every setter** additionally calls
  `world.trackWrite(index, componentId)` (type-system.md I-ACC-4), which is the *only*
  thing that drives the `Changed` filter and version stamps.
- `e.read(C)` and the bare `e.<comp>` shorthand are the **same runtime accessor singleton**
  as `e.write(C)` — there is no second hidden class (type-system.md keyInvariants;
  preserves one-hidden-class-per-`(archetype,component)`, decision #4). The read-only-ness
  is purely a **type-level** `Readonly` mapping; assignment is a compile error, so no
  un-tracked write can ever occur (Must-Fix #2).
- The accessor's captured column views are **length-tracking** (memory-buffers.md V-1),
  so an `EntityRef` accessor created before a `.grow()` keeps working after — no
  regeneration (Must-Fix #5). This is invisible to the user.

> **Delivered (M12 review).** `EntityRef.read`/`write` are now **generically typed** on the
> random-access path: `read<const C extends ComponentDef<Schema>>(c: C): ReadOf<C>` and
> `write<const C>(c: C): WriteOf<C>`. So `world.entity(h).write(Position)` infers a mutable
> `WriteView`, and `world.entity(h).read(Position)` infers a deeply-`Readonly` `ReadView`
> **without** caller casts — the Must-Fix #2 ergonomic contract (PA-2) holds on the
> random-access path, not only on the query-iteration element. The read-only **`entity.<comp>`
> shorthand** is NOT implemented as a getter on `EntityRef` (it would require per-world
> prototype installation keyed by registered components); it is **struck from the frozen
> surface** — `e.read(C)` is the random-access read path, and the query-iteration element keeps
> the `el.<comp>` shorthand. The bare public `e.handle` accessor replaces `e.__handle` on the
> public surface.

### 4.3 Structural verbs on `EntityRef`

```ts
e.add(Velocity, { dx: 1, dy: 0, dz: 0 });   // migration EMPTY-or-current → +Velocity (archetype-storage migrate)
e.remove(Frozen);                           // migration → −Frozen
e.has(Position);                            // main-thread membership (bitmask in serial phase; worker uses its sig)
e.despawn();                                // delegates to world.despawn(handle)
```

`add` / `remove` are facades over `migrate` (archetype-storage.md); on the main thread
they are synchronous (Q-A3: main-thread may be synchronous), on a worker they stage
`OP_ADD` / `OP_REMOVE` to the command buffer and apply between waves. `e.has(C)` is the
main-thread membership API (Must-Fix #1); a worker system asks membership via the
archetype signature it is already iterating, not the bitmask.

### 4.4 `query(...)` — the iteration DSL

```ts
import { read, write, With, Without, optional, Changed } from '@ecsia/ecsia';

const q = world.query(read(Velocity), write(Position), With(Enemy), Without(Frozen));

for (const e of q) {            // Query<Terms> is iterable; e is the bound EntityRef
  const p = e.write(Position);  // typed WriteView from the `write(Position)` term
  const v = e.read(Velocity);   // typed ReadView from the `read(Velocity)` term
  // ...
}
```

- Query terms: `read(C)`, `write(C)`, `With(C)`, `Without(C)`, `optional(C)`,
  `Changed(C)`, and `Pair(R, target | Wildcard)` (type-system.md query DSL).
- Iteration is **per-archetype** over matching archetype columns (archetype-storage.md
  `signatureMatches`), O(A) matching, **not** per-entity bitmask scanning (report §2.4
  correction). Cold-archetype entities are iterated transparently with identical
  semantics (archetype-storage.md FRAG-1).
- **Arity cap (report §6.5):** full tuple inference is supported up to
  `MAX_QUERY_ARITY = 8` terms in one `query(...)` call. Past 8, the element type degrades
  to a typed `LooseQueryElement` (a `Readonly<Record<...>>`-style union, never `any`).
  The escape hatch is an explicit annotation:

```ts
// wide system past the inference cap — annotate the iteration variable, no `any`:
for (const e of world.query(/* 10+ terms */) as Iterable<Has<Position> & HasWrite<Velocity>>) { /* ... */ }
```

### 4.5 The `Changed` filter (reactivity.md — driven by the write log)

```ts
const dirty = world.query(read(Position), Changed(Position));
for (const e of dirty) { /* only entities whose Position was written since this query last ran */ }
```

`Changed(C)` is driven **only** by the write log (`trackWrite`, pushed by every mutable
setter), consumed via a per-query `LogPointer` (reactivity.md R-2). It is **not** the
same mechanism as `world.changedSince(handle, tick)` (the public predicate, driven by
per-row `changeVersion` stamps). The two never read each other's mechanism (reactivity.md
R-2). No per-field atomic is incurred on the write hot path (report T3).

### 4.6 Observers (reactivity.md — deferred to a serial slot)

```ts
import { onAdd, onRemove, onChange } from '@ecsia/ecsia';

const h1 = world.observe(onAdd(Position, Velocity), (e, ctx) => { /* entity gained both */ });
const h2 = world.observe(onRemove(Health),          (e, ctx) => { /* about to lose Health */ });
const h3 = world.observe(onChange(Position),        (e, ctx) => { /* Position written this frame */ });
h1.dispose();
```

Observers **never** fire synchronously mid-system (report §2.7; reactivity.md R-3). They
are drained at the scheduler serial slot (`observerCadence`, default `'frame-end'`). An
`onRemove`/`Destroy` handler can still resolve the dying entity's last location because
identity is invalidated **last** (entity-model.md despawn ordering; reactivity.md R-8).
Mutations performed inside an observer are themselves staged to command buffers and
applied at the next serial flush, so creating/destroying entities inside an observer is
safe (report §2.7).

---

## 5. System definition & access declarations (consistency with the scheduler)

A system is `defineSystem({ name, read, write, run })` (§3.4). The end-to-end contract:

1. **Declaration is the conflict source.** The scheduler aggregates
   `read`/`write: Map<ComponentId, Set<SystemId>>` from the declared sets only
   (type-system.md `SystemAccess`; report §2.5 step 1). Two systems in the same
   topological layer run concurrently iff their **write-sets are disjoint** and neither
   reads what the other writes (report §2.5 step 3, v1 component-type granularity, T5).
2. **`run` receives a scoped `query`.** Inside `run`, `query(...)` returns the same
   `Query` type as `world.query`, but the scheduler has already validated that the terms'
   components are a subset of the declared `{ read, write }` (a dev-mode assertion). This
   keeps the declared access honest without inferring it.
3. **Write-intent is never inferred from `entity.write(C)`** (Must-Fix #2). A system that
   writes `Position` must list `Position` in `write`; the accessor setter only drives
   reactivity, not scheduling.
4. **Single-threaded first.** With `threaded: false` (default), the scheduler runs the
   waves serially in topological order on the main thread — a correct executor with the
   same observable result as the threaded path (report §3 #5). `threaded: true` dispatches
   each wave's disjoint batches to the worker pool; **no user code changes**.

---

## 6. `world.update()` — the frame loop

```ts
world.update(dt);   // one tick: run all systems under the wave schedule, then flush reactivity
```

`update` runs one tick. Its fixed internal order (reactivity.md lifecycle contract;
report §2.5 / §2.7) is:

1. `frameReset()` — advance `currentTick`, reset per-frame transient query lists.
2. For each wave in topological order: dispatch the wave's batches (serially in v1
   single-thread mode; to the worker pool under `threaded: true`), each worker reading
   archetype columns directly and staging structural intent to its **command buffer**
   (report §6.1). The main thread waits on the wave (Atomics tier per §6.3 / postMessage
   fallback).
3. Between waves: `mergeCorrals()` + apply command buffers in **fixed worker-index order**
   with **validate-then-apply, drop-if-dead** for every referenced eid (report §6.1
   Must-Fix #3); `maintainStructural()` updates queries incrementally.
4. `observerDrain()` at the serial slot (`observerCadence`).
5. `flushLogs()` — advance ring heads, drain the spill list (reactivity.md R-5; overflow
   is recoverable, never a throw).

All structural mutation (spawn/despawn/add/remove/addPair) thus happens at serial flush
points only — discharging the serial-mutation invariant the whole architecture rests on
(memory-buffers.md V-2; archetype-storage.md CO-1; Must-Fix #1).

---

## 7. Runtime / threading surface

```ts
const world = createWorld({ threaded: true, scheduler: { workers: 4 } });
```

- **Single-thread (default).** `threaded: false`. Correct, simplest, the v1 baseline.
- **SAB workers.** `threaded: true` and `globalThis.crossOriginIsolated === true`:
  archetype column SABs are shared zero-copy; waves dispatch to the pool; Atomics wait
  tier chosen by capability probe (report §6.3 tiers 1–3).
- **postMessage fallback.** `threaded: true` but **not** cross-origin-isolated, or
  `scheduler.workers: 'postMessage-fallback'`: columns are plain `ArrayBuffer`s transferred per wave
  via `Transferable` (report §6.3). Slower, correct, **identical public API**.
- **Never silent.** A `threaded: true` request in a non-isolated context emits a clear
  startup diagnostic and downgrades deterministically (report §6.3; §3 #9 honesty
  qualification). The user code — components, systems, queries — is **byte-for-byte the
  same** across all three modes.

---

## 8. Serialization entry points (two disjoint paths)

The report (§2.9, §3 #9) mandates separating **zero-copy intra-process sharing** from
**copy-based snapshot/delta**. The public surface keeps them as distinct verbs:

```ts
// --- copy-based (persistence / network) ---
const snap: ArrayBuffer = world.createSnapshot();   // detached, structure + per-component SoA sections
world.loadSnapshot(snap);                            // with entity-ID remap on deserialize
const delta = world.createDeltaSerializer(world.currentTick());
const patch: ArrayBuffer = delta.encode();           // version-stamp driven (changedSince), NOT a shadow map

// --- zero-copy (intra-process worker sharing) ---
const manifest: SharedHandleManifest = world.exportSharedHandles();   // SAB-backed columns/regions, no value copy
```

- `createSnapshot` / `loadSnapshot` / `createDeltaSerializer` are **copy** boundaries —
  they emit/consume detached `ArrayBuffer`s and translate `eid` fields through a remap
  table on load (report §2.9 Layer 3). Deltas are driven by the version stamps
  (`world.changedSince` / `world.changedRows`; reactivity.md), so there is **no shadow
  map** memory.
- `exportSharedHandles` is the **zero-copy** boundary (memory-buffers.md
  `exportSharedHandles(): SharedHandleManifest`): it hands out the underlying SAB-backed
  column/region handles for another worker to wrap directly — no value serialization. It
  is only meaningful when `threaded` and cross-origin-isolated (report §2.9 Layer 1).

---

## 9. Worked example — a small combat simulation

This example exercises **components, relations, a `Changed` filter, queries, and two
systems with a read/write conflict** end to end. It is written to type-check under strict
TS and to be consistent with every module spec cited inline.

### 9.1 Definitions

```ts
import {
  createWorld, defineComponent, defineTag, defineRelation, defineSystem,
  read, write, With, Without, Changed, Pair, Wildcard,
  staticString, eid, type EntityHandle,
} from '@ecsia/ecsia';

// --- components (type-system.md defineComponent; memory-buffers.md columns) ---
const Position = defineComponent({ x: 'f32', y: 'f32' });
const Velocity = defineComponent({ dx: 'f32', dy: 'f32' });
const Health   = defineComponent({ current: 'f32', max: 'f32' });
const Faction  = defineComponent({ side: staticString('red', 'blue') });

// --- tags (zero-column, archetype-storage.md tag path) ---
const Dead = defineTag('Dead');

// --- relations (relations.md) ---
// exclusive: a unit targets at most one enemy; re-target = in-place eid write, NO migration (P3)
const Targets = defineRelation('Targets', { exclusive: true });
// non-exclusive payload: a unit can apply damage-over-time to many targets, each its own amount → overflow table
const Burns = defineRelation<{ dps: 'f32' }>({ dps: 'f32' }, { exclusive: false });
```

### 9.2 Spawning a small scene

```ts
const world = createWorld({
  components: [Position, Velocity, Health, Faction],
  relations:  [Targets, Burns],
  systems:    [MovementSystem, CombatSystem],   // defined below
  maxEntities: 1 << 16,
});

function spawnUnit(side: 'red' | 'blue', x: number, y: number): EntityHandle {
  // spawnWith → single migration EMPTY → {Position,Velocity,Health,Faction} (entity-model spawnWith; archetype migrate)
  const h = world.spawnWith(
    [Position, { x, y }],
    [Velocity, { dx: 0, dy: 0 }],
    [Health,   { current: 100, max: 100 }],
    [Faction,  { side }],
  );
  return h;
}

const red  = spawnUnit('red',  0,  0);
const blue = spawnUnit('blue', 10, 0);

// establish a combat relation (exclusive Targets) — re-targeting later is a field write, not a migration
world.addPair(red,  Targets, blue);
world.addPair(blue, Targets, red);

// a non-exclusive payload relation: `red` burns `blue` for 5 dps (payload → overflow table, Must-Fix #4)
world.addPair(red, Burns, blue, { dps: 5 });
```

### 9.3 Two systems with a read/write conflict

`MovementSystem` **writes** `Position` (reading `Velocity`). `CombatSystem` **reads**
`Position` (writing `Health`). Because `CombatSystem` reads what `MovementSystem` writes,
the scheduler serializes them: a read-after-write conflict on `Position` (report §2.5
step 3). They cannot share a wave; `MovementSystem` is ordered before `CombatSystem`.

```ts
const MovementSystem = defineSystem({
  name:  'Movement',
  read:  [Velocity],
  write: [Position],                                // declared write-intent — the scheduler contract (Must-Fix #2)
  run({ query, dt }) {
    for (const e of query(read(Velocity), write(Position), Without(Dead))) {
      const v = e.read(Velocity);
      const p = e.write(Position);                  // mutable WriteView; setter pushes to writeLog (drives Changed)
      p.x += v.dx * dt;
      p.y += v.dy * dt;
    }
  },
});

const CombatSystem = defineSystem({
  name:  'Combat',
  read:  [Position, Faction],                       // READS Position → conflicts with Movement's WRITE Position
  write: [Health],
  run({ query, world, dt }) {
    // Only react to units whose Position actually moved this frame: the Changed filter (reactivity.md, write-log driven)
    for (const attacker of query(read(Position), read(Faction), Changed(Position), Without(Dead))) {
      // exclusive Targets: resolve the single current target (eid field, no scan)
      const targetHandle = firstTarget(world, attacker.__handle);
      if (targetHandle === undefined || !world.isAlive(targetHandle)) continue;

      const ap = attacker.read(Position);
      const target = world.entity(targetHandle);
      const tp = target.read(Position);
      const dist2 = (ap.x - tp.x) ** 2 + (ap.y - tp.y) ** 2;

      if (dist2 < MELEE_RANGE_2) {
        const th = target.write(Health);            // write Health (declared); cross-entity write within one system
        th.current = Math.max(0, th.current - MELEE_DAMAGE * dt);
        if (th.current === 0) target.add(Dead);     // structural change — synchronous on main thread (archetype migrate)
      }
    }
  },
});

const MELEE_RANGE_2 = 4;
const MELEE_DAMAGE  = 30;

// helper: pull the single exclusive target of a unit (relations.md targetsOf for exclusive = eid column read)
function firstTarget(world: World, subject: EntityHandle): EntityHandle | undefined {
  for (const t of world.query(/* ... */)) { /* illustrative */ }
  // in practice: world's relation API exposes the exclusive target directly:
  // return world.targetOf(subject, Targets);   // exclusive single-target convenience
  return undefined;
}
```

> Note: `firstTarget` is illustrative. For an **exclusive** relation the runtime resolves
> the single target via the subject's `eid` payload column directly (relations.md
> `targetsOf(subject, relation)` → exclusive eid column read, O(1)), so no query is
> required; the convenience verb is **`createRelations(world).targetOf(subject, Targets)`**
> (AS BUILT, Q-PA1 resolved): it returns `EntityHandle | null` and **throws** on a
> non-exclusive relation. `attacker.__handle` in this pseudocode is the public
> **`attacker.handle`** accessor in the as-built `EntityRef`.

### 9.4 A reactive cleanup system using a relation cascade

```ts
const CleanupSystem = defineSystem({
  name:  'Cleanup',
  read:  [Health],
  write: [],                                        // no component writes; only structural despawns (staged)
  run({ query, world }) {
    for (const e of query(With(Dead))) {
      // despawn cascades: preDespawn removes all (s, Targets, dead) and (s, Burns, dead) pairs before the
      // generation bump, so no live pair references a dead target (relations.md P4; entity-model despawn ordering)
      world.despawn(e.__handle);
    }
  },
});
```

### 9.5 Observing structural change

```ts
// deferred observer — fires at the frame-end serial slot, never mid-system (reactivity.md R-3)
world.observe(onRemove(Health), (e, ctx) => {
  console.log(`unit ${e.__handle} died at tick ${ctx.tick}`);   // last location still resolvable (R-8)
});
```

### 9.6 Driving the simulation

```ts
const FIXED_DT = 1 / 60;
for (let frame = 0; frame < 600; frame++) {
  world.update(FIXED_DT);   // Movement (wave 1) → Combat (wave 2, after, RAW on Position) → Cleanup; observers drain
}

// snapshot for persistence (copy path), or share columns zero-copy with a worker (intra-process)
const save = world.createSnapshot();
```

### 9.7 What this example proves (consistency checklist)

| Exercised | Mechanism | Module / invariant |
|---|---|---|
| Components with mixed field types (`f32`, `staticString`) | `defineComponent`, column layout | type-system.md, memory-buffers.md field table |
| Tag with no column | `defineTag('Dead')` | archetype-storage.md tag (no `ColumnSet`) |
| Exclusive relation, re-target without migration | `defineRelation(.., {exclusive:true})`, `addPair` | relations.md P3, Must-Fix #4 |
| Non-exclusive payload relation → overflow table | `defineRelation<{dps}>(.., {exclusive:false})` | relations.md overflow-table, Must-Fix #4 |
| Query with `With`/`Without` and per-archetype match | `query(read, write, With, Without)` | archetype-storage.md `signatureMatches` |
| `Changed` filter driven by write log (not version stamps) | `Changed(Position)` after `write(Position)` setter | reactivity.md R-2, Must-Fix #2 |
| Read/write conflict serializing two systems | Movement writes Position, Combat reads Position | scheduler conflict DAG, report §2.5 |
| Tracked mutation only via `write(C)`; shorthand read-only | `e.write(Position)` vs `e.read(Position)` | Must-Fix #2 (TS2540 on shorthand) |
| Structural change inside a system (synchronous main / staged worker) | `target.add(Dead)`, `world.despawn` | archetype-storage.md migrate; report §6.1 |
| Cascade-on-delete removing dangling pairs | `world.despawn` → preDespawn | relations.md P4/P5; entity-model despawn ordering |
| Deferred observer at serial slot | `world.observe(onRemove(Health), ...)` | reactivity.md R-3/R-8 |
| Frame loop ordering (waves → command apply → observer drain → flush) | `world.update(dt)` | §6; reactivity.md lifecycle |
| Copy-based snapshot distinct from zero-copy sharing | `createSnapshot` vs `exportSharedHandles` | report §2.9 layers |

---

## 10. Public re-export manifest (`@ecsia/ecsia`) — AS BUILT (M12, frozen)

> **Reconciliation note (M12 review).** The aspirational manifest sketched in earlier drafts
> assumed module-scope standalones (`defineRelation`, `Pair`, `Changed`, an `eid` token
> constructor) and relation/serialization verbs hanging off the `World` facade. The as-built
> runtime instead binds relations and serialization to a world through small **free functions**
> (`createRelations(world)`, `createSnapshotSerializer(world)`), because those subsystems mint
> **world-scoped** state (synthetic component ids, presence bits) that is meaningless without a
> world — and because the dependency graph must stay **acyclic** (`@ecsia/core` must not import
> `@ecsia/relations`/`@ecsia/serialization`). This section is the **normative frozen surface**;
> where it and §2.3/§3.3/§9 disagree, **this section wins** (the worked example §9 is illustrative
> pseudocode, reconciled in the per-section notes).

The umbrella package re-exports exactly the following (normative home in parentheses). Every
world-consuming function accepts the **public `World` view** (PA-1: the `__`-seams are omitted from
the exported `World`/`EntityRef` types):

```ts
// world — the single constructor returns the PUBLIC World facade (no `__` seams; PA-1..PA-8)
export { createWorld, ConfigError } from '@ecsia/ecsia';      // createWorld is umbrella-wrapped
export type { World, EntityRef, WorldPhase, WorldOptions } from '@ecsia/ecsia';

// definitions (module scope)
export { defineComponent, defineTag } from '@ecsia/core';     // schema constructors (re-homed via core)
export { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from '@ecsia/scheduler';
// `defineRelation` is reached through the world-attach API: createRelations(world).defineRelation(...)
export { createRelations, Wildcard } from '@ecsia/relations'; // + the Relations API it returns

// field tokens (constructors; scalar tokens incl. 'eid' are string literals in a schema, not exports)
export { vec, vec2, vec3, vec4, staticString, object } from '@ecsia/core';

// query DSL  (Changed → query(...).changed(); Pair → createRelations(world).Pair)
export { read, write, With, Without, optional, MAX_QUERY_ARITY } from '@ecsia/core';

// reactivity
export { onAdd, onRemove, onChange } from '@ecsia/core';

// scheduler (opt-in frame loop) + worker-parallel path
export { createScheduler, WorkerPool } from '@ecsia/ecsia';   // createScheduler is umbrella-wrapped

// serialization (umbrella-wrapped to accept the public World; copy + zero-copy paths)
export {
  createSnapshotSerializer, createSnapshotDeserializer, createDeltaSerializer, applyDelta,
  bootstrapForWorker, attachWorld,
} from '@ecsia/ecsia';

// convenience wiring (tree-shakeable one-liners that curry a world)
export { snapshot, relationsOf } from '@ecsia/ecsia';

// branded types + inference helpers (escape hatch)
export type {
  EntityHandle, EntityIndex, ComponentId, ComponentDef, ComponentOptions,
  RelationDef, RelationOptions, PairDef, WildcardToken, PairAccessor, StorageKind,
  ReadView, WriteView, ReadOf, WriteOf, SchemaOf,
  Query, LooseQuery, QueryTerm, QueryElement, Has, HasWrite, Tick,
  ObserverHandle, ObserverContext, ObserverTerm, ObserverCadence,
  SharedHandleManifest, SnapshotSerializer, SnapshotDeserializer, DeltaSerializer, WorldBootstrap,
  SystemDef, SystemContext, OrderingHint, SchedulerHandle, CreateSchedulerOptions,
  PoolConfig, PoolSystem, RoundDispatcher, ScalarToken, VecToken, StaticStringToken, ObjectToken,
  FieldToken, Schema, ReactivityOptions, SchedulerOptions, ChangeTracking, WorkerOption,
} from '@ecsia/ecsia';
```

**`vec4` and the `eid` token are IN the frozen set** (vec4 is a documented field-token
constructor; `eid` is the scalar field token written as the string `'eid'` inside a schema, e.g.
`defineComponent({ who: 'eid' })` — there is no separate `eid` *constructor* to export). The
exported `World`/`EntityRef` are the **public view types** declared by the umbrella, with the
`__`-prefixed wiring seams and scheduler-only loop verbs omitted (PA-1).

`MAX_QUERY_ARITY = 8` is exported as a documented constant. The kernel
(`createWorld` + `query` + accessors) runs **without** importing `@ecsia/scheduler` in
single-threaded mode; `defineSystem` + the scheduler pull in the scheduler layer
(report §5.1: scheduler is an opt-in layer over a kernel that runs single-threaded).

---

## 11. Cross-module consistency invariants this surface must not violate

- **PA-1 (single-writer):** every public verb that mutates structure (`spawn`,
  `spawnWith`, `despawn`, `add`, `remove`, `addPair`, `removePair`, `warm`,
  `loadSnapshot`) executes on the main thread at a serial flush point. Worker-side calls
  stage to command buffers and apply in fixed worker-index order with drop-if-dead
  (Must-Fix #1/#3; entity-model I10; archetype-storage CO-1).
- **PA-2 (read-only shorthand):** `entity.<comp>` and `entity.read(C)` are deeply
  `Readonly`; assignment is `TS2540`. The only tracked-mutation path is `entity.write(C)`
  (Must-Fix #2). No public API lets a write escape the write log.
- **PA-3 (declared write-intent):** the scheduler reads write-intent only from
  `SystemDef.write`; never from accessor calls. `Changed` reactivity and scheduler
  conflict detection use **disjoint** mechanisms (Must-Fix #2; reactivity.md R-2).
- **PA-4 (identical API across runtimes):** the same user code runs under single-thread,
  SAB-worker, and postMessage-fallback modes; the mode is a `createWorld` option, never a
  code-shape change (report §6.3; §3 #9).
- **PA-5 (length-tracking accessors):** no public accessor is invalidated by a `.grow()`;
  views are length-tracking on the primary path (Must-Fix #5; memory-buffers V-1). The
  user never re-fetches an accessor because a column grew.
- **PA-6 (bounded inference):** `query(...)` is type-inferred up to `MAX_QUERY_ARITY=8`;
  beyond it the typed `Has<C>`/`HasWrite<C>` annotation escape hatch is the documented
  fallback — never `any` (report §6.5).
- **PA-7 (recoverable reactivity):** observer/log overflow spills to a growable
  main-thread list and is drained at the next flush; no public operation throws on a busy
  frame (reactivity.md R-5; report §2.7).
- **PA-8 (relation exclusivity transparency):** the storage split (subject column vs
  overflow table) and the per-relation presence bit are invisible to the user; the only
  user-facing contract is exclusivity cardinality (Must-Fix #4).

---

## 12. Open Questions (non-blocking; deferred to gated milestones)

- **Q-PA1 (targetOf convenience): RESOLVED (M12).** Exposed as
  `createRelations(world).targetOf(subject, exclusiveRelation)` (relations.md `targetsOf`
  exclusive path). Returns `EntityHandle | null` (null = no current target) and **throws**
  on a non-exclusive relation. It lives on the Relations API object rather than on `World`,
  for the acyclic-dependency reason in §10.
- **Q-PA2 (system context surface):** whether `SystemContext` exposes `commands` (an
  explicit command-buffer handle) for power users staging structural ops, or whether the
  same `world` verbs transparently route to the buffer under `threaded: true`. Leaning
  transparent (PA-4). Settle at M7.
- **Q-PA3 (spawnWith init ergonomics):** the `[Def, value]` tuple form vs an object form
  `{ Position: {...}, Velocity: {...} }`; the tuple form is shown here for unambiguous
  `ComponentDef` identity. Confirm against the type-inference budget at M11 (§6.5).
- **Q-PA4 (observerCadence default):** `'frame-end'` (default) vs `'per-system'` enabling
  earlier observation at higher drain cost; the literal set is canonically
  `'frame-end' | 'per-system'` (world.md §9.5; the scheduler maps `'per-system'` to its
  per-wave serial-slot dispatch internally). Tune at M9.
- **Q-PA5 (snapshot scope):** whether `createSnapshot` captures cold-archetype entities
  and relation overflow tables in v1 or defers relation-state serialization to M10
  (serialization spec). Default: full world state including relations.
- **Q-PA6 (umbrella tree-shaking):** confirm the umbrella re-export does not pull the
  scheduler/worker code into a single-threaded bundle; validated by a bundle-size fixture
  at M11.
