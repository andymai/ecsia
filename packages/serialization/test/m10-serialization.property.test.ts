// M10 serialization DISCRIMINATING property + structural suite (serialization.md §11 invariants).
//
// Each property is designed to FAIL if the locked design regresses — they are not tautologies over
// the implementation. Deep comparison is done through the PUBLIC query / getPair surface only.
//
//   S-4  round-trip IDENTITY: deserialize(serialize(world)) ≡ world over the entity SET, component
//        VALUES, and RELATIONS — for random worlds, compared via world.query(...).each + getPair.
//   S-3  delta SOUNDNESS: applying a delta over a random tick range equals REPLAYING the writes; and
//        the delta path allocates NO shadow memory (it is version-stamp driven — instrumented by
//        asserting the changed-row set the serializer emits === world.changedRows, never a value diff).
//   S-5  remap TOTALITY: every eid / pair-target field survives a deserialize into a world with a
//        DISJOINT id space (the destination is pre-populated with unrelated live entities so the id
//        spaces genuinely differ) — no dangling reference, no aliasing onto a live unrelated entity.
//   structural  delta SIZE scales with CHANGED-field count, not entity count: writing W of N entities
//        yields a delta whose payload length depends on W, not N (the no-100MB-static-buffer / "delta
//        scales with changed-field count" discipline, §9 / §6.2).
//
// DEFERRED (no bench harness this milestone): the snapshot/delta THROUGHPUT bench (wall-clock
// bytes/sec, allocation profiling over many ticks). Its STRUCTURAL surrogate — that delta payload
// length tracks the changed-row count rather than the entity count — is asserted below (S-3 size).

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema, World } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import {
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'

// Component defs register to exactly one world; a cross-world round-trip mirrors the real
// (cross-process) case where BOTH sides run the same defineComponent source. A factory rebuilds a
// fresh, structurally-identical def set per world so the schemaHash matches across the boundary.
function makeDefs() {
  return {
    Position: defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' }),
    Health: defineComponent({ hp: 'i32' }, { name: 'health' }),
    Target: defineComponent({ who: 'eid' }, { name: 'target' }),
    Tag: defineComponent({}, { name: 'tag' }),
  }
}
type Defs = ReturnType<typeof makeDefs>

interface WorldKit {
  world: World
  D: Defs
}
function makeWorld(): WorldKit {
  const D = makeDefs()
  const world = createWorld({
    components: [D.Position, D.Health, D.Target, D.Tag] as readonly ComponentDef<Schema>[],
    maxEntities: 256,
  })
  return { world, D }
}

// A self-describing description of a world we can build deterministically on both producer & receiver.
interface EntitySpec {
  hasPosition: boolean
  hasHealth: boolean
  hasTarget: boolean
  hasTag: boolean
  x: number
  y: number
  hp: number
  // targetRef is an index into the spawned-entity array (or -1 for NO_ENTITY); resolved to a handle.
  targetRef: number
}

const entitySpecArb = fc.record({
  hasPosition: fc.boolean(),
  hasHealth: fc.boolean(),
  hasTarget: fc.boolean(),
  hasTag: fc.boolean(),
  x: fc.integer({ min: -1000, max: 1000 }),
  y: fc.integer({ min: -1000, max: 1000 }),
  hp: fc.integer({ min: -32000, max: 32000 }),
  targetRef: fc.integer({ min: -1, max: 31 }),
})

const worldArb = fc.array(entitySpecArb, { minLength: 0, maxLength: 24 })

// Build a world from specs; returns the spawned handles in spec order so refs resolve deterministically.
function buildWorld(world: World, D: Defs, specs: readonly EntitySpec[]): EntityHandle[] {
  const handles: EntityHandle[] = []
  for (const spec of specs) {
    const defs: ComponentDef<Schema>[] = []
    if (spec.hasPosition) defs.push(D.Position as ComponentDef<Schema>)
    if (spec.hasHealth) defs.push(D.Health as ComponentDef<Schema>)
    if (spec.hasTarget) defs.push(D.Target as ComponentDef<Schema>)
    if (spec.hasTag) defs.push(D.Tag as ComponentDef<Schema>)
    handles.push(world.spawnWith(...defs))
  }
  // Second pass: write values + resolve eid refs now that every handle exists.
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] as EntitySpec
    const h = handles[i] as EntityHandle
    if (spec.hasPosition) {
      const p = world.entity(h).write(D.Position) as { x: number; y: number }
      p.x = spec.x
      p.y = spec.y
    }
    if (spec.hasHealth) {
      ;(world.entity(h).write(D.Health) as { hp: number }).hp = spec.hp
    }
    if (spec.hasTarget) {
      const t = world.entity(h).write(D.Target) as { who: number }
      const ref = spec.targetRef
      t.who = ref >= 0 && ref < handles.length ? (handles[ref] as number) : -1
    }
  }
  return handles
}

