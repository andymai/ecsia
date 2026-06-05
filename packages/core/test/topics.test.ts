// Topics — core store semantics: defineTopic validation, world.publish (the outside-systems
// path), per-reader cursors, double-buffered retention with the cursor-snap warning, the
// publisher-SystemId segment sort, the spill-then-regrow overflow path, and the serial-phase
// mutation guard. Scheduler-driven semantics (visibility matrix, ctx.publish/consume, DAG edges)
// live in the scheduler suite.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createWorld, defineTopic, vec, staticString, object, field, NO_ENTITY } from '../src/index.js'
import { TOPIC_HEADER_WORDS } from '../src/topics/index.js'
import type { TopicDef } from '../src/index.js'
import type { Schema } from '@ecsia/schema'

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

const erased = (t: TopicDef<Schema, string>): TopicDef<Schema> => t

// The consume view is POOLED — fields must be read inside the loop, so collect eagerly.
function vals(it: Iterable<unknown>, key = 'n'): unknown[] {
  const out: unknown[] = []
  for (const e of it) out.push((e as Record<string, unknown>)[key])
  return out
}

describe('defineTopic validation', () => {
  test('requires a non-empty name', () => {
    expect(() => defineTopic('', { x: 'f32' })).toThrow(/non-empty topic name/)
  })

  test('rejects object<T> fields (cannot live in a u32 ring)', () => {
    expect(() => defineTopic('Bad', { payload: object<{ a: number }>() })).toThrow(/object<T> field/)
  })

  test("rejects free-form 'string' fields (sidecar-backed, not ring-encodable)", () => {
    expect(() => defineTopic('Bad', { label: 'string' })).toThrow(/'string' field/)
  })

  test('rejects reserved/non-identifier field names', () => {
    expect(() => defineTopic('Bad', { __x: 'f32' })).toThrow(/invalid field name/)
  })

  test('accepts the component scalar/vec/staticString/eid token set + field() defaults', () => {
    const T = defineTopic('Ok', {
      a: 'f32',
      b: 'f64',
      c: 'eid',
      d: vec('f32', 3),
      e: staticString('x', 'y'),
      f: field('i32', { default: 7 }),
    })
    expect(T.name).toBe('Ok')
    expect(T.id as number).toBe(-1) // unregistered until a world interns it
  })
})

