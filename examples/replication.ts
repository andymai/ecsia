// Network replication between two worlds. A "server" world runs a small seeded simulation —
// units drifting under a Movement system, with periodic spawn/despawn churn, an entity-reference
// field, and a ChildOf relation — and a "client" world mirrors it over a MessageChannel (a pair of
// connected message ports, the same API a WebSocket or worker port gives you). The server
// broadcasts one ReplicationMessage per tick; the client applies each through a
// ReplicationReceiver, which checks that every delta chains onto the tick it last applied. Three
// things happen mid-run: the client joins after the stream has already started (it gets a full
// baseline taken at the same flush as that tick's delta, so the deltas chain cleanly); churn keeps
// creating and destroying entities after the join (the receiver's remap table grows to cover
// them); and one message is deliberately dropped (the client notices the broken chain, reports
// needBaseline, asks the server to resync, and convergence resumes from a fresh baseline). At the
// end, every server entity must have a client counterpart with byte-equal component values, found
// through a stable id — entity handles differ across worlds, so identity rides an Identity
// component and the comparison looks entities up by uid, never by raw handle.

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  createRelations,
  createReplicationStream,
  createReplicationReceiver,
  encodeReplicationMessage,
  decodeReplicationMessage,
  read,
  write,
} from 'ecsia'
import type { EntityHandle, World } from 'ecsia'

export interface ReplicationOptions {
  /** Total simulation ticks. Default 30. */
  readonly ticks?: number
  /** Tick at which the client joins the stream. Default 5. */
  readonly joinTick?: number
  /** Tick whose delta is deliberately dropped in transit. Default 12. */
  readonly dropTick?: number
  /** Spawn one unit and despawn the oldest every N ticks. Default 3. */
  readonly churnEvery?: number
  /** Seed for the random-number generator. Default 1. */
  readonly seed?: number
}

export interface ReplicationResult {
  readonly ticks: number
  readonly entitiesServer: number
  readonly entitiesClient: number
  /** Largest absolute difference across all mirrored component fields (0 ⇒ byte-equal). */
  readonly maxFieldDelta: number
  /** Baselines sent in response to the client's needBaseline request (the drop ⇒ exactly 1). */
  readonly resyncs: number
  /** The server's entity-reference field resolves to the remapped client entity. */
  readonly eidResolved: boolean
  /** Every server ChildOf pair exists between the remapped client counterparts. */
  readonly pairResolved: boolean
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// Component definitions get their id when registered with a world, so each world builds its own
// set from the same source — exactly how a real client and server share one schema module. The
// schemaHash matches because the definitions match.
function makeDefs() {
  return {
    Identity: defineComponent({ uid: 'string' }, { name: 'identity' }),
    Position: defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' }),
    Velocity: defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' }),
    // An entity-reference column. 'eid' fields are remapped on apply, so the reference survives
    // the wire — unlike a handle hidden inside an object<T> field, which would not be.
    Follows: defineComponent({ target: 'eid' }, { name: 'follows' }),
  }
}

export async function main(opts: ReplicationOptions = {}): Promise<ReplicationResult> {
  const ticks = opts.ticks ?? 30
  const joinTick = opts.joinTick ?? 5
  const dropTick = opts.dropTick ?? 12
  const churnEvery = opts.churnEvery ?? 3
  const rand = seededRandom(opts.seed ?? 1)
  const dt = 1 / 60

  // --- the server world: components, a ChildOf relation, and a drifting-units sim -------------
  const S = makeDefs()
  const server = createWorld({ components: Object.values(S), maxEntities: 1 << 12 })
  const serverRel = createRelations(server)
  const ChildOf = serverRel.defineRelation(null, { exclusive: true })

  const anchor = server.spawnWith(
    [S.Identity, { uid: 'anchor' }],
    [S.Position, { x: 0, y: 0 }],
    [S.Velocity, { dx: 0, dy: 0 }],
  )
  const spawnUnit = (uid: string): EntityHandle => {
    const h = server.spawnWith(
      [S.Identity, { uid }],
      [S.Position, { x: (rand() - 0.5) * 100, y: (rand() - 0.5) * 100 }],
      [S.Velocity, { dx: (rand() - 0.5) * 10, dy: (rand() - 0.5) * 10 }],
    )
    serverRel.addPair(h, ChildOf, anchor)
    return h
  }
  let unitCounter = 0
  const units: EntityHandle[] = []
  for (let i = 0; i < 4; i++) units.push(spawnUnit(`unit-${unitCounter++}`))
  // The follower tracks the newest unit through its eid reference field.
  const follower = server.spawnWith(
    [S.Identity, { uid: 'follower' }],
    [S.Position, { x: 0, y: 0 }],
    [S.Velocity, { dx: 0, dy: 0 }],
    [S.Follows, { target: units[units.length - 1]! }],
  )

  const Movement = defineSystem({
    name: 'Movement',
    read: [S.Velocity],
    write: [S.Position],
    run({ query }) {
      for (const e of query(read(S.Velocity), write(S.Position))) {
        e.position.x += e.velocity.dx * dt
        e.position.y += e.velocity.dy * dt
      }
    },
  })
  const serverScheduler = createScheduler(server, [Movement])

  // --- the client world: same schema source, no simulation — it only mirrors ------------------
  const C = makeDefs()
  const client = createWorld({ components: Object.values(C), maxEntities: 1 << 12 })
  const clientRel = createRelations(client)
  const ChildOfClient = clientRel.defineRelation(null, { exclusive: true })

  // --- the wire: a MessageChannel carrying encoded bytes --------------------------------------
  // This example runs under Node, so the ports speak Node's event style — .on('message', data).
  // In a browser the same ports use port.addEventListener('message', (event) => ...) with the
  // payload on event.data, and a real network transport would be a WebSocket's message event.
  const channel = new MessageChannel()
  const stream = createReplicationStream(server)
  const receiver = createReplicationReceiver(client)

  let joined = false
  let pendingResync = false
  let resyncRequested = false
  let resyncs = 0

  channel.port2.on('message', (data: unknown) => {
    const msg = decodeReplicationMessage(data as Uint8Array)
    const result = receiver.apply(msg)
    if (msg.kind === 'baseline' && result.applied) {
      joined = true
      pendingResync = false
    } else if (result.needBaseline && joined && !pendingResync) {
      // The chain broke (a message was lost). Ask the server for a fresh baseline — once; more
      // unappliable deltas will arrive before the baseline does, and re-asking would re-baseline
      // for nothing.
      pendingResync = true
      channel.port2.postMessage('need-baseline')
    }
  })
  channel.port1.on('message', (data: unknown) => {
    if (data === 'need-baseline') resyncRequested = true
  })

  // MessagePort delivery is asynchronous: yield a few macrotasks so each tick's messages (and the
  // client's possible resync request) land before the next tick.
  const pump = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
  }

