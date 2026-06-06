// Spill-discard safety at the frame boundary. frameReset clears the overflow spill;
// a changed-flavor consumer that drained MID-frame (before later systems pushed more spilled
// writes) has a spillCursor behind the spill it never read. The contract is fail-safe, not
// fail-silent: the next drain must either surface those writes or take the conservative
// OVERFLOW_SENTINEL path (every current match reported). Silently dropping them — the changed
// filter never firing for a real write — is the regression this file pins.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

function makeKit(opts?: Parameters<typeof createWorld>[0]): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const components = [Position] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ ...opts, components }), Position }
}

describe('frameReset discards an undrained spill → conservative path, never silent loss', () => {
  test('writes spilled AFTER a mid-frame drain still surface (precisely or conservatively) next frame', () => {
    const { world, Position } = makeKit({ maxEntities: 64, reactivity: { maxWritesPerFrame: 4 } })
    const q = world.query(read(Position)).changed()
    const handles: EntityHandle[] = []
    for (let i = 0; i < 16; i++) handles.push(world.spawnWith(Position))
    world.frameReset()

    // Overflow the 4-entry ring: 8 writes → 4 in the ring, 4 in the spill.
    for (const h of handles.slice(0, 8)) (world.entity(h).write(Position) as { x: number }).x = 1
    // Mid-frame drain: the changed pointer advances past the ring AND the spill so far.
    let first = 0
    q.eachChanged(() => first++)
    expect(first).toBe(8)

    // Later systems write more — the ring is full, so these land entirely in the spill,
    // BEHIND the already-advanced spill cursor.
    for (const h of handles.slice(8)) (world.entity(h).write(Position) as { x: number }).x = 2

    world.flushLogs()
    world.frameReset()

    // The undrained spill was discarded at the reset. The consumer must either still see those
    // 8 writes or receive the overflow signal and report every current match — never nothing.
    const seen = new Set<EntityHandle>()
    q.eachChanged((el) => seen.add(el.handle))
    for (const h of handles.slice(8)) expect(seen.has(h)).toBe(true)
  })

  test('a consumer that fully drained before the reset stays precise (no spurious conservative drain)', () => {
    const { world, Position } = makeKit({ maxEntities: 64, reactivity: { maxWritesPerFrame: 4 } })
    const q = world.query(read(Position)).changed()
    const handles: EntityHandle[] = []
    for (let i = 0; i < 16; i++) handles.push(world.spawnWith(Position))
    world.frameReset()

    // Overflow the ring, then drain AFTER all writes — the pointer fully consumes ring + spill.
    for (const h of handles.slice(0, 8)) (world.entity(h).write(Position) as { x: number }).x = 1
    let first = 0
    q.eachChanged(() => first++)
    expect(first).toBe(8)

    world.flushLogs()
    world.frameReset()

    // Nothing was lost for this consumer, so the next frame's changed set is exactly the
    // next frame's writes — not a conservative all-matches superset.
    ;(world.entity(handles[15] as EntityHandle).write(Position) as { x: number }).x = 3
    const seen = new Set<EntityHandle>()
    q.eachChanged((el) => seen.add(el.handle))
    expect(seen.size).toBe(1)
    expect(seen.has(handles[15] as EntityHandle)).toBe(true)
  })

  test('a consumer undrained across TWO resets still takes the conservative path (signal not erased)', () => {
    const { world, Position } = makeKit({ maxEntities: 64, reactivity: { maxWritesPerFrame: 4 } })
    const q = world.query(read(Position)).changed()
    const handles: EntityHandle[] = []
    for (let i = 0; i < 16; i++) handles.push(world.spawnWith(Position))
    world.frameReset()

    for (const h of handles.slice(0, 8)) (world.entity(h).write(Position) as { x: number }).x = 1
    let first = 0
    q.eachChanged(() => first++)
    expect(first).toBe(8)
    for (const h of handles.slice(8)) (world.entity(h).write(Position) as { x: number }).x = 2

    // Two empty frames pass before the query is read again — the second reset must not
    // re-sync the still-lagging consumer and erase its pending overflow signal.
    world.flushLogs()
    world.frameReset()
    world.flushLogs()
    world.frameReset()

    const seen = new Set<EntityHandle>()
    q.eachChanged((el) => seen.add(el.handle))
    for (const h of handles.slice(8)) expect(seen.has(h)).toBe(true)
  })
})
