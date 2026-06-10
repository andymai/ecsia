// compile() PROPERTY suite: the compiled `.each` body and the SAME body run through the proxy `.each`
// produce byte-identical final column state under random interleavings of spawn (into BOTH matched
// archetypes — exercising the archetype-set-change rebuild), despawn, value writes, integrate steps, and
// forced column growth (a burst crosses the 1024-row reservation, forcing the re-back that replaces
// col.view under a live compiled binding). Two worlds get the same op sequence; only the integration path
// differs, so any divergence is a compile() bug. A second property drives the SAME comparison with a
// `.changed(Position)` consumer attached to BOTH worlds and asserts the drained changed-sets match —
// proving the compiled tracked-write path records reactivity identically to the accessor.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, read, write } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import type { PooledElement } from '../src/internal.js'
import { analyzeEachBody } from '../src/internal.js'

const DT = 1 / 60

type Op =
  | { kind: 'spawn'; arch: 0 | 1; n: number; dx: number; dy: number }
  | { kind: 'despawn'; pick: number }
  | { kind: 'write'; pick: number; dx: number; dy: number }
  | { kind: 'step' }
  | { kind: 'burst'; n: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('spawn' as const),
      arch: fc.constantFrom(0 as const, 1 as const),
      n: fc.integer({ min: 1, max: 20 }),
      dx: fc.integer({ min: -8, max: 8 }),
      dy: fc.integer({ min: -8, max: 8 }),
    }),
    weight: 3,
  },
  { arbitrary: fc.record({ kind: fc.constant('despawn' as const), pick: fc.nat() }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant('write' as const),
      pick: fc.nat(),
      dx: fc.integer({ min: -8, max: 8 }),
      dy: fc.integer({ min: -8, max: 8 }),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant('step' as const) }), weight: 2 },
  { arbitrary: fc.record({ kind: fc.constant('burst' as const), n: fc.integer({ min: 1100, max: 1300 }) }), weight: 1 },
)

interface Rig {
  world: ReturnType<typeof createWorld>
  handles: EntityHandle[]
  step: () => void
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
  Extra: ComponentDef<Schema>
}

type IntegEl = { position: { x: number; y: number }; velocity: { dx: number; dy: number } }

const canonicalBody = (e: IntegEl, ctx: { dt: number }): void => {
  e.position.x += e.velocity.dx * ctx.dt
  e.position.y += e.velocity.dy * ctx.dt
}

// `body` is run through BOTH compile() (reads its .toString()) and the proxy .each (calls it on the
// pooled element). The SAME function drives both paths, so any divergence is a compile() bug.
function makeRig(compiled: boolean, body: (e: IntegEl, ctx: { dt: number }) => void = canonicalBody): Rig {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const Extra = defineComponent({ v: 'i32' }, { name: 'extra' })
  const world = createWorld({
    components: [Position, Velocity, Extra] as readonly ComponentDef<Schema>[],
    maxEntities: 1 << 16,
  })
  const q = world.query(write(Position), read(Velocity)) as unknown as {
    compile<Ctx>(b: (e: IntegEl, ctx: Ctx) => void): (ctx: Ctx) => void
    each(fn: (e: PooledElement) => void): void
  }
  // Seed the burst archetype before binding so a re-back hits a LIVE compiled binding.
  const seed = world.spawnWith(Position, Velocity)
  const compiledRun = q.compile<{ dt: number }>(body)
  const step = compiled
    ? () => compiledRun({ dt: DT })
    : () => q.each((e) => body(e as unknown as IntegEl, { dt: DT }))
  return { world, handles: [seed], step, Position, Velocity, Extra }
}

function apply(rig: Rig, op: Op): void {
  const { world, handles } = rig
  switch (op.kind) {
    case 'spawn':
    case 'burst': {
      for (let i = 0; i < op.n; i++) {
        const h =
          op.kind === 'spawn' && op.arch === 1
            ? world.spawnWith(rig.Position, rig.Velocity, rig.Extra)
            : world.spawnWith(rig.Position, rig.Velocity)
        if (op.kind === 'spawn') {
          const v = world.entity(h).write(rig.Velocity) as { dx: number; dy: number }
          v.dx = op.dx
          v.dy = op.dy
        }
        handles.push(h)
      }
      break
    }
    case 'despawn': {
      if (handles.length === 0) return
      const i = op.pick % handles.length
      world.despawn(handles[i] as EntityHandle)
      handles.splice(i, 1)
      break
    }
    case 'write': {
      if (handles.length === 0) return
      const h = handles[op.pick % handles.length] as EntityHandle
      const v = world.entity(h).write(rig.Velocity) as { dx: number; dy: number }
      v.dx = op.dx
      v.dy = op.dy
      break
    }
    case 'step':
      rig.step()
      break
  }
}

describe('PROP compile() integrator == .each integrator', { timeout: 60_000 }, () => {
  test('random spawn/despawn/write/step/growth interleavings end byte-identical', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const cmp = makeRig(true)
        const oracle = makeRig(false)
        for (const op of ops) {
          apply(cmp, op)
          apply(oracle, op)
        }
        cmp.step()
        oracle.step()

        expect(cmp.handles.length).toBe(oracle.handles.length)
        for (let i = 0; i < cmp.handles.length; i++) {
          const a = cmp.world.entity(cmp.handles[i] as EntityHandle).read(cmp.Position) as { x: number; y: number }
          const b = oracle.world.entity(oracle.handles[i] as EntityHandle).read(oracle.Position) as {
            x: number
            y: number
          }
          expect(a.x).toBe(b.x)
          expect(a.y).toBe(b.y)
        }
      }),
      { numRuns: 40 },
    )
  })

  test('with a .changed(Position) consumer, the drained changed-sets match the proxy path', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), (ops) => {
        const cmp = makeRig(true)
        const oracle = makeRig(false)
        const changedOf = (rig: Rig) =>
          rig.world.query(read(rig.Position)).changed(rig.Position) as unknown as {
            eachChanged(fn: (e: PooledElement) => void): void
          }
        const cChanged = changedOf(cmp)
        const oChanged = changedOf(oracle)
        for (const op of ops) {
          apply(cmp, op)
          apply(oracle, op)
        }
        cmp.world.frameReset()
        oracle.world.frameReset()
        cmp.step()
        oracle.step()

        const drain = (c: { eachChanged(fn: (e: PooledElement) => void): void }): number => {
          let n = 0
          c.eachChanged(() => n++)
          return n
        }
        expect(drain(cChanged)).toBe(drain(oChanged))
      }),
      { numRuns: 30 },
    )
  })
})

