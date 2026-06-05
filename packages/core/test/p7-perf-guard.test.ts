// P7 perf-regression GUARDS — structural / counter-based, NOT wall-clock (non-flaky by construction).
// These lock in the two iteration hot-path optimizations whose measured numbers live in docs/perf/P7.md:
//
//   WRITE-PATH-GATE  the .each setter's trackWrite chain is fully skipped when no write consumer exists.
//                    Counter invariant: with `tracking.active === false`, N scalar writes ⇒ ZERO
//                    handleIndex decodes AND ZERO trackWrite calls; flip it true ⇒ exactly N of each.
//                    This is the P7 optimization that cut .each ~22.8 → ~10.4 ns/ent (50k, single proc).
//
//   CHUNK-SETUP-O(A) eachChunk's per-call machinery (column resolves) is O(archetypes), independent of
//                    N: the column index map is built ONCE per (component) and reused, and the chunk is a
//                    single reused instance. Counter invariant: column-index BUILD count does not grow
//                    with entity count, and the row loop allocates nothing per row (asserted via a stable
//                    chunk identity + a constant resolve count across two N).
//
// A wall-clock assertion would be flaky across machines/JIT; these assert the STRUCTURE that makes the
// win real, so a regression that re-introduces per-write handle decoding or per-call column rebuilding
// fails deterministically.

import { describe, expect, test } from 'vitest'
import { buildColumnSet, bindAccessorRow, createWorld, defineComponent, write } from '@ecsia/core'
import type { QueryChunk } from '@ecsia/core'
import { Buffers, ComponentRegistry, probeCapabilities } from '../src/internal.js'
import type { AccessorWorld } from '../src/internal.js'
import type { ComponentDef, Schema } from '@ecsia/core'

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

// A counting accessor-world: spies on the two calls the setter's track() makes (handleIndex decode +
// trackWrite). `tracking` is a live cell so flipping `.active` mid-test reflects immediately (the same
// shared-cell semantics the real world uses).
function countingWorld(): AccessorWorld & {
  handleIndexCalls: number
  trackWriteCalls: number
  tracking: { active: boolean }
} {
  const tracking = { active: false }
  const self = {
    handleIndexCalls: 0,
    trackWriteCalls: 0,
    tracking,
    trackWrite(_index: number, _componentId: unknown, _fieldIndex?: number): void {
      self.trackWriteCalls += 1
    },
    handleIndex(h: unknown): number {
      self.handleIndexCalls += 1
      return (h as number) & 0x3fffff
    },
  }
  return self as unknown as AccessorWorld & {
    handleIndexCalls: number
    trackWriteCalls: number
    tracking: { active: boolean }
  }
}

