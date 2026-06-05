// M7 PARALLELISM-SAFETY PROPERTY suite (fast-check). Each property is genuinely DISCRIMINATING — it
// would fail if the safety invariant it guards were broken — and is checked against an INDEPENDENT
// oracle, never the implementation's own helpers.
//
//   SERIAL-EQUIVALENCE (headline, SCH-3 / CB-2): a random structural workload applied across MANY
//     per-worker command buffers (nondeterministic encoding order, simulated by shuffling worker
//     buffers) yields the IDENTICAL world (entity set + component values) as the deterministic
//     fixed-worker-index merge. Determinism despite nondeterministic completion order.
//   ENTITY-REF SAFETY (the M7-gating fuzz, CB-SAFE §8): random interleaved create/destroy/add streams
//     across workers — every dangling ref is DROPPED (never applied to a recycled slot); OP_ADD_PAIR
//     with a dead target dropped; reserved-ID create-then-use chains within a flush always succeed.
//   NO WORKER BITMASK ACCESS (Must-Fix #1): the bitmask phase gate throws on ANY read/write while
//     world.phase==='wave'; a fuzzed multi-worker run records ZERO bitmask access off the wave.
//   NO MID-WAVE STRUCTURAL MUTATION (CO-1): no archetype rows / record / alive-count change while
//     world.phase==='wave' across a fuzzed multi-worker run.

import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, handleIndex, onAdd, onRemove, onChange } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { WorkerPool } from '@ecsia/scheduler'
import { flushAll, makeCommandBuffer, makeEncoder, buildFieldCodec } from '../src/internal.js'
import type { PoolSystem } from '@ecsia/scheduler'
import type { CommandBuffer, CommandEncoder, ComponentFieldCodec, WorldApply } from '../src/internal.js'
import type { ComponentDef, ComponentId, Schema, SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

// --- shared scaffolding ---------------------------------------------------------------------------
interface Kit {
  world: World
  Health: ComponentDef<Schema>
  Mana: ComponentDef<Schema>
  codecById: Map<number, ComponentFieldCodec>
  seeds: EntityHandle[]
}

function makeKit(seedCount: number): Kit {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 13 })
  const codecById = new Map<number, ComponentFieldCodec>([
    [(Health as unknown as { id: number }).id, buildFieldCodec(Health)],
    [(Mana as unknown as { id: number }).id, buildFieldCodec(Mana)],
  ])
  const seeds: EntityHandle[] = []
  for (let i = 0; i < seedCount; i++) {
    const h = world.spawnWith(Health)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    seeds.push(h)
  }
  return { world, Health, Mana, codecById, seeds }
}

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

function encoderOver(cb: CommandBuffer, codecOf: (id: number) => ComponentFieldCodec, warn: (m: string) => void): CommandEncoder {
  return makeEncoder({
    cb,
    infoOf: (def) => {
      const id = (def as unknown as { id: number }).id
      return { id: id as unknown as ComponentId, codec: codecOf(id) }
    },
    relationCodec: () => undefined,
    warn,
  })
}

// --- a buffer-program generator: a list of ops per worker, each over the seed/reserved id space ----
type ProgOp =
  | { kind: 'destroy'; seed: number }
  | { kind: 'add'; seed: number; hp: number }
  | { kind: 'setpayload'; seed: number; hp: number }
  | { kind: 'create-add' } // reserved create, then add Mana to the fresh handle (create-then-use)

const progOp = (seedCount: number): fc.Arbitrary<ProgOp> =>
  fc.oneof(
    fc.record({ kind: fc.constant('destroy' as const), seed: fc.integer({ min: 0, max: seedCount - 1 }) }),
    fc.record({ kind: fc.constant('add' as const), seed: fc.integer({ min: 0, max: seedCount - 1 }), hp: fc.integer({ min: -1000, max: 1000 }) }),
    fc.record({ kind: fc.constant('setpayload' as const), seed: fc.integer({ min: 0, max: seedCount - 1 }), hp: fc.integer({ min: -1000, max: 1000 }) }),
    fc.record({ kind: fc.constant('create-add' as const) }),
  )