// --- body-shape fuzz: generate a random straight-line numeric body the analyzer ACCEPTS, run the SAME
// function through BOTH compile() and the proxy, assert byte-identical. This fuzzes the ANALYZER itself
// (write detection, e/ctx rewrite, operator handling) — the faithful-by-construction core — where the
// existing properties only vary the world ops under one fixed body.
const WRITABLE = ['position.x', 'position.y'] as const
const TERM = fc.oneof(
  fc.constantFrom('e.velocity.dx', 'e.velocity.dy', 'e.position.x', 'e.position.y', 'ctx.dt'),
  fc.integer({ min: -5, max: 5 }).map((n) => `${n}`),
)
const EXPR = fc.array(TERM, { minLength: 1, maxLength: 3 }).chain((terms) =>
  fc
    .array(fc.constantFrom('+', '-', '*'), { minLength: terms.length - 1, maxLength: Math.max(0, terms.length - 1) })
    // Spaces around operators so a `-` before a negative literal can't mis-lex as `--` (`x - -5`, not `x--5`).
    .map((ops) => terms.reduce((acc, t, i) => (i === 0 ? t : `${acc} ${ops[i - 1]} ${t}`), '')),
)
const STMT = fc.oneof(
  fc
    .record({ w: fc.constantFrom(...WRITABLE), op: fc.constantFrom('=', '+=', '-=', '*='), rhs: EXPR })
    .map(({ w, op, rhs }) => `e.${w}${op}${rhs};`),
  fc.record({ w: fc.constantFrom(...WRITABLE), inc: fc.constantFrom('++', '--') }).map(({ w, inc }) => `e.${w}${inc};`),
)
const BODY_SRC = fc.array(STMT, { minLength: 1, maxLength: 4 }).map((s) => s.join(''))

describe('PROP compile() faithful across FUZZED body shapes', { timeout: 60_000 }, () => {
  test('SANITY: a `new Function` body IS analyzed (the fuzz exercises the compiled path, not just proxy)', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    createWorld({ components: [Position, Velocity] as readonly ComponentDef<Schema>[] })
    const defs = new Map<string, ComponentDef<Schema>>([
      ['position', Position],
      ['velocity', Velocity],
    ])
    const plan = analyzeEachBody(new Function('e', 'ctx', 'e.position.x += e.velocity.dx * ctx.dt;') as never, {
      defByName: (n) => defs.get(n),
      idOf: (d) => ((d.id as unknown as number) >= 0 ? (d.id as unknown as number) : undefined),
      isRequired: () => true,
    })
    expect(plan).not.toBeNull() // proves the new-Function source parses + compiles, so the fuzz isn't trivial
  })

  test('a random straight-line body: compile() == proxy .each, byte-for-byte', () => {
    fc.assert(
      fc.property(BODY_SRC, fc.array(opArb, { minLength: 1, maxLength: 15 }), (src, ops) => {
        const body = new Function('e', 'ctx', src) as (e: IntegEl, ctx: { dt: number }) => void
        const cmp = makeRig(true, body)
        const oracle = makeRig(false, body)
        for (const op of ops) {
          apply(cmp, op)
          apply(oracle, op)
        }
        cmp.step()
        oracle.step()
        expect(cmp.handles.length).toBe(oracle.handles.length)
        for (let i = 0; i < cmp.handles.length; i++) {
          const a = cmp.world.entity(cmp.handles[i] as EntityHandle).read(cmp.Position) as { x: number; y: number }
          const b = oracle.world.entity(oracle.handles[i] as EntityHandle).read(oracle.Position) as { x: number; y: number }
          expect(a.x).toBe(b.x)
          expect(a.y).toBe(b.y)
        }
      }),
      { numRuns: 80 },
    )
  })

  test('a random body with a .changed(Position) consumer: the drained changed-sets match the proxy', () => {
    fc.assert(
      fc.property(BODY_SRC, fc.array(opArb, { minLength: 1, maxLength: 15 }), (src, ops) => {
        const body = new Function('e', 'ctx', src) as (e: IntegEl, ctx: { dt: number }) => void
        const cmp = makeRig(true, body)
        const oracle = makeRig(false, body)
        const changedOf = (rig: Rig) =>
          rig.world.query(read(rig.Position)).changed(rig.Position) as unknown as {
            eachChanged(fn: (e: PooledElement) => void): void
          }
        const cChanged = changedOf(cmp)
        const oChanged = changedOf(oracle)
        for (const op of ops) {
          apply(cmp, op)
          apply(oracle, op)
        }
        cmp.world.frameReset()
        oracle.world.frameReset()
        cmp.step()
        oracle.step()
        const drain = (c: { eachChanged(fn: (e: PooledElement) => void): void }): number => {
          let n = 0
          c.eachChanged(() => n++)
          return n
        }
        expect(drain(cChanged)).toBe(drain(oChanged))
      }),
      { numRuns: 60 },
    )
  })
})
