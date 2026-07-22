// Field-granular SECTION V (v5, FLAG_FIELD_GRANULAR): an archetype's changed rows are grouped by
// their identical change mask and each group emits ONE block carrying only that group's columns.
// The load-bearing property is anti-data-loss: whole-row emission is self-healing (a spurious send
// costs bytes), but a field the mask omits is never re-offered, so a wrongly-CLEAR bit strands a
// stale value on the receiver forever. These tests assert the receiver ends up EXACTLY where the
// component-granular stream would have put it.

import { describe, expect, it, test } from 'vitest'
import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { createWorld, defineComponent, defineTag, field, has, object, vec3 } from '@ecsia/core'
import type { ComponentDef, ComponentId, EntityHandle, Schema, World } from '@ecsia/core'
import {
  applyDelta,
  createDeltaSerializer,
  createReplicationReceiver,
  createReplicationStream,
  createSnapshotDeserializer,
  createSnapshotSerializer,
} from '../src/index.js'
import { FLAG_FIELD_GRANULAR } from '../src/format.js'

// Exactly representable in f32/f64 and inside the i32 range, and outside every value the property
// test writes — a field still holding it demonstrably never received one of those writes.
const SENTINEL = -987654

// A concealed component's payload, recognisable verbatim in a wire image if concealment ever leaks.
const SECRET_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])
const SECRET = new DataView(SECRET_BYTES.slice().buffer).getFloat64(0, true)

function containsSubsequence(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

type Row = Record<string, number | number[]>

const wideSchema = (nFields: number): Record<string, unknown> => {
  const schema: Record<string, unknown> = {}
  for (let i = 0; i < nFields; i++) {
    schema['f' + i] = i % 5 === 4 ? vec3() : i % 3 === 1 ? 'i32' : i % 3 === 2 ? 'f64' : 'f32'
  }
  return schema
}

// A fresh def per world: two worlds built from the same schema share a schemaHash, which is what the
// wire gate compares — the def objects themselves must not be shared across worlds.
const mkWorld = (nFields: number): { world: World; W: ComponentDef<Schema> } => {
  const W = defineComponent(wideSchema(nFields) as Schema, { name: 'wide' }) as ComponentDef<Schema>
  return { world: createWorld({ components: [W] }), W }
}

const rowOf = (world: World, W: ComponentDef<Schema>, e: EntityHandle): Row =>
  world.entity(e).write(W) as unknown as Row

const readRow = (world: World, W: ComponentDef<Schema>, e: EntityHandle): Row =>
  world.entity(e).read(W) as unknown as Row

// Field accessors are live views over the columns; materialize them before comparing across worlds.
const lanesOf = (row: Row, key: string): number[] => {
  const slot = row[key]
  return typeof slot === 'number' ? [slot] : Array.from(slot as ArrayLike<number>)
}

const writeField = (row: Row, key: string, value: number): void => {
  const slot = row[key]
  if (typeof slot === 'number') row[key] = value
  else (slot as unknown as { [lane: number]: number })[0] = value
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const snapshotDigest = (world: World): string => digest(createSnapshotSerializer(world).snapshotCopy())

/** Mirror `src` into a fresh world of the same schema and return it with its remap table. */
const mirrorOf = (src: World, nFields: number): { world: World; W: ComponentDef<Schema>; remap: Map<EntityHandle, EntityHandle> } => {
  const dst = mkWorld(nFields)
  const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src).snapshotCopy(), 'replace')
  return { ...dst, remap: res.remap as Map<EntityHandle, EntityHandle> }
}

