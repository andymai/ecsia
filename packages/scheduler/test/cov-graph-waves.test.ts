// Coverage: graph/waves.ts — concurrencyCompatible write/write + read/write rejections (branches
// 41/43), the cycle-escaped guard (lines 75-76, branch 73) via a hand-built cyclic DAG, round packing
// with incompatible systems (branch 100), worker-ineligible main-thread pinning into an existing
// worker round (lines 121-126, branch 119), and the eligible/worker-0 fall-through (branch 112).
// scheduler.md §5.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import { defineSystem } from '@ecsia/scheduler'
import { buildPlan, concurrencyCompatible, lowerSystems } from '../src/internal.js'
import type { DAG, ScheduleWave } from '../src/internal.js'
import type { ComponentDef, Schema, SystemId } from '@ecsia/schema'

/** A linear DAG over `n` nodes with NO edges (all in one wave). */
function noEdgeDag(n: number): DAG {
  return { n, succ: Array.from({ length: n }, () => [] as SystemId[]) }
}

function batchesOf(wave: ScheduleWave): { systemId: number; workerIndex: number }[] {
  return wave.rounds.flat().map((b) => ({ systemId: b.systemId as unknown as number, workerIndex: b.workerIndex }))
}

describe('waves.ts: concurrencyCompatible rejections (branches 41/43)', () => {
  test('two systems WRITING the same component are incompatible (branch 41, write/write)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_cc_ww' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const [a, b] = lowerSystems(
      [
        defineSystem({ name: 'a', write: [C], run() {} }),
        defineSystem({ name: 'b', write: [C], run() {} }),
      ],
      4,
    )
    expect(concurrencyCompatible(a!, b!)).toBe(false)
  })

  test('a-READ overlapping b-WRITE is incompatible (branch 43, a-read/b-write)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_cc_rw' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    // `a` reads C, `b` writes C → a.readWords & b.writeWords != 0 → branch 43 returns false.
    const [a, b] = lowerSystems(
      [
        defineSystem({ name: 'a', read: [C], run() {} }),
        defineSystem({ name: 'b', write: [C], run() {} }),
      ],
      4,
    )
    expect(concurrencyCompatible(a!, b!)).toBe(false)
  })

  test('a-WRITE overlapping b-READ is incompatible (branch 42, a-write/b-read)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_cc_wr' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const [a, b] = lowerSystems(
      [
        defineSystem({ name: 'a', write: [C], run() {} }),
        defineSystem({ name: 'b', read: [C], run() {} }),
      ],
      4,
    )
    expect(concurrencyCompatible(a!, b!)).toBe(false)
  })

  test('two pure READERS of the same component ARE compatible (read/read allowed, §5.6)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_cc_rr' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const [a, b] = lowerSystems(
      [
        defineSystem({ name: 'a', read: [C], run() {} }),
        defineSystem({ name: 'b', read: [C], run() {} }),
      ],
      4,
    )
    expect(concurrencyCompatible(a!, b!)).toBe(true)
  })
})

describe('waves.ts: extractWaves cycle-escaped guard (lines 75-76, branch 73)', () => {
  test('buildPlan over a DAG that still contains a cycle throws the SCH-1 safety assertion', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_wave_cycle' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const systems = lowerSystems(
      [defineSystem({ name: 'a', run() {} }), defineSystem({ name: 'b', run() {} })],
      4,
    )
    // A 0→1→0 cycle: every node has in-degree >= 1, so Kahn's queue is empty from the start and
    // `placed` stays 0 < n → the guard fires. (This path is unreachable via buildDAG, which detects
    // cycles first; the guard is the SCH-1 belt-and-braces assertion against an escaped cycle.)
    const cyclic: DAG = {
      n: 2,
      succ: [[1 as unknown as SystemId], [0 as unknown as SystemId]],
    }
    expect(() => buildPlan(systems, cyclic, 4, 0)).toThrow(/wave extraction dropped systems \(0\/2\)/)
  })
})