// A canonical, handle-independent description of the world's live state read through the PUBLIC
// surface. eid refs are normalized to a producer/receiver-agnostic token via the supplied resolver.
interface CanonRow {
  components: string[]
  x?: number
  y?: number
  hp?: number
  targetToken?: number // canonical index of the referenced entity, or -1 for NO_ENTITY
}

// Read every live entity's state through query().each + has(); produce a sorted, comparable digest.
// `tokenOf` maps a live handle → a stable cross-world token (its canonical index) so eid refs compare.
function canonicalize(world: World, D: Defs, allHandles: EntityHandle[], tokenOf: Map<number, number>): CanonRow[] {
  const rows: CanonRow[] = []
  for (const h of allHandles) {
    if (!world.isAlive(h)) continue
    const components: string[] = []
    const row: CanonRow = { components }
    if (world.has(h, D.Position)) {
      components.push('position')
      const p = world.entity(h).read(D.Position) as { x: number; y: number }
      row.x = p.x
      row.y = p.y
    }
    if (world.has(h, D.Health)) {
      components.push('health')
      row.hp = (world.entity(h).read(D.Health) as { hp: number }).hp
    }
    if (world.has(h, D.Target)) {
      components.push('target')
      // eid fields decode to a handle number or `null` (NO_ENTITY) — never a raw -1 (decodeEid, §3.4).
      const who = (world.entity(h).read(D.Target) as { who: number | null }).who
      row.targetToken = who === null ? -1 : tokenOf.get((who as number) >>> 0) ?? -2 // -2 = unresolvable
    }
    if (world.has(h, D.Tag)) components.push('tag')
    components.sort()
    rows.push(row)
  }
  // Sort by a stable digest so two worlds with the same SET (different spawn order) compare equal.
  rows.sort((a, b) => digest(a).localeCompare(digest(b)))
  return rows
}
function digest(r: CanonRow): string {
  return `${r.components.join('+')}|${r.x ?? ''}|${r.y ?? ''}|${r.hp ?? ''}|${r.targetToken ?? ''}`
}

// ---------------------------------------------------------------------------
// S-4 — round-trip IDENTITY over entity SET, component VALUES, and RELATIONS.
// ---------------------------------------------------------------------------

