// bindColumns (pinned columns): per-archetype column views resolved ONCE, factory-minted persistent
// runners, per-run invalidation. The contract under test: bind-time errors (row filter, rich field,
// unknown field, absent component), eachChunk-matching iteration order, factory re-invocation ONLY on
// view re-back or archetype-set change (never on population churn — meta.count is live), and the vec
// raw-view layout (row r at [r*stride, (r+1)*stride)).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object, read, vec3, write } from '@ecsia/core'
import { Buffers, LiveQuery, SparseSetU32, probeCapabilities } from '../src/internal.js'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import type { CompiledQuery, LiveQueryDeps, RegionKey } from '../src/internal.js'

function makeKit(maxEntities = 1 << 16): {
  world: ReturnType<typeof createWorld>
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
} {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const components = [Position, Velocity] as readonly ComponentDef<Schema>[]
  return { world: createWorld({ components, maxEntities }), Position, Velocity }
}

function spawnMoving(
  world: ReturnType<typeof createWorld>,
  Position: ComponentDef<Schema>,
  Velocity: ComponentDef<Schema>,
  dx = 1,
  dy = 0.5,
) {
  const h = world.spawnWith(Position, Velocity)
  const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
  v.dx = dx
  v.dy = dy
  return h
}

describe('bindColumns bind-time errors', () => {
  test('a row-filtered query throws (a pinned runner cannot skip rows)', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const buffers = new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })
    const current = new SparseSetU32(buffers, 'bc.d' as RegionKey, 'bc.s' as RegionKey, 64, 1 << 16)
    const cq = {
      withWords: [],
      notWords: [],
      optionalIds: [],
      residualWith: [],
      valueTerms: [],
      referencedIds: [],
      rowFilters: [{ presenceId: 1, targetEid: 1, targetFieldIndex: 0 }],
      hash: 'bc-rf',
      unsatisfiable: false,
    } as unknown as CompiledQuery
    const lq = new LiveQuery(cq, [], current, [], {} as LiveQueryDeps)
    expect(() => lq.bindColumns([Position, 'x'], () => () => {})).toThrow(/row-filtered/)
  })

  test("a rich field ('string'/object<T>) throws — no column to pin", () => {
    const Label = defineComponent({ text: 'string', meta: object<{ a: number }>(), x: 'f32' }, { name: 'label' })
    const world = createWorld({ components: [Label] as readonly ComponentDef<Schema>[] })
    world.spawnWith(Label)
    const q = world.query(write(Label))
    expect(() => q.bindColumns([Label, 'text' as never], () => () => {})).toThrow(/rich field/)
    expect(() => q.bindColumns([Label, 'meta' as never], () => () => {})).toThrow(/rich field/)
  })

  test('an unknown field throws', () => {
    const { world, Position } = makeKit()
    world.spawnWith(Position)
    const q = world.query(write(Position))
    expect(() => q.bindColumns([Position, 'nope' as never], () => () => {})).toThrow(/no column-backed field/)
  })

  test('a spec component the query does not require throws at bind', () => {
    const { world, Position, Velocity } = makeKit()
    world.spawnWith(Position) // archetype {Position} matches the query but lacks Velocity
    const q = world.query(write(Position))
    expect(() => q.bindColumns([Velocity, 'dx'], () => () => {})).toThrow(/not a required component/)
  })

  test('a non-required spec throws even when every CURRENT matched archetype has the component', () => {
    const { world, Position, Velocity } = makeKit()
    world.spawnWith(Position, Velocity) // the only matched archetype happens to carry Velocity
    const q = world.query(write(Position))
    // A future {Position}-only archetype would lack Velocity and blow up mid-run; reject at bind.
    expect(() => q.bindColumns([Velocity, 'dx'], () => () => {})).toThrow(/not a required component/)
  })

  test('mixed vec + scalar specs bind cleanly', () => {
    const Transform = defineComponent({ pos: vec3('f32'), w: 'f32' }, { name: 'transform' })
    const world = createWorld({ components: [Transform] as readonly ComponentDef<Schema>[] })
    world.spawnWith(Transform)
    const q = world.query(write(Transform))
    expect(() => q.bindColumns([Transform, 'pos'], [Transform, 'w'], () => () => {})).not.toThrow()
  })
})

