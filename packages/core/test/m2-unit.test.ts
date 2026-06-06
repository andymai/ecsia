// unit suite ( Exit criteria). Pins the externally
// observable behaviours of the memory/component layer:
// - defineComponent infers a usable component (read/write through the world).
// - entity.write(C).x = 5 mutates the column and reads back via read(C).
// - eid columns init fresh AND grown rows to -1 (the null sentinel), not 0.
// - a single allocBacking site decides SAB-vs-AB: the backing strategy is the one switch.
// - field round-trip encode→store→decode for every ElementKind incl staticString and eid
// (-1 <-> null).

import { describe, expect, test } from 'vitest'
import { bindAccessorRow, buildColumnSet, createWorld, decodeEid, defineComponent, encodeEid, makeColumnLayout, staticString, vec } from '@ecsia/core'
import { Buffers, ComponentRegistry, probeCapabilities } from '../src/internal.js'
import type { ColumnKey, ComponentDef, ElementKind, RegionKey, RuntimeCapabilities, Schema } from '@ecsia/core'
import type { AccessorWorld } from '../src/internal.js'

const k = (s: string): ColumnKey => s as ColumnKey
const newBuffers = (): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

function stubWorld(): AccessorWorld {
  return {
    trackWrite: () => {},
    tracking: { active: true },
    handleIndex: (h) => (h as number) & 0x3fffff,
    sidecarRead: () => undefined,
    sidecarWrite: () => {},
    generationOf: () => 0,
  }
}

describe('defineComponent infers a usable component', () => {
  test('a defined component reads and writes through the world entity surface', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c1' })
    const w = createWorld({ components: [Position] })
    // An entity reads/writes a component only once it HOLDS it. spawnWith lands it in the
    // {Position} archetype in a single migration.
    const ref = w.entity(w.spawnWith(Position))

    // write() returns the mutable singleton; read() the same instance typed Readonly.
    const write = ref.write(Position) as { x: number; y: number }
    write.x = 5
    write.y = -2

    const read = ref.read(Position) as Readonly<{ x: number; y: number }>
    expect(read.x).toBe(5)
    expect(read.y).toBe(-2)
  })

  test('entity.write(C).x = 5 mutates the underlying column and reads back', () => {
    // Drive the column directly to prove the setter reaches the TypedArray slot.
    const buffers = newBuffers()
    const world = stubWorld()
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c2' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Position])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Position, world, initialCapacity: 8 })

    const a = bindAccessorRow(set, 3, 42 as never) as unknown as { x: number; y: number }
    a.x = 5

    // The slot for row 3 of the x-column now holds 5; reading back through the accessor agrees.
    expect((set.columns[0]!.view as Float32Array)[3]).toBe(5)
    expect(a.x).toBe(5)
  })
})

describe(': eid columns init new + grown rows to -1 (null), not 0', () => {
  test('fresh eid column rows are -1, and decode to null', () => {
    const b = newBuffers()
    // eid → i32, fillOnInit -1 (the layout the component module derives for an eid field).
    const col = b.column(k('eid:fresh.0'), makeColumnLayout('i32', 1, -1), 5)
    const view = col.view as Int32Array
    expect([...view]).toEqual([-1, -1, -1, -1, -1])
    for (const slot of view) expect(decodeEid(slot)).toBeNull()
  })

  test('grown eid column tail is filled with -1 to the FULL grown capacity, not 0', () => {
    const b = newBuffers()
    const col = b.column(k('eid:grow.0'), makeColumnLayout('i32', 1, -1), 4)
    // Write a real handle at row 1 so we can prove the existing rows survive while the tail is -1.
    ;(col.view as Int32Array)[1] = encodeEid(7 as never)
    // newCapacity 5 is NOT a power-of-two multiple of 4: the doubling protocol grows to capacity 8,
    // so rows 5,6,7 lie in [newCapacity, actualCapacity) — they MUST still be the -1 sentinel.
    b.grow(col, 5)
    const view = col.view as Int32Array
    expect(col.capacity()).toBeGreaterThan(5)
    expect(view[0]).toBe(-1)
    expect(view[1]).toBe(7)
    // Assert over the WHOLE grown tail (col.capacity()), not just the requested newCapacity, so the
    // over-allocated rows past newCapacity are pinned to -1 rather than a phantom entity-0 reference.
    expect([...view.subarray(2, col.capacity())]).toEqual(Array(col.capacity() - 2).fill(-1))
  })

  test('a plain (non-eid) f32 column grows with a zero tail (only eid needs the explicit fill)', () => {
    const b = newBuffers()
    const col = b.column(k('plain:grow.0'), makeColumnLayout('f32', 1, 0), 2)
    b.grow(col, 6)
    expect([...(col.view as Float32Array).subarray(2, 6)]).toEqual([0, 0, 0, 0])
  })

  test('growing a zero-capacity column terminates (no infinite doubling from a 0 base)', () => {
    const b = newBuffers()
    const col = b.column(k('zero:grow.0'), makeColumnLayout('i32', 1, -1), 0)
    expect(col.capacity()).toBe(0)
    // Before the nextCapacityBytes guard this spun forever (0*2===0); it must now return promptly.
    b.grow(col, 5)
    expect(col.capacity()).toBeGreaterThanOrEqual(5)
    expect([...(col.view as Int32Array).subarray(0, col.capacity())]).toEqual(
      Array(col.capacity()).fill(-1),
    )
  })
})

