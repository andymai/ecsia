// review-fix suite: field-VALUE round-trips across the hot/cold archetype boundary in both
// directions, cold→cold migration, cold-row reclamation, and a combined membership+value coherence
// check. These DISCRIMINATE the silent-data-drop and row-leak bugs: each asserts on the actual
// field value carried (not just bitmask membership), so a migrate() that skips the shared-column
// copy for a cold target — or a cold store that never reclaims rows — fails here.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { ArchetypeStore, Bitmask, Buffers, ComponentRegistry, canonicalize, coldRowOf, probeCapabilities, sigHas } from '../src/internal.js'
import type { ComponentId } from '@ecsia/core'
import type { ColdStore, RecordSurface, Signature } from '../src/internal.js'

const newBuffers = (): Buffers =>
  new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

interface Store {
  store: ArchetypeStore
  recordArch: Map<number, number>
  recordRow: Map<number, number>
  registry: ComponentRegistry
  cold: ColdStore
}

function makeStore(componentCount: number, maxHotArchetypes = 1 << 20): Store {
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
    accessorWorld: { tracking: { active: true }, trackWrite: () => {}, handleIndex: (h) => (h as number) & 0xffff },
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
  return { store, recordArch, recordRow, registry, cold: store.cold }
}

/** Seat an index into EMPTY and return its handle (== index here). */
function seat(s: Store, index: number): number {
  const handle = index & 0xffff
  const row = s.store.allocRow(s.store.emptyArchetype, handle)
  s.recordArch.set(index, 0)
  s.recordRow.set(index, row)
  return handle
}

/** Read field 0 of component `c` for entity `index`, hot or cold, via the column view directly. */
function readField0(s: Store, index: number, c: ComponentId): number {
  const archId = s.recordArch.get(index) ?? 0
  const arch = s.store.byId[archId]!
  if (arch.cold) {
    const block = s.cold.blocks.get(c)!
    const row = coldRowOf(s.cold, index, c)
    const col = block.columns[0]!
    return col.view[row * col.layout.stride] as number
  }
  const set = arch.columnSets.get(c)!
  const row = s.recordRow.get(index) ?? 0
  const col = set.columns[0]!
  return col.view[row * col.layout.stride] as number
}

/** Write field 0 of component `c` for entity `index` (entity must already hold `c`). */
function writeField0(s: Store, index: number, c: ComponentId, value: number): void {
  const archId = s.recordArch.get(index) ?? 0
  const arch = s.store.byId[archId]!
  if (arch.cold) {
    const block = s.cold.blocks.get(c)!
    const row = coldRowOf(s.cold, index, c)
    const col = block.columns[0]!
    col.view[row * col.layout.stride] = value
    return
  }
  const set = arch.columnSets.get(c)!
  const row = s.recordRow.get(index) ?? 0
  const col = set.columns[0]!
  col.view[row * col.layout.stride] = value
}

describe('hot → cold migration preserves shared-column field VALUES', () => {
  test('reviewer repro: spawn {A} a=42, add B into a COLD {A,B}; A.a is still 42, not 0', () => {
    // EMPTY(0) hot, {A} hot (budget 2) => {A,B} is forced cold.
    const s = makeStore(2, 2)
    const A = 1 as ComponentId
    const B = 2 as ComponentId
    const idx = 1
    seat(s, idx)
    s.store.migrateAdding(idx, A) // {A} hot
    expect(s.store.byId[s.recordArch.get(idx)!]!.cold).toBe(false)
    writeField0(s, idx, A, 42)

    s.store.migrateAdding(idx, B) // -> {A,B}, cold
    const archAB = s.store.byId[s.recordArch.get(idx)!]!
    expect(archAB.cold).toBe(true) // the target is genuinely cold (precondition for the bug)

    // The shared component A's value MUST survive the hot->cold migration.
    expect(readField0(s, idx, A)).toBe(42)
    // The newly-added cold component B is zero-initialized.
    expect(readField0(s, idx, B)).toBe(0)
    // Membership stays coherent too.
    expect(s.store.byId[s.recordArch.get(idx)!]!.signature.length).toBe(2)
  })

  test('end-to-end via createWorld: cold target keeps the prior field value', () => {
    const A = defineComponent({ a: 'i32' }, { name: 'c1' })
    const B = defineComponent({ b: 'i32' }, { name: 'c2' })
    const w = createWorld({ components: [A, B], maxHotArchetypes: 2 })
    const e = w.spawnWith(A)
    ;(w.entity(e).write(A) as { a: number }).a = 42
    w.add(e, B) // {A,B} is cold under the cap
    expect((w.entity(e).read(A) as { a: number }).a).toBe(42)
    expect(w.has(e, A)).toBe(true)
    expect(w.has(e, B)).toBe(true)
  })
})