function encodeProgram(
  enc: CommandEncoder,
  ops: readonly ProgOp[],
  seeds: readonly EntityHandle[],
  Health: ComponentDef<Schema>,
  Mana: ComponentDef<Schema>,
): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'destroy':
        enc.destroy(seeds[op.seed]!)
        break
      case 'add':
        enc.add(seeds[op.seed]!, Mana, { mp: op.hp })
        break
      case 'setpayload':
        enc.setPayload(seeds[op.seed]!, Health, { hp: op.hp })
        break
      case 'create-add': {
        const child = enc.create()
        if ((child as unknown as number) >>> 0 !== 0xffffffff) enc.add(child, Mana, { mp: 7 })
        break
      }
    }
  }
}

// Reserve a block of live handles and load it into a buffer (mirrors prepareWave's reservation).
function fillReservationFor(world: World, cb: CommandBuffer, n: number): void {
  const block = world.reserveEntityBlock(0, n)
  cb.reservation = { handles: block.handles }
  cb.reservationCursor = 0
}

// A deterministic post-flush fingerprint: alive count + the multiset of (Health.hp) and (Mana.mp)
// over all alive entities. Independent of the implementation; order-insensitive via sorting.
function fingerprint(world: World, Health: ComponentDef<Schema>, Mana: ComponentDef<Schema>): { alive: number; hp: number[]; mp: number[] } {
  const hp: number[] = []
  const mp: number[] = []
  for (const v of world.query(Health) as Iterable<{ health: { hp: number } }>) hp.push(v.health.hp)
  for (const v of world.query(Mana) as Iterable<{ mana: { mp: number } }>) mp.push(v.mana.mp)
  hp.sort((a, b) => a - b)
  mp.sort((a, b) => a - b)
  return { alive: world.handleStats().aliveCount, hp, mp }
}

// CB-7 / spec-gap #4: capture the ORDERED reactivity delta stream the apply path emits. Observers fire
// at the serial drain, once per change, in the deterministic merge order — so two runs whose buffers
// re-sort to the same ascending-worker-index order MUST produce the byte-identical ordered stream.
interface ReactDelta {
  kind: string
  index: number
  component: number
}
function captureReactivity(world: World, Health: ComponentDef<Schema>, Mana: ComponentDef<Schema>): ReactDelta[] {
  const out: ReactDelta[] = []
  const layout = world.handleLayout
  const rec = (kind: string) => (e: { __handle: EntityHandle }, ctx: { component: number }) =>
    out.push({ kind, index: handleIndex(e.__handle, layout) as number, component: ctx.component })
  world.observe(onAdd(Mana), rec('add-mana'))
  world.observe(onRemove(Health), rec('remove-health'))
  world.observe(onChange(Health), rec('change-health'))
  world.observe(onChange(Mana), rec('change-mana'))
  return out
}
// Drive the serial drain so the captured stream reflects the just-applied flush.
function drainReactivity(world: World): void {
  world.maintainStructural()
  world.observerDrain()
  world.flushLogs()
}

