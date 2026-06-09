// umbrella sanity: importing '@ecsia/kit' gives the documented cohesive
// surface — a user assembles a whole world (component/tag/relation/query/system/serialization) from the
// ONE import, never reaching into a sub-package. This file double-duties as a type-check gate: the named
// imports below resolve to real values/types through the umbrella's re-exports, so if a re-export is
// dropped or renamed this test stops compiling (vitest transpiles it; the named-binding presence
// assertions below make the runtime surface explicit too).

import { describe, expect, test } from 'vitest'
import * as ecsia from '@ecsia/kit'
import {
  // world
  createWorld,
  ConfigError,
  // definitions
  defineComponent,
  defineTag,
  defineSystem,
  createRelations,
  Wildcard,
  // field tokens
  vec,
  vec2,
  vec3,
  vec4,
  staticString,
  object,
  // query DSL
  read,
  write,
  has,
  without,
  optional,
  MAX_QUERY_ARITY,
  // reactivity
  onAdd,
  onRemove,
  onChange,
  // scheduler
  createScheduler,
  WorkerPool,
  // serialization
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
  // null-handle sentinel + predicate
  NO_ENTITY,
  NULL_ENTITY,
  isNoEntity,
} from '@ecsia/kit'
// Type-only surface: if any of these is not re-exported, this import fails to compile.
import type {
  World,
  WorldOptions,
  EntityHandle,
  EntityRef,
  ComponentDef,
  RelationDef,
  ReadView,
  WriteView,
  ReadOf,
  WriteOf,
  SchemaOf,
  Query,
  QueryTerm,
  Has,
  HasWrite,
  Tick,
  ObserverHandle,
  ObserverContext,
  SharedHandleManifest,
  DeltaSerializer,
  SystemDef,
  SystemContext,
  Schema,
} from '@ecsia/kit'

describe('umbrella — the documented public surface is importable from ecsia', () => {
  test('every documented runtime export is a present binding of the right kind', () => {
    const fns = [
      createWorld,
      defineComponent,
      defineTag,
      defineSystem,
      createRelations,
      vec,
      vec2,
      vec3,
      vec4,
      staticString,
      object,
      read,
      write,
      has,
      without,
      optional,
      onAdd,
      onRemove,
      onChange,
      createScheduler,
      createSnapshotSerializer,
      createSnapshotDeserializer,
      createDeltaSerializer,
      applyDelta,
    ]
    for (const f of fns) expect(typeof f).toBe('function')
    // Constructors / classes.
    expect(typeof WorkerPool).toBe('function')
    expect(typeof ConfigError).toBe('function')
    expect(new ConfigError('x')).toBeInstanceOf(Error)
    // Constants + sentinels.
    expect(typeof MAX_QUERY_ARITY).toBe('number')
    expect(MAX_QUERY_ARITY).toBe(8) // /
    expect(Wildcard).toBeDefined()
    // null-handle sentinel + predicate are reachable from the umbrella (no @ecsia/core reach-in needed)
    expect(NO_ENTITY).toBe(0xffffffff)
    expect(NULL_ENTITY).toBe(NO_ENTITY)
    expect(isNoEntity(NO_ENTITY)).toBe(true)
  })

  test('the namespace import exposes the same surface (no missing re-export)', () => {
    for (const name of ['createWorld', 'defineComponent', 'defineTag', 'defineSystem', 'createScheduler']) {
      expect(typeof (ecsia as Record<string, unknown>)[name]).toBe('function')
    }
  })

  test('a whole world is assembled end-to-end from the single umbrella import (smoke of the cohesive API)', () => {
    // Use every layer reached through 'ecsia' once: schema (defineComponent/Tag), core (createWorld/
    // query/accessors/observe), relations (createRelations), scheduler (defineSystem/createScheduler),
    // serialization (snapshot/createSnapshotDeserializer). A single linear program — the documented UX.
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const Frozen = defineTag('frozen')

    const world = createWorld({
      components: [Position, Velocity, Frozen] as readonly ComponentDef<Schema>[],
      maxEntities: 1 << 12,
    })

    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true })

    let observed = 0
    const handle: ObserverHandle = world.observe(onChange(Position), () => {
      observed++
    })
    expect(handle).toBeDefined()

    const parent = world.spawnWith(Position, Velocity)
    const child = world.spawnWith(Position, Velocity)
    rel.addPair(child, ChildOf, parent)
    ;(world.entity(parent).write(Velocity) as { dx: number; dy: number }).dx = 2

    const Move = defineSystem({
      name: 'Move',
      read: [Velocity],
      write: [Position],
      run({ query }) {
        query(read(Velocity), write(Position)).each((el) => {
          const e = el as unknown as { velocity: { dx: number; dy: number }; position: { x: number; y: number } }
          e.position.x += e.velocity.dx
          e.position.y += e.velocity.dy
        })
      },
    })
    const scheduler = createScheduler(world, [Move])
    scheduler.update(1)

    // Movement actually ran through the scheduler driven entirely via the umbrella.
    expect((world.entity(parent).read(Position) as { x: number }).x).toBeCloseTo(2)
    // Relation resolves through the umbrella's relations runtime.
    expect(rel.hasPair(child, ChildOf, parent)).toBe(true)

    // Serialization round-trips through the umbrella's copy path (createSnapshotSerializer + deserializer).
    const bytes = createSnapshotSerializer(world).snapshot()
    expect(bytes.byteLength).toBeGreaterThan(0)
    const Position2 = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity2 = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const Frozen2 = defineTag('frozen')
    const dst = createWorld({
      components: [Position2, Velocity2, Frozen2] as readonly ComponentDef<Schema>[],
      maxEntities: 1 << 12,
    })
    // The receiver must declare the SAME relation set as the producer (schemaHash covers relations);
    // the deserializer re-establishes pairs through this provider (relations re-mint receiver-local ids).
    const relDst = createRelations(dst)
    relDst.defineRelation(null, { exclusive: true })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const nParent = remap.get(parent as never) as EntityHandle
    expect(dst.isAlive(nParent)).toBe(true)
    expect((dst.entity(nParent).read(Position2) as { x: number }).x).toBeCloseTo(2)

    handle.dispose()
  })
})

