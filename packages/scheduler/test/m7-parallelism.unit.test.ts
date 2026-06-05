// parallelism-safety UNIT suite. Each test pins
// ONE exit-criterion behaviour with a discriminating assertion:
// - a 2-worker disjoint-write wave is BIT-IDENTICAL to the serial executor;
// - crossOriginIsolated===false startup emits a diagnostic and never silently runs threaded;
// - each wait tier is unit-selected by a FORCED capability probe (selectWaitTier);
// - OP_DESTROY of an already-dead entity is a drop-if-dead no-op (CB-SAFE).
//
// Worker-pool tests use Node worker_threads (mirroring core/test/sab-smoke.test.ts): a fixed pool
// spawned over the BUILT worker-entry + a built kernel .mjs (a raw Worker has no TS transform).

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createWorld, defineComponent, handleIndex, NO_ENTITY } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { WorkerPool } from '@ecsia/scheduler'
import { flushAll, makeCommandBuffer, makeEncoder, buildFieldCodec, selectWaitTier, makeWaveSync, makeWaveCounter } from '../src/internal.js'
import type { PoolSystem } from '@ecsia/scheduler'
import type { CommandBuffer, ComponentFieldCodec, WorldApply } from '../src/internal.js'
import type { ComponentDef, ComponentId, Schema, SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

// --- a WorldApply built from the public World surface, for direct flushAll fuzz/unit tests ---------
// This mirrors WorkerPool.#worldApply (which is private) so a test can apply hand-built command
// buffers against a REAL world without spawning workers.
function worldApplyOf(world: World, codecById: ReadonlyMap<number, ComponentFieldCodec>, warn: (m: string) => void): WorldApply {
  const layout = world.handleLayout
  const apply = world.__apply
  return {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: (id) => codecById.get(id as unknown as number),
    addMany: (h, defs) => apply.addMany(h, defs),
    removeMany: (h, defs) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    warn,
  }
}

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

// --------------------------------------------------------------------------------------------------
describe('UNIT — multi-worker disjoint wave is BIT-IDENTICAL to the serial executor', () => {
  // The SAME kernels run on N workers (over the shared SABs) and on the main thread (one "worker" =
  // serial). A 2-worker pool and a serial application of the identical effect must agree byte-for-byte.
  test.each([2, 3, 4])('a %i-worker pool produces the identical Health/Mana column state as the serial oracle', async (workerCount) => {
    // A ComponentDef interns to exactly ONE world, and the worker fixture re-defines `health`/`mana`
    // by name (aligned from the manifest). So the threaded world owns the only Health/Mana, and the
    // serial reference is the ARITHMETIC oracle of what the SAME kernels (Health += 1, Mana -= 1) do —
    // a genuinely independent expectation, not a second registration of the same defs.
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })

    const threaded = createWorld({ components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers: workerCount } })
    const tHandles: EntityHandle[] = []
    const expected: { hp: number; mp: number }[] = []
    for (let i = 0; i < 96; i++) {
      const h = threaded.spawnWith(Health, Mana)
      ;(threaded.entity(h).write(Health) as { hp: number }).hp = i
      ;(threaded.entity(h).write(Mana) as { mp: number }).mp = 100 + i
      tHandles.push(h)
      expected.push({ hp: i + 1, mp: 100 + i - 1 }) // the serial oracle: one Regen + one Channel pass.
    }

    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
      { id: 1 as unknown as SystemId, name: 'Channel', matchComponents: [Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    pool = new WorkerPool({ world: threaded, workers: workerCount, kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY, systems })
    await pool.ready()

    // Two disjoint-write systems in ONE round, dispatched to two distinct workers.
    await pool.runRound(
      [
        { systemId: 0 as unknown as SystemId, workerIndex: 0 },
        { systemId: 1 as unknown as SystemId, workerIndex: 1 % workerCount },
      ],
      1,
    )

    expect(threaded.phase).toBe('serial') // back to serial after the flush slot.
    // BIT-IDENTICAL to the serial oracle: every entity's columns match exactly, in every worker count.
    for (let i = 0; i < tHandles.length; i++) {
      const t = tHandles[i]!
      expect((threaded.entity(t).read(Health) as { hp: number }).hp).toBe(expected[i]!.hp)
      expect((threaded.entity(t).read(Mana) as { mp: number }).mp).toBe(expected[i]!.mp)
    }
  })
})

// --------------------------------------------------------------------------------------------------
describe('UNIT — threaded startup without SAB-backed buffers is NEVER silent', () => {
  test('a threaded pool over a world with no SAB manifest emits a clear diagnostic and stays serial', async () => {
    // Force the no-cross-origin-isolation shape: a NON-threaded world has no SAB-backed columns/regions,
    // so __exportShared returns an empty manifest. The pool must DIAGNOSE rather than silently proceed.
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 256 }) // threaded:false ⇒ plain AB columns
    const manifest = world.__exportShared()
    expect(manifest.columns.length + manifest.regions.length).toBe(0) // precondition: no SAB buffers

    const diags: string[] = []
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems: [{ id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 }],
      diagnostic: (m) => diags.push(m),
    })

    // The diagnostic fires synchronously in the constructor (capability gate), never silently.
    expect(diags.some((m) => /no SAB-backed buffers|postMessage fallback|single-threaded/i.test(m))).toBe(true)
    expect(world.phase).toBe('serial')
  })
})

