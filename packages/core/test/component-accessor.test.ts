import { describe, expect, test } from 'vitest'
import { buildColumnSet, bindAccessorRow, defineComponent, defineTag, vec, staticString, createWorld } from '@ecsia/core'
import { Buffers, ComponentRegistry, probeCapabilities } from '../src/internal.js'
import type { ComponentDef, Schema } from '@ecsia/core'
import type { AccessorWorld } from '../src/internal.js'

const newBuffers = (): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

describe('defineComponent runtime (component-schema.md §2, §3)', () => {
  test('resolves descriptors + column layouts in declaration order', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c1' })
    expect(Position.fields.map((f) => f.name)).toEqual(['x', 'y'])
    const rt = Position as unknown as { columnLayouts: { element: string; stride: number }[] }
    expect(rt.columnLayouts).toEqual([
      { element: 'f32', stride: 1, elementBytes: 4, rowBytes: 4, fillOnInit: 0 },
      { element: 'f32', stride: 1, elementBytes: 4, rowBytes: 4, fillOnInit: 0 },
    ])
  })

  test('eid field default is the null sentinel and needs explicit init (C-2)', () => {
    const Ref = defineComponent({ target: 'eid' }, { name: 'c2' })
    const f = Ref.fields[0]!
    expect(f.default).toBe(-1)
    expect(f.needsExplicitInit).toBe(true)
  })

  test('object<T> field contributes no column and marks restrictedToMainThread', () => {
    const C = defineComponent({ mesh: { kind: 'object' as const } }, { name: 'c3' })
    const rt = C as unknown as { columnLayouts: unknown[]; restrictedToMainThread: boolean }
    expect(rt.columnLayouts).toEqual([])
    expect(rt.restrictedToMainThread).toBe(true)
  })

  test('tag defaults to sparse storage with zero fields', () => {
    const Alive = defineTag('Alive')
    expect(Alive.fields).toEqual([])
    expect(Alive.options.storage).toBe('sparse')
  })

  test('defineComponent validates fail-fast', () => {
    expect(() => defineComponent({ __x: 'f32' } as unknown as Schema, { name: 'c4' })).toThrow()
    expect(() => defineComponent({ v: vec('eid' as never, 2) }, { name: 'c5' })).toThrow()
    expect(() => defineComponent({ s: staticString() }, { name: 'c6' })).toThrow()
  })
})

// The accessor world stub: trackWrite is the M5 no-op; here we spy on the call SITE.
function stubWorld(): AccessorWorld & { calls: Array<[number, number, number?]> } {
  const calls: Array<[number, number, number?]> = []
  return {
    calls,
    trackWrite: (index, componentId, fieldIndex) => calls.push([index, componentId as number, fieldIndex]),
    handleIndex: (h) => (h as number) & 0x3fffff,
  }
}

describe('accessor factory closure (component-schema.md §8.2; type-system.md §9)', () => {
  test('read decodes the column slot at __idx; write encodes + tracks', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c7' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Position])

    const set = buildColumnSet({ buffers, archetypeId: 0, def: Position, world, initialCapacity: 8 })
    const a = bindAccessorRow(set, 2, 999 as never) as unknown as { x: number; y: number }
    a.x = 1.5
    a.y = -3
    expect(a.x).toBeCloseTo(1.5)
    expect(a.y).toBe(-3)

    // The write setter side effect (I-ACC-4 / world.md §9.1): handleIndex(__eid), componentId.
    expect(world.calls.length).toBe(2)
    expect(world.calls[0]).toEqual([999 & 0x3fffff, Position.id, undefined])
  })

  test('ONE hidden class per (archetype, component): same accessor singleton across resolves', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const C = defineComponent({ v: 'i32' }, { name: 'c8' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })
    const a1 = bindAccessorRow(set, 0, 1 as never)
    const a2 = bindAccessorRow(set, 1, 2 as never)
    expect(a1).toBe(a2)
  })

  test('eid accessor reads back null for the sentinel and a handle otherwise', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const Ref = defineComponent({ target: 'eid' }, { name: 'c9' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Ref])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Ref, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { target: number | null }
    expect(a.target).toBeNull() // C-2: fresh row is -1 → null
    a.target = 0x80000003 as never
    expect(a.target).toBe(0x80000003)
  })

  test('vec field exposes named axes and indexed access; writes track field-granular', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const Vel = defineComponent({ v: vec('f32', 3) }, { name: 'c10' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Vel])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Vel, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 1, 7 as never) as unknown as { v: { x: number; y: number; z: number; length: number; [i: number]: number } }
    a.v.x = 1
    a.v.y = 2
    a.v[2] = 3
    expect(a.v.length).toBe(3)
    expect([a.v.x, a.v.y, a.v.z]).toEqual([1, 2, 3])
    expect(world.calls.at(-1)?.[2]).toBe(0) // fieldIndex forwarded for vec writes
  })

  test('accessor survives a column grow: row read past old capacity is correct (M2 exit)', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const Position = defineComponent({ x: 'f32' }, { name: 'c11' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Position])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Position, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { x: number }

    buffers.grow(set.columns[0]!, 32)
    bindAccessorRow(set, 20, 0 as never)
    a.x = 9.5
    expect(a.x).toBeCloseTo(9.5)
  })
})

describe('entity.read / entity.write split (Must-Fix #2)', () => {
  test('write mutates, read reflects the same slot via the singleton', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c12' })
    const w = createWorld({ components: [Position] })

    // M3: the entity must hold Position before read/write; spawnWith lands it there in one migration.
    const e = w.spawnWith(Position)
    const ref = w.entity(e)
    const write = ref.write(Position) as { x: number; y: number }
    write.x = 4
    const read = ref.read(Position) as Readonly<{ x: number; y: number }>
    expect(read.x).toBe(4)
  })

  test('world.trackWrite is the canonical no-op stub (no throw) until M5', () => {
    const w = createWorld()
    expect(() => w.trackWrite(0, 1 as never, 0)).not.toThrow()
  })
})
