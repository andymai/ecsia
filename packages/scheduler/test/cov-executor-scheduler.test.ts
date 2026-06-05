// Coverage: executor/scheduler.ts — strideFor's explicit `registeredComponentCount` branch (line 49,
// branch 49). When provided, the access stride is ceil(count/32) regardless of declared ids; when
// omitted it is derived from the max declared component id. scheduler.md §12.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import type { ComponentDef, Schema } from '@ecsia/schema'

describe('scheduler.ts: strideFor explicit registeredComponentCount (branch 49)', () => {
  test('an explicit registeredComponentCount fixes accessStrideWords = ceil(count/32)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_stride_c' }) as ComponentDef<Schema>
    const world = createWorld({ components: [C] })
    const S = defineSystem({ name: 'S', read: [C], run() {} })
    // 33 registered components → ceil(33/32) = 2 words, INDEPENDENT of the (small) declared id.
    const sched = createScheduler(world, [S], { registeredComponentCount: 33 })
    expect(sched.plan.accessStrideWords).toBe(2)
  })

  test('count exactly on a 32-boundary rounds to one word', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_stride_c2' }) as ComponentDef<Schema>
    const world = createWorld({ components: [C] })
    const S = defineSystem({ name: 'S', read: [C], run() {} })
    const sched = createScheduler(world, [S], { registeredComponentCount: 32 })
    expect(sched.plan.accessStrideWords).toBe(1)
  })

  test('a zero count still yields at least one word (Math.max(1, …) floor)', () => {
    const world = createWorld()
    const S = defineSystem({ name: 'S', run() {} })
    const sched = createScheduler(world, [S], { registeredComponentCount: 0 })
    expect(sched.plan.accessStrideWords).toBe(1)
  })

  test('OMITTING registeredComponentCount derives the stride from the max declared id (branch 49 false)', () => {
    // Contrast case: with no explicit count, the stride is ceil((maxId+1)/32). A single component with
    // a small id stays at one word — proving the explicit-count branch is what widened it above.
    const C = defineComponent({ x: 'f32' }, { name: 'cov_stride_c3' }) as ComponentDef<Schema>
    const world = createWorld({ components: [C] })
    const S = defineSystem({ name: 'S', read: [C], run() {} })
    const sched = createScheduler(world, [S])
    expect(sched.plan.accessStrideWords).toBe(1)
  })
})
