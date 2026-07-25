// INTEGRATION — the BROWSER pool path, emulated end-to-end in Node: an injected non-blocking
// transport (mainThreadMayBlock: false → the tier-1 Atomics.waitAsync wave fence, the browser-main
// tier) delivers the bootstrap as the first postMessage to a worker running the BUILT
// dist/workers/browser-entry.js (`ecsiaWorker`, the '@ecsia/scheduler/worker' subpath) over a
// Web-Worker-global shim. No kernelModule anywhere — kernels are statically supplied, exactly like a
// bundled browser worker file. The threaded run must reproduce the single-thread executor's column
// state (parallel equals serial, over the browser tiers).

import { fileURLToPath } from 'node:url'
import { Worker as NodeWorker } from 'node:worker_threads'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { WorkerPool } from '@ecsia/scheduler/workers'
import type { WorkerTransport } from '@ecsia/scheduler/workers'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const SHIM_ENTRY = fileURLToPath(new URL('./fixtures/web-worker-shim-entry.mjs', import.meta.url))

/** The browser transport's shape (bootstrap via first postMessage), spawning over the WW shim. */
function browserishTransport(): WorkerTransport {
  return {
    mainThreadMayBlock: false,
    spawn(boot) {
      const worker = new NodeWorker(SHIM_ENTRY)
      worker.postMessage({ kind: 'ecsia:bootstrap', boot })
      const errCbs: ((err: unknown) => void)[] = []
      let terminated = false
      worker.on('error', (err) => {
        for (const cb of errCbs) cb(err)
      })
      worker.on('exit', (code) => {
        if (terminated || code === 0) return
        for (const cb of errCbs) cb(new Error(`worker exited unexpectedly with code ${code}`))
      })
      return {
        postMessage: (msg) => worker.postMessage(msg),
        onMessage: (cb) => worker.on('message', cb),
        onError: (cb) => {
          errCbs.push(cb)
        },
        terminate: async () => {
          terminated = true
          await worker.terminate()
        },
      }
    },
  }
}

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

function seedWorld(threaded: boolean, workers: number, n: number) {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld(
    threaded
      ? { components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers } }
      : { components: [Health, Mana], maxEntities: 1 << 12 },
  )
  const handles: EntityHandle[] = []
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Health, Mana)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    ;(world.entity(h).write(Mana) as { mp: number }).mp = 100 + i
    handles.push(h)
  }
  return { world, Health, Mana, handles }
}

describe('browser transport path (waitAsync tier + ecsiaWorker bootstrap) reproduces the serial result', () => {
  test('disjoint-write wave over 2 workers, no kernelModule: column state matches single-thread', async () => {
    const N = 48
    const FRAMES = 3

    const ref = seedWorld(false, 0, N)
    const Regen = defineSystem({
      name: 'Regen',
      read: [],
      write: [ref.Health],
      run({ query }) {
        for (const e of query(write(ref.Health)) as Iterable<{ health: { hp: number } }>) e.health.hp += 1
      },
    })
    const Channel = defineSystem({
      name: 'Channel',
      read: [],
      write: [ref.Mana],
      run({ query }) {
        for (const e of query(write(ref.Mana)) as Iterable<{ mana: { mp: number } }>) e.mana.mp -= 1
      },
    })
    const refSched = createScheduler(ref.world, [Regen, Channel])

    const thr = seedWorld(true, 2, N)
    const RegenT = defineSystem({ name: 'Regen', read: [], write: [thr.Health], run() {} })
    const ChannelT = defineSystem({ name: 'Channel', read: [], write: [thr.Mana], run() {} })
    const thrSched = createScheduler(thr.world, [RegenT, ChannelT], { workers: 2 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
      { id: 1 as unknown as SystemId, name: 'Channel', matchComponents: [thr.Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({ world: thr.world, workers: 2, systems, transport: browserishTransport() })
    await pool.ready()

    for (let f = 0; f < FRAMES; f++) {
      refSched.update(1)
      await thrSched.updateThreaded(pool, 1)
    }

    expect(thr.world.phase).toBe('serial')
    for (let i = 0; i < N; i++) {
      expect((thr.world.entity(thr.handles[i]!).read(thr.Health) as { hp: number }).hp).toBe(
        (ref.world.entity(ref.handles[i]!).read(ref.Health) as { hp: number }).hp,
      )
      expect((thr.world.entity(thr.handles[i]!).read(thr.Mana) as { mp: number }).mp).toBe(
        (ref.world.entity(ref.handles[i]!).read(ref.Mana) as { mp: number }).mp,
      )
    }
  })

  test('pool without transport and without kernelModule fails loud (node default needs kernels)', () => {
    const thr = seedWorld(true, 1, 4)
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    expect(() => new WorkerPool({ world: thr.world, workers: 1, systems })).toThrow(/kernelModule/)
  })

  test('a worker crash mid-wave rejects the update (fence raced against failure) and latches the pool broken', async () => {
    const thr = seedWorld(true, 1, 4)
    const KrashT = defineSystem({ name: 'Krash', read: [], write: [thr.Health], run() {} })
    const thrSched = createScheduler(thr.world, [KrashT], { workers: 1 })
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Krash', matchComponents: [thr.Health], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({ world: thr.world, workers: 1, systems, transport: browserishTransport(), diagnostic: () => {} })
    await pool.ready()

    // The Krash kernel process.exit(3)s BEFORE completing the wave: without the failure race this
    // await would strand forever. It must reject loudly instead.
    await expect(thrSched.updateThreaded(pool, 1)).rejects.toThrow(/crashed|exited/)
    // And the pool stays latched broken — further rounds refuse instead of dispatching into a dead pool.
    await expect(pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)).rejects.toThrow(/failed|crashed/)
  })
})