  // --- the broadcast loop ----------------------------------------------------------------------
  for (let t = 1; t <= ticks; t++) {
    serverScheduler.update(dt)
    if (t % churnEvery === 0) {
      server.despawn(units.shift()!)
      const newest = spawnUnit(`unit-${unitCounter++}`)
      units.push(newest)
      server.entity(follower).write(S.Follows).target = newest
    }

    // One emission per tick. Everything below happens at the same serial flush, which is what
    // lets a baseline chain onto the broadcast stream: its tick equals this delta's target tick.
    const msg = stream.tick()
    if (t !== dropTick) channel.port1.postMessage(encodeReplicationMessage(msg))
    if (t === joinTick) {
      // The client joins mid-stream: full state now, deltas chain from here.
      channel.port1.postMessage(encodeReplicationMessage(stream.baseline()))
    }
    if (resyncRequested) {
      resyncRequested = false
      resyncs += 1
      channel.port1.postMessage(encodeReplicationMessage(stream.baseline()))
    }
    await pump()
  }
  await pump()

  // --- convergence: every server entity has a byte-equal client counterpart, found by uid -----
  type Mirrored = { uid: string; x: number; y: number; dx: number; dy: number }
  const collect = (world: World, defs: ReturnType<typeof makeDefs>): Mirrored[] => {
    const out: Mirrored[] = []
    for (const e of world.query(read(defs.Identity), read(defs.Position), read(defs.Velocity))) {
      out.push({ uid: e.identity.uid, x: e.position.x, y: e.position.y, dx: e.velocity.dx, dy: e.velocity.dy })
    }
    return out
  }
  const serverEntities = collect(server, S)
  const clientEntities = collect(client, C)
  // The client-side uid → handle lookup. Replicated handles are client-local mints, so identity
  // crosses the wire as the Identity uid, and counterparts are found by that stable id.
  // WORKAROUND: a hand-rolled query map instead of createStableIndex, deliberately —
  // createStableIndex is currently unsafe across load(…, 'replace') / recycled entity indices:
  // SidecarStore.readForObserver returns the pending-clear stash keyed by index only, so onAdd
  // observers read PRE-load rich values after a second replace-load (every resync baseline here),
  // permanently corrupting the index (core bug, tracked). Don't "clean this up" back to
  // createStableIndex until that is fixed.
  const clientByUid = new Map<string, EntityHandle>()
  for (const e of client.query(read(C.Identity))) clientByUid.set(e.identity.uid, e.handle)

  let maxFieldDelta = 0
  for (const se of serverEntities) {
    const counterpart = clientByUid.get(se.uid)
    if (counterpart === undefined) {
      maxFieldDelta = Number.POSITIVE_INFINITY
      continue
    }
    // world.entity() reuses one pooled reference — copy fields out before the next read.
    const p = client.entity(counterpart).read(C.Position)
    const px = p.x
    const py = p.y
    const v = client.entity(counterpart).read(C.Velocity)
    for (const d of [Math.abs(se.x - px), Math.abs(se.y - py), Math.abs(se.dx - v.dx), Math.abs(se.dy - v.dy)]) {
      maxFieldDelta = Math.max(maxFieldDelta, d)
    }
  }

  // The eid reference: the server follower points at the newest unit; the client follower must
  // point at that unit's CLIENT counterpart (the remapped handle, not the server's).
  const serverTargetUid = server.entity(server.entity(follower).read(S.Follows).target).read(S.Identity).uid
  const clientFollower = clientByUid.get('follower')
  const eidResolved =
    clientFollower !== undefined &&
    client.entity(clientFollower).read(C.Follows).target === clientByUid.get(serverTargetUid)

  // The relation: every live unit is ChildOf the anchor on the client too, across the remap.
  const clientAnchor = clientByUid.get('anchor')
  let pairResolved = clientAnchor !== undefined
  for (const u of units) {
    const uid = server.entity(u).read(S.Identity).uid
    const cu = clientByUid.get(uid)
    pairResolved = pairResolved && cu !== undefined && clientAnchor !== undefined && clientRel.hasPair(cu, ChildOfClient, clientAnchor)
  }

  channel.port1.close()
  channel.port2.close()

  return {
    ticks,
    entitiesServer: serverEntities.length,
    entitiesClient: clientEntities.length,
    maxFieldDelta,
    resyncs,
    eidResolved,
    pairResolved,
  }
}
