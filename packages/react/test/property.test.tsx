// The bridge truth property: after every update(), every mounted hook's snapshot equals a direct
// read of the same fields — the bridge may never show a value the world doesn't. Random
// spawn/despawn/write/add/remove programs drive the world; probes capture what React last
// rendered; the oracle is the world itself.

import { describe, expect, test } from 'vitest'
import { render, act } from '@testing-library/react'
import fc from 'fast-check'
import { createWorld, defineComponent } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createScheduler } from '@ecsia/scheduler'
import { read } from '@ecsia/schema'
import { WorldProvider, useComponent, useQuery } from '../src/index.js'

const mkHealth = () => defineComponent({ hp: 'i32' }, { name: 'health' })
type HealthDef = ReturnType<typeof mkHealth>

type Op =
  | { op: 'write'; slot: number; value: number }
  | { op: 'spawn'; value: number }
  | { op: 'despawn'; slot: number }
  | { op: 'removeComp'; slot: number }
  | { op: 'addComp'; slot: number; value: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('write' as const), slot: fc.nat(9), value: fc.integer({ min: -1000, max: 1000 }) }),
  fc.record({ op: fc.constant('spawn' as const), value: fc.integer({ min: -1000, max: 1000 }) }),
  fc.record({ op: fc.constant('despawn' as const), slot: fc.nat(9) }),
  fc.record({ op: fc.constant('removeComp' as const), slot: fc.nat(9) }),
  fc.record({ op: fc.constant('addComp' as const), slot: fc.nat(9), value: fc.integer({ min: -1000, max: 1000 }) }),
)

interface Capture {
  components: Map<EntityHandle, { hp: number } | undefined>
  query: readonly EntityHandle[]
}

function EntityProbe({
  handle,
  Health,
  capture,
}: {
  handle: EntityHandle
  Health: HealthDef
  capture: Capture
}) {
  const snapshot = useComponent(handle, Health)
  capture.components.set(handle, snapshot as { hp: number } | undefined)
  return null
}

function QueryProbe({ Health, capture }: { Health: HealthDef; capture: Capture }) {
  capture.query = useQuery(read(Health))
  return null
}

function Harness({
  handles,
  Health,
  capture,
}: {
  handles: readonly EntityHandle[]
  Health: HealthDef
  capture: Capture
}) {
  return (
    <>
      <QueryProbe Health={Health} capture={capture} />
      {handles.map((h) => (
        <EntityProbe key={h} handle={h} Health={Health} capture={capture} />
      ))}
    </>
  )
}

function applyOp(world: World, Health: HealthDef, handles: EntityHandle[], op: Op): void {
  const pick = (slot: number): EntityHandle | undefined => handles[slot % Math.max(1, handles.length)]
  switch (op.op) {
    case 'spawn':
      handles.push(world.spawnWith([Health, { hp: op.value }]))
      break
    case 'write': {
      const h = pick(op.slot)
      if (h !== undefined && world.isAlive(h) && world.has(h, Health)) {
        world.entity(h).write(Health).hp = op.value
      }
      break
    }
    case 'despawn': {
      const h = pick(op.slot)
      if (h !== undefined && world.isAlive(h)) world.despawn(h)
      break
    }
    case 'removeComp': {
      const h = pick(op.slot)
      if (h !== undefined && world.isAlive(h) && world.has(h, Health)) world.remove(h, Health)
      break
    }
    case 'addComp': {
      const h = pick(op.slot)
      if (h !== undefined && world.isAlive(h) && !world.has(h, Health)) {
        world.add(h, Health)
        world.entity(h).write(Health).hp = op.value
      }
      break
    }
  }
}

describe('bridge truth property (fast-check)', () => {
  test(
    'after every update, every mounted snapshot equals a direct world read',
    () => {
      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
          const Health = mkHealth()
          const world = createWorld({ components: [Health] })
          const scheduler = createScheduler(world, [])
          const handles: EntityHandle[] = [
            world.spawnWith([Health, { hp: 1 }]),
            world.spawnWith([Health, { hp: 2 }]),
          ]
          act(() => {
            scheduler.update()
          })

          const capture: Capture = { components: new Map(), query: [] }
          const view = render(
            <WorldProvider world={world}>
              <Harness handles={handles} Health={Health} capture={capture} />
            </WorldProvider>,
          )

          try {
            for (const op of ops) {
              applyOp(world, Health, handles, op)
              act(() => {
                scheduler.update()
              })
              // Mount probes for any newly-spawned handles (keyed by handle = stable rows).
              view.rerender(
                <WorldProvider world={world}>
                  <Harness handles={handles} Health={Health} capture={capture} />
                </WorldProvider>,
              )

              // Oracle: the world itself, read directly.
              for (const h of handles) {
                const expected =
                  world.isAlive(h) && world.has(h, Health)
                    ? { hp: (world.entity(h).read(Health) as { hp: number }).hp }
                    : undefined
                expect(capture.components.get(h)).toEqual(expected)
              }
              const direct: EntityHandle[] = []
              world.query(read(Health)).each((e) => direct.push(e.handle))
              expect([...capture.query].sort()).toEqual(direct.sort())
            }
          } finally {
            view.unmount()
          }
        }),
        { numRuns: 25 },
      )
    },
    60_000,
  )
})