describe('waves.ts: packWave round packing', () => {
  test('two INCOMPATIBLE systems in one wave are split into two sequential rounds (branch 100)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_pack_incompat' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    // Both write C → incompatible. With no DAG edges they share a wave but cannot share a round.
    const systems = lowerSystems(
      [
        defineSystem({ name: 'a', write: [C], run() {} }),
        defineSystem({ name: 'b', write: [C], run() {} }),
      ],
      4,
    )
    const plan = buildPlan(systems, noEdgeDag(2), 4, 2)
    const wave = plan.waves[0]!
    expect(wave.rounds).toHaveLength(2)
    expect(wave.rounds[0]!.map((b) => b.systemId as unknown as number)).toEqual([0])
    expect(wave.rounds[1]!.map((b) => b.systemId as unknown as number)).toEqual([1])
  })

  test('two COMPATIBLE eligible systems pack into the SAME round on distinct workers', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_pack_compat1' }) as ComponentDef<Schema>
    const D = defineComponent({ y: 'f32' }, { name: 'cov_pack_compat2' }) as ComponentDef<Schema>
    createWorld({ components: [C, D] })
    const systems = lowerSystems(
      [
        defineSystem({ name: 'a', write: [C], run() {} }),
        defineSystem({ name: 'b', write: [D], run() {} }),
      ],
      4,
    )
    const plan = buildPlan(systems, noEdgeDag(2), 4, 2)
    expect(plan.waves[0]!.rounds).toHaveLength(1)
    const round = plan.waves[0]!.rounds[0]!
    expect(round.map((b) => b.workerIndex).sort()).toEqual([0, 1])
    // perWorkerSpawnHint reserves each system's maxSpawnsPerWave on its assigned worker.
    expect(plan.waves[0]!.perWorkerSpawnHint[0]).toBeGreaterThan(0)
    expect(plan.waves[0]!.perWorkerSpawnHint[1]).toBeGreaterThan(0)
  })

  test('a worker-INELIGIBLE system joins an existing worker round on the main-thread slot (lines 121-126, branch 119)', () => {
    // `a` writes a scalar component (worker-eligible). `b` writes an object<T> component
    // (restrictedToMainThread → ineligible). They access DISJOINT components so they are compatible
    // and share ONE round: `a` on worker 0, `b` pinned to the round's single main-thread slot (-1).
    const Scalar = defineComponent({ x: 'f32' }, { name: 'cov_elig_scalar' }) as ComponentDef<Schema>
    const Obj = defineComponent({ ref: object<{ k: number }>() }, { name: 'cov_inelig_obj' }) as ComponentDef<Schema>
    createWorld({ components: [Scalar, Obj] })
    const systems = lowerSystems(
      [
        defineSystem({ name: 'a', write: [Scalar], run() {} }),
        defineSystem({ name: 'b', write: [Obj], run() {} }),
      ],
      4,
    )
    expect(systems[0]!.workerEligible).toBe(true)
    expect(systems[1]!.workerEligible).toBe(false)
    const plan = buildPlan(systems, noEdgeDag(2), 4, 2)
    expect(plan.waves[0]!.rounds).toHaveLength(1)
    const round = batchesOf(plan.waves[0]!)
    // a → worker 0; b → main-thread slot (-1), in the SAME round.
    expect(round).toContainEqual({ systemId: 0, workerIndex: 0 })
    expect(round).toContainEqual({ systemId: 1, workerIndex: -1 })
  })

  test('a second ineligible system cannot share the round (only one main-thread slot) → new round', () => {
    // Two object-field systems over DISJOINT components: both ineligible. The single main-thread slot
    // per round forces them into separate rounds even though they are concurrency-compatible.
    const O1 = defineComponent({ a: object<{ k: number }>() }, { name: 'cov_inelig_o1' }) as ComponentDef<Schema>
    const O2 = defineComponent({ b: object<{ k: number }>() }, { name: 'cov_inelig_o2' }) as ComponentDef<Schema>
    createWorld({ components: [O1, O2] })
    const systems = lowerSystems(
      [
        defineSystem({ name: 'a', write: [O1], run() {} }),
        defineSystem({ name: 'b', write: [O2], run() {} }),
      ],
      4,
    )
    const plan = buildPlan(systems, noEdgeDag(2), 4, 2)
    expect(plan.waves[0]!.rounds).toHaveLength(2)
    expect(plan.waves[0]!.rounds[0]!.map((b) => b.workerIndex)).toEqual([-1])
    expect(plan.waves[0]!.rounds[1]!.map((b) => b.workerIndex)).toEqual([-1])
  })

  test('with workerCount 0, two compatible ELIGIBLE systems each take a main-thread slot in SEPARATE rounds (branch 112 fall-through)', () => {
    // workerCount===0: an eligible system can only take the single main-thread slot per round. Two
    // compatible eligible systems thus land in two rounds — the second one evaluates branch 112's
    // condition against an existing round whose main slot is taken (false side) and creates a new round.
    const C = defineComponent({ x: 'f32' }, { name: 'cov_w0_c' }) as ComponentDef<Schema>
    const D = defineComponent({ y: 'f32' }, { name: 'cov_w0_d' }) as ComponentDef<Schema>
    createWorld({ components: [C, D] })
    const systems = lowerSystems(
      [
        defineSystem({ name: 'a', write: [C], run() {} }),
        defineSystem({ name: 'b', write: [D], run() {} }),
      ],
      4,
    )
    const plan = buildPlan(systems, noEdgeDag(2), 4, 0)
    expect(plan.waves[0]!.rounds).toHaveLength(2)
    // Both pinned to the main thread (-1) since there are no workers.
    expect(batchesOf(plan.waves[0]!).every((b) => b.workerIndex === -1)).toBe(true)
  })
})