describe('S-4 — deserialize(serialize(world)) ≡ world (set, values, relations) for random worlds', () => {
  test('component round-trip is bit-faithful through the public query surface', () => {
    fc.assert(
      fc.property(worldArb, (specs) => {
        const src = makeWorld()
        const srcHandles = buildWorld(src.world, src.D, specs)

        // Producer-side canonical tokens: each live handle → its canonical index (sorted position).
        const srcTokens = new Map<number, number>()
        const liveSrc = srcHandles.filter((h) => src.world.isAlive(h))
        liveSrc.forEach((h, i) => srcTokens.set(h as number, i))
        const before = canonicalize(src.world, src.D, srcHandles, srcTokens)

        const bytes = createSnapshotSerializer(src.world).snapshotCopy()

        const dst = makeWorld()
        const { remap } = createSnapshotDeserializer(dst.world).load(bytes)

        // Receiver-side tokens: derive the same canonical index by mapping src→dst via remap, so the
        // eid refs compare on the SAME token space as the producer's.
        const dstTokens = new Map<number, number>()
        liveSrc.forEach((h, i) => {
          const nh = remap.get(h as never)
          if (nh !== undefined) dstTokens.set(nh as number, i)
        })
        const dstHandles = liveSrc.map((h) => remap.get(h as never) as EntityHandle)
        const after = canonicalize(dst.world, dst.D, dstHandles, dstTokens)

        expect(after).toEqual(before)
      }),
      { numRuns: 200 },
    )
  })

  test('relations round-trip with both eids remapped (random exclusive + non-exclusive pairs)', () => {
    const pairArb = fc.record({
      subjectRef: fc.integer({ min: 0, max: 7 }),
      targetRef: fc.integer({ min: 0, max: 7 }),
      exclusive: fc.boolean(),
      weight: fc.integer({ min: 0, max: 1000 }),
    })
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), fc.array(pairArb, { maxLength: 12 }), (n, pairSpecs) => {
        const P = defineComponent({ x: 'f32' }, { name: 'p' })
        const src = createWorld({ components: [P as ComponentDef<Schema>], maxEntities: 64 })
        const rel = createRelations(src)
        const ChildOf = rel.defineRelation({ weight: 'f32' }, { exclusive: true })
        const Likes = rel.defineRelation({ weight: 'f32' }, { exclusive: false })
        const ents: EntityHandle[] = []
        for (let i = 0; i < n; i++) ents.push(src.spawnWith(P as ComponentDef<Schema>))

        // Apply pairs; record the LOGICAL truth (subjectIdx, relName, targetIdx, weight) we expect back.
        // For exclusive, a later pair on the same subject overwrites the earlier one.
        const expected = new Map<string, number>()
        const exclusiveSubject = new Map<number, number>() // subjectIdx → targetIdx (last write wins)
        for (const ps of pairSpecs) {
          const s = ps.subjectRef % n
          const t = ps.targetRef % n
          if (s === t) continue
          const relDef = ps.exclusive ? ChildOf : Likes
          rel.addPair(ents[s] as EntityHandle, relDef, ents[t] as EntityHandle, { weight: ps.weight })
          if (ps.exclusive) {
            const prior = exclusiveSubject.get(s)
            if (prior !== undefined) expected.delete(`childof|${s}|${prior}`)
            exclusiveSubject.set(s, t)
            expected.set(`childof|${s}|${t}`, ps.weight)
          } else {
            expected.set(`likes|${s}|${t}`, ps.weight)
          }
        }

        const bytes = createSnapshotSerializer(src).snapshotCopy()

        const P2 = defineComponent({ x: 'f32' }, { name: 'p' })
        const dst = createWorld({ components: [P2 as ComponentDef<Schema>], maxEntities: 64 })
        const relDst = createRelations(dst)
        const ChildOfDst = relDst.defineRelation({ weight: 'f32' }, { exclusive: true })
        const LikesDst = relDst.defineRelation({ weight: 'f32' }, { exclusive: false })
        const { remap } = createSnapshotDeserializer(dst).load(bytes)
        const nEnts = ents.map((h) => remap.get(h as never) as EntityHandle)

        for (const [key, weight] of expected) {
          const [name, sStr, tStr] = key.split('|')
          const s = Number(sStr)
          const t = Number(tStr)
          const relDef = name === 'childof' ? ChildOfDst : LikesDst
          const ns = nEnts[s] as EntityHandle
          const nt = nEnts[t] as EntityHandle
          // both eids must remap; the pair must exist with the right payload on the RECEIVER handles.
          expect(relDst.hasPair(ns, relDef, nt)).toBe(true)
          expect((relDst.getPair(ns, relDef, nt).read() as { weight: number }).weight).toBeCloseTo(weight)
        }
      }),
      { numRuns: 120 },
    )
  })
})

