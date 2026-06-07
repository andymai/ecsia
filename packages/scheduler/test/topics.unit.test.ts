// Topics through the scheduler: the visibility matrix (same-frame vs next-frame by wave
// position), exactly-once + two-consumer independence, retention with the cursor-snap warning,
// late-added systems via re-plan, world.publish timing, dev-mode declaration errors, and the
// plan-shape contracts (publisher → consumer DAG edge; NO WAVE-CONFLICT participation).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorld, defineTopic, defineComponent } from '@ecsia/core'
import type { TopicDef, World } from '@ecsia/core'
import { createScheduler, defineSystem, inAnyOrderWith } from '@ecsia/scheduler'
import { CycleError } from '../src/internal.js'

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

interface MatrixRig {
  world: World
  sched: ReturnType<typeof createScheduler>
  log: Record<string, number[][]> // consumer name -> per-frame delivered payloads
  frame(): void
}

/**
 * Publisher in wave 1; consumers in wave 0 (earlier), wave 1 (same, via DENY), wave 2 (later, via
 * the implicit publisher → consumer edge). One event per frame, payload = frame number.
 */
function matrixRig(T: TopicDef<{ n: 'i32' }, 'Evt'>): MatrixRig {
  const world = createWorld({})
  const log: Record<string, number[][]> = { ConsEarlier: [], ConsSame: [], ConsLater: [] }
  let frameNo = 0
  const consumeAll = (name: string) => (ctx: { consume: (t: typeof T) => Iterable<{ n: number }> }) => {
    const got: number[] = []
    for (const ev of ctx.consume(T)) got.push(ev.n)
    log[name]!.push(got)
  }
  const ConsEarlier = defineSystem({ name: 'ConsEarlier', consume: [T], run: consumeAll('ConsEarlier') })
  // The deny hint endpoints resolve by NAME (the documented spread-copy pattern), so a stub
  // name-carrier stands in for the registered Pub inside its own order hint.
  const pubStub = defineSystem({ name: 'Pub', run() {} })
  const ConsSame = defineSystem({
    name: 'ConsSame',
    consume: [T],
    after: [ConsEarlier],
    order: [inAnyOrderWith(pubStub, undefined as never)] as never,
    run: consumeAll('ConsSame'),
  })
  const ConsSameFixed = defineSystem({
    name: 'ConsSame',
    consume: [T],
    after: [ConsEarlier],
    order: [inAnyOrderWith(pubStub, ConsSame)], // DENY: suppress the implicit Pub → ConsSame edge
    run: consumeAll('ConsSame'),
  })
  const ConsLater = defineSystem({ name: 'ConsLater', consume: [T], run: consumeAll('ConsLater') })
  const Pub = defineSystem({
    name: 'Pub',
    publish: [T],
    after: [ConsEarlier],
    run({ publish }) {
      publish(T, { n: frameNo })
    },
  })
  const sched = createScheduler(world, [ConsEarlier, Pub, ConsSameFixed, ConsLater])
  return {
    world,
    sched,
    log,
    frame() {
      frameNo += 1
      sched.update(1)
    },
  }
}