describe('world.publish + cursors', () => {
  test('registers the topic lazily, copies values at call time, delivers in call order', () => {
    const Damage = defineTopic('Damage', { amount: 'f32', target: 'eid' })
    const world = createWorld({})
    const init = { amount: 12.5 }
    world.publish(Damage, init)
    init.amount = 99 // mutation after publish must not leak into the stream (copied at call time)
    world.publish(Damage, { amount: 3 })
    expect((Damage.id as number) >= 0).toBe(true)
    expect(vals(world.__topics.consume(erased(Damage), 'reader'), 'amount')).toEqual([12.5, 3])
  })

  test('eid payload fields default to NO_ENTITY and round-trip handles without liveness checks', () => {
    const T = defineTopic('Eids', { who: 'eid' })
    const world = createWorld({})
    const e = world.spawn()
    world.publish(T, { who: e })
    world.publish(T, {})
    world.despawn(e)
    // The entity is dead by delivery time — the handle still reads back verbatim (a fact about
    // the past; the consumer checks isAlive if it needs the entity). An unset eid reads back null,
    // matching the component accessor convention.
    const seen = vals(world.__topics.consume(erased(T), 'r'), 'who')
    expect((seen[0] as number) >>> 0).toBe((e as number) >>> 0)
    expect(seen[1]).toBeNull()
    expect(world.isAlive(e)).toBe(false)
  })

  test('each (reader, topic) cursor is exactly-once and independent — no drain stealing', () => {
    const T = defineTopic('Tick', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 1 })
    world.publish(T, { n: 2 })
    expect(vals(world.__topics.consume(erased(T), 'A'))).toEqual([1, 2])
    expect(vals(world.__topics.consume(erased(T), 'B'))).toEqual([1, 2]) // B got the same events — A did not steal them
    expect(vals(world.__topics.consume(erased(T), 'A'))).toEqual([]) // exactly-once for A
    world.publish(T, { n: 3 })
    expect(vals(world.__topics.consume(erased(T), 'A'))).toEqual([3])
    expect(vals(world.__topics.consume(erased(T), 'B'))).toEqual([3])
  })

  test('a reader that breaks out of the loop mid-iteration resumes at the first unread event', () => {
    const T = defineTopic('Partial', { n: 'i32' })
    const world = createWorld({})
    for (let i = 0; i < 4; i++) world.publish(T, { n: i })
    for (const ev of world.__topics.consume(erased(T), 'r')) {
      if ((ev as { n: number }).n === 1) break
    }
    expect(vals(world.__topics.consume(erased(T), 'r'))).toEqual([2, 3])
  })

  test('the consume view is pooled — storing it across iterations reads the latest event', () => {
    const T = defineTopic('Pooled', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 1 })
    world.publish(T, { n: 2 })
    const stored: unknown[] = []
    for (const ev of world.__topics.consume(erased(T), 'r')) stored.push(ev)
    expect(stored[0]).toBe(stored[1]) // same pooled object
    expect((stored[0] as { n: number }).n).toBe(2) // rebound to the last row
  })

  test('duplicate topic NAMES in one world are rejected; re-registration of the same def is idempotent', () => {
    const A = defineTopic('Same', { n: 'i32' })
    const B = defineTopic('Same', { n: 'f32' })
    const world = createWorld({})
    world.publish(A, { n: 1 })
    expect(() => world.publish(B, { n: 2 })).toThrow(/already registered with this world/)
    world.__topics.register(erased(A)) // idempotent
  })

  test('a def registered with one world cannot be registered with another', () => {
    const T = defineTopic('OneWorld', { n: 'i32' })
    const a = createWorld({})
    a.publish(T, { n: 1 })
    const b = createWorld({})
    expect(() => b.publish(T, { n: 2 })).toThrow(/another world/)
  })
})

describe('canonical merge (segment sort by publishing SystemId)', () => {
  test('staged segments append in SystemId order regardless of staging order, FIFO within a system', () => {
    const T = defineTopic('Merge', { n: 'i32' })
    const world = createWorld({})
    const store = world.__topics
    store.register(erased(T))
    // Stage out of SystemId order, interleaved — simulating arbitrary worker completion order.
    store.stageValues(erased(T), 2, { n: 20 })
    store.stageValues(erased(T), 0, { n: 1 })
    store.stageValues(erased(T), 2, { n: 21 })
    store.stageValues(erased(T), 1, { n: 10 })
    store.stageValues(erased(T), 0, { n: 2 })
    expect(store.bounds(erased(T)).head).toBe(0) // nothing visible until the serial-slot merge
    store.mergeStaged()
    expect(vals(store.consume(erased(T), 'r'))).toEqual([1, 2, 10, 20, 21]) // (SystemId asc, per-system FIFO)
  })

  test('direct world.publish events order BEFORE later-staged events (ahead of wave 0)', () => {
    const T = defineTopic('Ahead', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 100 })
    world.__topics.stageValues(erased(T), 0, { n: 1 })
    world.__topics.mergeStaged()
    expect(vals(world.__topics.consume(erased(T), 'r'))).toEqual([100, 1])
  })
})

describe('retention (double-buffered by frame) + cursor snap', () => {
  test('events drop two frame-resets after their frame; a behind cursor snaps with a dev warning', () => {
    const T = defineTopic('Retain', { n: 'i32' })
    const world = createWorld({})
    // Kernel-only frame loop: each frameReset closes the current frame.
    world.publish(T, { n: 1 }) // frame 0
    // 'Sleepy' consumes the first event, then stops keeping up.
    expect(vals(world.__topics.consume(erased(T), 'Sleepy'))).toEqual([1])
    world.frameReset() // enter frame 1: frame-0 events retained
    expect(world.__topics.bounds(erased(T)).tail).toBe(0)
    world.publish(T, { n: 2 }) // frame 1
    world.publish(T, { n: 3 }) // frame 1
    world.frameReset() // enter frame 2: frame-1 events still retained (dropped only at N+2)
    world.frameReset() // enter frame 3: frame-0 AND frame-1 events dropped
    const bounds = world.__topics.bounds(erased(T))
    expect(bounds.tail).toBe(3)
    // Sleepy's cursor (1) is behind the tail (3) — snapped forward, with a dev warning naming both.
    expect(vals(world.__topics.consume(erased(T), 'Sleepy'))).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/topic 'Retain'.*'Sleepy'.*missed 2 event/))
  })

  test('a late reader initializes at the current head — no replay of retained events', () => {
    const T = defineTopic('Late', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 1 })
    world.__topics.initCursor(erased(T), 'newcomer')
    world.publish(T, { n: 2 })
    expect(vals(world.__topics.consume(erased(T), 'newcomer'))).toEqual([2])
  })
})

