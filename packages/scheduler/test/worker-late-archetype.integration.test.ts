// REGRESSION — archetypes created AFTER pool bootstrap must reach the workers. The worker's
// zero-copy view captures the shared buffer set once at startup; a lazily-created archetype's
// columns arrive only through the growth-journal broadcast at the wave fence. Before the fix,
// Buffers.column()/region() journaled only RE-backings, so a post-bootstrap archetype's columns
// were invisible to workers: readField returned 0 and writeField dropped, silently — the exact
// failure a spawner-driven world (entities minted every frame) hits on its first threaded run.
//
// The auto-threading path (threading.kernelModule) is used deliberately: it is the public
// `scheduler.update()` route, so the regression is pinned where a user hits it.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import type { SchedulerHandle } from '@ecsia/scheduler'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

let sched: SchedulerHandle | undefined
afterEach(async () => {
  await sched?.dispose()
  sched = undefined
})

describe('late-created archetypes reach the worker pool', () => {
  test('entities spawned AFTER the first threaded update are stepped by worker kernels', async () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
    const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers: 2 } })
    const Regen = defineSystem({ name: 'Regen', read: [], write: [Health], run() {} })
    const Channel = defineSystem({ name: 'Channel', read: [], write: [Mana], run() {} })
    sched = createScheduler(world, [Regen, Channel], {
      workers: 2,
      threading: { kernelModule: KERNEL_MODULE, workerEntryUrl: WORKER_ENTRY },
    })

    // First update BOOTSTRAPS the pool while ZERO matching entities (and zero archetypes) exist.
    await sched.update(1)

    // Now the archetype (Health+Mana) is created for the first time — post-bootstrap.
    const handles: EntityHandle[] = []
    for (let i = 0; i < 8; i++) {
      const h = world.spawnWith(Health, Mana)
      ;(world.entity(h).write(Health) as { hp: number }).hp = 10
      ;(world.entity(h).write(Mana) as { mp: number }).mp = 100
      handles.push(h)
    }

    for (let f = 0; f < 3; f++) await sched.update(1)

    // The m7 kernels: Regen hp+=1, Channel mp-=1, per frame. Entities existed for 3 threaded
    // frames; a worker blind to the new archetype leaves them untouched (the regression).
    for (const h of handles) {
      expect((world.entity(h).read(Health) as { hp: number }).hp).toBe(13)
      expect((world.entity(h).read(Mana) as { mp: number }).mp).toBe(97)
    }
  })
})
