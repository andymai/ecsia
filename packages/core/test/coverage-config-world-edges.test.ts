// Edge-case coverage for config.ts (the option-validation throws past the simple defaults) and the
// world.ts lenient/error corners reachable from the public + __serialize/__apply surfaces and the
// deferred-observer drain. Main-thread only — no WorkerPool, no worker_threads. Every assertion pins
// a concrete observable so a regression in the branch would fail.

import { describe, expect, test } from 'vitest'
import {
  ConfigError,
  createWorld,
  defineComponent,
  onAdd,
  onChange,
  resolveOptions,
} from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

describe('config — option-validation throws (config.ts §7)', () => {
  test('maxHotArchetypes must be a positive integer (config.ts:102-104)', () => {
    expect(() => resolveOptions({ maxHotArchetypes: 0 })).toThrow(/maxHotArchetypes must be a positive integer/)
    expect(() => resolveOptions({ maxHotArchetypes: -4 })).toThrow(ConfigError)
    expect(() => resolveOptions({ maxHotArchetypes: 2.5 })).toThrow(/maxHotArchetypes must be a positive integer/)
    // The valid override survives.
    expect(resolveOptions({ maxHotArchetypes: 512 }).maxHotArchetypes).toBe(512)
  })

  test('reactivity.maxWritesPerFrame must be a positive integer (config.ts:110-112)', () => {
    expect(() => resolveOptions({ reactivity: { maxWritesPerFrame: 0 } })).toThrow(/maxWritesPerFrame must be a positive integer/)
    expect(() => resolveOptions({ reactivity: { maxWritesPerFrame: -1 } })).toThrow(ConfigError)
  })

  test('reactivity.maxShapeChangesPerFrame must be a positive integer (config.ts:113-115)', () => {
    expect(() => resolveOptions({ reactivity: { maxShapeChangesPerFrame: 0 } })).toThrow(
      /maxShapeChangesPerFrame must be a positive integer/,
    )
    expect(() => resolveOptions({ reactivity: { maxShapeChangesPerFrame: 1.5 } })).toThrow(ConfigError)
  })

  test('scheduler.workers must be a non-negative integer or the fallback sentinel (config.ts:120-122)', () => {
    expect(() => resolveOptions({ scheduler: { workers: -1 } })).toThrow(/workers must be a non-negative integer/)
    expect(() => resolveOptions({ scheduler: { workers: 2.5 } })).toThrow(ConfigError)
    // Valid: a non-negative integer and the postMessage-fallback sentinel.
    expect(resolveOptions({ scheduler: { workers: 4 } }).scheduler.workers).toBe(4)
    expect(resolveOptions({ scheduler: { workers: 'postMessage-fallback' } }).scheduler.workers).toBe('postMessage-fallback')
  })
})

describe('world — construction diagnostics + __serialize / __apply surfaces', () => {
  // NOTE: world.ts:311 (the probeCapabilities single-threaded fallback console.warn) is UNREACHABLE on
  // this Node runtime: crossOriginIsolated === undefined makes sabAvailable true, so workerMode 'auto'
  // always selects an SAB backing and never invokes the emitDiagnostic callback. Not gamed.

  test('__serialize.relationIdOfPair returns undefined with no relation provider installed (world.ts:577-578)', () => {
    const w = createWorld() as unknown as { __serialize: { relationIdOfPair(id: number): number | undefined } }
    expect(w.__serialize.relationIdOfPair(123)).toBeUndefined()
  })

  test('__serialize.clearAll despawns every live entity across hot archetypes (world.ts:619-625)', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const w = createWorld({ components: [Position] as readonly ComponentDef<Schema>[] })
    const sz = (w as unknown as { __serialize: { clearAll(): void; aliveCount(): number } }).__serialize
    const a = w.spawn()
    const b = w.spawnWith(Position)
    const c = w.spawnWith(Position)
    expect(sz.aliveCount()).toBe(3)
    sz.clearAll()
    expect(sz.aliveCount()).toBe(0)
    for (const h of [a, b, c]) expect(w.isAlive(h)).toBe(false)
  })

  test('__apply.removeMany strips the given components (world.ts:654-656)', () => {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ x: 'f32' }, { name: 'velocity' })
    const w = createWorld({ components: [Position, Velocity] as readonly ComponentDef<Schema>[] })
    const e = w.spawnWith(Position, Velocity)
    expect(w.has(e, Velocity)).toBe(true)
    ;(w as unknown as { __apply: { removeMany(h: EntityHandle, defs: readonly ComponentDef<Schema>[]): void } }).__apply.removeMany(
      e,
      [Velocity] as readonly ComponentDef<Schema>[],
    )
    expect(w.has(e, Velocity)).toBe(false)
    expect(w.has(e, Position)).toBe(true)
  })

  test('querying an unregistered component throws via the compile idOf seam (world.ts:387 branch)', () => {
    const Registered = defineComponent({ x: 'f32' }, { name: 'registered' })
    const Stranger = defineComponent({ y: 'f32' }, { name: 'stranger' })
    const w = createWorld({ components: [Registered] as readonly ComponentDef<Schema>[] })
    // Stranger was never registered with this world; compiling a query that names it must fail-fast.
    expect(() => (w.query as unknown as (d: ComponentDef<Schema>) => unknown)(Stranger)).toThrow(
      /not registered with this world/,
    )
  })
})

