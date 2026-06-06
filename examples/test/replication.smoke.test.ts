// Smoke + regression test for the network-replication example. It locks in the documented flow:
// a server world broadcasting encoded ReplicationMessages over a MessageChannel, a client joining
// mid-stream (baseline + chained deltas), spawn/despawn churn growing the receiver's remap, and
// one dropped message triggering needBaseline → a single server resync → resumed convergence.
// Convergence is keyed by stable id — a createStableIndex over the Identity uid, never a raw
// entity handle. The index is observer-maintained across the receiver's replace-loads (every
// baseline/resync re-mints each entity index), so this run doubles as the end-to-end regression
// test for the rich observer-window read at recycled indices.

import { describe, expect, test } from 'vitest'
import { main as replication } from '../replication.js'

describe('example: replication (join mid-stream + churn + drop/resync)', () => {
  test('client converges byte-equal to the server, with exactly one resync', async () => {
    const r = await replication({ ticks: 30, joinTick: 5, dropTick: 12, churnEvery: 3, seed: 1 })

    expect(r.ticks).toBe(30)
    // Equal entity counts, and every mirrored field byte-equal (no epsilon in this run).
    expect(r.entitiesClient).toBe(r.entitiesServer)
    expect(r.maxFieldDelta).toBe(0)
    // The dropped delta broke the chain exactly once → exactly one needBaseline resync.
    expect(r.resyncs).toBe(1)
    // The eid reference and the ChildOf pairs resolve across the remap, not to producer handles.
    expect(r.eidResolved).toBe(true)
    expect(r.pairResolved).toBe(true)
  })

  test('is deterministic for a fixed seed', async () => {
    const a = await replication({ ticks: 24, joinTick: 4, dropTick: 10, seed: 7 })
    const b = await replication({ ticks: 24, joinTick: 4, dropTick: 10, seed: 7 })
    expect(b).toEqual(a)
  })
})
