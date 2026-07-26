// — worker write-corral overflow is DIAGNOSED, never silent. The corral SAB stages one
// (index, componentId) pair per worker field-write so the serial merge can drive `.changed()`/onChange
// and stamp changeVersion. When a worker stages more writes than the corral holds, the excess pairs
// cannot fit — but the overflow must be reported (the value write already landed in the shared column,
// so dropping its change-tracking staging silently would under-send reactivity/deltas: the unsafe
// direction). Regression: the writer used to saturate the count word at capacity, making the pool's
// `count > capPairs` merge check unreachable dead code — overflow was completely silent.

import { fileURLToPath } from 'node:url'
import { describe, expect, test, afterEach } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { WorkerPool } from '@ecsia/scheduler/workers'
import type { PoolSystem } from '@ecsia/scheduler'
import type { SystemId } from '@ecsia/schema'

const WORKER_ENTRY = fileURLToPath(new URL('../dist/workers/worker-entry.js', import.meta.url))
const KERNEL_MODULE = fileURLToPath(new URL('./fixtures/m7-kernels.mjs', import.meta.url))

function makeWorld(): { world: World; Health: ReturnType<typeof defineComponent>; handles: EntityHandle[] } {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
  const world = createWorld({ components: [Health, Mana], maxEntities: 1 << 12, threaded: true, scheduler: { workers: 1 } })
  const handles: EntityHandle[] = []
  for (let i = 0; i < 64; i++) {
    const h = world.spawnWith(Health)
    ;(world.entity(h).write(Health) as { hp: number }).hp = i
    handles.push(h)
  }
  return { world, Health, handles }
}

const regen: PoolSystem = {
  id: 0 as unknown as SystemId,
  name: 'Regen',
  matchComponents: [],
  kernel: () => {},
  maxSpawnsPerWave: 0,
}

let pool: WorkerPool | undefined
afterEach(async () => {
  await pool?.dispose()
  pool = undefined
})

describe('worker write-corral overflow protocol', () => {
  test('a wave staging more field-writes than the corral holds emits an overflow diagnostic (never silent)', async () => {
    const { world, Health, handles } = makeWorld()
    const diags: string[] = []
    const systems: PoolSystem[] = [{ ...regen, matchComponents: [Health] }]
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      writeCorralEntries: 8, // Regen stages 64 Health writes into an 8-pair corral → overflow
      diagnostic: (m) => diags.push(m),
    })
    await pool.ready()
    await pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)

    expect(world.phase).toBe('serial')
    // The overflow is DETECTED and reported. Before the fix the count word saturated at capacity so
    // this branch was unreachable — the drop was silent.
    expect(diags.some((m) => /write-corral overflow/i.test(m))).toBe(true)
    // The value writes hit the shared column directly (not gated by the corral), so every Health still
    // lands correctly — only the change-tracking staging overflowed.
    for (let i = 0; i < handles.length; i++) {
      expect((world.entity(handles[i]!).read(Health) as { hp: number }).hp).toBe(i + 1)
    }
  })

  test('a wave within corral capacity emits NO overflow diagnostic', async () => {
    const { world, Health, handles } = makeWorld()
    const diags: string[] = []
    const systems: PoolSystem[] = [{ ...regen, matchComponents: [Health] }]
    pool = new WorkerPool({
      world,
      workers: 1,
      kernelModule: KERNEL_MODULE,
      workerEntryUrl: WORKER_ENTRY,
      systems,
      writeCorralEntries: 128, // 64 writes < 128 → fits
      diagnostic: (m) => diags.push(m),
    })
    await pool.ready()
    await pool.runRound([{ systemId: 0 as unknown as SystemId, workerIndex: 0 }], 1)

    expect(diags.some((m) => /write-corral overflow/i.test(m))).toBe(false)
    for (let i = 0; i < handles.length; i++) {
      expect((world.entity(handles[i]!).read(Health) as { hp: number }).hp).toBe(i + 1)
    }
  })
})