describe('bindColumns iteration', () => {
  test('multi-archetype run() order matches eachChunk', () => {
    const Extra = defineComponent({ v: 'i32' }, { name: 'extra' })
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const world = createWorld({ components: [Position, Velocity, Extra] as readonly ComponentDef<Schema>[] })
    // Three matched archetypes with distinguishable populations: 1, 2, 3 entities.
    world.spawnWith(Position)
    for (let i = 0; i < 2; i++) world.spawnWith(Position, Velocity)
    for (let i = 0; i < 3; i++) world.spawnWith(Position, Velocity, Extra)
    const q = world.query(write(Position))

    const chunkOrder: number[] = []
    q.eachChunk((c) => chunkOrder.push(c.count))
    expect(chunkOrder).toHaveLength(3)

    const runOrder: number[] = []
    const run = q.bindColumns([Position, 'x'], (_views, meta) => () => {
      runOrder.push(meta.count)
    })
    run()
    expect(runOrder).toEqual(chunkOrder)
  })

  test('integration through pinned views matches the accessor read-back', () => {
    const { world, Position, Velocity } = makeKit()
    const n = 100
    for (let i = 0; i < n; i++) spawnMoving(world, Position, Velocity)
    const q = world.query(write(Position), read(Velocity))
    const dt = 1 / 60
    const run = q.bindColumns(
      [Position, 'x'],
      [Position, 'y'],
      [Velocity, 'dx'],
      [Velocity, 'dy'],
      ([px, py, dx, dy], meta) => () => {
        const count = meta.count
        for (let i = 0; i < count; i++) {
          px[i] = (px[i] as number) + (dx[i] as number) * dt
          py[i] = (py[i] as number) + (dy[i] as number) * dt
        }
      },
    )
    const steps = 10
    for (let s = 0; s < steps; s++) run()
    let seen = 0
    q.each((e) => {
      const el = e as unknown as { position: { x: number; y: number } }
      expect(el.position.x).toBeCloseTo(steps * dt, 6)
      expect(el.position.y).toBeCloseTo(steps * 0.5 * dt, 6)
      seen++
    })
    expect(seen).toBe(n)
  })

  test('vec3 field round-trips through the raw view (row r at [r*stride, (r+1)*stride))', () => {
    const Transform = defineComponent({ pos: vec3('f32'), w: 'f32' }, { name: 'transform' })
    const world = createWorld({ components: [Transform] as readonly ComponentDef<Schema>[] })
    const n = 8
    for (let i = 0; i < n; i++) world.spawnWith(Transform)
    const q = world.query(write(Transform))
    const run = q.bindColumns([Transform, 'pos'], [Transform, 'w'], ([pos, w], meta) => {
      // meta.strides[i] is the slots-per-row for spec i: 3 for the vec3 `pos`, 1 for the scalar `w`.
      // Read ONCE outside the runner so the hot loop never repeats the lookup.
      const s = meta.strides[0]!
      expect(meta.strides).toEqual([3, 1])
      return () => {
        const count = meta.count
        for (let r = 0; r < count; r++) {
          pos[r * s] = r
          pos[r * s + 1] = r * 10
          pos[r * s + 2] = r * 100
          w[r] = -r
        }
      }
    })
    run()
    let r = 0
    q.each((e) => {
      const el = e as unknown as { transform: { pos: { x: number; y: number; z: number }; w: number } }
      expect(el.transform.pos.x).toBe(r)
      expect(el.transform.pos.y).toBe(r * 10)
      expect(el.transform.pos.z).toBe(r * 100)
      expect(el.transform.w).toBe(-r)
      r++
    })
    expect(r).toBe(n)
  })
})

