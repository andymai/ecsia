// — deferred observers under the (serial-slot) drain. The headline
// correctness goal: an observer handler MAY create/destroy/add/remove entities, but those structural
// ops STAGE to a main-thread command buffer and apply at the NEXT serial flush — NEVER mid-drain. So
// no observer ever sees a partially-applied wave, the drain iterates a FROZEN log snapshot, and a
// spawn inside an onChange handler is observed by onAdd NEXT drain (deterministically), never
// re-entrantly this drain.
//
// apply next flush.
// no observer fires synchronously; the drain never re-enters unsafely.
// onChange fires once per coalesced net change.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, onAdd, onRemove, onChange } from '@ecsia/core'
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

describe(', applied next flush, observed by onAdd NEXT drain', () => {
  test('an onChange handler that spawns: the new entity is NOT live mid-drain; onAdd fires next drain', () => {
    const { world, Position, Velocity } = makeKit()
    const spawned: EntityHandle[] = []
    const addOrder: number[] = []
    let liveDuringHandler = -1

    // An onChange handler spawns a NEW entity with Velocity.
    world.observe(onChange(Position), () => {
      const e = world.spawn()
      // The handle is reserved-alive (usable) but its archetype placement is DEFERRED — so it is not
      // yet a Velocity holder, and the world is NOT mutated mid-drain.
      liveDuringHandler = world.isAlive(e) ? 1 : 0
      world.add(e, Velocity)
      spawned.push(e)
    })
    world.observe(onAdd(Velocity), () => addOrder.push(1))

    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 7

    // Drain 1: the onChange fires, stages a spawn+add. onAdd must NOT fire this drain.
    world.observerDrain()
    expect(spawned.length).toBe(1)
    expect(liveDuringHandler).toBe(1) // the reserved handle is usable inside the handler
    expect(addOrder.length).toBe(0) // not observed re-entrantly this drain

    // Drain 2: the staged spawn+add applies at THIS flush, then onAdd observes it.
    world.frameReset()
    world.observerDrain()
    expect(addOrder.length).toBe(1)
    // The spawned entity now genuinely holds Velocity.
    expect(world.has(spawned[0] as EntityHandle, Velocity)).toBe(true)
  })

  test('the world is not mutated mid-drain: a despawn staged in an observer applies only next flush', () => {
    const { world, Position } = makeKit()
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position)
    let aliveAfterHandler = -1

    world.observe(onChange(Position), () => {
      // Despawn b from inside the handler — staged, NOT applied now.
      world.despawn(b)
      aliveAfterHandler = world.isAlive(b) ? 1 : 0
    })

    world.frameReset()
    ;(world.entity(a).write(Position) as { x: number }).x = 1
    world.observerDrain()
    expect(aliveAfterHandler).toBe(1) // b still alive immediately after the handler (not applied yet)

    // Next flush applies the staged despawn.
    world.frameReset()
    world.observerDrain()
    expect(world.isAlive(b)).toBe(false)
  })
})

describe(' — no observer observes a partially-applied wave (safe despawn inside onRemove)', () => {
  test('an onRemove handler that despawns a sibling does not corrupt later observers in the same drain', () => {
    const { world, Position } = makeKit()
    // Three entities; despawning a triggers onRemove(a). Inside that handler we despawn c. The drain
    // must still process the rest of the FROZEN snapshot without c's removal shuffling rows mid-drain.
    const a = world.spawnWith(Position)
    const b = world.spawnWith(Position)
    const c = world.spawnWith(Position)
    ;(world.entity(a).write(Position) as { x: number }).x = 11
    ;(world.entity(b).write(Position) as { x: number }).x = 22
    ;(world.entity(c).write(Position) as { x: number }).x = 33

    const removedValues: number[] = []
    world.observe(onRemove(Position), (ref) => {
      const v = (ref.read(Position) as { x: number }).x
      removedValues.push(v)
      if (v === 11) world.despawn(c) // staged — must NOT shuffle rows mid-drain
    })

    world.frameReset()
    world.despawn(a)
    world.despawn(b)
    world.observerDrain()

    // a and b's removals were both observed this drain with their correct pre-removal values; c's
    // despawn was staged (not applied), so it did not appear this drain and did not corrupt b's read.
    expect(removedValues).toContain(11)
    expect(removedValues).toContain(22)
    expect(removedValues).not.toContain(33)
    expect(world.isAlive(c)).toBe(true)

    // Next flush applies c's staged despawn; its onRemove fires next drain.
    world.frameReset()
    world.observerDrain()
    expect(world.isAlive(c)).toBe(false)
    expect(removedValues).toContain(33)
  })
})

