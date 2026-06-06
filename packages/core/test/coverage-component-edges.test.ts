// Edge-case coverage for the component layer's owned files: defineComponent's fail-fast validation
// (schema/token/option throws), resolveDescriptor's width-selection + user-default branches, the
// accessor factory's column-count guard / unsupported-ctor guard / vec setter / whole-instance
// __rebind, and buildColumnSet's unregistered-component guard. Each assertion pins a concrete
// observable so a regression in the branch would fail.

import { describe, expect, test } from 'vitest'
import { buildColumnSet, defineComponent, staticString, vec } from '@ecsia/core'
import { Buffers, ComponentRegistry, makeAccessorFactory, probeCapabilities, registerComponentId, resolveDescriptor } from '../src/internal.js'
import type { ComponentDef, Schema, FieldToken } from '@ecsia/core'
import type { AccessorWorld } from '../src/internal.js'

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

function stubWorld(): AccessorWorld {
  return {
    tracking: { active: true },
    trackWrite: () => {},
    handleIndex: (h) => h as number,
    sidecarRead: () => undefined,
    sidecarWrite: () => {},
    generationOf: () => 0,
  }
}

describe('defineComponent — fail-fast validation (define.ts )', () => {
  test('schema must be a plain object (define.ts:42)', () => {
    expect(() => defineComponent(null as unknown as Schema, { name: 'c1' })).toThrow(/schema must be a plain object/)
    expect(() => defineComponent([] as unknown as Schema, { name: 'c2' })).toThrow(/schema must be a plain object/)
  })

  test('reserved __ prefix / non-identifier field names rejected (define.ts:48 branch)', () => {
    expect(() => defineComponent({ __x: 'f32' } as unknown as Schema, { name: 'c3' })).toThrow(/invalid field name/)
    expect(() => defineComponent({ '1bad': 'f32' } as unknown as Schema, { name: 'c4' })).toThrow(/invalid field name/)
  })

  test('a non-object, non-string token is not a valid field token (define.ts:57-59)', () => {
    expect(() => defineComponent({ x: 42 } as unknown as Schema, { name: 'c5' })).toThrow(/is not a valid field token/)
    expect(() => defineComponent({ x: null } as unknown as Schema, { name: 'c6' })).toThrow(/is not a valid field token/)
  })

  test('vec token validation: numeric elem + integer len >= 1 (define.ts:63-69)', () => {
    expect(() => defineComponent({ v: { kind: 'vec', elem: 99, len: 2 } } as unknown as Schema, { name: 'c7' })).toThrow(/needs a scalar elem/)
    expect(() => defineComponent({ v: vec('bool' as never, 2) }, { name: 'c8' })).toThrow(/element must be numeric/)
    expect(() => defineComponent({ v: vec('eid' as never, 2) }, { name: 'c9' })).toThrow(/element must be numeric/)
    expect(() => defineComponent({ v: { kind: 'vec', elem: 'f32', len: 0 } } as unknown as Schema, { name: 'c10' })).toThrow(/len must be an integer >= 1/)
    expect(() => defineComponent({ v: { kind: 'vec', elem: 'f32', len: 1.5 } } as unknown as Schema, { name: 'c11' })).toThrow(/len must be an integer >= 1/)
  })

  test('staticString token validation: >=1 distinct choices (define.ts:73-77)', () => {
    expect(() => defineComponent({ s: staticString() }, { name: 'c12' })).toThrow(/needs >= 1 choice/)
    expect(() => defineComponent({ s: { kind: 'staticString', choices: ['a', 'a'] } } as unknown as Schema, { name: 'c13' })).toThrow(/must be distinct/)
  })

  test('an unknown token kind is rejected (define.ts:78-79)', () => {
    expect(() => defineComponent({ x: { kind: 'mystery' } } as unknown as Schema, { name: 'c14' })).toThrow(/unknown token kind/)
  })

  test('options validation: storage enum + non-negative integer maxHistory (define.ts:83-88)', () => {
    expect(() => defineComponent({ x: 'f32' }, { storage: 'weird' } as never)).toThrow(/storage must be 'packed' or 'sparse'/)
    expect(() => defineComponent({ x: 'f32' }, { maxHistory: -1 } as never)).toThrow(/maxHistory must be a non-negative integer/)
    expect(() => defineComponent({ x: 'f32' }, { maxHistory: 2.5 } as never)).toThrow(/maxHistory must be a non-negative integer/)
    // Valid options resolve.
    const C = defineComponent({ x: 'f32' }, { name: 'cValid', storage: 'sparse', maxHistory: 4 })
    expect(C.options).toEqual({ storage: 'sparse', maxHistory: 4, persist: true })
  })

  test('registerComponentId throws on a second registration (define.ts:166-168)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'c15' }) as ComponentDef<Schema>
    registerComponentId(C, 1 as never)
    expect(() => registerComponentId(C, 2 as never)).toThrow(/already registered to a world/)
  })
})

