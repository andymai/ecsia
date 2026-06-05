// reactivity invariant suite. Driven through createWorld so the trackWrite
// setter call-site, the shape-log commit points, and the query-flavor hooks are exercised end to end.
//
// / the .changed FILTER is driven by trackWrite from the MUTABLE setter; the
// Readonly shorthand NEVER tracks; changeVersion drives the PUBLIC predicate.
// observers fire only at observerDrain, never synchronously mid-system.
// a destroy observer can resolve the dying entity's last component value.
// add-then-remove of a component within a frame nets to no add/remove delta.
// ring overflow spills and recovers (no hard throw).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write, onAdd, onRemove, onChange } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

function makeKit(opts?: Parameters<typeof createWorld>[0]): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ x: 'f32', y: 'f32' }, { name: 'velocity' })
  const components = [Position, Velocity] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ ...opts, components }), Position, Velocity }
}

describe('/ — the Changed filter is write-log driven from the mutable setter', () => {
  test('a mutable setter write surfaces in eachChanged; the readonly path never tracks', () => {
    const { world, Position } = makeKit()
    const q = world.query(read(Position)).changed()
    const e = world.spawnWith(Position)
    world.frameReset()

    // Readonly shorthand read does NOT track.
    void (world.entity(e).read(Position) as { x: number }).x
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(0)

    // The mutable setter DOES track.
    ;(world.entity(e).write(Position) as { x: number }).x = 5
    q.eachChanged((el) => {
      void el
      changed++
    })
    expect(changed).toBe(1)
  })

  test('an entity written N times in a frame appears in the changed set once (dedup)', () => {
    const { world, Position } = makeKit()
    const q = world.query(write(Position)).changed()
    const e = world.spawnWith(Position)
    world.frameReset()
    const w = world.entity(e).write(Position) as { x: number; y: number }
    w.x = 1
    w.x = 2
    w.y = 3
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(1)
  })

  test('changedSince predicate is changeVersion-driven (independent of the write-log filter)', () => {
    const { world, Position } = makeKit()
    // Touch changedSince first so per-row stamping is enabled before the write.
    const e = world.spawnWith(Position)
    expect(world.changedSince(e, 0)).toBe(false)
    world.frameReset() // tick → 1
    ;(world.entity(e).write(Position) as { x: number }).x = 9
    // The write stamped the row at the current tick (1); strictly-after-0 is true, after-1 is false.
    expect(world.changedSince(e, 0)).toBe(true)
    expect(world.changedSince(e, world.currentTick())).toBe(false)
  })
})

describe('— observers are deferred, never synchronous', () => {
  test('onChange does not fire from the setter; only at observerDrain', () => {
    const { world, Position } = makeKit()
    let fired = 0
    world.observe(onChange(Position), () => fired++)
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 7
    expect(fired).toBe(0) // NOT synchronous
    world.observerDrain()
    expect(fired).toBe(1)
  })

  test('onAdd fires at the drain for a component added this frame', () => {
    const { world, Position, Velocity } = makeKit()
    let added = 0
    world.observe(onAdd(Velocity), () => added++)
    const e = world.spawnWith(Position)
    world.frameReset()
    world.add(e, Velocity)
    expect(added).toBe(0)
    world.observerDrain()
    expect(added).toBe(1)
  })

  test('neither the setter nor maintainStructural fires an observer — only observerDrain does', () => {
    const { world, Position, Velocity } = makeKit()
    const fired: string[] = []
    world.observe(onChange(Position), () => fired.push('change'))
    world.observe(onAdd(Velocity), () => fired.push('add'))
    world.observe(onRemove(Velocity), () => fired.push('remove'))
    const e = world.spawnWith(Position, Velocity)
    world.frameReset()

    // Mutations mid-"system": no observer may fire.
    ;(world.entity(e).write(Position) as { x: number }).x = 1
    world.remove(e, Velocity)
    world.add(e, Velocity)
    expect(fired).toEqual([])

    // The serial structural-maintenance drain must ALSO not fire observers (it feeds query deltas only).
    world.maintainStructural()
    expect(fired).toEqual([])

    // Only the dedicated drain dispatches them.
    world.observerDrain()
    expect(fired).toContain('change')
  })
})

describe('changeVersion granularity — component-level default', () => {
  test('writing one field stamps the whole-entity row (component granularity): changedSince is true for the entity', () => {
    const { world, Position } = makeKit()
    const e = world.spawnWith(Position)
    expect(world.changedSince(e, 0)).toBe(false)
    world.frameReset() // tick → 1
    // Write only field x; component-granular stamping records the whole row at the current tick.
    ;(world.entity(e).write(Position) as { x: number }).x = 3
    expect(world.changedSince(e, 0)).toBe(true)
    // A second write to a DIFFERENT field in the same frame does not change the answer (same row stamp).
    ;(world.entity(e).write(Position) as { y: number }).y = 4
    expect(world.changedSince(e, 0)).toBe(true)
    expect(world.changedSince(e, world.currentTick())).toBe(false)
  })

  test('changeVersion stamping is OPT-IN: an entity never read via changedSince/.changed still answers false (lazy enable)', () => {
    const { world, Position } = makeKit()
    const e = world.spawnWith(Position)
    world.frameReset()
    // Write WITHOUT ever enabling the predicate first. The first changedSince call enables stamping,
    // but the prior write was not stamped, so it must report no change strictly-after a past tick.
    ;(world.entity(e).write(Position) as { x: number }).x = 7
    // changedSince(e, 0) lazily enables stamping; the already-applied write left no stamp → false.
    expect(world.changedSince(e, 0)).toBe(false)
  })
})