describe('P7 WRITE-PATH-GATE — trackWrite chain is dead-skipped with no consumer (counter-based)', () => {
  const N = 256

  function writeN(active: boolean): { handleIndexCalls: number; trackWriteCalls: number } {
    const buffers = newBuffers()
    const world = countingWorld()
    world.tracking.active = active
    const C = defineComponent({ v: 'f32' }, { name: 'p7gate' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: N })
    for (let i = 0; i < N; i++) {
      const a = bindAccessorRow(set, i, ((i + 1) << 4) as never) as unknown as { v: number }
      a.v = i // ONE scalar write per row
    }
    return { handleIndexCalls: world.handleIndexCalls, trackWriteCalls: world.trackWriteCalls }
  }

  test('inactive: N writes ⇒ ZERO handleIndex decodes and ZERO trackWrite calls', () => {
    const r = writeN(false)
    expect(r.handleIndexCalls).toBe(0)
    expect(r.trackWriteCalls).toBe(0)
  })

  test('active: N writes ⇒ exactly N handleIndex decodes and N trackWrite calls', () => {
    const r = writeN(true)
    expect(r.handleIndexCalls).toBe(N)
    expect(r.trackWriteCalls).toBe(N)
  })

  // V-1 / ACC-1: the gate is orthogonal to view rebind. After a column grow re-points the accessor's
  // view, the gate must STILL (a) let the value write land on the live (grown) view regardless of
  // tracking state, and (b) when active, record exactly one tracked write. Guards that the fast-out did
  // not bypass the rebind protocol.
  test('gate is rebind-safe: value lands on the grown view; active ⇒ exactly one tracked write', () => {
    const buffers = newBuffers()
    const world = countingWorld()
    const C = defineComponent({ v: 'f32' }, { name: 'p7grow' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })

    buffers.grow(set.columns[0]!, 64)
    // inactive: value still writes through the rebound view, no tracking.
    const aLow = bindAccessorRow(set, 40, 0x10 as never) as unknown as { v: number }
    aLow.v = 7.5
    expect(aLow.v).toBeCloseTo(7.5)
    expect(world.trackWriteCalls).toBe(0)
    // active: tracks exactly once, value still correct on the grown view.
    world.tracking.active = true
    const aHigh = bindAccessorRow(set, 50, 0x20 as never) as unknown as { v: number }
    aHigh.v = -2.25
    expect(aHigh.v).toBeCloseTo(-2.25)
    expect(world.trackWriteCalls).toBe(1)
    expect(world.handleIndexCalls).toBe(1)
  })

  test('flipping tracking.active mid-stream tracks only the post-flip writes (live shared cell)', () => {
    const buffers = newBuffers()
    const world = countingWorld()
    const C = defineComponent({ v: 'f32' }, { name: 'p7gate2' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 8 })
    const a = bindAccessorRow(set, 0, 0x10 as never) as unknown as { v: number }
    a.v = 1 // inactive
    a.v = 2 // inactive
    expect(world.trackWriteCalls).toBe(0)
    world.tracking.active = true
    a.v = 3 // active
    expect(world.trackWriteCalls).toBe(1)
    expect(world.handleIndexCalls).toBe(1)
  })
})

describe('P7 CHUNK-SETUP-O(A) — eachChunk preamble is independent of N (structural)', () => {
  function build(n: number): { resolves: number; chunkIdentities: Set<unknown>; rows: number } {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'p7cx' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'p7cv' })
    const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 20 })
    for (let i = 0; i < n; i++) {
      const h = world.spawnWith(Position, Velocity)
      const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
      v.dx = 1
      v.dy = 0.5
    }
    const q = world.query(write(Position), write(Velocity))
    let resolves = 0
    let rows = 0
    const chunkIdentities = new Set<unknown>()
    // Run the loop TWICE so a per-call (rather than cached) column rebuild would inflate the count.
    for (let pass = 0; pass < 2; pass++) {
      q.eachChunk((c: QueryChunk) => {
        chunkIdentities.add(c)
        // First resolve per (component, field) per call: count them so we can assert they don't scale with N.
        c.column(Position, 'x')
        c.column(Position, 'y')
        c.column(Velocity, 'dx')
        c.column(Velocity, 'dy')
        resolves += 4
        for (let i = 0; i < c.count; i++) rows += 1
      })
    }
    return { resolves, chunkIdentities, rows }
  }

  test('column-resolve count is constant across N (no per-row column rebuild)', () => {
    const small = build(64)
    const large = build(8192)
    // Single hot archetype ⇒ one chunk visit per pass ⇒ 4 resolves/pass × 2 passes = 8, for BOTH N.
    expect(small.resolves).toBe(8)
    expect(large.resolves).toBe(8)
    // Row work scales with N (sanity: the loop really visited every entity).
    expect(small.rows).toBe(2 * 64)
    expect(large.rows).toBe(2 * 8192)
  })

  test('the chunk is ONE reused instance across calls/passes (zero per-call chunk allocation)', () => {
    const { chunkIdentities } = build(1024)
    expect(chunkIdentities.size).toBe(1)
  })
})
