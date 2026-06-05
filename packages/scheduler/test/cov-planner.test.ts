// Coverage: planner/access.ts (idOf unregistered guard, worker-eligibility) + planner/define-system.ts
// (validation throws + the three ordering-hint combinators).,

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import { defineSystem, inAnyOrderWith, beforeWritersOf, afterReadersOf } from '@ecsia/scheduler'
import { lowerSystems, aggregateAccess } from '../src/internal.js'
import type { SystemDef } from '@ecsia/scheduler'
import type { ComponentDef, Schema } from '@ecsia/schema'

describe('define-system.ts: defineSystem validation (lines 10-15, branches 10/13)', () => {
  test('a valid def is frozen and branded with __ecsiaSystem', () => {
    const sys = defineSystem({ name: 'ok', run() {} })
    expect(sys.__ecsiaSystem).toBe(true)
    expect(Object.isFrozen(sys)).toBe(true)
    expect(sys.name).toBe('ok')
  })

  test('a missing name throws (branch 10: typeof name !== string)', () => {
    expect(() => defineSystem({ run() {} } as unknown as SystemDef)).toThrow(/`name` is required/)
  })

  test('an empty-string name throws (branch 10: name.length === 0)', () => {
    expect(() => defineSystem({ name: '', run() {} })).toThrow(/`name` is required/)
  })

  test('a non-function run throws and names the system (branch 13)', () => {
    expect(() => defineSystem({ name: 'broken', run: 42 as unknown as () => void })).toThrow(
      /defineSystem\('broken'\): `run` must be a function/,
    )
  })
})

describe('define-system.ts: ordering-hint combinators (lines 24-36)', () => {
  test('inAnyOrderWith builds a deny hint carrying both systems (suppress implicit edge)', () => {
    const a = defineSystem({ name: 'a', run() {} })
    const b = defineSystem({ name: 'b', run() {} })
    const hint = inAnyOrderWith(a, b)
    expect(hint).toEqual({ kind: 'deny', a, b })
    // Order matters for the carried payload — a is the first arg, b the second.
    expect(hint.kind === 'deny' && hint.a).toBe(a)
    expect(hint.kind === 'deny' && hint.b).toBe(b)
  })

  test('beforeWritersOf builds a class hint carrying the component', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_bwo' }) as ComponentDef<Schema>
    const hint = beforeWritersOf(C)
    expect(hint.kind).toBe('beforeWritersOf')
    expect(hint.kind === 'beforeWritersOf' && hint.component).toBe(C)
  })

  test('afterReadersOf builds a class hint carrying the component', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_aro' }) as ComponentDef<Schema>
    const hint = afterReadersOf(C)
    expect(hint.kind).toBe('afterReadersOf')
    expect(hint.kind === 'afterReadersOf' && hint.component).toBe(C)
  })
})

describe('access.ts: idOf unregistered guard (lines 24-28)', () => {
  test('lowering a system declaring access to an UNREGISTERED component throws and names it', () => {
    // A component never registered with any world keeps id === -1 (UNREGISTERED).
    const Loose = defineComponent({ x: 'f32' }, { name: 'unregistered_comp' }) as ComponentDef<Schema>
    expect((Loose as unknown as { id: number }).id).toBe(-1) // precondition: truly unregistered
    const sys = defineSystem({ name: 'usesLoose', read: [Loose], run() {} })
    expect(() => lowerSystems([sys], 4)).toThrow(
      /system declares access to component 'unregistered_comp' which is not registered/,
    )
  })

  test('a registered component lowers without throwing and its id is packed into the read signature', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'registered_comp' }) as ComponentDef<Schema>
    createWorld({ components: [C] }) // registration assigns a real id
    const id = (C as unknown as { id: number }).id
    expect(id).toBeGreaterThanOrEqual(0)
    const sys = defineSystem({ name: 'usesC', read: [C], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect([...box!.readIds]).toContain(id as never)
    // The id's bit is set in the packed read signature word.
    expect((box!.readWords[id >>> 5]! >>> (id & 31)) & 1).toBe(1)
  })
})

describe('access.ts: computeWorkerEligible (branch 45, line 25-28 via shareable)', () => {
  test('a system over only shareable (scalar) components is worker-eligible', () => {
    const C = defineComponent({ x: 'f32', y: 'i32' }, { name: 'shareable_comp' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const sys = defineSystem({ name: 'shareableSys', read: [C], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(true)
  })

  test('a system declaring a component with a non-shareable object<T> field is worker-INELIGIBLE (branch 45)', () => {
    // object<T> fields are restrictedToMainThread → shareable=false → the system is pinned main-thread.
    const Obj = defineComponent({ ref: object<{ k: number }>() }, { name: 'object_comp' }) as ComponentDef<Schema>
    createWorld({ components: [Obj] })
    const sys = defineSystem({ name: 'objSys', write: [Obj], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(false)
  })
})

describe('access.ts: aggregateAccess reader/writer maps', () => {
  test('readers and writers are aggregated per id from the lowered systems', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'agg_comp' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const id = (C as unknown as { id: number }).id
    const reader = defineSystem({ name: 'reader', read: [C], run() {} })
    const writer = defineSystem({ name: 'writer', write: [C], run() {} })
    const boxes = lowerSystems([reader, writer], 4)
    const { readers, writers } = aggregateAccess(boxes)
    expect(readers.get(id as never)?.has(boxes[0]!.id)).toBe(true) // reader system reads C
    expect(writers.get(id as never)?.has(boxes[1]!.id)).toBe(true) // writer system writes C
    expect(writers.get(id as never)?.has(boxes[0]!.id)).toBeFalsy() // reader is not a writer
  })
})
