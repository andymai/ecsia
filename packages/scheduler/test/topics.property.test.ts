// Topics PROPERTY suite (fast-check).
//
// HEADLINE — the serial-equivalence extension: a random workload of publisher/consumer systems with
// random payloads, run under workerCount ∈ {0, 2, 4} and the postMessage-fallback transport (plain
// AB command buffers), with SHUFFLED completion order — the canonical stream of every topic is
// BYTE-IDENTICAL (ring word content) and every consumer's delivered sequence is identical across
// all modes. workerCount 0 is the real single-thread executor (ctx.publish → staging → segment
// sort); workerCount 2/4 ride OP_PUBLISH records through per-worker command buffers into the SAME
// serial-slot merge. This is the property the feature exists for.
//
// ORDERING ORACLE: for random plans, the delivered order always equals
// (frame, wave, SystemId ascending, per-system FIFO) computed independently from the plan.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineTopic, buildTopicCodec, handleIndex } from '@ecsia/core'
import type { TopicDef, World } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import type { SystemDef } from '@ecsia/scheduler'
import { flushAll, makeCommandBuffer, makeEncoder, resetBuffer } from '../src/internal.js'
import type { CommandBuffer, CommandEncoder, WorldApply } from '../src/internal.js'
import type { Schema } from '@ecsia/schema'

const erased = (t: TopicDef<Schema, string>): TopicDef<Schema> => t

/** Deterministic event payload — a pure function of (publisher index, frame, event index). */
const payloadOf = (pub: number, frame: number, k: number): number => (pub + 1) * 100_000 + frame * 100 + k

interface Workload {
  /** eventsPerFrame[p] = events publisher p emits each frame. */
  readonly eventsPerFrame: readonly number[]
  /** afterDeps[p] ⊆ [0, p): explicit after-edges to earlier publishers (random wave structure). */
  readonly afterDeps: readonly (readonly number[])[]
}

const workloadArb: fc.Arbitrary<Workload> = fc
  .integer({ min: 1, max: 5 })
  .chain((pubs) =>
    fc.record({
      eventsPerFrame: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: pubs, maxLength: pubs }),
      afterDeps: fc.tuple(
        ...Array.from({ length: pubs }, (_, p) =>
          p === 0 ? fc.constant([] as number[]) : fc.uniqueArray(fc.integer({ min: 0, max: p - 1 }), { maxLength: p }),
        ),
      ),
    }),
  )

/** Build publisher defs (random after-chains) + one trailing consumer; ids are array order. */
function buildDefs(
  T: TopicDef<{ n: 'i32' }, string>,
  w: Workload,
  frameRef: { frame: number },
  delivered: number[][],
  publishViaCtx: boolean,
): SystemDef[] {
  const pubs: SystemDef[] = []
  for (let p = 0; p < w.eventsPerFrame.length; p++) {
    const deps = w.afterDeps[p]!.map((d) => pubs[d]!)
    const count = w.eventsPerFrame[p]!
    const index = p
    pubs.push(
      defineSystem({
        name: `Pub${p}`,
        publish: [T],
        after: deps,
        run({ publish }) {
          if (!publishViaCtx) return
          for (let k = 0; k < count; k++) publish(T, { n: payloadOf(index, frameRef.frame, k) })
        },
      }),
    )
  }
  const consumer = defineSystem({
    name: 'Cons',
    consume: [T],
    run({ consume }) {
      const got: number[] = []
      for (const ev of consume(T)) got.push((ev as { n: number }).n)
      delivered.push(got)
    },
  })
  return [...pubs, consumer]
}

/** wave index of each system name, read from the plan (the independent ordering input). */
function wavesOf(plan: ReturnType<typeof createScheduler>['plan']): Map<string, number> {
  const out = new Map<string, number>()
  plan.waves.forEach((wave, w) => {
    for (const round of wave.rounds) {
      for (const b of round) out.set(plan.systems[b.systemId as unknown as number]!.name, w)
    }
  })
  return out
}

