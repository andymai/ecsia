// bindColumns PROPERTY suite: a pinned integrator and the identical program on `.each` produce
// byte-identical final column state under random interleavings of spawn (into BOTH matched
// archetypes — exercising the archetype-set-change rebuild signal), despawn, value writes, steps,
// and forced column growth (a single burst crosses the 1024-row reservation, forcing the fallback
// grow that replaces col.view mid-program). Two worlds receive the same op sequence; only the integration
// path differs — so any divergence is a bindColumns invalidation bug, not program noise.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, read, write } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

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
    weight: 1,
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
  { arbitrary: fc.record({ kind: fc.constant('step' as const) }), weight: 1 },
  // INITIAL_ROWS (64) × GROWTH_RESERVE (16) = 1024 rows: spawn ops cap out below that (≤480 rows),
  // so a single n ≥ 1100 burst DETERMINISTICALLY crosses the reservation and forces the fallback
  // grow that replaces col.view — every sequence containing a burst exercises the re-back path
  // (the rig seeds the burst archetype before binding, so its pinned binding exists from t=0).
  // Weighted up so most generated sequences contain at least one burst.
  { arbitrary: fc.record({ kind: fc.constant('burst' as const), n: fc.integer({ min: 1100, max: 1300 }) }), weight: 2 },
)

interface Rig {
  world: ReturnType<typeof createWorld>
  handles: EntityHandle[]
  step: () => void
  Position: ComponentDef<Schema>
  Velocity: ComponentDef<Schema>
  Extra: ComponentDef<Schema>
}

function makeRig(pinned: boolean): Rig {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const Extra = defineComponent({ v: 'i32' }, { name: 'extra' })
  const world = createWorld({
    components: [Position, Velocity, Extra] as readonly ComponentDef<Schema>[],
    // Room for a worst-case all-burst sequence (25 × 1300) plus spawns.
    maxEntities: 1 << 16,
  })
  const q = world.query(write(Position), read(Velocity))
  // Seed the burst archetype ({Position, Velocity}) BEFORE binding so its pinned binding exists
  // from t=0: a burst crossing the 1024-row reservation then re-backs a LIVE binding (the path
  // under test) instead of growing columns no binding has captured yet.
  const seed = world.spawnWith(Position, Velocity)
  const step = pinned
    ? q.bindColumns(
        [Position, 'x'],
        [Position, 'y'],
        [Velocity, 'dx'],
        [Velocity, 'dy'],
        // SELF-CONTAINED (DT defined inside, closes over nothing) so the CODEGEN path is exercised —
        // this property (codegen integrator byte-identical to .each under random spawn/despawn/grow)
        // is the primary codegen correctness gate.
        (vs, meta) => {
          const px = vs[0] as Float32Array
          const py = vs[1] as Float32Array
          const dx = vs[2] as Float32Array
          const dy = vs[3] as Float32Array
          const dt = 1 / 60
          return () => {
            const count = meta.count
            for (let i = 0; i < count; i++) {
              px[i] = px[i]! + dx[i]! * dt
              py[i] = py[i]! + dy[i]! * dt
            }
          }
        },
      )
    : () => {
        q.each((e) => {
          const el = e as unknown as {
            position: { x: number; y: number }
            velocity: { dx: number; dy: number }
          }
          el.position.x += el.velocity.dx * DT
          el.position.y += el.velocity.dy * DT
        })
      }
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

describe('PROP-PINNED bindColumns integrator == .each integrator', { timeout: 60_000 }, () => {
  test('random spawn/despawn/write/step/growth interleavings end byte-identical', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
        const pinned = makeRig(true)
        const oracle = makeRig(false)
        for (const op of ops) {
          apply(pinned, op)
          apply(oracle, op)
        }
        // One final step so a trailing structural op is also integrated through both paths.
        pinned.step()
        oracle.step()

        expect(pinned.handles.length).toBe(oracle.handles.length)
        for (let i = 0; i < pinned.handles.length; i++) {
          const a = pinned.world.entity(pinned.handles[i] as EntityHandle).read(pinned.Position) as {
            x: number
            y: number
          }
          const b = oracle.world.entity(oracle.handles[i] as EntityHandle).read(oracle.Position) as {
            x: number
            y: number
          }
          // f32 slots through identical op sequences: exact equality, not approximate.
          expect(a.x).toBe(b.x)
          expect(a.y).toBe(b.y)
        }
      }),
      { numRuns: 40 },
    )
  })
})