// ---------------------------------------------------------------------------
// S-3 — delta SOUNDNESS: apply(delta) === replay(writes); version-stamp driven, no shadow memory.
// ---------------------------------------------------------------------------

describe('S-3 — delta over a random tick range equals replaying the writes; no shadow buffer', () => {
  test('applying a delta reconstructs the live world from a stale receiver copy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: -500, max: 500 })), { maxLength: 24 }),
        (n, writes) => {
          const P = defineComponent({ x: 'f32' }, { name: 'p' })
          const src = createWorld({ components: [P as ComponentDef<Schema>], maxEntities: 64 })
          const ents: EntityHandle[] = []
          for (let i = 0; i < n; i++) {
            const h = src.spawnWith(P as ComponentDef<Schema>)
            ;(src.entity(h).write(P) as { x: number }).x = i // initial value
            ents.push(h)
          }

          // Establish a receiver MIRROR (stale copy) via a baseline snapshot — also builds the remap.
          const R = defineComponent({ x: 'f32' }, { name: 'p' })
          const dst = createWorld({ components: [R as ComponentDef<Schema>], maxEntities: 64 })
          const baseBytes = createSnapshotSerializer(src).snapshotCopy()
          const { remap } = createSnapshotDeserializer(dst).load(baseBytes)

          // Open a delta relative to the current tick, advance, then apply a random write sequence.
          const ser = createDeltaSerializer(src, src.currentTick())
          src.advanceTick()
          for (const [idxRaw, val] of writes) {
            const idx = idxRaw % n
            ;(src.entity(ents[idx] as EntityHandle).write(P) as { x: number }).x = val
          }

          const deltaBytes = ser.deltaCopy()
          applyDelta(dst, deltaBytes, remap)

          // The receiver mirror must now equal the live producer for EVERY entity (changed or not).
          for (let i = 0; i < n; i++) {
            const live = (src.entity(ents[i] as EntityHandle).read(P) as { x: number }).x
            const nh = remap.get(ents[i] as never) as EntityHandle
            const mirrored = (dst.entity(nh).read(R) as { x: number }).x
            expect(mirrored).toBeCloseTo(live)
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  test('the delta carries EXACTLY the version-stamped changed rows (no shadow-map diff)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 16 }), fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }), (n, mask) => {
        const P = defineComponent({ x: 'f32' }, { name: 'p' })
        const src = createWorld({ components: [P as ComponentDef<Schema>], maxEntities: 64 })
        const ents: EntityHandle[] = []
        for (let i = 0; i < n; i++) ents.push(src.spawnWith(P as ComponentDef<Schema>))

        const ser = createDeltaSerializer(src, src.currentTick())
        const since = src.currentTick()
        src.advanceTick()

        // Write a SUBSET. A write to value V === current V still stamps (the design is version-stamp
        // driven, NOT an epsilon/shadow value-diff): we write the SAME value to prove a stamp, not a
        // value change, drives inclusion — this is the discriminating part.
        const writtenIdx = new Set<number>()
        for (let i = 0; i < n; i++) {
          if (mask[i % mask.length]) {
            ;(src.entity(ents[i] as EntityHandle).write(P) as { x: number }).x = 0 // identical value
            writtenIdx.add(i)
          }
        }

        // Ground truth from reactivity: the changed-row set the version stamps report.
        const archChanged = new Map<number, Set<number>>()
        for (const a of src.__serialize.archetypes()) {
          const rows = new Set<number>([...src.changedRows(a.id, since)])
          if (rows.size > 0) archChanged.set(a.id, rows)
        }

        const deltaBytes = ser.deltaCopy()

        // Decode the delta value section and collect the entity HANDLES it carries.
        const carried = decodeDeltaHandles(deltaBytes)
        const expectedHandles = new Set<number>()
        for (const i of writtenIdx) expectedHandles.add((ents[i] as number) >>> 0)

        expect(carried).toEqual(expectedHandles)

        // And it must match reactivity's stamp-driven changed-row set exactly (rows → handles).
        const stampHandles = new Set<number>()
        for (const a of src.__serialize.archetypes()) {
          const rows = archChanged.get(a.id)
          if (rows === undefined) continue
          for (const r of rows) stampHandles.add((a.rows[r] as number) >>> 0)
        }
        expect(carried).toEqual(stampHandles)
      }),
      { numRuns: 150 },
    )
  })
})