// Pure type-level assertions (no runtime). These compile iff the inference helpers are re-exported with
// the documented meaning; a regression in a re-exported type surfaces as a build/transpile error here.
function _typeOnly(): void {
  const C = defineComponent({ x: 'f32' }, { name: 't' })
  type _W = WriteOf<typeof C>
  type _R = ReadOf<typeof C>
  type _S = SchemaOf<typeof C>
  // ReadView is the readonly projection; WriteView is mutable (surfaced through the umbrella).
  const _rv: ReadView<{ x: 'f32' }> | null = null
  const _wv: WriteView<{ x: 'f32' }> | null = null
  const _has: Has<typeof C> | null = null
  const _hw: HasWrite<typeof C> | null = null
  const _t: Tick = 0 as Tick
  const _q: Query<readonly QueryTerm[]> | null = null
  const _ctx: SystemContext | null = null
  const _sd: SystemDef | null = null
  const _wo: WorldOptions = {}
  const _eh: EntityHandle | null = null
  const _er: EntityRef | null = null
  const _w: World | null = null
  const _rd: RelationDef<void> | null = null
  const _shm: SharedHandleManifest | null = null
  const _ds: DeltaSerializer | null = null
  const _oc: ObserverContext | null = null
  void [_rv, _wv, _has, _hw, _t, _q, _ctx, _sd, _wo, _eh, _er, _w, _rd, _shm, _ds, _oc]
  void (null as _W | _R | _S | null)

  // Seam-omission guard: the public facade types must expose NO `__`-prefixed keys. The tuple wrapper
  // defeats conditional-type distribution so an empty extraction resolves to `true` and any leaked seam
  // (a non-empty union) resolves to `never` — i.e. a seam added to core without being omitted by the
  // umbrella fails this file's compile instead of shipping as public API.
  type NoSeams<T> = [Extract<keyof T, `__${string}`>] extends [never] ? true : never
  const _worldSeamFree: NoSeams<World> = true
  const _refSeamFree: NoSeams<EntityRef> = true
  void [_worldSeamFree, _refSeamFree]
}
void _typeOnly
