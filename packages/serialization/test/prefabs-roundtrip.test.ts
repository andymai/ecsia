// Prefab serialization (isa-prefabs.md): ZERO new wire format. Templates are
// ordinary rows (the serializer iterates archetypes, so default query exclusion hides nothing);
// the built-ins ride the registry under their stable names ("ecsia:Prefab", "ecsia:IsA"); IsA
// pairs ride the existing relations section and PASS 3 recreates the edges WITHOUT re-running
// copy semantics (the snapshot already carries final post-copy, post-override values).
//
// determinism: the round-trip reaches a byte-stable fixed point — re-snapshotting a loaded
// world and loading THAT reproduces identical bytes.
// fail-fast: a prefabs-flag mismatch between producer and receiver refuses to load (schemaHash).
// merge-mode edge: a pair whose target is not in the snapshot is skipped with a dev warning;
// instance data is intact, only the ancestor edge is lost.

import { describe, it, expect, vi } from 'vitest'
import { createWorld, defineComponent, has, read } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations, Wildcard } from '@ecsia/relations'
import { createSnapshotSerializer, createSnapshotDeserializer } from '../src/index.js'

function makeKit() {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Attack = defineComponent({ dmg: 'i32' }, { name: 'attack' })
  const components = [Health, Attack] as readonly ComponentDef<Schema>[]
  const world = createWorld({ prefabs: true, components })
  const rel = createRelations(world)
  return { world, rel, Health, Attack }
}

