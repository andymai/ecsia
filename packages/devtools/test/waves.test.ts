// explainPlan: the WHY of a REAL createScheduler plan. We build a plan with KNOWN conflicts —
// a writer + reader of the same component (must end up wave-ordered), a write-write pair, and a
// rich-field system (must be pinned, reason 'rich-fields') — then assert the conflict edges carry the
// right kind + component name, the wave ordering separates the conflicting systems, and the pin reason.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import { createScheduler, defineSystem, inAnyOrderWith } from '@ecsia/scheduler'
import { explainPlan, componentNameMap, renderText } from '../src/index.js'

describe('explainPlan — the WHY of a real schedule', () => {
  // A writes a; B reads a + writes b; P writes a rich (object) field. The (writer A, reader B) pair on
  // component `a` is the KNOWN read-write conflict; P is the KNOWN rich-field pin.
  function build() {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const B = defineComponent({ v: 'i32' }, { name: 'b' })
    const Rich = defineComponent({ obj: object<string>() }, { name: 'rich' })
    const world = createWorld({ components: [A, B, Rich] })

    const Writer = defineSystem({ name: 'Writer', read: [], write: [A], run() {} })
    const Reader = defineSystem({ name: 'Reader', read: [A], write: [B], run() {} })
    const RichWriter = defineSystem({ name: 'RichWriter', read: [], write: [Rich], run() {} })

    const sched = createScheduler(world, [Writer, Reader, RichWriter])
    return { sched, world }
  }

  test('the writer+reader of the same component are wave-ordered (writer before reader)', () => {
    const { sched, world } = build()
    const plan = explainPlan(sched, componentNameMap(world))

    // The read-write dependency on `a` forces serialization → at least 2 waves.
    expect(plan.waves.length).toBeGreaterThanOrEqual(2)

    // Locate the wave index of each system.
    const waveOf = (name: string): number => {
      for (const w of plan.waves) {
        for (const b of w.batches) if (b.systems.some((s) => s.name === name)) return w.index
      }
      return -1
    }
    const writerWave = waveOf('Writer')
    const readerWave = waveOf('Reader')
    expect(writerWave).toBeGreaterThanOrEqual(0)
    expect(readerWave).toBeGreaterThanOrEqual(0)
    // Writer (writes a) must run in an EARLIER wave than Reader (reads a).
    expect(writerWave).toBeLessThan(readerWave)
  })

  test('the read-write conflict edge names the right kind and component', () => {
    const { sched, world } = build()
    const plan = explainPlan(sched, componentNameMap(world))

    const rw = plan.conflicts.find((c) => c.on === 'a' && c.kind === 'read-write')
    expect(rw).toBeDefined()
    // Pair order is plan SystemId-ascending: Writer registered before Reader.
    expect(rw!.a).toBe('Writer')
    expect(rw!.b).toBe('Reader')
    expect(rw!.on).toBe('a')
    expect(rw!.kind).toBe('read-write')
  })

  test('a rich-field-writing system is pinned with reason rich-fields', () => {
    const { sched, world } = build()
    const plan = explainPlan(sched, componentNameMap(world))

    const pin = plan.pinned.find((p) => p.system === 'RichWriter')
    expect(pin).toBeDefined()
    expect(pin!.reason).toBe('rich-fields')

    // And the per-system access record marks it worker-ineligible.
    const sys = plan.waves.flatMap((w) => w.batches).flatMap((b) => b.systems).find((s) => s.name === 'RichWriter')!
    expect(sys.workerEligible).toBe(false)
    expect(sys.writes).toEqual(['rich'])
  })

  test('worker-eligible systems carry component names in reads/writes, not ids', () => {
    const { sched, world } = build()
    const plan = explainPlan(sched, componentNameMap(world))

    const all = plan.waves.flatMap((w) => w.batches).flatMap((b) => b.systems)
    const writer = all.find((s) => s.name === 'Writer')!
    expect(writer.writes).toEqual(['a'])
    expect(writer.reads).toEqual([])
    expect(writer.workerEligible).toBe(true)

    const reader = all.find((s) => s.name === 'Reader')!
    expect(reader.reads).toEqual(['a'])
    expect(reader.writes).toEqual(['b'])

    // Every system in the plan appears exactly once across the waves.
    expect(all.map((s) => s.name).sort()).toEqual(['Reader', 'RichWriter', 'Writer'])
  })

  test('write-write conflict is reported on the shared component', () => {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const world = createWorld({ components: [A] })
    const X = defineSystem({ name: 'X', read: [], write: [A], run() {} })
    const Y = defineSystem({ name: 'Y', read: [], write: [A], run() {} })
    const plan = explainPlan(createScheduler(world, [X, Y]), componentNameMap(world))

    const ww = plan.conflicts.find((c) => c.kind === 'write-write')
    expect(ww).toBeDefined()
    expect(ww!.on).toBe('a')
    expect(ww!.a).toBe('X')
    expect(ww!.b).toBe('Y')
  })

  // GUARD against conflict-vs-schedule drift. `conflicts` must reflect the plan's ACTUAL placement, not a
  // re-derived type-level overlap test. An `inAnyOrderWith(X, Y)` deny suppresses the IMPLICIT ordering
  // edge between two writers of `a`, so the scheduler collapses them into ONE wave. But a write-write
  // hazard is never concurrency-compatible, so round-packing still puts them in SEPARATE rounds — they
  // run sequentially. The deny moved them from "different waves" to "different rounds of one wave"; both
  // are genuine separation, so the conflict is STILL reported here (and on the right rounds). The
  // placement read is what keeps this honest: were a deny ever to leave the two systems in the SAME
  // round, `separated()` would suppress the report.
  function denyHelper() {
    const A = defineComponent({ v: 'i32' }, { name: 'a' })
    const world = createWorld({ components: [A] })
    const X = defineSystem({ name: 'X', read: [], write: [A], run() {} })
    const Ybase = defineSystem({ name: 'Y', read: [], write: [A], run() {} })
    const Y = defineSystem({ ...Ybase, order: [inAnyOrderWith(X, Ybase)] })
    const plan = explainPlan(createScheduler(world, [X, Y]), componentNameMap(world))
    const coordOf = (name: string): string => {
      for (const w of plan.waves) for (let r = 0; r < w.batches.length; r++) {
        if (w.batches[r]!.systems.some((s) => s.name === name)) return `${w.index}:${r}`
      }
      return ''
    }
    return { plan, coordOf }
  }

  test('inAnyOrderWith collapses two writers into ONE wave but they stay in SEPARATE rounds', () => {
    const { plan, coordOf } = denyHelper()
    expect(plan.waves.length).toBe(1) // deny honored: not serialized across waves
    // yet the write-write hazard keeps them in different rounds of that wave (sequential execution).
    expect(coordOf('X')).not.toBe(coordOf('Y'))
    expect(coordOf('X').startsWith('0:')).toBe(true)
    expect(coordOf('Y').startsWith('0:')).toBe(true)
  })

  test('the conflict IS reported because the plan genuinely separates the two writers (different rounds)', () => {
    const { plan } = denyHelper()
    const ww = plan.conflicts.find((c) => c.on === 'a' && c.kind === 'write-write' && c.a === 'X' && c.b === 'Y')
    expect(ww).toBeDefined()
  })

  test('every reported conflict corresponds to a pair the plan ACTUALLY separated (different wave/round)', () => {
    // Property guard tying `conflicts` to placement: no conflict may name a pair the plan co-located in
    // the same (wave, round). This is the invariant the placement-derived implementation guarantees and
    // the old type-overlap reimplementation did NOT (it reported purely from access overlap, blind to
    // whether the scheduler kept the pair concurrent).
    const { plan } = denyHelper()
    const coord = new Map<string, string>()
    plan.waves.forEach((w, wi) => w.batches.forEach((b, ri) =>
      b.systems.forEach((s) => coord.set(s.name, `${wi}:${ri}`))))
    expect(plan.conflicts.length).toBeGreaterThan(0)
    for (const c of plan.conflicts) {
      expect(coord.get(c.a)).not.toBe(coord.get(c.b)) // never a same-slot (concurrent) pair
    }
  })

  test('accepts either a SchedulerHandle or a bare plan and yields identical output', () => {
    const { sched, world } = build()
    const names = componentNameMap(world)
    const fromHandle = explainPlan(sched, names)
    const fromPlan = explainPlan(sched.plan, names)
    expect(fromPlan).toEqual(fromHandle)
  })

  test('without a name map, components render as #id but the shape is intact', () => {
    const { sched } = build()
    const plan = explainPlan(sched) // no names
    const all = plan.waves.flatMap((w) => w.batches).flatMap((b) => b.systems)
    // ids render as #<n>; still resolvable as a conflict edge.
    expect(all.length).toBe(3)
    expect(plan.conflicts.every((c) => c.on.startsWith('#'))).toBe(true)
    // Renders to text without throwing.
    expect(renderText(plan)).toContain('wave 0')
  })

  test('the plan explanation is plain + JSON-serializable', () => {
    const { sched, world } = build()
    const plan = explainPlan(sched, componentNameMap(world))
    const round = JSON.parse(JSON.stringify(plan))
    expect(round.conflicts.find((c: { on: string }) => c.on === 'a').kind).toBe('read-write')
    expect(round.pinned.find((p: { system: string }) => p.system === 'RichWriter').reason).toBe('rich-fields')
  })
})
