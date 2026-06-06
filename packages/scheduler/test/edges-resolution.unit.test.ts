// Opposite-direction edge resolution (graph/edges.ts buildEdges post-pass): a STRICTLY stronger
// declaration deletes a weaker edge pointing the other way; EQUAL weights keep both edges and the
// cycle detector reports the contradiction. These five tests lock the resolution semantics — each
// fails if the strict `>` becomes `>=` (the equal-weight cycles would silently resolve) or if
// `b.best` re-keys to unordered pairs (opposite edges would collapse into one max-weight entry and
// the explicit-vs-implicit cases would never see a reverse edge).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTopic } from '@ecsia/core'
import { beforeWritersOf, createScheduler, defineSystem } from '@ecsia/scheduler'
import { CycleError, EdgeWeight, aggregateAccess, buildEdges, lowerSystems, resolveOrdering } from '../src/internal.js'
import type { SystemBox } from '../src/internal.js'
import type { SchedulerHandle } from '@ecsia/scheduler'

function boxesOf(defs: ReturnType<typeof defineSystem>[], stride = 4): SystemBox[] {
  return resolveOrdering(lowerSystems(defs, stride), defs)
}

function waveOf(sched: SchedulerHandle, name: string): number {
  for (let w = 0; w < sched.plan.waves.length; w++) {
    for (const round of sched.plan.waves[w]!.rounds) {
      for (const b of round) {
        if (sched.plan.systems[b.systemId as unknown as number]!.name === name) return w
      }
    }
  }
  return -1
}

describe('opposite-direction resolution: strictly stronger declarations win, equal weights cycle', () => {
  test('(a) explicit consumer.before = [publisher] beats the implicit topic edge — next-frame delivery', () => {
    const T = defineTopic('OptOut', { n: 'i32' })
    const world = createWorld({})
    let frame = 0
    const log: number[][] = []
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
      before: [Pub], // EXPLICIT(5) Cons → Pub, opposite the IMPLICIT(1) topic edge Pub → Cons
      run({ consume }) {
        const got: number[] = []
        for (const ev of consume(T)) got.push(ev.n)
        log.push(got)
      },
    })
    // Without the resolution this is a 2-cycle (CycleError); the explicit declaration must win.
    const sched = createScheduler(world, [Pub, Cons])
    expect(waveOf(sched, 'Cons')).toBeLessThan(waveOf(sched, 'Pub'))
    frame = 1
    sched.update(1)
    frame = 2
    sched.update(1)
    // The user opted into next-frame delivery: frame 1's event arrives in frame 2.
    expect(log).toEqual([[], [1]])
  })

  test('(b) equal-weight opposite EXPLICIT edges still throw CycleError', () => {
    const world = createWorld({})
    const B = defineSystem({ name: 'B', run() {} })
    // A → B (A.before) and B → A (A.after): both EXPLICIT(5), genuinely contradictory.
    const A = defineSystem({ name: 'A', before: [B], after: [B], run() {} })
    expect(() => createScheduler(world, [A, B])).toThrow(CycleError)
  })

  test('(c) explicit beats the opposite registration-order implicit component edge', () => {
    const C = defineComponent({ v: 'i32' }, { name: 'edges_res_flip' })
    const world = createWorld({ components: [C] })
    // Writer registered first → IMPLICIT(1) Writer → Reader on C (registration order).
    const Writer = defineSystem({ name: 'Writer', write: [C], run() {} })
    // Reader declares the OPPOSITE order explicitly — EXPLICIT(5) Reader → Writer.
    const Reader = defineSystem({ name: 'Reader', read: [C], before: [Writer], run() {} })
    // Pre-resolution behavior was a CycleError; the explicit declaration now wins.
    const sched = createScheduler(world, [Writer, Reader])
    expect(waveOf(sched, 'Reader')).toBeLessThan(waveOf(sched, 'Writer'))
  })

  test('(d) EXPLICIT(5) deletes an opposite CLASS_HINT(3) edge', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'edges_res_hint' })
    createWorld({ components: [C] })
    const Writer = defineSystem({ name: 'Writer', write: [C], run() {} })
    // beforeWritersOf(C) → CLASS_HINT(3) Hinter → Writer; after: [Writer] → EXPLICIT(5) Writer → Hinter.
    const Hinter = defineSystem({ name: 'Hinter', read: [C], order: [beforeWritersOf(C)], after: [Writer], run() {} })
    const boxes = boxesOf([Writer, Hinter])
    const edges = buildEdges(boxes, [Writer, Hinter], aggregateAccess(boxes))
    // The weaker opposite hint edge is deleted...
    expect(edges.some((e) => (e.from as unknown as number) === 1 && (e.to as unknown as number) === 0)).toBe(false)
    // ...and the explicit edge survives at full weight.
    const kept = edges.find((e) => (e.from as unknown as number) === 0 && (e.to as unknown as number) === 1)
    expect(kept).toBeDefined()
    expect(kept!.weight).toBe(EdgeWeight.EXPLICIT)
  })

  test('(e) implicit-vs-implicit equal weight (topic edge vs component edge) still cycles', () => {
    const C = defineComponent({ v: 'i32' }, { name: 'edges_res_imp' })
    const T = defineTopic('ImpVsImp', { n: 'i32' })
    const world = createWorld({ components: [C] })
    // Cons registered first → IMPLICIT(1) component edge Cons → Pub on C (registration order);
    // the topic derives IMPLICIT(1) Pub → Cons. Equal weights: neither wins — report the cycle.
    const Cons = defineSystem({ name: 'Cons', write: [C], consume: [T], run() {} })
    const Pub = defineSystem({ name: 'Pub', read: [C], publish: [T], run() {} })
    expect(() => createScheduler(world, [Cons, Pub])).toThrow(CycleError)
  })
})
