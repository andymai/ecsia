# Saving and syncing

Once a world is running — in ecsia's entity component system (ECS), each thing in your
world is an entity (just an id) whose data lives in components (typed pieces of data
attached to entities) — you'll want to get its state out: saved to disk, sent over a
network, or handed to a worker thread. ecsia serializes through **two structurally separate
transports**:

- **Copy snapshot / delta** → `Uint8Array` bytes, for network, persistence, or copying a
  world into a separate JS context. A snapshot is a complete copy of the world's state at
  one moment; a delta is just the changes since a known point, small enough to send over a
  network.
- **Zero-copy worker bootstrap** → `SharedArrayBuffer` handles (never bytes), for handing a
  world to worker threads inside the same process. A `SharedArrayBuffer` is memory several
  threads can read and write at once, so nothing needs copying. (See
  [Multithreading](/guide/parallelism).)

The bytes path never carries `SharedArrayBuffer` handles; the bootstrap path never carries
value bytes.

## Snapshot: a whole world, bit-exact

`createSnapshotSerializer(world)` round-trips a world bit-exactly — for every **persisted**
field; fields marked `persist: false` are skipped and re-default on load (see
[Skipping transient fields](#skipping-transient-fields)). `createSnapshotDeserializer(world)`
loads it into a fresh world, returning an entity-id **remap** (loading mints new entity
handles, and the table maps each producer handle to its loaded handle). Both must run in the
world's serial phase — a point where no systems are mid-run.

```ts
import {
  createWorld, defineComponent,
  createSnapshotSerializer, createSnapshotDeserializer,
} from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })

const src = createWorld({ components: [Position], maxEntities: 1 << 16 })
src.spawnWith([Position, { x: 1, y: 2 }])

const bytes = createSnapshotSerializer(src).snapshotCopy() // detached buffer, safe to persist/transfer

const dst = createWorld({ components: [Position], maxEntities: 1 << 16 })
const { remap, entitiesCreated } = createSnapshotDeserializer(dst).load(bytes)
// `remap` maps each producer handle to its freshly-minted handle in `dst`.
```

`snapshot()` returns a view onto a reusable buffer (valid until the next call); `snapshotCopy()`
returns a fresh detached buffer safe to transfer or persist.

## Delta: changes since a tick

`createDeltaSerializer(world, sinceTick)` emits both the value changes **and** the
structural changes — anything that alters what components an entity has: spawning,
despawning, adding or removing a component — since a tick (one step of the simulation). It
is driven by per-row **version stamps**, counters recording when each value last changed.
There is **no shadow map** on the core: ecsia doesn't keep a second copy of your data to
detect changes — the version stamps do it. Apply a delta with `applyDelta(world, bytes,
remap)`, passing the remap that ties producer handles to this world's handles.

```ts
import {
  createWorld, defineComponent,
  createDeltaSerializer, applyDelta,
} from 'ecsia'
import type { EntityHandle } from 'ecsia'

const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
const world = createWorld({ components: [Position], maxEntities: 1 << 16 })
const e = world.spawnWith([Position, { x: 0, y: 0 }])

const since = world.currentTick()
const ser = createDeltaSerializer(world, since)

world.entity(e).write(Position).x = 10
const patch = ser.deltaCopy()   // covers (sinceTick, currentTick]

// On the consumer (a world that already loaded the matching snapshot):
const remap = new Map<EntityHandle, EntityHandle>()
// applyDelta(consumerWorld, patch, remap)
```

### Epsilon mode (lower-level option)

The package-level `createDeltaSerializer` accepts an opt-in numeric **`epsilon`** tolerance:
a changed row whose every changed numeric field is within `epsilon` of the last emitted
value is dropped from the value section. Rich fields (`object<T>()` fields, which hold
arbitrary JS values) and structural ops are never epsilon-filtered. To compare against the
last emitted value, the serializer keeps its own private copy of the numeric data — the core
stays shadow-free — which is exactly why epsilon is opt-in: the memory cost is real.

```ts
import { createDeltaSerializer } from '@ecsia/serialization'
import type { World } from '@ecsia/core'

declare const world: World
const since = 0

// Drop sub-tolerance numeric changes (e.g. jitter below 0.001).
const ser = createDeltaSerializer(world, since, { epsilon: 0.001 })
const patch = ser.deltaCopy()
```

## Skipping transient fields

Some component data has no business in a save file: derived values, per-frame caches, debug
counters. Mark a field — or a whole component — `persist: false` at definition time and the
snapshot/delta writers skip it; on load it takes its declared default.

```ts
import { createWorld, defineComponent, field } from 'ecsia'

// One transient field inside an otherwise-persisted component:
const Body = defineComponent(
  {
    x: 'f32',
    y: 'f32',
    speedCache: field('f32', { persist: false }), // derived from x/y deltas — recomputed after load
  },
  { name: 'body' },
)

// Or an entirely transient component:
const PathCache = defineComponent({ next: 'eid' }, { name: 'pathCache', persist: false })

const world = createWorld({ components: [Body, PathCache], maxEntities: 1 << 16 })
```

The rules:

- **Values only, never structure.** A `persist: false` component keeps its membership across a
  round-trip (the entity still *has* it — including tags); only its field values re-default.
- **Defaults still apply.** A skipped field declared `field('u8', { default: 3, persist: false })`
  reads back `3` after a load, not `0`.
- **Reactivity is unaffected.** Writes to skipped fields still feed the write log and the
  `.changed` version stamps. Because those stamps are shared per-entity, a delta whose row
  changed *only* in a skipped field still re-sends that row's persisted values — a harmless,
  receiver-idempotent over-send; the skipped value itself never reaches the wire.
- **Mismatched flags fail loudly.** The persisted-field subset is folded into the `schemaHash`,
  and **both** `load` (snapshots) and `applyDelta` (deltas carry the hash in their header) throw
  on a mismatch instead of mis-reading columns. (Relation payloads are name-keyed on the wire,
  so a skipped payload field is simply omitted and re-defaults without affecting the hash — and
  the receiver enforces *its own* flags on apply, so a producer without the flag cannot write
  into a payload field the receiver declared transient.)

## Structural journal & observer log

The delta interleaves a **structural section** (spawns/despawns/add/remove since the tick)
ahead of the value section, so a single patch restores both shape and values. For a
standalone stream of structural ops, `@ecsia/serialization` exposes `createObserverLog` and
the `encodeStructuralOps` / `applyStructuralOps` pair.

```ts
import { createObserverLog } from '@ecsia/serialization'
import type { World } from '@ecsia/core'

declare const world: World
const log = createObserverLog(world)
// `log` records structural deltas you can encode and replay on another world.
```

## Re-backing notices: keeping worker views live across column growth

The zero-copy bootstrap hands each worker its column `SharedArrayBuffer`s **once**, by
reference — workers then read and write that shared memory directly. That raises a question:
what happens when a column needs more room?

1. **The problem.** Each column reserves address space up front, and most growth happens *in
   place* (`SharedArrayBuffer.prototype.grow` within that reservation) — a length-tracking
   view auto-widens, so nothing needs re-pointing. But when a column grows **past its
   reservation**, the buffer layer must allocate a **new** `SharedArrayBuffer`, copy the
   data over, and re-back the column. A worker's captured view would otherwise keep reading
   the abandoned buffer.
2. **A growth counter records every move.** The buffer layer keeps a **growth generation** —
   a counter that only ever increases, ticking once per re-backing — alongside a list of
   **re-backing notices**, each carrying the new `SharedArrayBuffer` handle and layout for
   an affected column.
3. **Workers re-point at the wave fence.** A wave is a batch of systems that run at the same
   time; the **wave fence** is the synchronization point between waves. At each fence,
   before the next dispatch, the worker pool reads the growth counter. Only if it advanced
   does the pool **drain** the notices and broadcast them to every worker. Each worker
   re-wraps the named columns onto their new backing and **acknowledges on the wave
   counter**; the dispatch does not proceed until all workers have applied. The new
   `SharedArrayBuffer` references travel by `postMessage` (a `SharedArrayBuffer` cannot ride
   inside another one), while the *signal* to apply rides the same `Atomics` fence the wave
   loop already uses — `Atomics` being the JS primitives threads use to coordinate.
4. **Zero overhead when nothing grew.** Checking the counter is a single integer read, so in
   steady state there is no per-wave cost. And because every worker re-points before the
   next wave starts, the result stays serial-equivalent — byte-identical to a
   single-threaded run — at any column size.

This is the producer side of `applyColumnsAdded` on the worker view: in-place growth emits
nothing (views auto-widen); only re-backing onto a new `SharedArrayBuffer` produces a notice.

## Version gating

The wire is versioned (`SERIALIZATION_FORMAT_VERSION`). On load, the deserializer
range-checks the header version and **throws** on an unsupported version or a schema
mismatch rather than silently mis-reading bytes. The zero-copy worker `attachWorld` likewise
throws on a `schemaHash` mismatch — a worker built from a different component schema than
the host is rejected as stale code, not run blindly.

## Carrying entity references across the wire (RF-NOREMAP)

::: warning A handle stored inside an `object<T>` is NOT remapped
On a round-trip, entity ids are remapped — but only through the channels the serializer can
see: **`eid` column fields** and **relation targets**. An `EntityHandle` buried inside an
`object<T>()` rich field is opaque JSON; it is serialized as a raw number and is **not**
remapped, so after loading it points into the producer's index space and is almost certainly
invalid.
:::

To carry a reference that survives the wire, either:

1. use a dedicated `eid` **column** field (which *is* remapped), or
2. store a **stable application id** and resolve it after load with `createStableIndex`.

```ts
import { createWorld, defineComponent, createStableIndex } from 'ecsia'

// A stable, app-meaningful id lives in a 'string' field; build an id → entity index over it.
const Identity = defineComponent({ uid: 'string' }, { name: 'identity' })
const world = createWorld({ components: [Identity], maxEntities: 1 << 16 })
const index = createStableIndex(world, Identity, 'uid')

world.spawnWith([Identity, { uid: 'player-1' }])
// After a load, resolve the surviving stable id back to the (new) handle:
const handle = index.get('player-1')
```

## See also

- [Reacting to changes](/guide/reactivity) — `changedSince` reads the same version stamps
  the delta rides.
- [Multithreading](/guide/parallelism) — the zero-copy `bootstrapForWorker` / `attachWorld`
  handoff.