describe(': a single allocBacking site decides SAB vs AB', () => {
  // The backing strategy on `capabilities` is the ONE switch; every column AND region honours it
  // uniformly. We construct a Buffers per strategy and assert no allocation re-decides.
  const sabCaps = probeCapabilities('sab') // Node: resizable-sab
  const abCaps = probeCapabilities('single') // Node: resizable-ab

  test('an *-sab strategy backs every column and region with a SharedArrayBuffer', () => {
    if (!sabCaps.sabAvailable) return // skip where SAB/COI is unavailable
    expect(sabCaps.backing.endsWith('sab')).toBe(true)
    const b = new Buffers({ capabilities: sabCaps, maxEntities: 1 << 20 })
    const col = b.column(k('b1sab.0'), makeColumnLayout('f32', 1), 4)
    const reg = b.region('b1sab.region' as RegionKey, 'u32', 4)
    expect(col.backing).toBeInstanceOf(SharedArrayBuffer)
    expect(reg.backing).toBeInstanceOf(SharedArrayBuffer)
  })

  test('an *-ab strategy backs every column and region with a plain ArrayBuffer', () => {
    expect(abCaps.backing.endsWith('ab')).toBe(true)
    const b = new Buffers({ capabilities: abCaps, maxEntities: 1 << 20 })
    const col = b.column(k('b1ab.0'), makeColumnLayout('f32', 1), 4)
    const reg = b.region('b1ab.region' as RegionKey, 'u32', 4)
    expect(col.backing).toBeInstanceOf(ArrayBuffer)
    expect(col.backing).not.toBeInstanceOf(SharedArrayBuffer)
    expect(reg.backing).toBeInstanceOf(ArrayBuffer)
  })

  test('the strategy is the only input that flips SAB vs AB (same Buffers, every alloc agrees)', () => {
    const b = new Buffers({ capabilities: abCaps, maxEntities: 1 << 20 })
    const c1 = b.column(k('b1u.0'), makeColumnLayout('i32', 1), 4)
    const c2 = b.column(k('b1u.1'), makeColumnLayout('u8', 3), 4)
    const r1 = b.region('b1u.r' as RegionKey, 'f64', 4)
    const sab = (x: { backing: unknown }): boolean => x.backing instanceof SharedArrayBuffer
    // Every allocation matches the single strategy decision — none re-decide independently.
    expect([sab(c1), sab(c2), sab(r1)]).toEqual([false, false, false])
  })
})