describe('field-granular deltas — the receiver lands exactly where component granularity puts it', () => {
  it('random schemas and random per-tick field writes: same receiver, nothing untouched is clobbered', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        // At least FIELD_GROUP_MIN_ROWS rows, so a shared mask forms a group large enough to survive
        // the degenerate guard: with fewer the archetype always falls back to whole-row blocks and
        // the subset encoding — the thing under test — is never exercised.
        fc.integer({ min: 4, max: 9 }),
        fc.array(
          fc.tuple(
            fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), // fields written on EVERY entity
            fc.nat(), // one entity…
            fc.nat(), // …written on one field of its own, so masks also differ within a tick
            fc.integer({ min: -1000, max: 1000 }),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (nFields, nEnts, ticks) => {
          const src = mkWorld(nFields)
          const ents: EntityHandle[] = []
          for (let i = 0; i < nEnts; i++) {
            const e = src.world.spawnWith(src.W)
            const row = rowOf(src.world, src.W, e)
            // Every field starts at a value no later write produces: a receiver still holding it
            // proves the field was never touched, and a receiver holding anything else proves it
            // was clobbered by a mis-indexed column.
            for (let f = 0; f < nFields; f++) writeField(row, 'f' + f, SENTINEL)
            ents.push(e)
          }
          const recvC = mirrorOf(src.world, nFields)
          const recvF = mirrorOf(src.world, nFields)
          const serC = createDeltaSerializer(src.world, src.world.currentTick())
          const serF = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field' })

          const written = new Set<string>()
          const touch = (ent: EntityHandle, f: number, v: number): void => {
            const key = 'f' + (f % nFields)
            writeField(rowOf(src.world, src.W, ent), key, v)
            written.add(`${ent}:${key}`)
          }
          for (const [shared, solo, soloField, value] of ticks) {
            src.world.advanceTick()
            ents.forEach((ent, i) => {
              for (const f of shared) touch(ent, f, value + i)
            })
            touch(ents[solo % ents.length] as EntityHandle, soloField, value - 1)
            applyDelta(recvC.world, serC.deltaCopy(), recvC.remap)
            applyDelta(recvF.world, serF.deltaCopy(), recvF.remap)
          }

          expect(snapshotDigest(recvF.world)).toBe(snapshotDigest(recvC.world))
          for (const e of ents) {
            const producer = readRow(src.world, src.W, e)
            const mirrored = readRow(recvF.world, recvF.W, recvF.remap.get(e) as EntityHandle)
            for (let f = 0; f < nFields; f++) {
              const key = 'f' + f
              const got = lanesOf(mirrored, key)
              expect(got).toEqual(lanesOf(producer, key))
              if (!written.has(`${e}:${key}`)) expect(got[0]).toBe(SENTINEL)
            }
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('discriminates: a mask-blind writer that emits the wrong column would be caught', () => {
    // The property above only bites if the field images really do carry SUBSETS. Prove they do:
    // with one field of sixteen moving, the field image is a fraction of the component image, and
    // its header advertises the field-granular grammar.
    const nFields = 16
    const src = mkWorld(nFields)
    const ents: EntityHandle[] = []
    for (let i = 0; i < 12; i++) {
      const e = src.world.spawnWith(src.W)
      const row = rowOf(src.world, src.W, e)
      for (let f = 0; f < nFields; f++) writeField(row, 'f' + f, SENTINEL)
      ents.push(e)
    }
    const serC = createDeltaSerializer(src.world, src.world.currentTick())
    const serF = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field' })
    // Warm: the first emission that observes an archetype finds a FRESH shadow column and reports
    // every row wholly changed, so the subset only shows up from the second emission on.
    src.world.advanceTick()
    for (const e of ents) writeField(rowOf(src.world, src.W, e), 'f0', 1)
    serC.deltaCopy()
    serF.deltaCopy()

    src.world.advanceTick()
    for (const e of ents) writeField(rowOf(src.world, src.W, e), 'f2', 3)
    const bytesC = serC.deltaCopy()
    const bytesF = serF.deltaCopy()

    expect(bytesF.byteLength).toBeLessThan(bytesC.byteLength / 4)
    expect(new DataView(bytesF.buffer, bytesF.byteOffset).getUint8(7) & FLAG_FIELD_GRANULAR).toBe(FLAG_FIELD_GRANULAR)
    expect(new DataView(bytesC.buffer, bytesC.byteOffset).getUint8(7) & FLAG_FIELD_GRANULAR).toBe(0)
  })

  it('a dense small archetype falls back to whole-row blocks rather than fragmenting', () => {
    // The degenerate guard: masks so heterogeneous that grouping costs more header than it saves.
    // The fallback still tags every column, so the reader's branch stays unconditional — the image
    // is at most 2 bytes per column larger than the component-granular one, never wrong.
    const nFields = 4
    const src = mkWorld(nFields)
    const ents: EntityHandle[] = []
    for (let i = 0; i < 4; i++) {
      const e = src.world.spawnWith(src.W)
      for (let f = 0; f < nFields; f++) writeField(rowOf(src.world, src.W, e), 'f' + f, SENTINEL)
      ents.push(e)
    }
    const recv = mirrorOf(src.world, nFields)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field' })
    applyDelta(recv.world, ser.deltaCopy(), recv.remap)

    src.world.advanceTick()
    ents.forEach((e, i) => {
      writeField(rowOf(src.world, src.W, e), 'f' + (i % nFields), i + 1) // every row a different mask
    })
    applyDelta(recv.world, ser.deltaCopy(), recv.remap)

    for (const e of ents) {
      const mirrored = readRow(recv.world, recv.W, recv.remap.get(e) as EntityHandle)
      const producer = readRow(src.world, src.W, e)
      for (let f = 0; f < nFields; f++) expect(lanesOf(mirrored, 'f' + f)).toEqual(lanesOf(producer, 'f' + f))
    }
  })

  it('structural churn composes: spawn, despawn and migration keep the two receivers identical', () => {
    const mk = (): { world: World; W: ComponentDef<Schema>; T: ComponentDef<Schema> } => {
      const W = defineComponent(wideSchema(6) as Schema, { name: 'wide' }) as ComponentDef<Schema>
      const T = defineComponent({}, { name: 'tag' }) as ComponentDef<Schema>
      return { world: createWorld({ components: [W, T] }), W, T }
    }
    const src = mk()
    const ents: EntityHandle[] = []
    for (let i = 0; i < 6; i++) {
      const e = src.world.spawnWith(src.W)
      for (let f = 0; f < 6; f++) writeField(rowOf(src.world, src.W, e), 'f' + f, SENTINEL)
      ents.push(e)
    }
    const mirror = (): { world: World; W: ComponentDef<Schema>; remap: Map<EntityHandle, EntityHandle> } => {
      const dst = mk()
      const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshotCopy(), 'replace')
      return { world: dst.world, W: dst.W, remap: res.remap as Map<EntityHandle, EntityHandle> }
    }
    const recvC = mirror()
    const recvF = mirror()
    const serC = createDeltaSerializer(src.world, src.world.currentTick())
    const serF = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field' })
    const step = (fn: () => void): void => {
      src.world.advanceTick()
      fn()
      applyDelta(recvC.world, serC.deltaCopy(), recvC.remap)
      applyDelta(recvF.world, serF.deltaCopy(), recvF.remap)
      expect(snapshotDigest(recvF.world)).toBe(snapshotDigest(recvC.world))
    }

    step(() => writeField(rowOf(src.world, src.W, ents[0] as EntityHandle), 'f1', 5))
    step(() => src.world.add(ents[1] as EntityHandle, src.T)) // migration
    step(() => src.world.despawn(ents[2] as EntityHandle)) // swap-pop: a survivor inherits the row
    step(() => {
      const fresh = src.world.spawnWith(src.W)
      writeField(rowOf(src.world, src.W, fresh), 'f0', 12)
    })
    step(() => writeField(rowOf(src.world, src.W, ents[3] as EntityHandle), 'f4', 7)) // a vec3 lane
  })

  it('a tenant change in a column-less archetype still emits (the mask cannot see it)', () => {
    // Every persisted field is RICH, so the change mask has no bits at all: an emitter that reduced
    // "should this row emit" to `mask !== 0` would strand the new occupant on the receiver.
    const mk = (): { world: World; L: ComponentDef<Schema> } => {
      const L = defineComponent({ text: 'string', meta: object<{ k: number }>() }, { name: 'label' }) as ComponentDef<Schema>
      return { world: createWorld({ components: [L] }), L }
    }
    const src = mk()
    const a = src.world.spawnWith(src.L)
    ;(rowOf(src.world, src.L, a) as unknown as { text: string }).text = 'first'

    const dst = mk()
    const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshotCopy(), 'replace')
    const remap = res.remap as Map<EntityHandle, EntityHandle>
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field' })

    src.world.advanceTick()
    src.world.despawn(a)
    const b = src.world.spawnWith(src.L) // reuses the row a occupied
    ;(rowOf(src.world, src.L, b) as unknown as { text: string }).text = 'second'
    applyDelta(dst.world, ser.deltaCopy(), remap)

    const mb = remap.get(b) as EntityHandle
    expect((readRow(dst.world, dst.L, mb) as unknown as { text: string }).text).toBe('second')
  })
})

// A frozen field-granular wire golden. Row grouping is an INTERNAL choice of key, but the groups it
// produces — and the order it produces them in — are the emitted bytes. This pins both against a
// grouping refactor; a failure means the block partition or its order moved.
describe('field-granular SECTION V is byte-frozen', () => {
  const goldenFrames = (): Uint8Array[] => {
    const nFields = 6
    const W = defineComponent(wideSchema(nFields) as Schema, { name: 'wide' }) as ComponentDef<Schema>
    const Tag = defineTag('t') as unknown as ComponentDef<Schema>
    const world = createWorld({ components: [W, Tag] })
    // 12 entities over TWO archetypes (9 without the tag, 3 with): the 9-row one is wide enough for
    // multi-group emission, the 3-row one always trips the degenerate guard — both paths, one stream.
    const ents = Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? world.spawnWith(W, Tag) : world.spawnWith(W)))
    for (const e of ents) for (let f = 0; f < nFields; f++) writeField(rowOf(world, W, e), 'f' + f, SENTINEL)
    const ser = createDeltaSerializer(world, world.currentTick(), { granularity: 'field' })
    const frames: Uint8Array[] = []
    const step = (fn: () => void): void => {
      world.advanceTick()
      fn()
      frames.push(ser.deltaCopy())
    }
    step(() => ents.forEach((e, i) => writeField(rowOf(world, W, e), 'f0', i))) // fresh: whole rows
    step(() => ents.forEach((e) => writeField(rowOf(world, W, e), 'f2', 1))) // one uniform group
    // TWO groups, and the SECOND one occurs first in row order — so the emission order is observable.
    step(() => ents.forEach((e, i) => writeField(rowOf(world, W, e), i % 2 === 0 ? 'f3' : 'f1', i)))
    step(() =>
      ents.forEach((e, i) => {
        writeField(rowOf(world, W, e), 'f' + (i % 3), i) // three groups…
        if (i % 2 === 0) writeField(rowOf(world, W, e), 'f4', i) // …split further: hits the fallback
      }),
    )
    step(() => ents.forEach((e, i) => (i < 7 ? writeField(rowOf(world, W, e), 'f5', i) : undefined)))
    step(() => {
      /* empty frame */
    })
    return frames
  }

  it('reproduces the golden field-granular stream', () => {
    const frames = goldenFrames()
    expect(frames.map((f) => f.byteLength)).toEqual([644, 336, 320, 468, 244, 36]) // fails first, and legibly
    const h = createHash('sha256')
    for (const f of frames) h.update(f)
    expect(h.digest('hex')).toBe('9740fd8afc28fa271efe4b8b2534b9a9db8dcfb2f22a69de9260080c142f06e9')
  })
})

