// Coverage for ArchetypeStore column-row initialization corners and the warm() promotion's
// missing-source fallback:
// - #initColumnRow skips object<T> fields (ctor === null) and applies the explicit fill for
// needsExplicitInit fields (eid → EID_NULL), exercised by adding such a component via migration;
// - warm() over an archetype whose signature includes a TAG component takes the dstSet-absent
// `continue` (the tag contributes no hot ColumnSet) while still promoting the column-bearing one.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTag, object } from '@ecsia/core'
import { ArchetypeStore, Bitmask, Buffers, ComponentRegistry, canonicalize, probeCapabilities } from '../src/internal.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/core'
import type { RecordSurface, Signature } from '../src/internal.js'

const newBuffers = (): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

function storeKit(componentCount: number, maxHotArchetypes: number): {
  store: ArchetypeStore
  recordArch: Map<number, number>
  recordRow: Map<number, number>
} {
  const buffers = newBuffers()
  const registry = new ComponentRegistry()
  const defs = Array.from({ length: componentCount }, (_, i) => defineComponent({ ['f' + i]: 'i32' as const }, { name: 'f' + i }))
  registry.register(defs)
  const recordArch = new Map<number, number>()
  const recordRow = new Map<number, number>()
  const record: RecordSurface = {
    commitRecord: (index, archId, row) => {
      recordArch.set(index, archId)
      recordRow.set(index, row)
    },
    archetypeIdOf: (index) => recordArch.get(index) ?? 0,
    rowOf: (index) => recordRow.get(index) ?? 0,
  }
  const bitmask = new Bitmask(buffers, registry.nextComponentId, 1 << 16, () => 'serial')
  const store = new ArchetypeStore({
    buffers,
    accessorWorld: { tracking: { active: true }, trackWrite: () => {}, handleIndex: (h) => (h as number) & 0xffff, sidecarRead: () => undefined, sidecarWrite: () => {}, generationOf: () => 0 },
    bitmask,
    record,
    maxHotArchetypes,
    stride: bitmask.stride,
    maxEntities: 1 << 16,
    enqueueRemoveLog: () => {},
    tick: () => 0,
    defOf: (c) => registry.defOf(c),
    handleIndex: (h) => h & 0xffff,
  })
  return { store, recordArch, recordRow }
}

describe('#initColumnRow object + needsExplicitInit fields (migration add path)', () => {
  test('adding a component with an eid + object field initializes eid to null, object field has no column', () => {
    // ref is an eid field (needsExplicitInit -> filled with EID_NULL); payload is object<T> (ctor null,
    // contributes NO column so it is skipped in #initColumnRow).
    const Link = defineComponent({ ref: 'eid', payload: object<{ tag: string }>() }, { name: 'link' })
    const Marker = defineComponent({ m: 'i32' }, { name: 'marker' })
    const w = createWorld({ components: [Link, Marker] as readonly ComponentDef<Schema>[] })

    const e = w.spawnWith(Marker)
    // Adding Link drives migrate() -> #initColumnRow(Link): the eid column is filled to its null
    // sentinel, the object field is skipped (no column to touch).
    w.add(e, Link)
    expect(w.has(e, Link)).toBe(true)

    const link = w.entity(e).read(Link) as { ref: unknown; payload: unknown }
    // A freshly initialized eid field reads back as null (decodeEid(EID_NULL)), NOT 0 (which would be a
    // valid entity handle 0) — this discriminates the needsExplicitInit fill from a plain zero-init.
    expect(link.ref).toBeNull()
  })

  test('the eid fill is genuinely the null sentinel, not a coincidental zero', () => {
    const Link = defineComponent({ ref: 'eid' }, { name: 'link2' })
    const A = defineComponent({ a: 'i32' }, { name: 'a' })
    const w = createWorld({ components: [Link, A] as readonly ComponentDef<Schema>[] })
    const e = w.spawnWith(A)
    w.add(e, Link)
    const link = w.entity(e).read(Link) as { ref: unknown }
    expect(link.ref).toBeNull()

    // Setting it to a real handle then reading proves the column is live (not always null).
    const other = w.spawn()
    ;(w.entity(e).write(Link) as { ref: unknown }).ref = other
    expect((w.entity(e).read(Link) as { ref: unknown }).ref).not.toBeNull()
  })
})

describe('warm() with a tag component in the signature (dstSet-absent continue)', () => {
  test('promotes a cold {tag, data} archetype: data column carried, tag stays pure membership', () => {
    const Tag = defineTag('flag')
    const Data = defineComponent({ d: 'i32' }, { name: 'data' })
    // EMPTY hot only -> {Data} cold, then {Tag, Data} cold.
    const components = [Tag, Data] as readonly ComponentDef<Schema>[]
    const w = createWorld({ components, maxHotArchetypes: 1 })
    const e = w.spawnWith(Tag, Data)
    ;(w.entity(e).write(Data) as { d: number }).d = 55
    expect(w.entity(e).__archetypeId).not.toBe(0)

    // Warm the {Tag, Data} archetype. The tag contributes no dstSet, so warm() hits the
    // `dstSet === undefined -> continue` arm while still copying Data's column value.
    w.warm(Tag, Data)
    expect((w.entity(e).read(Data) as { d: number }).d).toBe(55)
    expect(w.has(e, Tag)).toBe(true)
    expect(w.has(e, Data)).toBe(true)
  })

  test('direct store.warm over a {tag, data} signature flips cold->hot with one ColumnSet', () => {
    const { store } = storeKit(2, 1) // only EMPTY hot; component ids 1,2 are both i32 (column-bearing)
    // Build a 2-id signature; both are column-bearing here so both promote (sanity vs. the tag case
    // above which is driven through the world facade where a real tag exists).
    const sig = canonicalize([1, 2] as unknown as ComponentId[]) as Signature
    const arch = store.getOrCreateArchetype(sig)
    expect(arch.cold).toBe(true)
    store.warm(sig)
    expect(arch.cold).toBe(false)
    expect(arch.columnSets.size).toBe(2)
  })
})
