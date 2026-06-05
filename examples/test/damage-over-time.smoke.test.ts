// Smoke + regression test for the damage-over-time example. It locks in the documented path:
// structural changes from inside a system via ctx.world, an onRemove(Health) death observer (a
// callback that fires when the component is removed), and a ChildOf exclusive relation whose
// deleteSubject cascade despawns children when their parent dies. Results are keyed by spec
// index (mob id), not raw entity handle.

import { describe, expect, test } from 'vitest'
import { main as damageOverTime } from '../damage-over-time.js'

describe('example: damage-over-time (damage + death + cascade)', () => {
  test('default sim burns mobs down, cascades children, and logs every death once', () => {
    const r = damageOverTime()

    // Tracing DEFAULT_MOBS (see damage-over-time.ts): mob1 (hp 6, 3 stacks, child of 0) burns to
    // 0 hp on tick 3 and despawns; the deleteSubject cascade despawns its child, mob2. mob3
    // (hp 4, 2 stacks) and mob4 (1 stack) burn out their stacks before dying. Mobs 0/3/4 survive.
    expect(r.ticksRun).toBe(3)

    // Exactly mobs 1 and 2 died — the burned-out parent and its cascaded child.
    expect(new Set(r.deaths)).toEqual(new Set([1, 2]))
    // The onRemove(Health) observer fired once per death, proving it actually ran.
    expect(r.observedDeathCount).toBe(2)

    // Survivors are exactly mobs 0, 3, 4 (cascade left no dangling child of the dead mob1).
    expect(new Set(r.survivors)).toEqual(new Set([0, 3, 4]))

    // The Burning component was removed at 0 stacks (the system's ctx.world.remove path), so no
    // survivor is still burning.
    expect(r.stillBurning).toEqual([])

    // Final hp after the damage arithmetic: mob0 untouched (10), mob3 burned 4→2→1, mob4 50→49.
    expect(r.hpById[0]).toBe(10)
    expect(r.hpById[3]).toBe(1)
    expect(r.hpById[4]).toBe(49)
  })

  test('despawning a parent cascades the whole subtree (deleteSubject)', () => {
    // A single chain root→1→2→3; only the root burns. When the root dies, the entire ChildOf
    // subtree cascades in one despawn.
    const r = damageOverTime({
      mobs: [
        { hp: 1, burning: 1, parent: null }, // 0 root, dies tick 1
        { hp: 99, burning: 0, parent: 0 }, //   1
        { hp: 99, burning: 0, parent: 1 }, //   2
        { hp: 99, burning: 0, parent: 2 }, //   3
      ],
      ticks: 4,
    })
    // The root's despawn cascades its child, that child's child, and so on — all four die.
    expect(r.survivors).toEqual([])
    expect(new Set(r.deaths)).toEqual(new Set([0, 1, 2, 3]))
    expect(r.observedDeathCount).toBe(4)
    expect(r.ticksRun).toBe(1)
  })

  test('an extinguished mob keeps living without its Burning component', () => {
    const r = damageOverTime({
      mobs: [{ hp: 100, burning: 2, parent: null }], // burns 2 then 1 stack, never dies
      ticks: 8,
    })
    expect(r.survivors).toEqual([0])
    expect(r.deaths).toEqual([])
    expect(r.observedDeathCount).toBe(0)
    expect(r.stillBurning).toEqual([]) // Burning removed once stacks hit 0
    // hp: 100 - 2 (tick1, stacks→1) - 1 (tick2, stacks→0, Burning removed) = 97
    expect(r.hpById[0]).toBe(97)
  })
})