// Two index namespaces meet here. The change mask, the persisted-column list and the wire ordinal
// all count COLUMN-BACKED fields only (`ctor !== null`), while a component's canonical field index
// counts every field including the rich ones — which ride SECTION R on a separate schedule. A
// component interleaving rich and numeric fields is where an off-by-namespace bug surfaces: the
// wire ordinal of a numeric field sitting AFTER a rich one differs from its schema field index.
describe('field granularity across mixed rich + numeric components', () => {
  interface Mixed {
    world: World
    // Rich in the MIDDLE, and a numeric field after two rich ones.
    A: ComponentDef<Schema>
    // Rich FIRST: every numeric column of B sits after a rich field.
    B: ComponentDef<Schema>
    // Rich LAST: the trailing case, where the namespaces happen to agree.
    C: ComponentDef<Schema>
  }
  const mkMixed = (): Mixed => {
    const A = defineComponent(
      { hp: 'i32', name: 'string', pos: vec3(), meta: object<{ k: number }>(), armor: 'f32' },
      { name: 'a' },
    ) as ComponentDef<Schema>
    const B = defineComponent({ label: 'string', vx: 'f32', vy: 'f64' }, { name: 'b' }) as ComponentDef<Schema>
    const C = defineComponent({ x: 'f32', y: 'f32', note: 'string' }, { name: 'c' }) as ComponentDef<Schema>
    return { world: createWorld({ components: [A, B, C] }), A, B, C }
  }
  const NUMERIC: readonly (readonly [keyof Mixed & ('A' | 'B' | 'C'), string])[] = [
    ['A', 'hp'],
    ['A', 'pos'],
    ['A', 'armor'],
    ['B', 'vx'],
    ['B', 'vy'],
    ['C', 'x'],
    ['C', 'y'],
  ]
  const richOf = (m: Mixed, e: EntityHandle, comp: 'A' | 'B' | 'C', key: string): unknown =>
    (m.world.entity(e).read(m[comp]) as unknown as Record<string, unknown>)[key]
  const setRich = (m: Mixed, e: EntityHandle, comp: 'A' | 'B' | 'C', key: string, value: unknown): void => {
    ;(m.world.entity(e).write(m[comp]) as unknown as Record<string, unknown>)[key] = value
  }

  const scenario = (): { src: Mixed; dst: Mixed; ents: EntityHandle[]; remap: Map<EntityHandle, EntityHandle> } => {
    const src = mkMixed()
    // Enough rows sharing a mask to clear the degenerate guard, so the SUBSET encoding is exercised.
    const ents = Array.from({ length: 8 }, () => src.world.spawnWith(src.A, src.B, src.C))
    for (const e of ents) {
      for (const [comp, key] of NUMERIC) writeField(rowOf(src.world, src[comp], e), key, SENTINEL)
      setRich(src, e, 'A', 'name', 'name-0')
      setRich(src, e, 'A', 'meta', { k: 0 })
      setRich(src, e, 'B', 'label', 'label-0')
      setRich(src, e, 'C', 'note', 'note-0')
    }
    const dst = mkMixed()
    const res = createSnapshotDeserializer(dst.world).load(createSnapshotSerializer(src.world).snapshotCopy(), 'replace')
    return { src, dst, ents, remap: res.remap as Map<EntityHandle, EntityHandle> }
  }

  const expectMirrored = (s: { src: Mixed; dst: Mixed; ents: EntityHandle[]; remap: Map<EntityHandle, EntityHandle> }): void => {
    for (const e of s.ents) {
      const local = s.remap.get(e) as EntityHandle
      for (const [comp, key] of NUMERIC) {
        expect(lanesOf(readRow(s.dst.world, s.dst[comp], local), key)).toEqual(
          lanesOf(readRow(s.src.world, s.src[comp], e), key),
        )
      }
      for (const [comp, key] of [['A', 'name'], ['A', 'meta'], ['B', 'label'], ['C', 'note']] as const) {
        expect(richOf(s.dst, local, comp, key)).toEqual(richOf(s.src, e, comp, key))
      }
    }
  }

  it('only a numeric field AFTER a rich one changes: it lands on the right column, nothing else moves', () => {
    const s = scenario()
    const ser = createDeltaSerializer(s.src.world, s.src.world.currentTick(), { granularity: 'field' })
    applyDelta(s.dst.world, ser.deltaCopy(), s.remap)

    s.src.world.advanceTick()
    for (const e of s.ents) {
      writeField(rowOf(s.src.world, s.src.B, e), 'vy', 42) // B: rich FIRST, so vy is wire ordinal 1
      writeField(rowOf(s.src.world, s.src.A, e), 'armor', 7) // A: two rich fields precede armor
    }
    applyDelta(s.dst.world, ser.deltaCopy(), s.remap)

    expectMirrored(s)
    for (const e of s.ents) {
      const local = s.remap.get(e) as EntityHandle
      for (const [comp, key] of NUMERIC) {
        if (key === 'vy' || key === 'armor') continue
        expect(lanesOf(readRow(s.dst.world, s.dst[comp], local), key)[0]).toBe(SENTINEL)
      }
    }
  })

  it('only the RICH field changes: SECTION R still carries it and no numeric column is touched', () => {
    const s = scenario()
    const ser = createDeltaSerializer(s.src.world, s.src.world.currentTick(), { granularity: 'field' })
    applyDelta(s.dst.world, ser.deltaCopy(), s.remap)

    s.src.world.advanceTick()
    for (const e of s.ents) {
      setRich(s.src, e, 'A', 'name', 'renamed')
      setRich(s.src, e, 'C', 'note', 'annotated')
    }
    applyDelta(s.dst.world, ser.deltaCopy(), s.remap)

    expectMirrored(s)
    for (const e of s.ents) {
      const local = s.remap.get(e) as EntityHandle
      expect(richOf(s.dst, local, 'A', 'name')).toBe('renamed')
      for (const [comp, key] of NUMERIC) {
        expect(lanesOf(readRow(s.dst.world, s.dst[comp], local), key)[0]).toBe(SENTINEL)
      }
    }
  })

  it('a mixed write across all three components round-trips every field', () => {
    const s = scenario()
    const ser = createDeltaSerializer(s.src.world, s.src.world.currentTick(), { granularity: 'field' })
    applyDelta(s.dst.world, ser.deltaCopy(), s.remap)

    for (let tick = 1; tick <= 4; tick++) {
      s.src.world.advanceTick()
      s.ents.forEach((e, i) => {
        writeField(rowOf(s.src.world, s.src.A, e), 'hp', tick * 10 + i)
        writeField(rowOf(s.src.world, s.src.A, e), 'pos', tick + i)
        writeField(rowOf(s.src.world, s.src.C, e), 'y', tick * 3)
        if (i % 2 === 0) writeField(rowOf(s.src.world, s.src.B, e), 'vx', tick) // a second mask group
        if (i % 3 === 0) setRich(s.src, e, 'B', 'label', `label-${tick}`)
      })
      applyDelta(s.dst.world, ser.deltaCopy(), s.remap)
      expectMirrored(s)
    }
  })
})