describe('visibility matrix (publisher wave W; consumers at W-1 / W / W+1)', () => {
  test('later-wave consumer gets SAME-FRAME delivery; same/earlier-wave consumers get NEXT-FRAME', () => {
    const T = defineTopic('Evt', { n: 'i32' })
    const rig = matrixRig(T)

    // Plan-shape preconditions: ConsEarlier strictly before Pub; ConsSame in Pub's wave; ConsLater after.
    const waveOf = (name: string): number => {
      for (let w = 0; w < rig.sched.plan.waves.length; w++) {
        for (const round of rig.sched.plan.waves[w]!.rounds) {
          for (const b of round) if (rig.sched.plan.systems[b.systemId as unknown as number]!.name === name) return w
        }
      }
      return -1
    }
    expect(waveOf('ConsEarlier')).toBeLessThan(waveOf('Pub'))
    expect(waveOf('ConsSame')).toBe(waveOf('Pub'))
    expect(waveOf('ConsLater')).toBeGreaterThan(waveOf('Pub'))

    rig.frame() // frame 1: Pub publishes n=1
    rig.frame() // frame 2: Pub publishes n=2
    rig.frame() // frame 3: Pub publishes n=3

    // Later wave: sees the event the SAME frame it was published.
    expect(rig.log.ConsLater).toEqual([[1], [2], [3]])
    // Same wave: deterministic next-frame delivery (never lost, never doubled).
    expect(rig.log.ConsSame).toEqual([[], [1], [2]])
    // Earlier wave: next-frame delivery too.
    expect(rig.log.ConsEarlier).toEqual([[], [1], [2]])
  })

  test('two later-wave consumers receive IDENTICAL sequences (independent cursors, no stealing)', () => {
    const T = defineTopic('Pair', { n: 'i32' })
    const world = createWorld({})
    const a: number[] = []
    const b: number[] = []
    let frame = 0
    const Pub = defineSystem({
      name: 'Pub',
      publish: [T],
      run({ publish }) {
        publish(T, { n: frame })
        publish(T, { n: frame * 10 })
      },
    })
    const ConsA = defineSystem({
      name: 'ConsA',
      consume: [T],
      run({ consume }) {
        for (const ev of consume(T)) a.push(ev.n)
      },
    })
    const ConsB = defineSystem({
      name: 'ConsB',
      consume: [T],
      run({ consume }) {
        for (const ev of consume(T)) b.push(ev.n)
      },
    })
    const sched = createScheduler(world, [Pub, ConsA, ConsB])
    for (frame = 1; frame <= 3; frame++) sched.update(1)
    expect(a).toEqual([1, 10, 2, 20, 3, 30])
    expect(b).toEqual(a)
  })
})

describe('retention + cursor snap through the frame loop', () => {
  test('a consumer that stops consuming and resumes 2+ frames later snaps with a dev warning', () => {
    const T = defineTopic('Lag', { n: 'i32' })
    const world = createWorld({})
    let frame = 0
    let sleeping = false
    const delivered: number[] = []
    const Pub = defineSystem({
      name: 'Pub',
      publish: [T],
      run({ publish }) {
        publish(T, { n: frame })
      },
    })
    const Cons = defineSystem({
      name: 'Cons',
      consume: [T],
      run({ consume }) {
        if (sleeping) return // cursor does not advance when the system never calls consume
        for (const ev of consume(T)) delivered.push(ev.n)
      },
    })
    const sched = createScheduler(world, [Pub, Cons])
    frame = 1
    sched.update(1) // delivered: [1]
    sleeping = true
    for (frame = 2; frame <= 5; frame++) sched.update(1) // events 2..5 published; 2,3 dropped by retention
    sleeping = false
    frame = 6
    sched.update(1)
    // Entering frame 6, only frame-5 events are still retained: the cursor snapped past the
    // dropped 2,3,4; the retained 5 + this frame's 6 arrive.
    expect(delivered).toEqual([1, 5, 6])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/topic 'Lag'.*'Cons'.*missed 3 event.*dropped by retention/))
  })

  test('a system added by a RE-PLAN starts at the current head — no replay of retained events', () => {
    const T = defineTopic('Join', { n: 'i32' })
    const world = createWorld({})
    let frame = 0
    const Pub = defineSystem({
      name: 'Pub',
      publish: [T],
      run({ publish }) {
        publish(T, { n: frame })
      },
    })
    const schedA = createScheduler(world, [Pub])
    frame = 1
    schedA.update(1)
    frame = 2
    schedA.update(1) // events 1,2 published; 2 (and possibly 1) still retained

    const delivered: number[] = []
    const Late = defineSystem({
      name: 'Late',
      consume: [T],
      run({ consume }) {
        for (const ev of consume(T)) delivered.push(ev.n)
      },
    })
    // Re-plan: rebuilt wholesale; Pub's identity persists, Late's cursor initializes at the head.
    const schedB = createScheduler(world, [Pub, Late])
    frame = 3
    schedB.update(1)
    expect(delivered).toEqual([3]) // only the post-join event — retained 1,2 are NOT replayed
  })
})

