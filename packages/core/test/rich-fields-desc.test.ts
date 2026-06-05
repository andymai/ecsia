// RF-DESC (rich-fields.md §2.3 / §10): for every field, `ctor === null ⟺ rich !== undefined ⟺
// shareable === false`. The three are equivalent — a rich field has no column, has a sidecar kind, and
// is never SAB-shareable. This is the load-bearing classification every storage/serialization/pinning
// site branches on, so it is asserted directly against the resolved FieldDescriptor of every token kind.

import { describe, expect, test } from 'vitest'
import { defineComponent, object, field, vec3, staticString } from '@ecsia/core'
import type { ComponentDef, FieldDescriptor, Schema } from '@ecsia/core'

const fieldsOf = (c: ComponentDef<Schema>): readonly FieldDescriptor[] => c.fields

describe('RF-DESC — ctor===null ⟺ rich!==undefined ⟺ shareable===false', () => {
  test('the equivalence holds for every field across a wide schema', () => {
    const Wide = defineComponent(
      {
        n: 'i32', //              numeric column → not rich
        f: 'f64', //              numeric column → not rich
        v: vec3('f32'), //        vec column → not rich, shareable
        choice: staticString(['a', 'b']), // enum staticString → column, shareable, NOT rich
        text: 'string', //        rich (string)
        meta: object<{ k: number }>(), // rich (object)
        labeled: field('string', { default: 'd' }), // rich (string) with default
      },
      { name: 'Wide' },
    )
    for (const f of fieldsOf(Wide)) {
      const isNullCtor = f.ctor === null
      const isRich = f.rich !== undefined
      const isUnshareable = f.shareable === false
      // the three-way equivalence — any field violating it fails here.
      expect(isRich).toBe(isNullCtor)
      expect(isUnshareable).toBe(isNullCtor)
    }
  })

  test("only 'string'/object fields are rich; their kind matches the token", () => {
    const C = defineComponent(
      { text: 'string', meta: object<unknown>(), n: 'i32', choice: staticString(['x']) },
      { name: 'KindCheck' },
    )
    const byName = new Map(fieldsOf(C).map((f) => [f.name, f]))
    expect(byName.get('text')!.rich).toBe('string')
    expect(byName.get('meta')!.rich).toBe('object')
    expect(byName.get('n')!.rich).toBeUndefined()
    // staticString is an ENUM column (shareable), NOT a rich field — the boundary that distinguishes it
    // from the free-form 'string' token.
    expect(byName.get('choice')!.rich).toBeUndefined()
    expect(byName.get('choice')!.shareable).toBe(true)
    expect(byName.get('n')!.shareable).toBe(true)
  })

  test('a component carrying any rich field is restrictedToMainThread (component-level pin source)', () => {
    const Pure = defineComponent({ x: 'f32' }, { name: 'PureNum' })
    const RichStr = defineComponent({ text: 'string' }, { name: 'RichStr' })
    const RichObj = defineComponent({ meta: object<unknown>() }, { name: 'RichObj' })
    const Mixed = defineComponent({ x: 'f32', text: 'string' }, { name: 'MixedRT' })
    const rtm = (c: ComponentDef<Schema>): boolean =>
      (c as unknown as { restrictedToMainThread: boolean }).restrictedToMainThread
    expect(rtm(Pure)).toBe(false)
    expect(rtm(RichStr)).toBe(true)
    expect(rtm(RichObj)).toBe(true)
    expect(rtm(Mixed)).toBe(true)
  })
})