// --------------------------------------------------------------------------------------------------
describe('SERIAL-EQUIVALENCE (headline, SCH-3 / CB-2)', () => {
  test('the SAME multi-worker workload applied in ANY completion order yields the IDENTICAL world as the fixed merge', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }), // worker count
        fc.array(fc.array(progOp(8), { maxLength: 6 }), { minLength: 2, maxLength: 4 }), // per-worker programs
        (_workers, perWorker) => {
          const SEED = 8
          // Build the canonical per-worker buffers once (encoding is deterministic per worker), then
          // apply them under TWO different "completion orders" (the array order is shuffled). flushAll
          // sorts by workerIndex internally, so BOTH must produce the identical world (CB-2).
          const buildBuffers = (k: Kit): CommandBuffer[] => {
            const bufs: CommandBuffer[] = []
            perWorker.forEach((ops, wi) => {
              const cb = makeCommandBuffer(wi, 256, false)
              fillReservationFor(k.world, cb, 8)
              const enc = encoderOver(cb, (id) => k.codecById.get(id)!, () => {})
              encodeProgram(enc, ops, k.seeds, k.Health, k.Mana)
              bufs.push(cb)
            })
            return bufs
          }

          // Run A: buffers applied in ascending order.
          const a = makeKit(SEED)
          const da = captureReactivity(a.world, a.Health, a.Mana)
          const bufsA = buildBuffers(a)
          flushAll(worldApplyOf(a.world, a.codecById, () => {}), bufsA)
          drainReactivity(a.world)
          const fa = fingerprint(a.world, a.Health, a.Mana)

          // Run B: buffers applied in REVERSED array order (simulating a different completion order).
          const b = makeKit(SEED)
          const db = captureReactivity(b.world, b.Health, b.Mana)
          const bufsB = buildBuffers(b)
          flushAll(worldApplyOf(b.world, b.codecById, () => {}), [...bufsB].reverse())
          drainReactivity(b.world)
          const fb = fingerprint(b.world, b.Health, b.Mana)

          // DEEP-COMPARE (1): entity count + component-value multisets are identical regardless of order.
          expect(fb).toEqual(fa)
          // DEEP-COMPARE (2, CB-7 / spec-gap #4): the ORDERED reactivity delta stream is identical too —
          // observed exactly once per change, in the deterministic ascending-worker-index merge order
          // (flushAll re-sorts both runs to the same order). A reorder or double-emit would diverge.
          expect(db).toEqual(da)
        },
      ),
      { numRuns: 120 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('COMMAND-BUFFER ENTITY-REF SAFETY (the M7-gating fuzz, CB-SAFE §8)', () => {
  test('every dangling reference is DROPPED — no applied op ever names a non-alive seed slot', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(progOp(6), { maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        (perWorker) => {
          const SEED = 6
          const k = makeKit(SEED)
          const bufs: CommandBuffer[] = []
          perWorker.forEach((ops, wi) => {
            const cb = makeCommandBuffer(wi, 256, false)
            fillReservationFor(k.world, cb, 8)
            const enc = encoderOver(cb, (id) => k.codecById.get(id)!, () => {})
            encodeProgram(enc, ops, k.seeds, k.Health, k.Mana)
            bufs.push(cb)
          })

          // Instrument the apply surface: capture every (addMany/removeMany/writePayload/despawn)
          // target and assert it was ALIVE at the moment of application (validate-then-apply, §8).
          const violations: string[] = []
          const base = worldApplyOf(k.world, k.codecById, () => {})
          const guarded: WorldApply = {
            ...base,
            addMany: (h, defs) => {
              if (!k.world.isAlive(h)) violations.push(`addMany on dead ${h}`)
              base.addMany(h, defs)
            },
            removeMany: (h, defs) => {
              if (!k.world.isAlive(h)) violations.push(`removeMany on dead ${h}`)
              base.removeMany(h, defs)
            },
            writePayload: (h, def, values) => {
              if (!k.world.isAlive(h)) violations.push(`writePayload on dead ${h}`)
              base.writePayload(h, def, values)
            },
          }

          expect(() => flushAll(guarded, bufs)).not.toThrow()
          // CB-SAFE: no mutation was ever applied to a dead entity, recycled or otherwise.
          expect(violations).toEqual([])
        },
      ),
      { numRuns: 200 },
    )
  })

  test('reserved-ID create-then-use chains within a flush ALWAYS succeed (CB-3, §8.5)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 16 }), (chainLen) => {
        const k = makeKit(0)
        const aliveBeforeReserve = k.world.handleStats().aliveCount // 0 seeds
        const cb = makeCommandBuffer(0, 1024, false)
        // Reserved handles are ALIVE the instant they are reserved (§6.1), so the alive delta is taken
        // against the pre-reserve count; the discriminator is that each child is alive AND has Mana.
        fillReservationFor(k.world, cb, chainLen)
        const enc = encoderOver(cb, (id) => k.codecById.get(id)!, () => {})
        // create() then immediately add(Mana) on the fresh handle — the create-then-use chain.
        const children: EntityHandle[] = []
        for (let i = 0; i < chainLen; i++) {
          const child = enc.create()
          expect((child as unknown as number) >>> 0).not.toBe(0xffffffff) // reservation sized exactly
          enc.add(child, k.Mana, { mp: i })
          children.push(child)
        }
        flushAll(worldApplyOf(k.world, k.codecById, () => {}), [cb])
        // Every created child is alive AND carries the add — none dropped (per-handle, not via a
        // cached LiveQuery, so this discriminates the create-then-use chain itself, CB-3).
        expect(k.world.handleStats().aliveCount).toBe(aliveBeforeReserve + chainLen)
        for (const child of children) {
          expect(k.world.isAlive(child)).toBe(true)
          expect(k.world.has(child, k.Mana)).toBe(true)
        }
      }),
      { numRuns: 80 },
    )
  })

  test('a worker referencing an entity another worker destroys in the SAME flush drops the ref', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (victimCount) => {
        const k = makeKit(victimCount)
        // Worker 0 destroys every seed; worker 1 (applied AFTER, ascending index) tries to add to them.
        const w0 = makeCommandBuffer(0, 512, false)
        const w1 = makeCommandBuffer(1, 512, false)
        const enc0 = encoderOver(w0, (id) => k.codecById.get(id)!, () => {})
        const warns: string[] = []
        const enc1 = encoderOver(w1, (id) => k.codecById.get(id)!, () => {})
        for (const s of k.seeds) enc0.destroy(s)
        for (const s of k.seeds) enc1.add(s, k.Mana, { mp: 1 })

        flushAll(worldApplyOf(k.world, k.codecById, (m) => warns.push(m)), [w0, w1])
        // All seeds destroyed; none gained Mana (every worker-1 add dropped — destroyed-this-flush).
        for (const s of k.seeds) expect(k.world.isAlive(s)).toBe(false)
        let withMana = 0
        for (const _ of k.world.query(k.Mana) as Iterable<unknown>) withMana++
        expect(withMana).toBe(0)
        expect(warns.length).toBeGreaterThanOrEqual(victimCount)
      }),
      { numRuns: 100 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('NO WORKER BITMASK ACCESS during a wave (Must-Fix #1)', () => {
  // The bitmask is the single-entity membership substrate; its phase gate throws on ANY read/write
  // while world.phase==='wave'. world.has() → storage.has → bitmaskHas → assertSerial. So any bitmask
  // touch off the serial slot is a HARD ERROR, which is exactly what proves workers never read it.
  test('a bitmask read (world.has) during phase==="wave" THROWS — the gate that forbids worker access', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health], maxEntities: 64 })
    const h = world.spawnWith(Health)
    expect(world.has(h, Health)).toBe(true) // serial: fine
    world.__setPhase('wave')
    expect(() => world.has(h, Health)).toThrow(/serial-phase only/i) // wave: bitmask access forbidden
    world.__setPhase('serial')
  })

  test('a real fuzzed multi-round 2-worker run never trips the bitmask gate (no worker reads it)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (rounds) => {
        const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
        const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
        const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 11, threaded: true, scheduler: { workers: 2 } })
        const handles: EntityHandle[] = []
        for (let i = 0; i < 32; i++) {
          const e = world.spawnWith(Health, Mana)
          ;(world.entity(e).write(Health) as { hp: number }).hp = i
          ;(world.entity(e).write(Mana) as { mp: number }).mp = 100 + i
          handles.push(e)
        }

        // If ANY worker read the bitmask mid-wave, the #assertSerial gate (phase==='wave') would throw
        // inside the worker, set the wave error flag, and post a diagnostic — corrupting the result.
        // So a clean, serial-equivalent run with ZERO diagnostics is the proof of no worker bitmask
        // access (Must-Fix #1). We capture every diagnostic the pool emits.
        const diags: string[] = []
        const systems: PoolSystem[] = [
          { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
          { id: 1 as unknown as SystemId, name: 'Channel', matchComponents: [Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
        ]
        const localPool = new WorkerPool({ world, workers: 2, kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY, systems, diagnostic: (m) => diags.push(m) })
        try {
          await localPool.ready()
          for (let r = 0; r < rounds; r++) {
            await localPool.runRound(
              [
                { systemId: 0 as unknown as SystemId, workerIndex: 0 },
                { systemId: 1 as unknown as SystemId, workerIndex: 1 },
              ],
              1,
            )
          }
          // No worker error / bitmask-gate trip (workers read ARCHETYPE TABLES only), and the result is
          // serial-equivalent: Health += rounds, Mana -= rounds for every entity.
          expect(diags.filter((m) => /serial-only|serial-phase only|error|threw/i.test(m))).toEqual([])
          for (let i = 0; i < handles.length; i++) {
            expect((world.entity(handles[i]!).read(Health) as { hp: number }).hp).toBe(i + rounds)
            expect((world.entity(handles[i]!).read(Mana) as { mp: number }).mp).toBe(100 + i - rounds)
          }
          expect(world.phase).toBe('serial')
        } finally {
          await localPool.dispose()
        }
      }),
      { numRuns: 4 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('NO MID-WAVE STRUCTURAL MUTATION (CO-1)', () => {
  test('any structural mutation attempted while phase==="wave" THROWS — the CO-1 gate', () => {
    // The load-bearing CO-1 guard: every storage/entity/bitmask mutation asserts phase==='serial'.
    // While the world is in the wave window, a structural verb (add/remove/despawn) must throw, which
    // is exactly what forbids a worker from mutating archetype rows / records / bitmask mid-wave.
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
    const world = createWorld({ components: [Health, Mana], maxEntities: 64 })
    const h = world.spawnWith(Health)
    world.__setPhase('wave')
    expect(() => world.add(h, Mana)).toThrow() // archetype row/record/bitmask mutation forbidden
    expect(() => world.despawn(h)).toThrow()
    expect(() => world.spawnWith(Health)).toThrow()
    world.__setPhase('serial')
    // After leaving the wave the same ops succeed (the gate is phase-scoped, not permanent).
    expect(() => world.add(h, Mana)).not.toThrow()
  })

  test('a fuzzed worker SPAWNER run lands structure ONLY at the serial flush (alive-count unchanged across the wave window)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (rounds) => {
        const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
        const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
        const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 11, threaded: true, scheduler: { workers: 1 } })
        const handles: EntityHandle[] = []
        for (let i = 0; i < 24; i++) handles.push(world.spawnWith(Health))

        const systems: PoolSystem[] = [
          { id: 0 as unknown as SystemId, name: 'Spawner', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: handles.length },
        ]
        const diags: string[] = []
        const localPool = new WorkerPool({
          world,
          workers: 1,
          kernelModule: KERNEL_MODULE,
          workerEntryUrl: WORKER_ENTRY,
          systems,
          components: [Health, Mana],
          diagnostic: (m) => diags.push(m),
        })
        try {
          await localPool.ready()
          const before = world.handleStats().aliveCount
          for (let r = 0; r < rounds; r++) {
            // The worker stages OP_CREATE+OP_ADD mid-wave; if it had mutated structure directly the
            // CO-1 gate would have thrown in the worker (diagnostic). Each round nets +N alive at the
            // serial flush — structural change happens at the flush, never inside the wave.
            await localPool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)
          }
          expect(diags.filter((m) => /serial-only|serial-phase only|error|threw/i.test(m))).toEqual([]) // no mid-wave mutation
          expect(world.handleStats().aliveCount).toBe(before + rounds * handles.length)
          expect(world.phase).toBe('serial')
        } finally {
          await localPool.dispose()
        }
      }),
      { numRuns: 3 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('SANITY — 2-worker disjoint throughput (non-flaky; speedup BENCH is DEFERRED)', () => {
  // Wall-clock speedup benches are DEFERRED (no bench harness). This is only a structural sanity that
  // two disjoint-write systems DO run on two distinct workers and BOTH effects land — the
  // proof-of-existence the near-linear-speedup bench would later quantify. NOT a timing assertion.
  test('two disjoint systems both apply via two workers in one round (existence, not timing)', async () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
    const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers: 2 } })
    const handles: EntityHandle[] = []
    for (let i = 0; i < 128; i++) {
      const e = world.spawnWith(Health, Mana)
      ;(world.entity(e).write(Health) as { hp: number }).hp = i
      ;(world.entity(e).write(Mana) as { mp: number }).mp = i
      handles.push(e)
    }
    const systems: PoolSystem[] = [
      { id: 0 as unknown as SystemId, name: 'Regen', matchComponents: [Health], kernel: () => {}, maxSpawnsPerWave: 0 },
      { id: 1 as unknown as SystemId, name: 'Channel', matchComponents: [Mana], kernel: () => {}, maxSpawnsPerWave: 0 },
    ]
    const localPool = new WorkerPool({ world, workers: 2, kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY, systems })
    try {
      await localPool.ready()
      await localPool.runRound(
        [
          { systemId: 0 as unknown as SystemId, workerIndex: 0 },
          { systemId: 1 as unknown as SystemId, workerIndex: 1 },
        ],
        1,
      )
      // Both workers' effects landed: Health up by 1 (worker 0), Mana down by 1 (worker 1).
      for (let i = 0; i < handles.length; i++) {
        expect((world.entity(handles[i]!).read(Health) as { hp: number }).hp).toBe(i + 1)
        expect((world.entity(handles[i]!).read(Mana) as { mp: number }).mp).toBe(i - 1)
      }
    } finally {
      await localPool.dispose()
    }
  })
})