describe('world.publish timing', () => {
  test('events published BEFORE the first createScheduler are delivered to first-plan consumers', () => {
    const T = defineTopic('PrePlan', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 42 }) // input-event path, before any plan exists
    const delivered: number[] = []
    const Cons = defineSystem({
      name: 'Cons',
      consume: [T],
      run({ consume }) {
        for (const ev of consume(T)) delivered.push(ev.n)
      },
    })
    const sched = createScheduler(world, [Cons])
    sched.update(1)
    // "every system sees it next update" — the first plan's consumers must include pre-plan events.
    expect(delivered).toEqual([42])
    sched.update(1)
    expect(delivered).toEqual([42]) // exactly-once, no replay on the next frame
  })

  test('events published between frames are visible to EVERY system next update, ahead of wave 0', () => {
    const T = defineTopic('Input', { n: 'i32' })
    const world = createWorld({})
    const early: number[][] = []
    const later: number[][] = []
    const ConsEarly = defineSystem({
      name: 'ConsEarly',
      consume: [T],
      run({ consume }) {
        const got: number[] = []
        for (const ev of consume(T)) got.push(ev.n)
        early.push(got)
      },
    })
    const Pub = defineSystem({
      name: 'Pub',
      publish: [T],
      after: [ConsEarly],
      run({ publish }) {
        publish(T, { n: 7 })
      },
    })
    const ConsLater = defineSystem({
      name: 'ConsLater',
      consume: [T],
      run({ consume }) {
        const got: number[] = []
        for (const ev of consume(T)) got.push(ev.n)
        later.push(got)
      },
    })
    const sched = createScheduler(world, [ConsEarly, Pub, ConsLater])
    world.publish(T, { n: 100 }) // between frames (the input-event path)
    sched.update(1)
    // Wave-0 consumer sees the outside event the very next update; the later-wave consumer sees it
    // BEFORE the same frame's staged publish (outside events order ahead of wave 0).
    expect(early).toEqual([[100]])
    expect(later).toEqual([[100, 7]])
  })

  test('world.publish from inside a system body throws (use ctx.publish)', () => {
    const T = defineTopic('Misuse', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 0 }) // registers the topic
    const Bad = defineSystem({
      name: 'Bad',
      run({ world: w }) {
        w.publish(T, { n: 1 })
      },
    })
    const sched = createScheduler(world, [Bad])
    expect(() => sched.update(1)).toThrow(/during world update.*ctx\.publish/s)
  })
})

describe('dev-mode declaration errors', () => {
  test('an undeclared publish throws naming the system and the missing declaration', () => {
    const T = defineTopic('Undeclared1', { n: 'i32' })
    const world = createWorld({})
    const Declares = defineSystem({ name: 'Declares', publish: [T], run() {} })
    const Sneaky = defineSystem({
      name: 'Sneaky',
      run({ publish }) {
        publish(T, { n: 1 })
      },
    })
    const sched = createScheduler(world, [Declares, Sneaky])
    expect(() => sched.update(1)).toThrow(/'Sneaky' publishes topic 'Undeclared1' without declaring it/)
  })

  test('an undeclared consume throws naming the system and the missing declaration', () => {
    const T = defineTopic('Undeclared2', { n: 'i32' })
    const world = createWorld({})
    const Declares = defineSystem({ name: 'Declares', publish: [T], run() {} })
    const Sneaky = defineSystem({
      name: 'Sneaky',
      run({ consume }) {
        for (const _ of consume(T)) void _
      },
    })
    const sched = createScheduler(world, [Declares, Sneaky])
    expect(() => sched.update(1)).toThrow(/'Sneaky' consumes topic 'Undeclared2' without declaring it/)
  })
})