describe('prefab snapshot round-trip', () => {
  it('templates, chains, instances, and overrides survive; PASS 3 re-links IsA without re-copying', () => {
    const src = makeKit()
    const goblin = src.rel.definePrefab([src.Health, { hp: 35 }], [src.Attack, { dmg: 10 }])
    const boss = src.rel.definePrefab({ extends: goblin }, [src.Health, { hp: 200 }])
    const i1 = src.rel.spawnFrom(goblin)
    const i2 = src.rel.spawnFrom(boss, [src.Health, { hp: 250 }]) // override ≠ template value
    const bytes = createSnapshotSerializer(src.world).snapshotCopy()

    const dst = makeKit()
    const { remap } = createSnapshotDeserializer(dst.world).load(bytes)
    const g2 = remap.get(goblin) as EntityHandle
    const b2 = remap.get(boss) as EntityHandle
    const e1 = remap.get(i1) as EntityHandle
    const e2 = remap.get(i2) as EntityHandle

    // Values: the wire carries final post-copy, post-override state — addPair re-linked the IsA
    // edges WITHOUT re-stamping template values (a re-copy would reset e2 to 200).
    expect((dst.world.entity(e1).read(dst.Health) as { hp: number }).hp).toBe(35)
    expect((dst.world.entity(e2).read(dst.Health) as { hp: number }).hp).toBe(250)
    expect((dst.world.entity(e2).read(dst.Attack) as { dmg: number }).dmg).toBe(10)
    expect((dst.world.entity(b2).read(dst.Health) as { hp: number }).hp).toBe(200)

    // Edges: the full transitive ancestor set, re-minted receiver-locally.
    expect(dst.rel.hasPair(e1, dst.rel.IsA, g2)).toBe(true)
    expect(dst.rel.hasPair(e2, dst.rel.IsA, b2)).toBe(true)
    expect(dst.rel.hasPair(e2, dst.rel.IsA, g2)).toBe(true)

    // The built-ins re-attached by NAME: default exclusion + template queries work on the receiver.
    const gameplay: number[] = []
    dst.world.query(read(dst.Health)).each((m) => gameplay.push(m.handle as number))
    expect(gameplay.sort()).toEqual([e1 as number, e2 as number].sort())
    const templates: number[] = []
    dst.world.query(has(dst.rel.Prefab)).each((m) => templates.push(m.handle as number))
    expect(templates.sort()).toEqual([g2 as number, b2 as number].sort())
    expect(dst.world.query(dst.rel.Pair(dst.rel.IsA, Wildcard)).count).toBe(2)

    // …and the loaded world keeps working as a prefab world: spawn another instance from the
    // re-linked template and it inherits the template's (deserialized) values.
    const e3 = dst.rel.spawnFrom(b2)
    expect((dst.world.entity(e3).read(dst.Health) as { hp: number }).hp).toBe(200)
    expect(dst.rel.hasPair(e3, dst.rel.IsA, g2)).toBe(true)
  })

  it('round-trip determinism: re-snapshotting a loaded world is a byte-stable fixed point', () => {
    const src = makeKit()
    const goblin = src.rel.definePrefab([src.Health, { hp: 35 }])
    const boss = src.rel.definePrefab({ extends: goblin }, [src.Health, { hp: 200 }], [src.Attack, { dmg: 5 }])
    src.rel.spawnFrom(goblin)
    src.rel.spawnFrom(boss, [src.Health, { hp: 250 }])
    const bytesA = createSnapshotSerializer(src.world).snapshotCopy()

    const w1 = makeKit()
    createSnapshotDeserializer(w1.world).load(bytesA)
    const ser1 = createSnapshotSerializer(w1.world)
    const bytesB = ser1.snapshotCopy()
    // Same world serialized twice → byte-identical (canonical determinism).
    expect(Buffer.from(ser1.snapshotCopy())).toEqual(Buffer.from(bytesB))

    // One more generation: loading the re-snapshot reproduces it byte-for-byte (the fixed point).
    const w2 = makeKit()
    createSnapshotDeserializer(w2.world).load(bytesB)
    const bytesC = createSnapshotSerializer(w2.world).snapshotCopy()
    expect(Buffer.from(bytesC)).toEqual(Buffer.from(bytesB))
  })

  it('fail-fast: a prefabs-flag mismatch between producer and receiver refuses to load', () => {
    const src = makeKit()
    src.rel.definePrefab([src.Health, { hp: 35 }])
    const bytes = createSnapshotSerializer(src.world).snapshotCopy()

    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Attack = defineComponent({ dmg: 'i32' }, { name: 'attack' })
    const plain = createWorld({ components: [Health, Attack] }) // prefabs: false
    expect(() => createSnapshotDeserializer(plain).load(bytes)).toThrow(/schemaHash/)
  })

  it('merge-mode dangling prefab: the IsA pair is skipped with a dev warning, instance data intact', () => {
    const src = makeKit()
    const goblin = src.rel.definePrefab([src.Health, { hp: 35 }])
    const instance = src.rel.spawnFrom(goblin)
    const bytes = createSnapshotSerializer(src.world).snapshotCopy()

    // Simulate a sub-scene whose pair references an entity outside the snapshot: the relations
    // section is the buffer tail here (one tag pair, no rich section) — [u32 pairCount=1]
    // [u32 subject][u16 relationId][u32 target][u16 payloadCount=0] — so the target word sits at
    // length-6. Verify each layout assumption FIRST so a future wire change fails loudly here
    // instead of silently doctoring the wrong bytes.
    const doctored = bytes.slice()
    const view = new DataView(doctored.buffer, doctored.byteOffset)
    expect(view.getUint32(doctored.length - 16, true)).toBe(1) // pairCount
    expect(view.getUint32(doctored.length - 12, true)).toBe(instance as number) // subject
    expect(view.getUint32(doctored.length - 6, true)).toBe(goblin as number) // target
    expect(view.getUint16(doctored.length - 2, true)).toBe(0) // payloadCount (tag pair)
    view.setUint32(doctored.length - 6, 999_999, true)

    const dst = makeKit()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { remap } = createSnapshotDeserializer(dst.world).load(doctored, 'merge')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in the snapshot'))
      const e = remap.get(instance) as EntityHandle
      const g = remap.get(goblin) as EntityHandle
      expect((dst.world.entity(e).read(dst.Health) as { hp: number }).hp).toBe(35) // data intact
      expect(dst.rel.hasPair(e, dst.rel.IsA, g)).toBe(false) // ancestor queryability lost
      expect(dst.rel.hasRelation(e, dst.rel.IsA)).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
