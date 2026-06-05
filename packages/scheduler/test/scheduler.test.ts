import { describe, expect, test, vi } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import { createScheduler, defineSystem, inAnyOrderWith } from '@ecsia/scheduler'
import { EdgeWeight, CycleError, aggregateAccess, buildDAG, buildEdges, buildPlan, concurrencyCompatible, lowerSystems, resolveOrdering, Op } from '../src/internal.js'
import type { SystemDef } from '@ecsia/scheduler'

// A ComponentDef interns to exactly one world, so each test mints fresh defs + its own world.
function fixture() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const Health = defineComponent({ current: 'f32', max: 'f32' }, { name: 'health' })
  const world = createWorld({ components: [Position, Velocity, Health] })
  return { world, Position, Velocity, Health }
}

describe('command-buffer op ordinals ', () => {
  test('CREATE=0 .. SET_PAYLOAD=6', () => {
    expect([Op.CREATE, Op.DESTROY, Op.ADD, Op.REMOVE, Op.ADD_PAIR, Op.REMOVE_PAIR, Op.SET_PAYLOAD]).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
  })
})

describe('access aggregation ', () => {
  test('readers/writers maps from declared sets only', () => {
    const { Position, Velocity, Health } = fixture()
    const Movement = defineSystem({ name: 'Movement', read: [Velocity], write: [Position], run() {} })
    const Combat = defineSystem({ name: 'Combat', read: [Position], write: [Health], run() {} })
    const { readers, writers } = aggregateAccess(lowerSystems([Movement, Combat], 1))
    expect([...(writers.get(Position.id) ?? [])]).toEqual([0])
    expect([...(readers.get(Position.id) ?? [])]).toEqual([1])
    expect([...(writers.get(Health.id) ?? [])]).toEqual([1])
  })
})

describe('conflict DAG ', () => {
  test('read-after-write serializes Movement before Combat', () => {
    const { Position, Velocity, Health } = fixture()
    const Movement = defineSystem({ name: 'Movement', read: [Velocity], write: [Position], run() {} })
    const Combat = defineSystem({ name: 'Combat', read: [Position], write: [Health], run() {} })
    const defs = [Movement, Combat]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
    expect(edges).toHaveLength(1)
    expect(edges[0]!.from).toBe(0)
    expect(edges[0]!.to).toBe(1)
    expect(edges[0]!.weight).toBe(EdgeWeight.IMPLICIT)
  })

  test('two pure readers of a component do NOT conflict (no edge)', () => {
    const { Position } = fixture()
    const A = defineSystem({ name: 'A', read: [Position], write: [], run() {} })
    const B = defineSystem({ name: 'B', read: [Position], write: [], run() {} })
    const defs = [A, B]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    expect(buildEdges(boxes, defs, aggregateAccess(boxes))).toHaveLength(0)
  })

  test('explicit after — EXPLICIT weight 5', () => {
    fixture()
    const First = defineSystem({ name: 'First', run() {} })
    const Second = defineSystem({ name: 'Second', after: [First], run() {} })
    const defs = [First, Second]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
    expect(edges).toHaveLength(1)
    expect([edges[0]!.from, edges[0]!.to, edges[0]!.weight]).toEqual([0, 1, EdgeWeight.EXPLICIT])
  })

  test('inAnyOrderWith suppresses the implicit edge (safe override)', () => {
    const { Position } = fixture()
    const a = defineSystem({ name: 'A', write: [Position], run() {} })
    const b = defineSystem({ name: 'B', read: [Position], run() {} })
    const aWithDeny = defineSystem({ ...a, order: [inAnyOrderWith(a, b)] })
    const defs = [aWithDeny, b]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    expect(buildEdges(boxes, defs, aggregateAccess(boxes))).toHaveLength(0)
  })

  test('a cycle throws CycleError with a named chain + inAnyOrderWith suggestion', () => {
    fixture()
    const X: SystemDef = defineSystem({ name: 'X', run() {} })
    const Y: SystemDef = defineSystem({ name: 'Y', before: [X], after: [X], run() {} })
    const defs = [X, Y]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    const edges = buildEdges(boxes, defs, aggregateAccess(boxes))
    expect(() => buildDAG(boxes, edges)).toThrow(CycleError)
    try {
      buildDAG(boxes, edges)
    } catch (e) {
      expect((e as CycleError).message).toContain('System cycle detected')
      expect((e as CycleError).message).toContain('inAnyOrderWith')
    }
  })
})