describe('plan shape: DAG edges yes, WAVE-CONFLICT no', () => {
  test('publisher → consumer derives an implicit edge (consumer lands in a later wave)', () => {
    const T = defineTopic('Edge', { n: 'i32' })
    const world = createWorld({})
    // Consumer registered FIRST: without the topic edge both would share wave 0.
    const Cons = defineSystem({ name: 'Cons', consume: [T], run() {} })
    const Pub = defineSystem({ name: 'Pub', publish: [T], run() {} })
    const sched = createScheduler(world, [Cons, Pub])
    expect(sched.plan.waves.length).toBe(2)
    const wave0 = sched.plan.waves[0]!.rounds.flat().map((b) => sched.plan.systems[b.systemId as unknown as number]!.name)
    expect(wave0).toEqual(['Pub'])
  })

  test('inAnyOrderWith suppresses the topic edge (consumer accepts next-frame delivery)', () => {
    const T = defineTopic('Denied', { n: 'i32' })
    const world = createWorld({})
    const Pub = defineSystem({ name: 'Pub', publish: [T], run() {} })
    const consStub = defineSystem({ name: 'Cons', run() {} })
    const Cons = defineSystem({ name: 'Cons', consume: [T], order: [inAnyOrderWith(Pub, consStub)], run() {} })
    const sched = createScheduler(world, [Pub, Cons])
    expect(sched.plan.waves.length).toBe(1) // both in wave 0 — the implicit edge was denied
  })

  test('mutual publish/consume across two systems reports a CycleError with both topic causes', () => {
    const A = defineTopic('AtoB', { n: 'i32' })
    const B = defineTopic('BtoA', { n: 'i32' })
    const world = createWorld({})
    const S1 = defineSystem({ name: 'S1', publish: [A], consume: [B], run() {} })
    const S2 = defineSystem({ name: 'S2', publish: [B], consume: [A], run() {} })
    expect(() => createScheduler(world, [S1, S2])).toThrow(CycleError)
    expect(() => createScheduler(world, [S1, S2])).toThrow(/publishes topic/)
    // The report names the topic-specific break: explicit after for same-frame, deny for next-frame.
    expect(() => createScheduler(world, [S1, S2])).toThrow(/consumer\.after = \[publisher\].*inAnyOrderWith\(publisher, consumer\).*next-frame/s)
  })

  test('two same-wave publishers of one topic share a ROUND under workers > 0 (no WAVE-CONFLICT)', () => {
    const T = defineTopic('CoPub', { n: 'i32' })
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
    const world = createWorld({ components: [Health, Mana] })
    // Disjoint component access; both publish T. If publish participated in WAVE-CONFLICT (treated
    // as a plain write), they could not share a round.
    const PubA = defineSystem({ name: 'PubA', write: [Health], publish: [T], run() {} })
    const PubB = defineSystem({ name: 'PubB', write: [Mana], publish: [T], run() {} })
    const sched = createScheduler(world, [PubA, PubB], { workers: 2 })
    expect(sched.plan.waves.length).toBe(1)
    expect(sched.plan.waves[0]!.rounds.length).toBe(1) // ONE concurrent round — co-publishers parallelize
    expect(sched.plan.waves[0]!.rounds[0]!.length).toBe(2)
  })

  test('a consumer is worker-assigned like any eligible system (worker-side consume shipped)', () => {
    const T = defineTopic('Pin', { n: 'i32' })
    const world = createWorld({})
    const Pub = defineSystem({ name: 'Pub', publish: [T], run() {} })
    const Cons = defineSystem({ name: 'Cons', consume: [T], run() {} })
    const sched = createScheduler(world, [Pub, Cons], { workers: 2 })
    const consBatch = sched.plan.waves.flatMap((w) => w.rounds.flat()).find(
      (b) => sched.plan.systems[b.systemId as unknown as number]!.name === 'Cons',
    )
    expect(consBatch!.workerIndex).toBeGreaterThanOrEqual(0) // consumers ride workers now
    const pubBatch = sched.plan.waves.flatMap((w) => w.rounds.flat()).find(
      (b) => sched.plan.systems[b.systemId as unknown as number]!.name === 'Pub',
    )
    expect(pubBatch!.workerIndex).toBeGreaterThanOrEqual(0) // publishers stay worker-eligible
  })
})

describe('zero cost when unused', () => {
  test('a topic-free schedule registers no topics and runs the frame loop untouched', () => {
    const world = createWorld({})
    const S = defineSystem({ name: 'S', run() {} })
    const sched = createScheduler(world, [S])
    sched.update(1)
    sched.update(1)
    expect(world.__topics.count).toBe(0)
  })

  test('ctx.publish encodes schema defaults for omitted fields', () => {
    const T = defineTopic('Defaults', { a: 'i32', b: 'f32' })
    const world = createWorld({})
    const seen: Array<{ a: number; b: number }> = []
    const Pub = defineSystem({
      name: 'Pub',
      publish: [T],
      run({ publish }) {
        publish(T, { b: 2.5 })
        publish(T)
      },
    })
    const Cons = defineSystem({
      name: 'Cons',
      consume: [T],
      run({ consume }) {
        for (const ev of consume(T)) seen.push({ a: ev.a, b: ev.b })
      },
    })
    const sched = createScheduler(world, [Pub, Cons])
    sched.update(1)
    expect(seen).toEqual([
      { a: 0, b: 2.5 },
      { a: 0, b: 0 },
    ])
  })
})