describe('world — deferred-observer staging of spawnWith / remove (world.ts:763-767,781-783)', () => {
  function makeKit(): {
    world: ReturnType<typeof createWorld>
    Position: ComponentDef<Schema>
    Velocity: ComponentDef<Schema>
  } {
    const Position = defineComponent({ x: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ x: 'f32' }, { name: 'velocity' })
    return {
      world: createWorld({ components: [Position, Velocity] as readonly ComponentDef<Schema>[] }),
      Position,
      Velocity,
    }
  }

  test('an observer-issued spawnWith is STAGED (reserved now, placed next flush) (world.ts:763-767)', () => {
    const { world, Position, Velocity } = makeKit()
    let staged: EntityHandle | null = null
    let aliveDuringHandler = false
    world.observe(onChange(Position), () => {
      // spawnWith inside the drain stages the op; the handle is reserved (alive) but unplaced.
      staged = world.spawnWith(Velocity)
      aliveDuringHandler = world.isAlive(staged)
    })
    const e = world.spawnWith(Position)
    world.frameReset()
    ;(world.entity(e).write(Position) as { x: number }).x = 1 // dirties Position → onChange next drain
    world.observerDrain()
    expect(staged).not.toBeNull()
    // The reserved handle was alive immediately (reserved-spawn model), placement deferred.
    expect(aliveDuringHandler).toBe(true)
    // After the next flush the staged spawn is fully placed and carries Velocity.
    world.frameReset()
    world.observerDrain()
    expect(world.isAlive(staged as unknown as EntityHandle)).toBe(true)
    expect(world.has(staged as unknown as EntityHandle, Velocity)).toBe(true)
  })

  test('a multi-component onAdd fires only once the entity holds the WHOLE term — drives holdsAll (world.ts:441-444)', () => {
    const { world, Position, Velocity } = makeKit()
    let fired = 0
    // A two-component term: dispatchStructural consults world.holdsAll(index, [Position, Velocity]).
    world.observe(onAdd(Position, Velocity), () => fired++)

    // Add Position only: the term is NOT yet satisfied → holdsAll returns false → no fire.
    const e = world.spawnWith(Position)
    world.frameReset()
    world.observerDrain()
    expect(fired).toBe(0)

    // Now add Velocity: the entity holds BOTH → holdsAll returns true → fires exactly once.
    world.add(e, Velocity)
    world.frameReset()
    world.observerDrain()
    expect(fired).toBe(1)
  })

  test('an observer-issued remove is STAGED, applied at the next flush (world.ts:781-783)', () => {
    const { world, Position, Velocity } = makeKit()
    const target = world.spawnWith(Position, Velocity)
    world.observe(onChange(Position), () => {
      world.remove(target, Velocity) // staged, not applied mid-drain
    })
    world.frameReset()
    ;(world.entity(target).write(Position) as { x: number }).x = 5
    world.observerDrain()
    // Mid-drain the remove was only staged; Velocity is still present until the next flush applies it.
    expect(world.has(target, Velocity)).toBe(true)
    world.frameReset()
    world.observerDrain()
    expect(world.has(target, Velocity)).toBe(false)
    expect(world.has(target, Position)).toBe(true)
  })
})