describe(' — the drain never re-enters itself', () => {
  test('a nested observerDrain() call during a handler is a no-op (re-entrancy guard)', () => {
    const { world, Position } = makeKit()
    let fires = 0
    world.observe(onChange(Position), () => {
      fires++
      // A pathological re-entrant drain must not double-fire or corrupt pointers.
      world.observerDrain()
    })
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 5
    world.observerDrain()
    expect(fires).toBe(1) // exactly once — the nested drain was rejected
  })
})

describe('', () => {
  test('an onAdd handler reads the just-added component values via ref.read(C)', () => {
    const { world, Position, Velocity } = makeKit()
    let seenX = -1
    // Observe Velocity adds; the entity is alive and its values are bundled/readable at fire time.
    world.observe(onAdd(Velocity), (ref) => {
      seenX = (ref.read(Velocity) as { x: number }).x
    })
    const e = world.spawnWith(Position)
    world.add(e, Velocity)
    ;(world.entity(e).write(Velocity) as { x: number }).x = 99
    world.observerDrain()
    expect(seenX).toBe(99)
  })
})

describe(': an observer-issued write is deferred to the NEXT drain', () => {
  // The shape log is consumed before the write log in one drain. A structural (onAdd) handler that
  // calls entity.write(C) appends a write-log entry; the spec's frozen-snapshot wording means
  // that write must NOT be observed by an onChange handler in the SAME drain (no intra-drain
  // write-cascade). It fires on the NEXT drain. This pins the chosen semantic (review issue #2).
  test('an onAdd handler that writes a component does NOT trigger onChange this drain; it fires next drain', () => {
    const { world, Position, Velocity } = makeKit()
    const changeOrder: number[] = []
    let changesAtAddTime = -1

    // onAdd(Velocity) writes Position on the same entity — appending a write-log entry MID-drain.
    world.observe(onAdd(Velocity), (ref) => {
      ;(ref.write(Position) as { x: number }).x = 1
      changesAtAddTime = changeOrder.length // how many onChange fired BEFORE this write, this drain
    })
    world.observe(onChange(Position), () => changeOrder.push(1))

    const e = world.spawnWith(Position)
    world.add(e, Velocity)
    world.frameReset()

    // Drain 1: onAdd(Velocity) fires and writes Position. onChange(Position) must NOT fire this drain
    // for that write — the write-log consume is bounded to the head snapshotted at drain entry.
    world.observerDrain()
    expect(changesAtAddTime).toBe(0)
    expect(changeOrder.length).toBe(0)

    // Drain 2: the deferred write is now within the snapshot; onChange fires exactly once.
    world.frameReset()
    world.observerDrain()
    expect(changeOrder.length).toBe(1)
  })
})

describe(' — onChange fires once per coalesced net change', () => {
  test('N writes to the same component in one frame fire onChange exactly once', () => {
    const { world, Position } = makeKit()
    let changes = 0
    world.observe(onChange(Position), () => changes++)
    const e = world.spawnWith(Position)
    world.frameReset()
    for (let i = 0; i < 10; i++) (world.entity(e).write(Position) as { x: number }).x = i
    world.observerDrain()
    expect(changes).toBe(1)
  })
})