// A view's concealment grouping and the delta serializer's change-mask grouping are the SAME
// mechanism keyed differently (rows sharing a uniform column set become one block, and applyDelta
// keys rows by handle, ignoring the block's archetype id). They compose without interacting: a view
// carries no emission shadow of its own, so filtered deltas stay component-granular while the
// unfiltered stream on the same world is field-granular.
describe('field granularity composes with interest management', () => {
  it('a concealed component never reaches the view, eids stay masked, and the unfiltered stream mirrors exactly', () => {
    const defs = (): { P: ComponentDef<Schema>; Secret: ComponentDef<Schema>; Link: ComponentDef<Schema>; V: ComponentDef<Schema> } => ({
      P: defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema>,
      Secret: defineComponent({ val: 'f64' }, { name: 'secret' }) as ComponentDef<Schema>,
      Link: defineComponent({ who: 'eid' }, { name: 'link' }) as ComponentDef<Schema>,
      V: defineTag('vis') as unknown as ComponentDef<Schema>,
    })
    const src = defs()
    const world = createWorld({ components: [src.P, src.Secret, src.Link, src.V] })
    const viewDefs = defs()
    const viewWorld = createWorld({ components: [viewDefs.P, viewDefs.Secret, viewDefs.Link, viewDefs.V] })
    const fullDefs = defs()
    const fullWorld = createWorld({ components: [fullDefs.P, fullDefs.Secret, fullDefs.Link, fullDefs.V] })

    const stream = createReplicationStream(world, { granularity: 'field' })
    const viewReceiver = createReplicationReceiver(viewWorld)
    const fullReceiver = createReplicationReceiver(fullWorld)
    const view = stream.view({ visible: world.query(has(src.V)), hideComponents: [src.Secret.id as ComponentId] })

    const visible: EntityHandle[] = []
    for (let i = 0; i < 6; i++) {
      const e = world.spawnWith(src.P, src.Secret, src.V)
      ;(world.entity(e).write(src.P) as { x: number }).x = i
      ;(world.entity(e).write(src.Secret) as { val: number }).val = SECRET
      visible.push(e)
    }
    const hidden = world.spawnWith(src.P) // no V ⇒ invisible to the view
    const linker = world.spawnWith(src.Link, src.V)
    ;(world.entity(linker).write(src.Link) as { who: EntityHandle }).who = hidden

    fullReceiver.apply(stream.baseline())
    viewReceiver.apply(view.baseline())

    const viewImages: Uint8Array[] = []
    for (let tick = 0; tick < 4; tick++) {
      world.advanceTick()
      for (const e of visible) {
        ;(world.entity(e).write(src.P) as { x: number }).x = tick + 1 // one of two columns moves
        ;(world.entity(e).write(src.Secret) as { val: number }).val = SECRET
      }
      const filtered = view.delta()
      viewImages.push(filtered.bytes)
      expect(viewReceiver.apply(filtered).applied).toBe(true)
      expect(fullReceiver.apply(stream.tick()).applied).toBe(true)
    }

    for (const bytes of viewImages) {
      expect(containsSubsequence(bytes, SECRET_BYTES)).toBe(false) // IM-2 still holds
      expect(new DataView(bytes.buffer, bytes.byteOffset).getUint8(7) & FLAG_FIELD_GRANULAR).toBe(0)
    }
    // The view's eid masking still fires: the invisible target reads as null on the client.
    const localLinker = viewReceiver.remap.get(linker) as EntityHandle
    expect((viewWorld.entity(localLinker).read(viewDefs.Link) as { who: number | null }).who).toBe(null)
    // …and the unfiltered field-granular stream mirrored every visible AND hidden entity exactly.
    for (const e of [...visible, hidden]) {
      const local = fullReceiver.remap.get(e) as EntityHandle
      expect((fullWorld.entity(local).read(fullDefs.P) as { x: number }).x).toBe(
        (world.entity(e).read(src.P) as { x: number }).x,
      )
    }
    for (const e of visible) {
      const local = viewReceiver.remap.get(e) as EntityHandle
      expect((viewWorld.entity(local).read(viewDefs.P) as { x: number }).x).toBe(4)
    }
  })
})