describe('— destroy ordering lets an onRemove handler read the last value', () => {
  test('onRemove resolves the dying entity and reads its final component value', () => {
    const { world, Position } = makeKit()
    let seen = -1
    world.observe(onRemove(Position), (ref) => {
      seen = (ref.read(Position) as { x: number }).x
    })
    const e = world.spawnWith(Position)
    ;(world.entity(e).write(Position) as { x: number }).x = 42
    world.frameReset()
    world.despawn(e)
    world.observerDrain()
    expect(seen).toBe(42)
  })

  test(': despawning a NON-last row with a live sibling reads the DYING value, not the shuffled-in sibling', () => {
    // The discriminating case the single-entity test cannot reach: a sibling occupies the archetype's
    // last row and swap-pops into the dying entity's row. Without
    // entity's column data is overwritten by the sibling BEFORE observerDrain, so the handler would
    // read the sibling's value. With deferral it reads the dying entity's own pre-removal value.
    const { world, Position } = makeKit()
    const a = world.spawnWith(Position) // row 0
    const b = world.spawnWith(Position) // row 1 (the last row that shuffles into a's row on despawn)
    ;(world.entity(a).write(Position) as { x: number }).x = 11
    ;(world.entity(b).write(Position) as { x: number }).x = 22
    let seen = -1
    world.observe(onRemove(Position), (ref) => {
      seen = (ref.read(Position) as { x: number }).x
    })
    world.frameReset()
    world.despawn(a)
    world.observerDrain()
    expect(seen).toBe(11)
    // The live sibling's value must remain intact after the swap-pop + reclaim.
    expect((world.entity(b).read(Position) as { x: number }).x).toBe(22)
  })

  test(': without a remove-observer the row is reclaimed immediately (sibling shuffles into the dying row)', () => {
    const { world, Position } = makeKit()
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position)
    ;(world.entity(a).write(Position) as { x: number }).x = 11
    ;(world.entity(b).write(Position) as { x: number }).x = 22
    world.frameReset()
    world.despawn(a)
    world.observerDrain()
    // No deferral window: b's value is intact and b is still queryable with its value.
    expect((world.entity(b).read(Position) as { x: number }).x).toBe(22)
    const q = world.query(read(Position))
    expect(q.count).toBe(1)
    let walked = 0
    q.each(() => walked++)
    expect(walked).toBe(1)
  })
})

describe('— add-then-remove within a frame coalesces (off the shape log too)', () => {
  test('maintainStructural drain agrees with synchronous maintenance', () => {
    const { world, Position, Velocity } = makeKit()
    const q = world.query(read(Position), read(Velocity)).added().removed()
    const e = world.spawnWith(Position)
    world.frameReset()
    world.add(e, Velocity)
    world.remove(e, Velocity)
    world.maintainStructural()
    let added = 0
    let removed = 0
    q.eachAdded(() => added++)
    q.eachRemoved(() => removed++)
    expect(added).toBe(0)
    expect(removed).toBe(0)
  })
})

describe('— recoverable overflow spill (no hard throw)', () => {
  test('writing more entities than the tiny ring holds does not throw and reports all changed', () => {
    const { world, Position } = makeKit({ maxEntities: 64, reactivity: { maxWritesPerFrame: 4 } })
    const q = world.query(read(Position)).changed()
    const handles: EntityHandle[] = []
    for (let i = 0; i < 32; i++) handles.push(world.spawnWith(Position))
    world.frameReset()
    // 32 writes into a 4-entry ring → 28 spill, no throw.
    expect(() => {
      for (const h of handles) (world.entity(h).write(Position) as { x: number }).x = 1
    }).not.toThrow()
    let changed = 0
    q.eachChanged(() => changed++)
    expect(changed).toBe(32)
    expect(() => world.flushLogs()).not.toThrow()
  })
})

describe('lifecycle frame loop is idempotent across frames', () => {
  test('a fresh frame clears the prior frame changed set', () => {
    const { world, Position } = makeKit()
    const q = world.query(read(Position)).changed()
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 1
    let first = 0
    q.eachChanged(() => first++)
    expect(first).toBe(1)
    world.flushLogs()
    world.frameReset()
    let second = 0
    q.eachChanged(() => second++)
    expect(second).toBe(0)
  })
})
