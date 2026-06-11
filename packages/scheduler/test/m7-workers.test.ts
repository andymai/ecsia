// smoke: a 2-worker DISJOINT-WRITE wave runs over the shared SAB buffer set and is
// SERIAL-EQUIVALENT to the single-threaded result. Exercises: one-time SAB column transfer, the
// Atomics wave fence, the reservation Atomics.sub take path layout, per-worker command buffers, and
// the deterministic worker-index merge.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { WorkerPool } from '@ecsia/scheduler/workers'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

function makeWorld(): {
  world: World
  Health: ReturnType<typeof defineComponent>
  Mana: ReturnType<typeof defineComponent>
  handles: EntityHandle[]
} {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld({
    components: [Health, Mana],
    maxEntities: 1 << 12,
    threaded: true,
    scheduler: { workers: 2 },
  })
  const handles: EntityHandle[] = []
  for (let i = 0; i < 64; i++) {
    const h = world.spawnWith(Health, Mana)
    const hv = world.entity(h).write(Health) as { hp: number }
    hv.hp = i
    const mv = world.entity(h).write(Mana) as { mp: number }
    mv.mp = 100 + i
    handles.push(h)
  }
  return { world, Health, Mana, handles }
}

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

describe('worker pool — 2-worker disjoint-write wave (serial-equivalent)', () => {
  test('two disjoint-write systems run concurrently on two workers and match the serial result', async () => {
    const { world, Health, Mana, handles } = makeWorld()

    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'Regen',
        matchComponents: [Health],
        kernel: () => {},
        maxSpawnsPerWave: 0,
      },
      {
        id: 1 as unknown as SystemId,
        name: 'Channel',
        matchComponents: [Mana],
        kernel: () => {},
        maxSpawnsPerWave: 0,
      },
    ]

    pool = new WorkerPool({
      world,
      workers: 2,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
    })
    await pool.ready()

    // One round: Regen (worker 0, writes Health) + Channel (worker 1, writes Mana) run concurrently.
    await pool.runRound(
      [
        { systemId: 0 as unknown as SystemId, workerIndex: 0 },
        { systemId: 1 as unknown as SystemId, workerIndex: 1 },
      ],
      1,
    )

    // world.phase must be back to 'serial' after the flush slot (PHASE-2).
    expect(world.phase).toBe('serial')

    // Serial-equivalent expectation: Health += 1, Mana -= 1 for every entity (the kernels' effect).
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!
      expect((world.entity(h).read(Health) as { hp: number }).hp).toBe(i + 1)
      expect((world.entity(h).read(Mana) as { mp: number }).mp).toBe(100 + i - 1)
    }
  })

  test('a worker structural wave (OP_CREATE + OP_ADD) applies via the deterministic merge', async () => {
    const { world, Health, Mana, handles } = makeWorld()
    const before = world.handleStats().aliveCount
    const systems: PoolSystem[] = [
      {
        id: 0 as unknown as SystemId,
        name: 'Spawner',
        matchComponents: [Health],
        kernel: () => {},
        maxSpawnsPerWave: handles.length, // one spawn per matched Health entity
      },
    ]
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      components: [Health, Mana],
    })
    await pool.ready()

    await pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)

    expect(world.phase).toBe('serial')
    // Each of the 64 Health entities spawned one Mana child this wave: alive count grows by 64.
    expect(world.handleStats().aliveCount).toBe(before + handles.length)
    // Every new child carries Mana = 7 (the OP_ADD initial payload). Query Mana-only entities.
    let childrenWithMana = 0
    for (const e of world.query(Mana) as Iterable<{ mana: { mp: number } }>) {
      if (e.mana.mp === 7) childrenWithMana++
    }
    expect(childrenWithMana).toBe(handles.length)
  })

  test('reservation exhaustion mid-wave caps spawns with NO spurious OP_CREATE and no corruption (issue #2)', async () => {
    // The spawner matches 64 Health entities but maxSpawnsPerWave is UNDER-SIZED (16). The worker's
    // takeReserved() returns NO_ENTITY after 16 takes; the worker-entry create override must then emit
    // NOTHING — NOT a spurious OP_CREATE 0xffffffff that the apply path would
    // try to spawnReserved(NO_ENTITY) → record-table corruption. So the wave spawns EXACTLY 16 children,
    // never crashes, and the world stays consistent.
    const { world, Health, Mana, handles } = makeWorld()
    const CAP = 16
    const before = world.handleStats().aliveCount
    const diags: string[] = []
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Spawner', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: CAP },
    ]
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      components: [Health, Mana],
      diagnostic: (m) => diags.push(m),
    })
    await pool.ready()

    await expect(pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)).resolves.toBeUndefined()

    expect(world.phase).toBe('serial')
    // Exactly CAP children spawned (the rest silently capped) — no spurious create applied a NO_ENTITY.
    expect(world.handleStats().aliveCount).toBe(before + CAP)
    let childrenWithMana = 0
    for (const e of world.query(Mana) as Iterable<{ mana: { mp: number } }>) {
      if (e.mana.mp === 7) childrenWithMana++
    }
    expect(childrenWithMana).toBe(CAP)
    // The exhaustion is a recoverable diagnostic, never a crash/corruption (no 'corrupt'/'NO_ENTITY spawn').
    expect(diags.some((m) => /corrupt|record-table|spawnReserved/i.test(m))).toBe(false)
    // The original 64 Health entities are untouched and alive (no slot corruption from a bogus index).
    for (const h of handles) expect(world.isAlive(h)).toBe(true)
  })

  test('three rounds compose deterministically (Health grows by 3, Mana shrinks by 3)', async () => {
    const { world, Health, Mana, handles } = makeWorld()
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
      { id: 1 as unknown as SystemId, name: 'Channel', matchComponents: [Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({ world, workers: 2, kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY, systems })
    await pool.ready()

    for (let f = 0; f < 3; f++) {
      await pool.runRound(
        [
          { systemId: 0 as unknown as SystemId, workerIndex: 0 },
          { systemId: 1 as unknown as SystemId, workerIndex: 1 },
        ],
        1,
      )
    }

    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!
      expect((world.entity(h).read(Health) as { hp: number }).hp).toBe(i + 3)
      expect((world.entity(h).read(Mana) as { mp: number }).mp).toBe(100 + i - 3)
    }
  })
})
