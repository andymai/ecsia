// One-word log entries pack componentId into the generationBits headroom above indexBits. A
// component set that does not fit — or generationBits: 0, where the 32-bit shift is a JS no-op —
// must never reach the packed-entry writers: the corruption is silent (observers and .changed
// re-test the wrong entities). Defaults auto-widen; explicit overrides fail fast.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, ConfigError } from '../src/index.js'
import type { ComponentDef, Schema } from '../src/index.js'

const manyComponents = (n: number): ComponentDef<Schema>[] =>
  Array.from({ length: n }, (_, i) => defineComponent({ x: 'u8' }, { name: `c${i}` }) as ComponentDef<Schema>)

describe('log-entry packing guard', () => {
  test('explicit logEntryWords: 1 with generationBits: 0 throws', () => {
    expect(() => createWorld({ generationBits: 0, threaded: false, reactivity: { logEntryWords: 1 } })).toThrow(ConfigError)
  })

  test('generationBits: 0 defaults to two-word entries instead of corrupting', () => {
    expect(() => createWorld({ generationBits: 0, threaded: false })).not.toThrow()
  })

  test('explicit logEntryWords: 1 with more component ids than headroom throws', () => {
    // generationBits 2 → 2 componentId bits → max id 3; 4 components mint ids 1..4.
    expect(() =>
      createWorld({ generationBits: 2, maxEntities: 8, components: manyComponents(4), reactivity: { logEntryWords: 1 } }),
    ).toThrow(/cannot pack/)
  })

  test('an oversized component set auto-widens the default width', () => {
    expect(() => createWorld({ generationBits: 2, maxEntities: 8, components: manyComponents(4) })).not.toThrow()
  })
})
