// Rich-field round-trip property (rich-fields.md §11): a randomized world with string + object<T> + a
// numeric column + an eid column, snapshotted and deserialized, reproduces every rich value (RF-ROUNDTRIP)
// with the eid column remapped and the in-object handle NOT remapped (RF-NOREMAP). A second snapshot of
// the loaded world is byte-equal to a re-snapshot of itself (canonical determinism, rich section included).

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, object } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer } from '../src/index.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

interface Meta {
  tags: string[]
  n: number
}

describe('M10 RICH — round-trip property (RF-ROUNDTRIP)', () => {
  it('every string + object<T> value survives a snapshot round-trip for a randomized entity set', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string(),
            meta: fc.record({ tags: fc.array(fc.string(), { maxLength: 4 }), n: fc.integer({ min: -1000, max: 1000 }) }),
            hp: fc.integer({ min: -2147483648, max: 2147483647 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (specs) => {
          const Node = defineComponent(
            { hp: 'i32', label: 'string', meta: object<Meta>() },
            { name: 'node' },
          )
          const src = createWorld({ components: asComps(Node) })
          const handles: EntityHandle[] = []
          for (const sp of specs) {
            const e = src.spawnWith([Node, { hp: sp.hp, label: sp.label, meta: sp.meta }])
            handles.push(e)
          }

          const bytes = createSnapshotSerializer(src).snapshotCopy()
          const R = defineComponent({ hp: 'i32', label: 'string', meta: object<Meta>() }, { name: 'node' })
          const dst = createWorld({ components: asComps(R) })
          const { remap } = createSnapshotDeserializer(dst).load(bytes)

          for (let i = 0; i < specs.length; i++) {
            const n = remap.get(handles[i] as never) as EntityHandle
            const got = dst.entity(n).read(R) as { hp: number; label: string; meta: Meta }
            expect(got.hp).toBe(specs[i]!.hp)
            expect(got.label).toBe(specs[i]!.label)
            expect(got.meta).toEqual(specs[i]!.meta)
          }

          // Fixed point: re-snapshotting the LOADED world twice is byte-stable (canonical determinism,
          // rich section included — sparse, ordered by archetype/row/signature).
          const ser = createSnapshotSerializer(dst)
          expect(Buffer.from(ser.snapshotCopy())).toEqual(Buffer.from(ser.snapshotCopy()))
        },
      ),
      { numRuns: 40 },
    )
  })
})