describe('resolveDescriptor — width selection + user-default branches (descriptors.ts )', () => {
  test('unknown scalar token throws (descriptors.ts:45)', () => {
    expect(() => resolveDescriptor('x', 'nope' as unknown as FieldToken)).toThrow(/unknown scalar token/)
  })

  test('staticString index ctor widens with choice count (descriptors.ts:51-53)', () => {
    const small = resolveDescriptor('s', staticString('a', 'b'))
    expect(small.ctor).toBe(Uint8Array)
    // 257 distinct choices → Uint16Array (descriptors.ts:51).
    const mid = resolveDescriptor('s', staticString(...Array.from({ length: 257 }, (_, i) => `c${i}`)))
    expect(mid.ctor).toBe(Uint16Array)
    // 65537 distinct choices → Uint32Array (descriptors.ts:52).
    const big = resolveDescriptor('s', staticString(...Array.from({ length: 65_537 }, (_, i) => `c${i}`)))
    expect(big.ctor).toBe(Uint32Array)
  })

  test('a non-zero user scalar default flips needsExplicitInit (descriptors.ts:65-67,74 branch)', () => {
    const zero = resolveDescriptor('x', 'u8', 0)
    expect(zero.needsExplicitInit).toBe(false) // 0 is zero-equivalent
    const falsy = resolveDescriptor('b', 'bool', false)
    expect(falsy.needsExplicitInit).toBe(false) // false is zero-equivalent
    const nonzero = resolveDescriptor('x', 'u8', 7)
    expect(nonzero.needsExplicitInit).toBe(true)
    expect(nonzero.default).toBe(7)
  })

  test('a non-zero user vec default flips needsExplicitInit (descriptors.ts:93 branch)', () => {
    const zeroVec = resolveDescriptor('v', vec('f32', 3), [0, 0, 0])
    expect(zeroVec.needsExplicitInit).toBe(false)
    const nonzeroVec = resolveDescriptor('v', vec('f32', 3), [0, 1, 0])
    expect(nonzeroVec.needsExplicitInit).toBe(true)
    expect(nonzeroVec.default).toEqual([0, 1, 0])
  })

  test('staticString user default resolves to its choice index; non-zero needs init (descriptors.ts:113 branch)', () => {
    const d = resolveDescriptor('s', staticString('red', 'green', 'blue'), 'blue')
    expect(d.default).toBe(2)
    expect(d.needsExplicitInit).toBe(true)
    // A default of choices[0] stores index 0 → no explicit init.
    const d0 = resolveDescriptor('s', staticString('red', 'green'), 'red')
    expect(d0.default).toBe(0)
    expect(d0.needsExplicitInit).toBe(false)
  })

  test('a malformed object token (unknown kind) reaches the final throw (descriptors.ts:148-151)', () => {
    expect(() => resolveDescriptor('x', { kind: 'bogus' } as unknown as FieldToken)).toThrow(/unknown field token for field 'x'/)
  })

  test('staticString encode rejects a value outside the choice set', () => {
    const d = resolveDescriptor('s', staticString('a', 'b'))
    expect(() => d.encode('z')).toThrow(/not in choices/)
    expect(d.encode('b')).toBe(1)
    expect(d.decode(1)).toBe('b')
  })
})