describe('field granularity under an epsilon tolerance', () => {
  // The shadow may only advance for the columns a block actually TRANSMITS. Snapping an omitted
  // column would reset its sub-tolerance drift baseline without the receiver ever seeing the value,
  // and the divergence would then grow without bound instead of staying within epsilon.
  test('a field drifting sub-epsilon forever still converges to within epsilon', () => {
    const nFields = 4
    const src = mkWorld(nFields)
    // Enough rows sharing one mask to clear the degenerate guard — otherwise the archetype falls
    // back to whole-row blocks and the shadow-advance rule under test is never exercised.
    const ents = Array.from({ length: 8 }, () => src.world.spawnWith(src.W))
    const recv = mirrorOf(src.world, nFields)
    const ser = createDeltaSerializer(src.world, src.world.currentTick(), { granularity: 'field', epsilon: 0.5 })
    applyDelta(recv.world, ser.deltaCopy(), recv.remap)

    let drift = 0
    for (let i = 0; i < 200; i++) {
      src.world.advanceTick()
      drift += 0.1
      for (const e of ents) {
        writeField(rowOf(src.world, src.W, e), 'f0', drift)
        writeField(rowOf(src.world, src.W, e), 'f2', i) // f2 always moves, so the row always emits
      }
      applyDelta(recv.world, ser.deltaCopy(), recv.remap)
      for (const e of ents) {
        const got = readRow(recv.world, recv.W, recv.remap.get(e) as EntityHandle)['f0'] as number
        expect(Math.abs(got - drift)).toBeLessThanOrEqual(0.5 + 1e-4) // f0 is f32: epsilon + rounding
      }
    }
  })

  test('a non-persisted write never defeats the drop, and never mis-indexes the columns', () => {
    const T = (): ComponentDef<Schema> =>
      defineComponent({ a: 'f32', hidden: field('f32', { persist: false }), b: 'f32' }, { name: 't' }) as ComponentDef<Schema>
    const srcT = T()
    const src = createWorld({ components: [srcT] })
    const e = src.spawnWith(srcT)
    ;(src.entity(e).write(srcT) as unknown as Row)['a'] = 1
    ;(src.entity(e).write(srcT) as unknown as Row)['b'] = 2

    const dstT = T()
    const dst = createWorld({ components: [dstT] })
    const res = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy(), 'replace')
    const remap = res.remap as Map<EntityHandle, EntityHandle>
    const ser = createDeltaSerializer(src, src.currentTick(), { granularity: 'field' })
    applyDelta(dst, ser.deltaCopy(), remap)

    src.advanceTick()
    ;(src.entity(e).write(srcT) as unknown as Row)['b'] = 9
    ;(src.entity(e).write(srcT) as unknown as Row)['hidden'] = 42
    applyDelta(dst, ser.deltaCopy(), remap)

    const mirrored = dst.entity(remap.get(e) as EntityHandle).read(dstT) as unknown as Row
    // `b` is the SECOND persisted column but the THIRD field: a block carrying `b` alone must name
    // wire field index 1, not 2 (and not overwrite `a`).
    expect(mirrored['a']).toBe(1)
    expect(mirrored['b']).toBe(9)
  })
})
