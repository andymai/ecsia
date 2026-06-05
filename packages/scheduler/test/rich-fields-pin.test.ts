// RF-PIN: a component with >=1 rich field is restrictedToMainThread; any system
// declaring read OR write access to it is worker-ineligible. The pin is component-level and fires via
// the EXISTING computeWorkerEligible walk once 'string'.shareable === false — no planner change.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import { defineSystem } from '@ecsia/scheduler'
import { lowerSystems, buildFieldCodec } from '../src/internal.js'
import type { ComponentDef, Schema } from '@ecsia/schema'

const asComp = (c: ComponentDef<Schema>): ComponentDef<Schema> => c

describe('RF-PIN — string + mixed components pin systems to the main thread', () => {
  test('a system over a rich-only string component is worker-INELIGIBLE', () => {
    const Label = asComp(defineComponent({ text: 'string' }, { name: 'Label' }) as ComponentDef<Schema>)
    createWorld({ components: [Label] })
    const sys = defineSystem({ name: 'labelSys', write: [Label], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(false)
  })

  test('READ-ONLY access to a rich component still pins (component-level)', () => {
    const Label = asComp(defineComponent({ text: 'string' }, { name: 'Label2' }) as ComponentDef<Schema>)
    createWorld({ components: [Label] })
    const sys = defineSystem({ name: 'readLabel', read: [Label], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(false)
  })

  test('a MIXED component (numeric + string) pins despite the numeric field', () => {
    const Thing = asComp(defineComponent({ hp: 'i32', name: 'string' }, { name: 'Thing' }) as ComponentDef<Schema>)
    createWorld({ components: [Thing] })
    const sys = defineSystem({ name: 'thingSys', read: [Thing], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(false)
  })

  test('object<T> pins identically to string', () => {
    const Node = asComp(defineComponent({ meta: object<{ k: number }>() }, { name: 'NodeP' }) as ComponentDef<Schema>)
    createWorld({ components: [Node] })
    const sys = defineSystem({ name: 'nodeSys', write: [Node], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(false)
  })

  test('a purely numeric component stays worker-eligible', () => {
    const Pos = asComp(defineComponent({ x: 'f32', y: 'f32' }, { name: 'PosP' }) as ComponentDef<Schema>)
    createWorld({ components: [Pos] })
    const sys = defineSystem({ name: 'posSys', write: [Pos], run() {} })
    const [box] = lowerSystems([sys], 4)
    expect(box!.workerEligible).toBe(true)
  })
})

describe('RF-PIN — the command-buffer field codec skips rich fields without error', () => {
  test('a mixed component encodes ONLY its shareable numeric field; the string is filtered, no throw', () => {
    const Thing = asComp(defineComponent({ hp: 'i32', name: 'string' }, { name: 'ThingC' }) as ComponentDef<Schema>)
    createWorld({ components: [Thing] })
    const codec = buildFieldCodec(Thing)
    // Only `hp` is encodable; `name` (string, shareable=false) is filtered out (defense-in-depth).
    expect(codec.fields.length).toBe(1)
    const out = new Int32Array(codec.totalWords)
    expect(() => codec.encode({ hp: 5, name: 'ignored' }, out, 0)).not.toThrow()
  })
})
