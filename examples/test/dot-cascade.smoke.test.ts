// Smoke + regression test for the DoT/death/cascade example — the program the newcomer-sim failed to
// write from the docs. It locks the documented path: in-system structural mutation via ctx.world, an
// onRemove(Health) death observer, and a ChildOf exclusive relation whose deleteSubject cascade
// despawns children when a parent dies. Results are keyed by spec index (mob id), not raw handle.

import { describe, expect, test } from 'vitest'
import { main as dotCascade } from '../dot-cascade.js'

describe('example: dot-cascade (DoT + death + cascade)', () => {
  test('default sim burns mobs down, cascades children, and logs every death once', () => {
    const r = dotCascade()

    // Tracing DEFAULT_MOBS (see dot-cascade.ts): mob1 (hp6, burn3, child of 0) burns to 0 hp on tick 3
    // and despawns; its deleteSubject cascade despawns child mob2 (child of 1). mob3 (hp4, burn2) and
    // mob4 (burn1) extinguish their Burning before dying. mob0/3/4 survive.
    expect(r.ticksRun).toBe(3)

    // Exactly mobs 1 and 2 died — the burned-out parent and its cascaded child.
    expect(new Set(r.deaths)).toEqual(new Set([1, 2]))
    // The onRemove(Health) observer fired once per death, proving the death observer actually ran.
    expect(r.observedDeathCount).toBe(2)

    // Survivors are exactly mobs 0, 3, 4 (cascade left no dangling child of the dead mob1).
    expect(new Set(r.survivors)).toEqual(new Set([0, 3, 4]))

    // The Burning component was removed at 0 stacks (the system's ctx.world.remove path), so no
    // survivor is still burning.
    expect(r.stillBurning).toEqual([])

    // Final hp after the DoT arithmetic: mob0 untouched (10), mob3 burned 4→2→1, mob4 burned 50→49.
    expect(r.hpById[0]).toBe(10)
    expect(r.hpById[3]).toBe(1)
    expect(r.hpById[4]).toBe(49)
  })

  test('despawning a parent cascades the whole subtree (deleteSubject)', () => {
    // A 1-root chain root→1→2→3; only the root burns. When the root burns out, the entire ChildOf
    // subtree cascades in one despawn.
    const r = dotCascade({
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
    const r = dotCascade({
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