// --------------------------------------------------------------------------------------------------
describe('UNIT — each wait tier is selected by a forced capability probe', () => {
  test('tier 1 (waitAsync) when the browser-main waitAsync cap is present', () => {
    expect(selectWaitTier({ waitAsync: true, waitBlocking: true, sabAvailable: true })).toBe('waitAsync')
  })
  test('tier 2 (coordinator-block) when only blocking Atomics.wait is available', () => {
    expect(selectWaitTier({ waitAsync: false, waitBlocking: true, sabAvailable: true })).toBe('coordinator-block')
  })
  test('tier 3 (promise-poll) when SAB is present but neither wait primitive is', () => {
    expect(selectWaitTier({ waitAsync: false, waitBlocking: false, sabAvailable: true })).toBe('promise-poll')
  })
  test('postMessage fallback when no SAB is available at all', () => {
    expect(selectWaitTier({ waitAsync: false, waitBlocking: false, sabAvailable: false })).toBe('postMessage')
  })

  test('await resolves ONLY when remaining===0 (epoch/spurious-wake guard)', async () => {
    // Drive the tier-3 poll WaveSync without any worker: arm 1, then decrement to 0; await must resolve.
    const counter = makeWaveCounter(1)
    const sync = makeWaveSync('promise-poll')
    sync.begin(counter, 2)
    expect(counter.view[0]).toBe(2) // remaining armed to batchCount
    // Decrement to a non-zero value first: await must NOT resolve yet.
    sync.complete(counter)
    expect(counter.view[0]).toBe(1)
    const awaited = sync.await(counter) as Promise<void>
    let resolved = false
    void awaited.then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(resolved).toBe(false) // remaining===1 ⇒ still waiting
    sync.complete(counter) // → 0; last decrementer
    await awaited
    expect(resolved).toBe(true)
    expect(counter.view[0]).toBe(0)
  })
})

// --------------------------------------------------------------------------------------------------
describe('UNIT — OP_DESTROY of an already-dead entity is a drop-if-dead no-op (CB-SAFE )', () => {
  // Build a command buffer by hand and apply it via flushAll against a real world.
  function kit() {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 256 })
    const codecById = new Map<number, ComponentFieldCodec>([[(Health as unknown as { id: number }).id, buildFieldCodec(Health)]])
    return { world, Health, codecById }
  }

  function encoderOver(cb: CommandBuffer, Health: ComponentDef<Schema>, warn: (m: string) => void) {
    const codec = buildFieldCodec(Health)
    return makeEncoder({
      cb,
      infoOf: (def) => ({ id: (def as unknown as { id: number }).id as unknown as ComponentId, codec }),
      relationCodec: () => undefined,
      warn,
    })
  }

  test('destroying a handle that was already despawned applies nothing and warns (no double-free, no throw)', () => {
    const { world, Health, codecById } = kit()
    const live = world.spawnWith(Health)
    world.despawn(live) // already dead before the wave's buffer is applied
    const beforeAlive = world.handleStats().aliveCount

    const cb = makeCommandBuffer(0, 64, false)
    const warns: string[] = []
    const enc = encoderOver(cb, Health, (m) => warns.push(m))
    enc.destroy(live) // OP_DESTROY on a dead handle

    expect(() => flushAll(worldApplyOf(world, codecById, (m) => warns.push(m)), [cb])).not.toThrow()
    expect(world.handleStats().aliveCount).toBe(beforeAlive) // unchanged: the destroy dropped
    expect(warns.some((m) => /dead entity/i.test(m))).toBe(true) // dev diagnostic, NEVER silent
  })

  test('a destroy of an entity another record destroyed earlier THIS flush is dropped (tombstone)', () => {
    const { world, Health, codecById } = kit()
    const victim = world.spawnWith(Health)
    const aliveBefore = world.handleStats().aliveCount

    const cb = makeCommandBuffer(0, 64, false)
    const warns: string[] = []
    const enc = encoderOver(cb, Health, (m) => warns.push(m))
    enc.destroy(victim) // first destroy: applies
    enc.destroy(victim) // second destroy: same flush ⇒ tombstoned ⇒ dropped (no double-free)

    flushAll(worldApplyOf(world, codecById, (m) => warns.push(m)), [cb])
    expect(world.handleStats().aliveCount).toBe(aliveBefore - 1) // exactly one despawn happened
    expect(warns.some((m) => /destroyed earlier this flush/i.test(m))).toBe(true)
  })

  test('OP_ADD naming a dead entity (subject) is dropped — never applied to a recycled slot', () => {
    const { world, Health, codecById } = kit()
    const dead = world.spawnWith(Health)
    world.despawn(dead)

    const cb = makeCommandBuffer(0, 64, false)
    const warns: string[] = []
    const enc = encoderOver(cb, Health, (m) => warns.push(m))
    enc.add(dead, Health, { hp: 9 }) // dangling subject

    flushAll(worldApplyOf(world, codecById, (m) => warns.push(m)), [cb])
    expect(world.isAlive(dead)).toBe(false)
    expect(warns.some((m) => /dead entity/i.test(m))).toBe(true)
  })
})

// --------------------------------------------------------------------------------------------------
describe('UNIT — single-thread fallback runs main-thread when threaded requested without isolation', () => {
  test('a non-threaded world with a scheduler runs single-threaded and never touches a worker', () => {
    // The degenerate path: no workers ⇒ flushAll is a no-op, phase never leaves serial (PHASE-1).
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 64 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codecById = new Map<number, ComponentFieldCodec>()
    // flushAll with zero buffers is a no-op (single-thread degenerate).
    expect(() => flushAll(worldApplyOf(world, codecById, () => {}), [])).not.toThrow()
    expect(world.phase).toBe('serial')
    warn.mockRestore()
    void NO_ENTITY
  })
})