describe('overflow: spill, never throw; regrow at the next frame reset', () => {
  test('publishing past the ring capacity spills with one warning and loses nothing', () => {
    const T = defineTopic('Burst', { n: 'i32' })
    const world = createWorld({})
    const N = 2000 // initial capacity is 256 rows — far past it
    for (let i = 0; i < N; i++) world.publish(T, { n: i })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/topic 'Burst' ring overflowed/))
    const seen = vals(world.__topics.consume(erased(T), 'r'))
    expect(seen.length).toBe(N)
    expect(seen[0]).toBe(0)
    expect(seen[N - 1]).toBe(N - 1)
    // The next frame reset folds the spill into a 2x-peak ring; the stream stays intact.
    world.frameReset()
    const words = world.__topics.streamWords(erased(T))
    expect(words.length).toBe(N * (TOPIC_HEADER_WORDS + 1))
    // Row payloads survived the regrow verbatim (header words zero, payload = i).
    expect(words[TOPIC_HEADER_WORDS]).toBe(0)
    expect(words[(N - 1) * (TOPIC_HEADER_WORDS + 1) + TOPIC_HEADER_WORDS]).toBe(N - 1)
  })
})

describe('phase + update guards (the canonical ring is serial-phase-only)', () => {
  test("world.publish throws while world.phase === 'wave'", () => {
    const T = defineTopic('Guard', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 1 })
    world.__setPhase('wave')
    expect(() => world.publish(T, { n: 2 })).toThrow(/world\.phase === 'serial'/)
    world.__setPhase('serial')
  })

  test("mergeStaged throws while world.phase === 'wave' (instrumented serial-slot invariant)", () => {
    const T = defineTopic('Guard2', { n: 'i32' })
    const world = createWorld({})
    world.__topics.register(erased(T))
    world.__topics.stageValues(erased(T), 0, { n: 1 })
    world.__setPhase('wave')
    expect(() => world.__topics.mergeStaged()).toThrow(/outside the serial phase/)
    world.__setPhase('serial')
    world.__topics.mergeStaged() // succeeds at the serial slot
  })

  test('world.publish during an update throws (use ctx.publish inside systems)', () => {
    const T = defineTopic('Guard3', { n: 'i32' })
    const world = createWorld({})
    world.publish(T, { n: 1 })
    world.__topics.beginUpdate()
    expect(() => world.publish(T, { n: 2 })).toThrow(/during world update/)
    world.__topics.endUpdate()
    world.publish(T, { n: 3 })
  })
})

describe('payload fidelity', () => {
  test('f32 bits, f64 two-word, vec, staticString and negative ints round-trip exactly', () => {
    const T = defineTopic('Fidelity', {
      a: 'f32',
      b: 'f64',
      c: 'i32',
      d: vec('f32', 3),
      e: staticString('low', 'high'),
      f: 'bool',
    })
    const world = createWorld({})
    world.publish(T, { a: 1.5, b: Math.PI, c: -42, d: [1, 2.5, -3], e: 'high', f: true })
    let read: Record<string, unknown> | null = null
    for (const ev of world.__topics.consume(erased(T), 'r')) {
      const v = ev as Record<string, unknown>
      read = { a: v.a, b: v.b, c: v.c, d: [...(v.d as number[])], e: v.e, f: v.f }
    }
    expect(read).toEqual({ a: 1.5, b: Math.PI, c: -42, d: [1, 2.5, -3], e: 'high', f: true })
  })
})