describe('field round-trip encode→store→decode for every ElementKind', () => {
  // Build a one-field component per scalar token, run a value through the accessor (which encodes on
  // write and decodes on read), and confirm it survives the TypedArray slot round-trip.
  const cases: ReadonlyArray<{ token: string; element: ElementKind; input: number; expected: number }> = [
    { token: 'i8', element: 'i8', input: -5, expected: -5 },
    { token: 'u8', element: 'u8', input: 200, expected: 200 },
    { token: 'u8c', element: 'u8c', input: 200, expected: 200 },
    { token: 'i16', element: 'i16', input: -3000, expected: -3000 },
    { token: 'u16', element: 'u16', input: 60000, expected: 60000 },
    { token: 'i32', element: 'i32', input: -123456, expected: -123456 },
    { token: 'u32', element: 'u32', input: 0x90000005, expected: 0x90000005 },
    { token: 'f32', element: 'f32', input: 1.5, expected: 1.5 },
    { token: 'f64', element: 'f64', input: 1.123456789, expected: 1.123456789 },
  ]

  for (const c of cases) {
    test(`${c.token} round-trips ${c.input}`, () => {
      const buffers = newBuffers()
      const world = stubWorld()
      const C = defineComponent({ v: c.token as never }, { name: 'c3' }) as ComponentDef<Schema>
      new ComponentRegistry(buffers, world).register([C])
      const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })
      const a = bindAccessorRow(set, 1, 0 as never) as unknown as { v: number }
      a.v = c.input
      expect(a.v).toBe(c.expected)
      expect(set.columns[0]!.layout.element).toBe(c.element)
    })
  }

  test('bool round-trips true/false through a u8 slot', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const C = defineComponent({ b: 'bool' }, { name: 'c4' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { b: boolean }
    a.b = true
    expect(a.b).toBe(true)
    expect((set.columns[0]!.view as Uint8Array)[0]).toBe(1)
    a.b = false
    expect(a.b).toBe(false)
    expect((set.columns[0]!.view as Uint8Array)[0]).toBe(0)
  })

  test('staticString round-trips a choice through its stored index, throws on an unknown value', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const C = defineComponent({ state: staticString('idle', 'run', 'jump') }, { name: 'c5' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { state: string }
    a.state = 'run'
    expect(a.state).toBe('run')
    // Stored as the index (1) into the choices table, not the bytes.
    expect((set.columns[0]!.view as Uint8Array)[0]).toBe(1)
    expect(() => {
      a.state = 'fly'
    }).toThrow()
  })

  test('eid round-trips a full u32 handle and maps -1 <-> null ( sentinel)', () => {
    // Direct codec round-trip for the sentinel boundary.
    expect(decodeEid(-1)).toBeNull()
    expect(decodeEid(encodeEid(0 as never))).toBe(0) // index 0 is a valid entity, NOT null
    const handle = 0x90000005 // generation high bits set → exceeds 2^31, stored two's-complement
    expect(decodeEid(encodeEid(handle as never))).toBe(handle)

    // …and through the accessor: a fresh row decodes null, a written handle decodes back.
    const buffers = newBuffers()
    const world = stubWorld()
    const Ref = defineComponent({ target: 'eid' }, { name: 'c6' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Ref])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Ref, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { target: number | null }
    expect(a.target).toBeNull()
    a.target = handle as never
    expect(a.target).toBe(handle)
  })

  test('vec round-trips n contiguous slots per row (stride = n)', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const C = defineComponent({ v: vec('f32', 3) }, { name: 'c7' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([C])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: C, world, initialCapacity: 4 })
    const a = bindAccessorRow(set, 2, 0 as never) as unknown as {
      v: { x: number; y: number; z: number; length: number }
    }
    a.v.x = 1
    a.v.y = 2
    a.v.z = 3
    expect([a.v.x, a.v.y, a.v.z]).toEqual([1, 2, 3])
    // Row 2 of a stride-3 column occupies slots 6,7,8 contiguously.
    expect([...(set.columns[0]!.view as Float32Array).subarray(6, 9)]).toEqual([1, 2, 3])
  })
})

describe('post-grow accessor validity (cross-library Proxy bench DEFERRED — correctness stand-in)', () => {
  // The cross-library Proxy-vs-closure perf bench is deferred (no bench harness yet). In its place
  // this pins the CORRECTNESS the bench would otherwise depend on: a pre-grow accessor writes a row
  // past the old capacity AFTER a grow with NO regeneration on the primary path.
  test('a pre-grow accessor writes/reads a high row after grow with no class regeneration', () => {
    const buffers = newBuffers()
    const world = stubWorld()
    const Position = defineComponent({ x: 'f32' }, { name: 'c8' }) as ComponentDef<Schema>
    new ComponentRegistry(buffers, world).register([Position])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Position, world, initialCapacity: 4 })

    const accessorBeforeGrow = set.accessor
    const a = bindAccessorRow(set, 0, 0 as never) as unknown as { x: number }

    buffers.grow(set.columns[0]!, 64)

    // SAME accessor singleton (no regeneration); poke it at a row past the old capacity.
    expect(set.accessor).toBe(accessorBeforeGrow)
    bindAccessorRow(set, 50, 0 as never)
    a.x = 9.5
    expect(a.x).toBe(9.5)
    expect((set.columns[0]!.view as Float32Array)[50]).toBe(9.5)
  })
})