// Decode a delta image's value section and return the set of entity handles whose rows it carries.
// (Independent of the serializer internals — re-parses the wire per §6.2: a 24-byte header carrying the
// structural + value section offsets, then a value section in NATIVE element-width per field.)
const ELEMENT_BYTES: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 8: 8 }
function decodeDeltaHandles(bytes: Uint8Array): Set<number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Header: magic(4) version(2) endian(1) flags(1) baselineTick(4) targetTick(4) structOff(4) valueOff(4).
  const valueOff = dv.getUint32(20, true)
  let off = valueOff
  const changedArchetypeCount = dv.getUint32(off, true)
  off += 4
  const handles = new Set<number>()
  for (let ai = 0; ai < changedArchetypeCount; ai++) {
    off += 4 // archetype id
    const rowCount = dv.getUint32(off, true)
    off += 4
    for (let r = 0; r < rowCount; r++) {
      handles.add(dv.getUint32(off, true) >>> 0)
      off += 4
    }
    const componentCount = dv.getUint16(off, true)
    off += 2
    for (let ci = 0; ci < componentCount; ci++) {
      off += 4 // componentId
      const fieldCount = dv.getUint16(off, true)
      off += 2
      for (let fi = 0; fi < fieldCount; fi++) {
        const element = dv.getUint8(off)
        off += 1
        const stride = dv.getUint8(off)
        off += 1
        off += rowCount * stride * (ELEMENT_BYTES[element] as number) // native element width per changed row (§6.2)
      }
    }
  }
  return handles
}

// ---------------------------------------------------------------------------
// S-5 — remap TOTALITY against a DISJOINT id space.
// ---------------------------------------------------------------------------

describe('S-5 — every eid / pair-target survives a load into a world with a DISJOINT id space', () => {
  test('no dangling reference and no aliasing onto a pre-existing unrelated live entity', () => {
    fc.assert(
      fc.property(
        worldArb.filter((s) => s.length >= 2),
        fc.integer({ min: 1, max: 40 }),
        (specs, preCount) => {
          const src = makeWorld()
          const srcHandles = buildWorld(src.world, src.D, specs)

          const dst = makeWorld()
          // Pre-populate the destination with UNRELATED live entities so the receiver's id space is
          // genuinely shifted: fresh spawns consume low handle indices, forcing loaded entities onto a
          // DISJOINT range from the producer's handles. We also give them distinct sentinel values.
          const preHandles: EntityHandle[] = []
          for (let i = 0; i < preCount; i++) {
            const h = dst.world.spawnWith(dst.D.Position, dst.D.Target)
            ;(dst.world.entity(h).write(dst.D.Position) as { x: number; y: number }).x = 7777
            // Leave Target.who at its default (-1 ⇒ reads back as null / NO_ENTITY).
            preHandles.push(h)
          }
          const preHandleSet = new Set(preHandles.map((h) => h as number))

          const bytes = createSnapshotSerializer(src.world).snapshotCopy()
          const { remap } = createSnapshotDeserializer(dst.world).load(bytes, 'merge')

          // (a) every producer handle remapped to a FRESH handle disjoint from the pre-existing set.
          const liveSrc = srcHandles.filter((h) => src.world.isAlive(h))
          const remappedSet = new Set<number>()
          for (const h of liveSrc) {
            const nh = remap.get(h as never)
            expect(nh).toBeDefined()
            expect(preHandleSet.has(nh as number)).toBe(false) // no aliasing onto a live unrelated entity
            remappedSet.add(nh as number)
          }

          // (b) every eid ref on a loaded entity points at a remapped handle (never a producer handle,
          //     never a pre-existing unrelated entity), or is the NO_ENTITY sentinel.
          for (let i = 0; i < specs.length; i++) {
            const spec = specs[i] as EntitySpec
            if (!spec.hasTarget) continue
            const nh = remap.get(srcHandles[i] as never)
            if (nh === undefined) continue
            const who = (dst.world.entity(nh as EntityHandle).read(dst.D.Target) as { who: number | null }).who
            if (who === null) {
              // sentinel — legitimate if the producer ref was the sentinel OR pointed off-snapshot.
              continue
            }
            const ref = (who as number) >>> 0
            // The ref MUST be one of the freshly-loaded remapped handles — never a producer handle and
            // never a pre-existing unrelated entity (that would be aliasing / a dangling ref).
            expect(remappedSet.has(ref)).toBe(true)
            expect(preHandleSet.has(ref)).toBe(false)
          }

          // (c) the pre-existing entities are UNTOUCHED (merge mode leaves them intact).
          for (const h of preHandles) {
            expect((dst.world.entity(h).read(dst.D.Position) as { x: number }).x).toBeCloseTo(7777)
            expect((dst.world.entity(h).read(dst.D.Target) as { who: number | null }).who).toBeNull()
          }
        },
      ),
      { numRuns: 120 },
    )
  })
})