describe('cold → hot migration (warm) carries field VALUES out of the overflow store', () => {
  test('a populated cold archetype, promoted via warm, keeps every resident entity value', () => {
    // EMPTY hot only => {A} is cold.
    const s = makeStore(2, 1)
    const A = 1 as ComponentId
    const i1 = 1
    const i2 = 2
    seat(s, i1)
    seat(s, i2)
    s.store.migrateAdding(i1, A)
    s.store.migrateAdding(i2, A)
    const archA = s.store.byId[s.recordArch.get(i1)!]!
    expect(archA.cold).toBe(true)
    writeField0(s, i1, A, 100)
    writeField0(s, i2, A, 200)

    s.store.warm(archA.signature)
    expect(archA.cold).toBe(false)
    // Both residents migrated OUT of the overflow store into contiguous hot rows; values intact.
    expect(readField0(s, i1, A)).toBe(100)
    expect(readField0(s, i2, A)).toBe(200)
    // Records now point at the hot archetype with valid rows (no orphan), distinct dense rows.
    const r1 = s.recordRow.get(i1)!
    const r2 = s.recordRow.get(i2)!
    expect(r1).not.toBe(r2)
    expect(archA.count).toBe(2)
    expect(archA.rows[r1]! & 0xffff).toBe(i1)
    expect(archA.rows[r2]! & 0xffff).toBe(i2)
    // The cold overflow rows were reclaimed.
    expect(coldRowOf(s.cold, i1, A)).toBe(-1)
    expect(coldRowOf(s.cold, i2, A)).toBe(-1)
  })
})

describe('cold → cold migration preserves shared values (rowOf clobber regression)', () => {
  test('add a 2nd cold component to a cold entity; the first stays intact', () => {
    // EMPTY hot only => everything else cold.
    const s = makeStore(3, 1)
    const A = 1 as ComponentId
    const B = 2 as ComponentId
    const idx = 1
    seat(s, idx)
    s.store.migrateAdding(idx, A) // {A} cold
    expect(s.store.byId[s.recordArch.get(idx)!]!.cold).toBe(true)
    writeField0(s, idx, A, 77)

    s.store.migrateAdding(idx, B) // {A,B} cold — both source and dest are cold
    expect(s.store.byId[s.recordArch.get(idx)!]!.cold).toBe(true)
    expect(readField0(s, idx, A)).toBe(77) // shared cold value not clobbered by re-alloc
    expect(readField0(s, idx, B)).toBe(0)
  })
})

describe('cold-row reclamation: no monotonic leak, freed rows reused', () => {
  test('despawn-style removeRow frees the cold rows; the next cold alloc reuses them', () => {
    const s = makeStore(2, 1) // {A} is cold
    const A = 1 as ComponentId
    const i1 = 1
    seat(s, i1)
    s.store.migrateAdding(i1, A)
    const archA = s.store.byId[s.recordArch.get(i1)!]!
    const row1 = coldRowOf(s.cold, i1, A)
    expect(row1).toBe(0)
    const nextAfterFirst = s.cold.nextRow.get(A)
    expect(nextAfterFirst).toBe(1)

    // Remove i1 from the cold archetype (despawn path): removeRow(arch, recordRow=index).
    s.store.removeRow(archA, s.recordRow.get(i1)!, () => {})
    // The (index, A) mapping is gone; archOf entry cleared (no stale leak across index reuse).
    expect(coldRowOf(s.cold, i1, A)).toBe(-1)
    expect(s.cold.archOf.has(i1)).toBe(false)

    // A new cold entity REUSES the freed row instead of advancing nextRow (no monotonic growth).
    const i2 = 2
    seat(s, i2)
    s.store.migrateAdding(i2, A)
    expect(coldRowOf(s.cold, i2, A)).toBe(row1) // reclaimed slot 0
    expect(s.cold.nextRow.get(A)).toBe(1) // nextRow did NOT advance
  })

  test('100 cold spawn/despawn cycles keep nextRow bounded (leak guard)', () => {
    const s = makeStore(2, 1)
    const A = 1 as ComponentId
    for (let i = 1; i <= 100; i++) {
      const idx = i
      seat(s, idx)
      s.store.migrateAdding(idx, A)
      const archA = s.store.byId[s.recordArch.get(idx)!]!
      s.store.removeRow(archA, s.recordRow.get(idx)!, () => {})
    }
    // Without reclamation nextRow would be ~100; with the free-list it stays at 1.
    expect(s.cold.nextRow.get(A)).toBe(1)
    expect(s.cold.rowOf.size).toBe(0) // no stale (index, componentId) mappings linger
  })
})

describe('combined membership + VALUE coherence across the hot/cold boundary', () => {
  test('after each migration both bitmask membership AND the carried field value are correct', () => {
    const s = makeStore(3, 2) // EMPTY + one hot archetype; deeper signatures go cold
    const ids = [1, 2, 3] as ComponentId[]
    const idx = 1
    seat(s, idx)
    for (const c of ids) {
      s.store.migrateAdding(idx, c)
      // set a distinct value into the just-added component.
      writeField0(s, idx, c, (c as number) * 10)
      const sig = s.store.byId[s.recordArch.get(idx)!]!.signature as Signature
      // every held component still reports its value AND membership coherently.
      for (const held of ids) {
        if (sigHas(sig, held)) {
          expect(readField0(s, idx, held)).toBe((held as number) * 10)
        }
      }
    }
  })
})