// --------------------------------------------------------------------------------------------------
describe('ORDERING ORACLE', { timeout: 60_000 }, () => {
  test('delivered order equals (frame, wave, SystemId, FIFO) computed independently from the plan', () => {
    let topicSeq = 0
    fc.assert(
      fc.property(workloadArb, (w) => {
        const T = defineTopic(`Oracle${topicSeq++}`, { n: 'i32' })
        const world = createWorld({})
        const frameRef = { frame: 0 }
        const delivered: number[][] = []
        const defs = buildDefs(T, w, frameRef, delivered, true)
        const sched = createScheduler(world, defs)

        const FRAMES = 2
        for (frameRef.frame = 1; frameRef.frame <= FRAMES; frameRef.frame++) sched.update(1)

        // Independent oracle: the consumer sits in a later wave than every publisher (implicit
        // publisher → consumer edges), so frame f delivers ALL of frame f's events, ordered by
        // (wave asc, SystemId asc, FIFO). SystemId = registration order = publisher index here.
        const waveByName = wavesOf(sched.plan)
        const consWave = waveByName.get('Cons')!
        const pubOrder = Array.from({ length: w.eventsPerFrame.length }, (_, p) => p)
          .filter((p) => waveByName.get(`Pub${p}`)! < consWave)
          .sort((a, b) => {
            const wa = waveByName.get(`Pub${a}`)!
            const wb = waveByName.get(`Pub${b}`)!
            return wa - wb || a - b
          })
        expect(pubOrder.length).toBe(w.eventsPerFrame.length) // every publisher precedes the consumer
        for (let f = 1; f <= FRAMES; f++) {
          const expected: number[] = []
          for (const p of pubOrder) {
            for (let k = 0; k < w.eventsPerFrame[p]!; k++) expected.push(payloadOf(p, f, k))
          }
          expect(delivered[f - 1]).toEqual(expected)
        }
      }),
      { numRuns: 60 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
// The threaded-transport simulation: the same plan, but every publish rides an OP_PUBLISH record in
// a per-worker command buffer (worker = SystemId % workerCount), encoded in SHUFFLED system order
// and applied in SHUFFLED buffer order — exactly the nondeterminism real workers introduce. flushAll
// + mergeStaged are the very code paths the real pool drives.

function topicWorldApply(world: World, warn: (m: string) => void): WorldApply {
  const layout = world.handleLayout
  const apply = world.__apply
  return {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: () => undefined,
    addMany: (h, defs) => apply.addMany(h, defs),
    removeMany: (h, defs) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    stagePublish: (topicId, systemId, words, at, f) => world.__topics.stageWords(topicId, systemId, words, at, f),
    warn,
  }
}

/** Deterministic Fisher-Yates over a seeded LCG so shuffles vary per run but reproduce per seed. */
function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr]
  let s = (seed >>> 0) || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

interface FrameResult {
  streams: number[][] // per frame: the canonical stream words after the frame
  delivered: number[][] // consumer deliveries per frame
}

/** Reference: the real single-thread executor (workerCount 0). */
function runReference(T: TopicDef<{ n: 'i32' }, string>, w: Workload, frames: number): FrameResult {
  const world = createWorld({})
  const frameRef = { frame: 0 }
  const delivered: number[][] = []
  const sched = createScheduler(world, buildDefs(T, w, frameRef, delivered, true))
  const streams: number[][] = []
  for (frameRef.frame = 1; frameRef.frame <= frames; frameRef.frame++) {
    sched.update(1)
    streams.push([...world.__topics.streamWords(erased(T))])
  }
  return { streams, delivered }
}

/** Simulated threaded transport: OP_PUBLISH through per-worker command buffers, shuffled orders. */
function runTransport(
  T: TopicDef<{ n: 'i32' }, string>,
  w: Workload,
  frames: number,
  workers: number,
  sharedBacking: boolean,
  seed: number,
): FrameResult {
  const world = createWorld(sharedBacking ? { threaded: true, scheduler: { workers } } : {})
  const frameRef = { frame: 0 }
  const unusedDelivered: number[][] = []
  // Same defs/plan shape, but bodies publish NOTHING via ctx — events arrive as OP_PUBLISH records.
  const defs = buildDefs(T, w, frameRef, unusedDelivered, false)
  const sched = createScheduler(world, defs, { workers })
  const store = world.__topics
  const codec = buildTopicCodec(T.fields)
  const warn = (m: string): void => {
    throw new Error(`unexpected diagnostic: ${m}`)
  }

  const buffers: CommandBuffer[] = []
  const encoders: CommandEncoder[] = []
  let currentSystemId = 0
  for (let i = 0; i < workers; i++) {
    const cb = makeCommandBuffer(i, 256, sharedBacking)
    buffers.push(cb)
    encoders.push(
      makeEncoder({
        cb,
        infoOf: () => {
          throw new Error('no component records in this workload')
        },
        relationCodec: () => undefined,
        topicInfoOf: () => ({ id: T.id as number, codec }),
        publisherSystemId: () => currentSystemId,
        warn,
      }),
    )
  }

  const streams: number[][] = []
  const delivered: number[][] = []
  const worldApply = topicWorldApply(world, warn)

  for (frameRef.frame = 1; frameRef.frame <= frames; frameRef.frame++) {
    store.beginUpdate()
    world.frameReset()
    sched.plan.waves.forEach((wave, waveIndex) => {
      for (const cb of buffers) resetBuffer(cb)
      // Run the wave's batches in a SHUFFLED order (simulating worker completion nondeterminism).
      const batches = shuffled(wave.rounds.flat(), seed ^ (frameRef.frame * 31 + waveIndex))
      for (const b of batches) {
        const sb = sched.plan.systems[b.systemId as unknown as number]!
        if (sb.name === 'Cons') {
          const got: number[] = []
          for (const ev of store.consume(erased(T), 'Cons')) got.push((ev as { n: number }).n)
          delivered.push(got)
          continue
        }
        const p = Number(sb.name.slice(3))
        currentSystemId = sb.id as unknown as number
        const enc = encoders[(sb.id as unknown as number) % workers]!
        for (let k = 0; k < w.eventsPerFrame[p]!; k++) enc.publish(erased(T), { n: payloadOf(p, frameRef.frame, k) })
      }
      // Serial slot: deterministic merge despite shuffled buffer array (flushAll re-sorts), then
      // the canonical topic merge — the SAME code path the real pool + threaded loop drive.
      flushAll(worldApply, shuffled(buffers, seed ^ (frameRef.frame * 131 + waveIndex)))
      store.mergeStaged()
    })
    store.endUpdate()
    streams.push([...store.streamWords(erased(T))])
  }
  return { streams, delivered }
}

describe('OP_PUBLISH bypasses the entity-liveness gate (not entity-targeted)', () => {
  test('a publish encoded after a destroy in the SAME flush still lands — never validateSubject-dropped', () => {
    const T = defineTopic('Bypass', { n: 'i32' })
    const world = createWorld({})
    world.__topics.register(erased(T))
    const victim = world.spawn()
    const warns: string[] = []
    const cb = makeCommandBuffer(0, 64, false)
    const enc = makeEncoder({
      cb,
      infoOf: () => {
        throw new Error('unused')
      },
      relationCodec: () => undefined,
      topicInfoOf: () => ({ id: T.id as number, codec: buildTopicCodec(T.fields) }),
      publisherSystemId: () => 0,
      warn: (m) => warns.push(m),
    })
    enc.destroy(victim)
    enc.publish(erased(T), { n: 9 }) // even an eid-free payload after a destroy must apply
    enc.destroy(victim) // a genuinely dropped record, for contrast
    flushAll(topicWorldApply(world, (m) => warns.push(m)), [cb])
    world.__topics.mergeStaged()
    const got: number[] = []
    for (const ev of world.__topics.consume(erased(T), 'r')) got.push((ev as { n: number }).n)
    expect(got).toEqual([9])
    expect(world.isAlive(victim)).toBe(false)
    expect(warns.some((m) => /destroyed earlier this flush/.test(m))).toBe(true) // the second destroy
    expect(warns.some((m) => /Bypass/.test(m))).toBe(false) // the publish was never gated
  })
})

describe('SERIAL-EQUIVALENCE (headline): byte-identical canonical streams across worker counts', { timeout: 120_000 }, () => {
  test('workerCount ∈ {0, 2, 4} × {SAB, plain-AB fallback} × shuffled completion → identical streams + deliveries', () => {
    let topicSeq = 0
    fc.assert(
      fc.property(workloadArb, fc.integer({ min: 1, max: 0x7fffffff }), (w, seed) => {
        const FRAMES = 3
        const name = `Equiv${topicSeq++}`
        const ref = runReference(defineTopic(name, { n: 'i32' }), w, FRAMES)

        for (const workers of [2, 4]) {
          for (const shared of [false, true]) {
            // Each run needs fresh module-scope defs (a TopicDef binds to one world).
            const T = defineTopic(name, { n: 'i32' })
            const got = runTransport(T, w, FRAMES, workers, shared, seed)
            // BYTE-IDENTICAL canonical stream after every frame…
            expect(got.streams).toEqual(ref.streams)
            // …and identical delivered sequences for the consumer.
            expect(got.delivered).toEqual(ref.delivered)
          }
        }
      }),
      { numRuns: 40 },
    )
  })
})