describe('bindColumns invalidation', () => {
  test('forced column growth re-invokes the factory exactly once per binding', () => {
    const { world, Position, Velocity } = makeKit()
    const before = 100
    for (let i = 0; i < before; i++) spawnMoving(world, Position, Velocity)
    const q = world.query(write(Position), read(Velocity))
    let invocations = 0
    const run = q.bindColumns([Position, 'x'], [Velocity, 'dx'], ([px, dx], meta) => {
      invocations++
      return () => {
        const count = meta.count
        for (let i = 0; i < count; i++) px[i] = (px[i] as number) + (dx[i] as number)
      }
    })
    expect(invocations).toBe(1)
    run()
    run()
    expect(invocations).toBe(1)

    // INITIAL_ROWS (64) × GROWTH_RESERVE (16) = 1024: spawning past it forces the fallback grow that
    // replaces col.view — the one signal that must re-invoke the factory.
    const after = 2000
    for (let i = before; i < after; i++) spawnMoving(world, Position, Velocity)
    run()
    expect(invocations).toBe(2)
    run()
    expect(invocations).toBe(2)

    // Both pre- and post-growth entities integrated: 4 runs for the first 100, 2 for the rest.
    const xs: number[] = []
    q.each((e) => xs.push((e as unknown as { position: { x: number } }).position.x))
    expect(xs.filter((x) => x === 4).length).toBe(before)
    expect(xs.filter((x) => x === 2).length).toBe(after - before)
  })

  test('an archetype-set change rebuilds and visits the new archetype without re-invoking existing bindings', () => {
    const { world, Position, Velocity } = makeKit()
    for (let i = 0; i < 4; i++) {
      const h = world.spawnWith(Position)
      ;(world.entity(h).write(Position) as { x: number }).x = 0
    }
    const q = world.query(write(Position))
    let invocations = 0
    let visited = 0
    const run = q.bindColumns([Position, 'x'], ([px], meta) => {
      invocations++
      return () => {
        const count = meta.count
        visited += count
        for (let i = 0; i < count; i++) px[i] = (px[i] as number) + 1
      }
    })
    expect(invocations).toBe(1)
    run()
    expect(visited).toBe(4)

    // Spawn into a NEW archetype matching the query: the binding set rebuilds (one new factory
    // invocation), the existing archetype's binding is preserved (no second invocation for it).
    world.spawnWith(Position, Velocity)
    visited = 0
    run()
    expect(invocations).toBe(2)
    expect(visited).toBe(5)
    visited = 0
    run()
    expect(invocations).toBe(2)
    expect(visited).toBe(5)
  })

  test('meta.count tracks spawn/despawn with zero factory re-invocations', () => {
    const { world, Position, Velocity } = makeKit()
    const handles = Array.from({ length: 5 }, () => spawnMoving(world, Position, Velocity))
    const q = world.query(write(Position), read(Velocity))
    let invocations = 0
    const counts: number[] = []
    const run = q.bindColumns([Position, 'x'], (_views, meta) => {
      invocations++
      return () => counts.push(meta.count)
    })
    run()
    for (let i = 0; i < 3; i++) spawnMoving(world, Position, Velocity)
    run()
    world.despawn(handles[0] as EntityHandle)
    world.despawn(handles[1] as EntityHandle)
    run()
    expect(counts).toEqual([5, 8, 6])
    expect(invocations).toBe(1)
  })

  test('warm promotion re-invokes the factory exactly once and integrates the promoted rows', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const Extra = defineComponent({ v: 'i32' }, { name: 'extra' })
    // maxHotArchetypes: 2 = the EMPTY archetype + the first populated one ({P,V}); the second
    // populated archetype ({P,V,E}) lands COLD — matched by the query but carrying no binding.
    const world = createWorld({
      components: [Position, Velocity, Extra] as readonly ComponentDef<Schema>[],
      maxHotArchetypes: 2,
    })
    const hot = Array.from({ length: 2 }, () => {
      const h = world.spawnWith(Position, Velocity)
      world.entity(h).write(Velocity).dx = 1
      return h
    })
    const cold = Array.from({ length: 3 }, () => world.spawnWith(Position, Velocity, Extra))

    const q = world.query(write(Position), read(Velocity))
    const coldArch = (q as unknown as LiveQuery).matchingArchetypes.find((a) => a.signature.length === 3)
    expect(coldArch?.cold).toBe(true)

    let invocations = 0
    const run = q.bindColumns([Position, 'x'], [Velocity, 'dx'], ([px, dx], meta) => {
      invocations++
      return () => {
        const count = meta.count
        for (let i = 0; i < count; i++) px[i] = (px[i] as number) + (dx[i] as number)
      }
    })
    expect(invocations).toBe(1) // the cold archetype gets no binding at bind time
    run() // cold rows not visited

    // Written while cold: lands in the cold blocks, must survive promotion into the hot columns.
    for (const h of cold) world.entity(h).write(Velocity).dx = 10
    world.warm(Position, Velocity, Extra)
    expect(coldArch?.cold).toBe(false)

    // Promotion flips arch.cold IN PLACE (matchingArchetypes length unchanged): the coldMatched
    // re-check is the only signal that can trigger this rebuild.
    run()
    expect(invocations).toBe(2)
    run()
    expect(invocations).toBe(2)

    // Hot rows integrated by all 3 runs (dx=1); promoted rows by the 2 post-promotion runs (dx=10).
    for (const h of hot) expect(world.entity(h).read(Position).x).toBe(3)
    for (const h of cold) expect(world.entity(h).read(Position).x).toBe(20)
  })

  test('an archetype bound while empty is skipped by run() and seen live once populated', () => {
    const { world, Position, Velocity } = makeKit()
    const h = world.spawnWith(Position, Velocity)
    world.despawn(h) // the {Position, Velocity} archetype exists with count 0
    const q = world.query(write(Position), read(Velocity))
    let invocations = 0
    let ran = 0
    const run = q.bindColumns([Position, 'x'], (_views, meta) => {
      invocations++
      return () => {
        ran += meta.count
      }
    })
    expect(invocations).toBe(1)
    run()
    expect(ran).toBe(0)
    // Population change only: same archetype set, same columns — no re-invocation.
    spawnMoving(world, Position, Velocity)
    spawnMoving(world, Position, Velocity)
    run()
    expect(ran).toBe(2)
    expect(invocations).toBe(1)
  })
})
