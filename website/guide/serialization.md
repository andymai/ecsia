# Serialization

ecsia serializes through **two structurally separate transports**:

- **Copy snapshot / delta** → `Uint8Array` bytes, for network, persistence, or cross-isolate copy.
- **Zero-copy worker bootstrap** → `SharedArrayBuffer` handles (never bytes), for intra-process worker
  handoff. (See [Parallelism](/guide/parallelism).)

The bytes path never carries SAB handles; the bootstrap path never carries value bytes.

## Snapshot: a whole world, bit-exact

`createSnapshotSerializer(world)` round-trips a world bit-exactly. `createSnapshotDeserializer(world)`
loads it into a fresh world, returning an entity-id **remap** (load mints new handles; the table maps
producer handles → loaded handles). Both must run in the world's serial phase.

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

`snapshot()` returns a view onto a reusable buffer (valid until the next call); `snapshotCopy()` returns
a fresh detached buffer safe to transfer or persist.

## Delta: changes since a tick

`createDeltaSerializer(world, sinceTick)` emits the value **and** structural changes since a tick, driven
by per-row version stamps — **no shadow map** on the core. Apply it with `applyDelta(world, bytes,
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

The package-level `createDeltaSerializer` accepts an opt-in numeric **`epsilon`** tolerance: a changed
row whose every changed numeric field is within `epsilon` of the last emitted value is dropped from the
value section. Rich fields and structural ops are never epsilon-filtered. The serializer owns its own
shadow for this (the core stays shadow-free), so it is opt-in precisely because the memory cost is real.

```ts
import { createDeltaSerializer } from '@ecsia/serialization'
import type { World } from '@ecsia/core'

declare const world: World
const since = 0

// Drop sub-tolerance numeric changes (e.g. jitter below 0.001).
const ser = createDeltaSerializer(world, since, { epsilon: 0.001 })
const patch = ser.deltaCopy()
```

## Structural journal & observer log

The delta interleaves a **structural section** (spawns/despawns/add/remove since the tick) ahead of the
value section, so a single patch restores both shape and values. For a standalone stream of structural
ops, `@ecsia/serialization` exposes `createObserverLog` and the `encodeStructuralOps` /
`applyStructuralOps` pair.

```ts
import { createObserverLog } from '@ecsia/serialization'
import type { World } from '@ecsia/core'

declare const world: World
const log = createObserverLog(world)
// `log` records structural deltas you can encode and replay on another world.
```

## Re-backing notices: keeping worker views live across column growth

The zero-copy bootstrap hands each worker its column SABs **once**, by reference. A length-tracking view
auto-widens when a column grows *in place* (`SharedArrayBuffer.prototype.grow` within the column's
reserved address space), so most growth re-points nothing. But when a column grows **past its
reservation**, the buffer layer must allocate a **new** `SharedArrayBuffer`, copy, and re-back — and a
worker's captured view would otherwise keep reading the abandoned buffer.

The buffer layer journals every such re-backing: a **monotonic growth generation** plus a list of
**re-backing notices** carrying the new SAB handle + layout per affected column. At each **wave fence**,
before the next dispatch, the worker pool reads the generation (a single integer check — zero cost when
nothing grew), and only if it advanced does it **drain** the notices and broadcast them to every worker.
Each worker re-wraps the named columns onto their new backing and **acknowledges on the wave counter**;
the dispatch does not proceed until all workers have applied. The new SAB references travel by
`postMessage` (a `SharedArrayBuffer` cannot ride inside another SAB), while the *signal* to apply rides
the same Atomics fence the wave loop already uses — so the result stays **serial-equivalent at any column
size**, with no per-wave overhead in steady state.

This is the producer side of `applyColumnsAdded` on the worker view: in-place growth emits nothing
(views auto-widen); only re-backing onto a new SAB produces a notice.

## Version gating

The wire is versioned (`SERIALIZATION_FORMAT_VERSION`). On load, the deserializer range-checks the
header version and **throws** on an unsupported version or a schema mismatch rather than silently
mis-reading bytes. The zero-copy worker `attachWorld` likewise throws on a `schemaHash` mismatch — a
worker built from a different component schema than the host is rejected as stale code, not run blindly.

## Carrying entity references across the wire (RF-NOREMAP)

::: warning A handle stored inside an `object<T>` is NOT remapped
On a round-trip, entity ids are remapped — but only through the channels the serializer can see:
**`eid` column fields** and **relation targets**. An `EntityHandle` buried inside an `object<T>()` rich
field is opaque JSON; it is serialized as a raw number and is **not** remapped, so after loading it
points into the producer's index space and is almost certainly invalid.
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

- [Reactivity](/guide/reactivity) — `changedSince` reads the same version stamps the delta rides.
- [Parallelism](/guide/parallelism) — the zero-copy `bootstrapForWorker` / `attachWorld` handoff.