describe('WAVE-CONFLICT + waves ', () => {
  test('concurrencyCompatible: disjoint writes ok, read-vs-write not', () => {
    const { Position, Health } = fixture()
    const A = defineSystem({ name: 'A', write: [Position], run() {} })
    const B = defineSystem({ name: 'B', write: [Health], run() {} })
    const C = defineSystem({ name: 'C', read: [Position], run() {} })
    const [a, b, c] = lowerSystems([A, B, C], 1)
    expect(concurrencyCompatible(a!, b!)).toBe(true)
    expect(concurrencyCompatible(a!, c!)).toBe(false)
  })

  test('disjoint systems share one wave (single-thread, both main-thread slots)', () => {
    const { Position, Health } = fixture()
    const A = defineSystem({ name: 'A', write: [Position], run() {} })
    const B = defineSystem({ name: 'B', write: [Health], run() {} })
    const defs = [A, B]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    const plan = buildPlan(boxes, buildDAG(boxes, buildEdges(boxes, defs, aggregateAccess(boxes))), 1, 0)
    expect(plan.waves).toHaveLength(1)
    expect(plan.waves[0]!.rounds.flat()).toHaveLength(2)
  })

  test('every same-round pair is concurrencyCompatible ', () => {
    const { Position, Velocity, Health } = fixture()
    const A = defineSystem({ name: 'A', write: [Position], run() {} })
    const B = defineSystem({ name: 'B', write: [Health], run() {} })
    const C = defineSystem({ name: 'C', write: [Velocity], run() {} })
    const defs = [A, B, C]
    const boxes = resolveOrdering(lowerSystems(defs, 1), defs)
    const plan = buildPlan(boxes, buildDAG(boxes, buildEdges(boxes, defs, aggregateAccess(boxes))), 1, 4)
    for (const wave of plan.waves) {
      for (const round of wave.rounds) {
        for (let i = 0; i < round.length; i++) {
          for (let j = i + 1; j < round.length; j++) {
            const ai = plan.systems[round[i]!.systemId as unknown as number]!
            const aj = plan.systems[round[j]!.systemId as unknown as number]!
            expect(concurrencyCompatible(ai, aj)).toBe(true)
          }
        }
      }
    }
  })
})

describe('single-thread executor end-to-end ', () => {
  test('Movement (wave 0) before Combat (wave 1); state mutates correctly', () => {
    const { world, Position, Velocity, Health } = fixture()
    const order: string[] = []
    const Movement = defineSystem({
      name: 'Movement',
      read: [Velocity],
      write: [Position],
      run({ query, dt }) {
        order.push('Movement')
        for (const e of query(Velocity, write(Position))) {
          const p = (e as { position: { x: number; y: number } }).position
          const v = (e as { velocity: { dx: number; dy: number } }).velocity
          p.x += v.dx * dt
          p.y += v.dy * dt
        }
      },
    })
    const Combat = defineSystem({
      name: 'Combat',
      read: [Position],
      write: [Health],
      run() {
        order.push('Combat')
      },
    })
    const scheduler = createScheduler(world, [Movement, Combat], { dev: true })
    const e = world.spawnWith(Position, Velocity)
    world.entity(e).write(Velocity).dx = 2

    scheduler.update(1)
    expect(order).toEqual(['Movement', 'Combat'])
    expect(world.entity(e).read(Position).x).toBeCloseTo(2)
    expect(world.phase).toBe('serial') // PHASE-1

    scheduler.update(1)
    expect(world.entity(e).read(Position).x).toBeCloseTo(4)
  })

  test('tick advances once per update', () => {
    const { world } = fixture()
    const scheduler = createScheduler(world, [defineSystem({ name: 'Noop', run() {} })])
    const t0 = world.tick
    scheduler.update(1)
    scheduler.update(1)
    expect(world.tick).toBe(t0 + 2)
  })

  test('empty system set: update is a clean no-op tick', () => {
    const world = createWorld()
    const scheduler = createScheduler(world, [])
    expect(scheduler.plan.waves).toHaveLength(0)
    expect(() => scheduler.update(1)).not.toThrow()
    expect(world.phase).toBe('serial')
  })
})

describe('dev-mode access guards ', () => {
  test('a write() term for an undeclared component warns', () => {
    const { world, Position } = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const Bad = defineSystem({
      name: 'Bad',
      read: [Position],
      write: [],
      run({ query }) {
        for (const _ of query(write(Position))) void _
      },
    })
    createScheduler(world, [Bad], { dev: true }).update(1)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not in its declared write set'))).toBe(true)
    warn.mockRestore()
  })
})
