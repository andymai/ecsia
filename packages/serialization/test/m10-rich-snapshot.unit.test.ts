// Rich-field SNAPSHOT serialization (rich-fields.md §7.2): the JSON sidecar SECTION 5, enumerated via
// a.signature ∩ richFields() (rich-only components MUST round-trip — G-4), the FLAG_HAS_RICH gate, the
// onUnserializable SKIP+dev-warn default policy (§7.4), and the RF-NOREMAP boundary (§7.5).

import { describe, it, expect, vi } from 'vitest'
import { createWorld, defineComponent, object } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer } from '../src/index.js'
import { FLAG_HAS_RICH, SERIALIZATION_FORMAT_VERSION } from '../src/format.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

describe('M10 RICH — snapshot round-trips string + object<T> (T-RT-SNAPSHOT)', () => {
  it('a rich-ONLY component (no ColumnSet) round-trips — proves the signature∩richFields walk (G-4)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    const e1 = src.spawnWith([Label, { text: 'hello' }])
    const e2 = src.spawnWith([Label, { text: 'wörld 🌍' }])

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    // Header advertises FLAG_HAS_RICH (byte 7) and v2.
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true)).toBe(SERIALIZATION_FORMAT_VERSION)
    expect(bytes[7]! & FLAG_HAS_RICH).toBe(FLAG_HAS_RICH)

    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const n1 = remap.get(e1 as never) as EntityHandle
    const n2 = remap.get(e2 as never) as EntityHandle
    expect((dst.entity(n1).read(R) as { text: string }).text).toBe('hello')
    expect((dst.entity(n2).read(R) as { text: string }).text).toBe('wörld 🌍')
  })

  it('a mixed numeric+object<T> component round-trips both the column and the rich field', () => {
    const Node = defineComponent({ hp: 'i32', meta: object<{ tags: string[]; n: number }>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const e = src.spawnWith([Node, { hp: 42, meta: { tags: ['a', 'b'], n: 7 } }])

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    const R = defineComponent({ hp: 'i32', meta: object<{ tags: string[]; n: number }>() }, { name: 'node' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const n = remap.get(e as never) as EntityHandle
    const got = dst.entity(n).read(R) as { hp: number; meta: { tags: string[]; n: number } }
    expect(got.hp).toBe(42)
    expect(got.meta).toEqual({ tags: ['a', 'b'], n: 7 })
  })

  it('an entity that never set its rich field emits nothing and re-defaults on load (sparse §7.2)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    const written = src.spawnWith([Label, { text: 'set' }])
    const empty = src.spawnWith(Label) // never written → default ''

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    expect((dst.entity(remap.get(written as never) as EntityHandle).read(R) as { text: string }).text).toBe('set')
    expect((dst.entity(remap.get(empty as never) as EntityHandle).read(R) as { text: string }).text).toBe('')
  })

  it('a world with NO rich values does not set FLAG_HAS_RICH (sparse — no empty section)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'label' })
    const src = createWorld({ components: asComps(Label) })
    src.spawnWith(Label) // present component, but field never written → no rich entries
    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(bytes[7]! & FLAG_HAS_RICH).toBe(0)
    // Still loads (the gate simply skips the absent section).
    const R = defineComponent({ text: 'string' }, { name: 'label' })
    const dst = createWorld({ components: asComps(R) })
    expect(() => createSnapshotDeserializer(dst).load(bytes)).not.toThrow()
  })
})

describe('M10 RICH — onUnserializable policy (T-RT-UNSERIALIZABLE, §7.4)', () => {
  it('default policy SKIPs a cyclic value + dev-warns; the rest of the snapshot survives', () => {
    const Node = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const bad = src.spawnWith(Node)
    ;(src.entity(bad).write(Node) as { meta: unknown }).meta = cyclic
    const good = src.spawnWith([Node, { meta: { ok: 1 } }])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    const R = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    // The bad entity re-defaults (undefined); the good one round-trips.
    expect((dst.entity(remap.get(bad as never) as EntityHandle).read(R) as { meta: unknown }).meta).toBeUndefined()
    expect((dst.entity(remap.get(good as never) as EntityHandle).read(R) as { meta: { ok: number } }).meta).toEqual({ ok: 1 })
  })

  it('an onUnserializable hook returning a replacement encodes the replacement', () => {
    const Node = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const src = createWorld({ components: asComps(Node) })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const e = src.spawnWith(Node)
    ;(src.entity(e).write(Node) as { meta: unknown }).meta = cyclic

    const bytes = createSnapshotSerializer(src, {
      onUnserializable: () => ({ replaced: true }),
    }).snapshotCopy()

    const R = defineComponent({ meta: object<unknown>() }, { name: 'node' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    expect((dst.entity(remap.get(e as never) as EntityHandle).read(R) as { meta: unknown }).meta).toEqual({ replaced: true })
  })
})

describe('M10 RICH — RF-NOREMAP boundary (T-RT-NOREMAP, §7.5)', () => {
  it('an EntityHandle stored INSIDE an object<T> is NOT remapped; the parallel eid column IS', () => {
    const Ref = defineComponent({ who: 'eid', meta: object<{ rawHandle: number }>() }, { name: 'ref' })
    const src = createWorld({ components: asComps(Ref) })
    // Diverge producer indices from a fresh receiver: spawn+despawn so `target` lands at a higher index
    // (and bumped generation) than the receiver's first fresh spawn — making the raw handle observably
    // different from the remapped one, so "not remapped" is a real assertion.
    for (let i = 0; i < 3; i++) src.despawn(src.spawnWith(Ref))
    const target = src.spawnWith(Ref)
    const holder = src.spawnWith(Ref)
    ;(src.entity(holder).write(Ref) as { who: number }).who = target as number
    ;(src.entity(holder).write(Ref) as { meta: { rawHandle: number } }).meta = { rawHandle: target as number }

    const bytes = createSnapshotSerializer(src).snapshotCopy()
    const R = defineComponent({ who: 'eid', meta: object<{ rawHandle: number }>() }, { name: 'ref' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(bytes)
    const nTarget = remap.get(target as never) as EntityHandle
    const nHolder = remap.get(holder as never) as EntityHandle
    const got = dst.entity(nHolder).read(R) as { who: number | null; meta: { rawHandle: number } }
    // eid COLUMN field remapped to the receiver handle.
    expect(got.who).toBe(nTarget as number)
    // handle inside the object is the RAW producer number — NOT remapped (the documented limitation).
    expect(got.meta.rawHandle).toBe(target as number)
    expect(got.meta.rawHandle).not.toBe(nTarget as number)
  })
})