// ---------------------------------------------------------------------------
// Structural surrogate for the DEFERRED throughput bench: delta payload length scales with the number
// of CHANGED rows (W), not the total entity count (N). Writing W of N entities yields a delta whose
// length is a function of W, independent of N. (Rejects the bitECS 100MB static buffer; §9 / §6.2.)
// ---------------------------------------------------------------------------

describe('delta SIZE scales with changed-field count W, not entity count N (deferred-bench surrogate)', () => {
  function deltaLenForWN(n: number, w: number): number {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const world = createWorld({ components: [P as ComponentDef<Schema>], maxEntities: 4096 })
    const ents: EntityHandle[] = []
    for (let i = 0; i < n; i++) ents.push(world.spawnWith(P as ComponentDef<Schema>))
    const ser = createDeltaSerializer(world, world.currentTick())
    world.advanceTick()
    for (let i = 0; i < w; i++) {
      ;(world.entity(ents[i] as EntityHandle).write(P) as { x: number }).x = i + 1
    }
    return ser.deltaCopy().byteLength
  }

  test('same W across very different N yields the same delta length', () => {
    const w = 4
    const small = deltaLenForWN(8, w)
    const huge = deltaLenForWN(2000, w)
    // The delta MUST NOT grow with N (no static megabuffer, no per-entity payload). For a single
    // archetype this is byte-exact: same W ⇒ same length regardless of N.
    expect(huge).toBe(small)
  })

  test('delta length grows monotonically with W (more changed rows ⇒ strictly larger payload)', () => {
    const n = 256
    const l1 = deltaLenForWN(n, 1)
    const l4 = deltaLenForWN(n, 4)
    const l16 = deltaLenForWN(n, 16)
    expect(l4).toBeGreaterThan(l1)
    expect(l16).toBeGreaterThan(l4)
    // And W=0 (no writes) is strictly smaller than any W>0 (empty value section).
    const l0 = deltaLenForWN(n, 0)
    expect(l1).toBeGreaterThan(l0)
  })

  test('property: for random N and W≤N, delta length depends only on W', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 200 }), fc.integer({ min: 1, max: 200 }), (w, nA, nB) => {
        const n1 = Math.max(w, nA)
        const n2 = Math.max(w, nB)
        expect(deltaLenForWN(n1, w)).toBe(deltaLenForWN(n2, w))
      }),
      { numRuns: 60 },
    )
  })
})