describe('makeAccessorFactory — guards + vec setter + whole-instance rebind (accessor.ts )', () => {
  test('the factory rejects a column array whose length != the plan length (accessor.ts:121-123)', () => {
    const C = defineComponent({ x: 'f32', y: 'f32' }, { name: 'c16' }) as ComponentDef<Schema>
    registerComponentId(C, 1 as never)
    const factory = makeAccessorFactory(C)
    // Two column-backed fields are planned; pass zero columns.
    expect(() => factory([])).toThrow(/expected 2 columns, got 0/)
  })

  test('the vec setter writes the whole row from an ArrayLike and tracks (accessor.ts:183-187)', () => {
    const buffers = newBuffers()
    const calls: number[] = []
    const trackingWorld: AccessorWorld = {
      tracking: { active: true },
      trackWrite: (i) => calls.push(i),
      handleIndex: (h) => h as number,
      sidecarRead: () => undefined,
      sidecarWrite: () => {},
      generationOf: () => 0,
    }
    const Vel = defineComponent({ v: vec('f32', 3) }, { name: 'c17' }) as ComponentDef<Schema>
    new ComponentRegistry().register([Vel])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: Vel, world: trackingWorld, initialCapacity: 4 })
    const a = set.accessor as unknown as { __idx: number; __eid: number; v: { x: number; y: number; z: number } }
    a.__idx = 1
    a.__eid = 5
    ;(a as unknown as { v: ArrayLike<number> }).v = [4, 5, 6] // whole-vec assignment → the setter branch
    expect([a.v.x, a.v.y, a.v.z]).toEqual([4, 5, 6])
    expect(calls).toContain(5) // the setter tracked a write for __eid 5
  })

  test('whole-instance __rebind re-points the field view onto a fresh backing (accessor.ts:142-144)', () => {
    const buffers = newBuffers()
    // SINGLE column-backed field: __rebind's loop re-points that field's view onto the new backing.
    // (For a multi-field component a whole-instance __rebind would alias both onto byteOffset 0 — the
    // documented reason the buffers layer drives per-field __rebindField instead. Here one field is safe.)
    const One = defineComponent({ a: 'u32' }, { name: 'c18' }) as ComponentDef<Schema>
    new ComponentRegistry().register([One])
    const set = buildColumnSet({ buffers, archetypeId: 0, def: One, world: stubWorld(), initialCapacity: 4 })
    const view = set.accessor as unknown as { __idx: number; a: number }
    view.__idx = 0
    view.a = 11
    expect(view.a).toBe(11)

    // Rebind onto a fresh, zeroed backing: the captured view now reads from the new buffer (was 11).
    const newBacking = new ArrayBuffer(4 * 8)
    set.accessor.__rebind(newBacking)
    expect(view.a).toBe(0)
    view.a = 99
    expect(view.a).toBe(99)
    // The original column buffer is untouched (the rebind re-pointed the accessor, not the column).
    expect((set.columns[0]!.view as Uint32Array)[0]).toBe(11)
  })

  test('an unsupported column-element ctor is rejected at plan time (accessor.ts:75-77)', () => {
    // columnElementOf throws for a ctor outside the ElementKind set. Forge a field with a foreign ctor.
    const fakeDef = {
      id: 1,
      name: 'Bad',
      fields: [{ name: 'x', ctor: Float32Array, stride: 1, encode: (v: unknown) => v as number, decode: (s: number) => s }],
    }
    // Float32Array IS supported; swap to an unsupported ctor (BigInt64Array) to hit the throw.
    fakeDef.fields[0]!.ctor = BigInt64Array as unknown as typeof Float32Array
    expect(() => makeAccessorFactory(fakeDef as unknown as ComponentDef<Schema>)).toThrow(/unsupported column element ctor/)
  })
})

describe('buildColumnSet — unregistered-component guard (column-set.ts )', () => {
  test('an unregistered def (id < 0) is rejected before any column allocation (column-set.ts:37-39)', () => {
    const buffers = newBuffers()
    // A def that was never registered to a world still carries UNREGISTERED (-1).
    const C = defineComponent({ x: 'f32' }, { name: 'c19' }) as ComponentDef<Schema>
    expect(() => buildColumnSet({ buffers, archetypeId: 0, def: C, world: stubWorld(), initialCapacity: 4 })).toThrow(
      /has no id \(register it with a world first\)/,
    )
  })
})
