// M12 cross-package integration fuzz — the milestone headline (build-plan.md M12; public-api.md §11).
//
// A single random op-sequence is driven THROUGH THE ecsia UMBRELLA API only (no reaching into a
// sub-package), so this test is also the proof that the umbrella's re-exports compose into a working
// whole. The model is a self-checking oracle: alongside the real world we maintain a plain-JS shadow of
// the intended state, and after every applied op we assert the live world still satisfies ALL of:
//
//   I*   (entity/handle integrity) — every handle the model believes alive is `isAlive`; every despawned
//        handle is dead; a handle is never simultaneously alive-and-dead; `entity(h)` resolves a live ref.
//   BM-2 (bitmask coherence)       — `world.has(h, C)` agrees with the model's component set for the
//        entity AND with membership in `world.query(has(C))` (the per-archetype iteration path) — the
//        point-test bitmask and the archetype signature can never disagree.
//   P1/P4 (relation presence / no-dangling) — `hasPair`/`subjectsOf`/`targetsOf` agree with the model;
//        despawning a subject OR target leaves NO live pair referencing the dead entity (cascade).
//   R-2  (reactivity agreement)    — the `.changed` FILTER (write-log driven) and the `changedSince`
//        PREDICATE (changeVersion driven) report the SAME set of entities written this frame, via two
//        disjoint mechanisms reached entirely through the umbrella.
//   SER  (serialize↔deserialize identity) — at checkpoints, snapshotCopy → load into a fresh world
//        reproduces the live component values, membership, and relations bit-faithfully (eids remapped).
//
// Everything below imports from 'ecsia' — that is the integration surface under test.

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  createWorld,
  defineComponent,
  defineTag,
  read,
  write,
  has,
  createRelations,
  createSnapshotSerializer,
  createSnapshotDeserializer,
} from 'ecsia'
import type { ComponentDef, EntityHandle, RelationDef, Schema, World } from 'ecsia'

// ---------------------------------------------------------------------------
// Fixed component/relation universe. Built fresh per world so a producer and a deserialize-receiver
// share a structurally-identical schema (schemaHash matches across the snapshot boundary).
// ---------------------------------------------------------------------------
function makeDefs() {
  return {
    Position: defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' }),
    Velocity: defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' }),
    Health: defineComponent({ hp: 'i32' }, { name: 'health' }),
    Target: defineComponent({ who: 'eid' }, { name: 'target' }),
    Frozen: defineTag('frozen'),
  }
}
type Defs = ReturnType<typeof makeDefs>
const COMP_NAMES = ['Position', 'Velocity', 'Health', 'Target', 'Frozen'] as const
type CompName = (typeof COMP_NAMES)[number]

interface Kit {
  world: World
  D: Defs
  rel: ReturnType<typeof createRelations>
  ChildOf: RelationDef<void> // exclusive (single parent)
  Likes: RelationDef<{ w: 'f32' }> // non-exclusive payload
}

function makeKit(maxEntities = 256): Kit {
  const D = makeDefs()
  const world = createWorld({
    components: Object.values(D) as readonly ComponentDef<Schema>[],
    maxEntities,
  })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true })
  const Likes = rel.defineRelation({ w: 'f32' }, { exclusive: false })
  return { world, D, rel, ChildOf, Likes }
}

function defByName(D: Defs, name: CompName): ComponentDef<Schema> {
  return D[name] as unknown as ComponentDef<Schema>
}

// ---------------------------------------------------------------------------
// Shadow model: the intended state, maintained independently of the world so the assertions are real
// (not tautologies that re-read the world). Keyed by the entity's *creation index* (a stable token that
// survives across the serialize boundary, unlike the raw handle).
// ---------------------------------------------------------------------------
interface ModelEntity {
  alive: boolean
  comps: Set<CompName>
  pos: { x: number; y: number }
  vel: { dx: number; dy: number }
  hp: number
  /** Position fields written THIS FRAME (for the R-2 changed agreement). */
  changedThisFrame: boolean
}
interface ModelPair {
  rel: 'ChildOf' | 'Likes'
  subject: number // creation index
  target: number // creation index
  w: number
}

class Model {
  ents: ModelEntity[] = []
  pairs: ModelPair[] = []

  spawn(comps: CompName[]): number {
    const idx = this.ents.length
    this.ents.push({
      alive: true,
      comps: new Set(comps),
      pos: { x: 0, y: 0 },
      vel: { dx: 0, dy: 0 },
      hp: 0,
      changedThisFrame: false,
    })
    return idx
  }
  liveIndices(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.ents.length; i++) if (this.ents[i]!.alive) out.push(i)
    return out
  }
  despawn(idx: number): void {
    const e = this.ents[idx]
    if (e === undefined || !e.alive) return
    e.alive = false
    // Cascade: drop every pair where this entity is subject OR target (P4 no-dangling).
    this.pairs = this.pairs.filter((p) => p.subject !== idx && p.target !== idx)
  }
  addPairExclusiveAware(p: ModelPair): void {
    if (p.rel === 'ChildOf') {
      // Exclusive: at most one target per (subject, relation) — last write wins.
      this.pairs = this.pairs.filter((q) => !(q.rel === 'ChildOf' && q.subject === p.subject))
    } else {
      // Non-exclusive: a (subject,target) pair updates its payload in place.
      this.pairs = this.pairs.filter(
        (q) => !(q.rel === 'Likes' && q.subject === p.subject && q.target === p.target),
      )
    }
    this.pairs.push(p)
  }
  removePair(rel: 'ChildOf' | 'Likes', subject: number, target: number): void {
    this.pairs = this.pairs.filter((q) => !(q.rel === rel && q.subject === subject && q.target === target))
  }
}

// ---------------------------------------------------------------------------
// The op alphabet. Each op is a self-contained command resolved against current live entities at apply
// time (indices are taken modulo the live set, so a generated op is never wasted).
// ---------------------------------------------------------------------------
type Op =
  | { t: 'spawn'; comps: readonly boolean[] }
  | { t: 'despawn'; e: number }
  | { t: 'add'; e: number; c: number }
  | { t: 'remove'; e: number; c: number }
  | { t: 'writePos'; e: number; x: number; y: number }
  | { t: 'addPair'; s: number; tt: number; excl: boolean; w: number }
  | { t: 'removePair'; s: number; tt: number; excl: boolean }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant('spawn' as const),
    comps: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
  }),
  fc.record({ t: fc.constant('despawn' as const), e: fc.nat(63) }),
  fc.record({ t: fc.constant('add' as const), e: fc.nat(63), c: fc.nat(4) }),
  fc.record({ t: fc.constant('remove' as const), e: fc.nat(63), c: fc.nat(4) }),
  fc.record({
    t: fc.constant('writePos' as const),
    e: fc.nat(63),
    x: fc.integer({ min: -500, max: 500 }),
    y: fc.integer({ min: -500, max: 500 }),
  }),
  fc.record({
    t: fc.constant('addPair' as const),
    s: fc.nat(63),
    tt: fc.nat(63),
    excl: fc.boolean(),
    w: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({ t: fc.constant('removePair' as const), s: fc.nat(63), tt: fc.nat(63), excl: fc.boolean() }),
)

// ---------------------------------------------------------------------------
// Invariant checks (run after every op).
// ---------------------------------------------------------------------------
function checkIntegrityAndBitmask(kit: Kit, model: Model, handles: (EntityHandle | undefined)[]): void {
  const { world, D } = kit
  for (let i = 0; i < model.ents.length; i++) {
    const e = model.ents[i]!
    const h = handles[i]
    if (h === undefined) continue
    // I*: liveness agrees with the model and is never ambiguous.
    expect(world.isAlive(h)).toBe(e.alive)
    if (!e.alive) continue
    // entity(h) resolves a live ref (I*).
    expect(world.entity(h).__handle >>> 0).toBe((h as number) >>> 0)
    // BM-2: the point-test bitmask agrees with the model's component set.
    for (const name of COMP_NAMES) {
      expect(world.has(h, defByName(D, name))).toBe(e.comps.has(name))
    }
  }
  // BM-2 (second leg): for each component, the archetype-iteration query set === the bitmask set ===
  // the model set. This is the one that catches a bitmask/signature divergence.
  for (const name of COMP_NAMES) {
    const def = defByName(D, name)
    const want = new Set<number>()
    for (let i = 0; i < model.ents.length; i++) {
      const e = model.ents[i]!
      const h = handles[i]
      if (h !== undefined && e.alive && e.comps.has(name)) want.add((h as number) >>> 0)
    }
    const gotQuery = new Set<number>()
    world.query(has(def)).each((el) => gotQuery.add(((el as { handle: EntityHandle }).handle as number) >>> 0))
    expect([...gotQuery].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b))
  }
}

function checkRelations(kit: Kit, model: Model, handles: (EntityHandle | undefined)[]): void {
  const { rel, ChildOf, Likes } = kit
  const relDef = (name: 'ChildOf' | 'Likes'): RelationDef<Schema | void> =>
    (name === 'ChildOf' ? ChildOf : Likes) as RelationDef<Schema | void>
  const h = (idx: number): EntityHandle => handles[idx] as EntityHandle

  // P1: every model pair is present in the world; P4: no pair references a dead entity.
  for (const p of model.pairs) {
    expect(model.ents[p.subject]!.alive).toBe(true)
    expect(model.ents[p.target]!.alive).toBe(true)
    expect(rel.hasPair(h(p.subject), relDef(p.rel), h(p.target))).toBe(true)
  }
  // No-dangling, the contrapositive: nothing in the world points at (or from) a dead entity. We probe
  // subjectsOf over a dead target — it must yield nothing.
  for (let i = 0; i < model.ents.length; i++) {
    if (model.ents[i]!.alive || handles[i] === undefined) continue
    expect([...rel.subjectsOf(ChildOf as RelationDef<Schema | void>, h(i))]).toEqual([])
    expect([...rel.subjectsOf(Likes as RelationDef<Schema | void>, h(i))]).toEqual([])
  }
  // subjectsOf agreement for live targets (relation presence, P1).
  const liveTargets = new Set(model.pairs.map((p) => p.target))
  for (const tIdx of liveTargets) {
    for (const name of ['ChildOf', 'Likes'] as const) {
      const wantSubjects = new Set(
        model.pairs.filter((p) => p.rel === name && p.target === tIdx).map((p) => (h(p.subject) as number) >>> 0),
      )
      const gotSubjects = new Set<number>()
      for (const s of rel.subjectsOf(relDef(name), h(tIdx))) gotSubjects.add((s as number) >>> 0)
      expect([...gotSubjects].sort((a, b) => a - b)).toEqual([...wantSubjects].sort((a, b) => a - b))
    }
  }
}

// SER: snapshot the producer, deserialize into a fresh receiver, and assert the receiver's state (read
// purely through the umbrella surface) matches the producer's, with eids/relations remapped by name.
function checkSerializeRoundTrip(kit: Kit, model: Model, handles: (EntityHandle | undefined)[]): void {
  const bytes = createSnapshotSerializer(kit.world).snapshotCopy()

  const dst = makeKit()
  const { remap } = createSnapshotDeserializer(dst.world).load(bytes)

  // Map each producer creation-index → receiver handle (only for live entities).
  const dstHandle: (EntityHandle | undefined)[] = handles.map((h) =>
    h !== undefined ? (remap.get(h as never) as EntityHandle | undefined) : undefined,
  )

  // Component membership + values survive the round-trip.
  for (let i = 0; i < model.ents.length; i++) {
    const e = model.ents[i]!
    if (!e.alive) continue
    const nh = dstHandle[i]
    expect(nh).toBeDefined()
    if (nh === undefined) continue
    expect(dst.world.isAlive(nh)).toBe(true)
    for (const name of COMP_NAMES) {
      expect(dst.world.has(nh, defByName(dst.D, name))).toBe(e.comps.has(name))
    }
    if (e.comps.has('Position')) {
      const p = dst.world.entity(nh).read(dst.D.Position) as { x: number; y: number }
      expect(p.x).toBeCloseTo(e.pos.x, 3)
      expect(p.y).toBeCloseTo(e.pos.y, 3)
    }
  }
  // Relations survive (subject + target both remapped).
  for (const p of model.pairs) {
    const ns = dstHandle[p.subject]
    const nt = dstHandle[p.target]
    expect(ns).toBeDefined()
    expect(nt).toBeDefined()
    if (ns === undefined || nt === undefined) continue
    const relDef = (p.rel === 'ChildOf' ? dst.ChildOf : dst.Likes) as RelationDef<Schema | void>
    expect(dst.rel.hasPair(ns, relDef, nt)).toBe(true)
  }
}

// R-2: across one frame of writes, the .changed FILTER and the changedSince PREDICATE name the SAME set.
function checkReactivityAgreement(): void {
  const kit = makeKit()
  const { world, D } = kit
  const changedQ = world.query(read(D.Position)).changed()
  const handles: EntityHandle[] = []
  for (let i = 0; i < 12; i++) handles.push(world.spawnWith(D.Position))

  world.frameReset()
  const sinceTick = world.currentTick() - 1
  const writtenIdx = new Set<number>()
  for (let i = 0; i < handles.length; i++) {
    if (i % 3 === 0) continue // leave a third untouched
    ;(world.entity(handles[i]!).write(D.Position) as { x: number }).x = i + 1
    writtenIdx.add(world.decodeHandle(handles[i]!).index as number)
  }

  const filterSet = new Set<number>()
  changedQ.eachChanged((el) => filterSet.add(world.decodeHandle(el.handle).index as number))
  const predicateSet = new Set<number>()
  for (const h of handles) if (world.changedSince(h, sinceTick)) predicateSet.add(world.decodeHandle(h).index as number)

  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  expect(sorted(filterSet)).toEqual(sorted(writtenIdx))
  expect(sorted(predicateSet)).toEqual(sorted(filterSet))
}

// ---------------------------------------------------------------------------
// The driver: apply one Op against (world, model) keeping them in lockstep.
// ---------------------------------------------------------------------------
function applyOp(kit: Kit, model: Model, handles: (EntityHandle | undefined)[], op: Op): void {
  const { world, D, rel, ChildOf, Likes } = kit
  const live = model.liveIndices()
  const relDef = (excl: boolean): RelationDef<Schema | void> =>
    (excl ? ChildOf : Likes) as RelationDef<Schema | void>

  switch (op.t) {
    case 'spawn': {
      const comps: CompName[] = []
      for (let c = 0; c < 5; c++) if (op.comps[c]) comps.push(COMP_NAMES[c]!)
      const defs = comps.map((n) => defByName(D, n))
      const h = defs.length > 0 ? world.spawnWith(...defs) : world.spawn()
      const idx = model.spawn(comps)
      handles[idx] = h
      break
    }
    case 'despawn': {
      if (live.length === 0) break
      const idx = live[op.e % live.length]!
      world.despawn(handles[idx] as EntityHandle)
      model.despawn(idx)
      break
    }
    case 'add': {
      if (live.length === 0) break
      const idx = live[op.e % live.length]!
      const name = COMP_NAMES[op.c]!
      if (!model.ents[idx]!.comps.has(name)) {
        world.add(handles[idx] as EntityHandle, defByName(D, name))
        model.ents[idx]!.comps.add(name)
        // A freshly-added column is zero-initialized; the model must agree (a prior remove discarded
        // any earlier value, so re-adding does NOT resurrect it).
        if (name === 'Position') model.ents[idx]!.pos = { x: 0, y: 0 }
      }
      break
    }
    case 'remove': {
      if (live.length === 0) break
      const idx = live[op.e % live.length]!
      const name = COMP_NAMES[op.c]!
      if (model.ents[idx]!.comps.has(name)) {
        world.remove(handles[idx] as EntityHandle, defByName(D, name))
        model.ents[idx]!.comps.delete(name)
      }
      break
    }
    case 'writePos': {
      if (live.length === 0) break
      const idx = live[op.e % live.length]!
      if (!model.ents[idx]!.comps.has('Position')) break
      const p = world.entity(handles[idx] as EntityHandle).write(D.Position) as { x: number; y: number }
      p.x = op.x
      p.y = op.y
      model.ents[idx]!.pos = { x: op.x, y: op.y }
      break
    }
    case 'addPair': {
      if (live.length < 2) break
      const s = live[op.s % live.length]!
      const t = live[op.tt % live.length]!
      if (s === t) break
      rel.addPair(handles[s] as EntityHandle, relDef(op.excl), handles[t] as EntityHandle, op.excl ? undefined : { w: op.w })
      model.addPairExclusiveAware({ rel: op.excl ? 'ChildOf' : 'Likes', subject: s, target: t, w: op.w })
      break
    }
    case 'removePair': {
      if (live.length < 2) break
      const s = live[op.s % live.length]!
      const t = live[op.tt % live.length]!
      if (s === t) break
      rel.removePair(handles[s] as EntityHandle, relDef(op.excl), handles[t] as EntityHandle)
      model.removePair(op.excl ? 'ChildOf' : 'Likes', s, t)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// The properties.
// ---------------------------------------------------------------------------
// PINNED SEED (public-api.md §11 / review): the fuzz must gate the API freeze deterministically — a
// suite that passes-or-fails on a random fast-check seed cannot. With the relations P4 aliasing bug
// fixed (subjectsOf/hasPair/getPair/targetsOf guard endpoint liveness before stripping the generation),
// this seed explores the generation-recycling op-shapes that previously surfaced the bug ~1-in-6 runs,
// now GREEN every run. Keep numRuns high; do NOT lower it to mask a flake.
const FUZZ_SEED = 0x12c0ffee

describe('M12 — cross-package integration fuzz through the ecsia umbrella', () => {
  test('random op sequences preserve entity/bitmask/relation invariants at every step (I*, BM-2, P1/P4)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const kit = makeKit()
        const model = new Model()
        const handles: (EntityHandle | undefined)[] = []
        for (const op of ops) {
          applyOp(kit, model, handles, op)
          checkIntegrityAndBitmask(kit, model, handles)
          checkRelations(kit, model, handles)
        }
      }),
      { numRuns: 120, seed: FUZZ_SEED },
    )
  })

  test('serialize→deserialize is an identity over the fuzzed end state (component values + relations, eids remapped)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const kit = makeKit()
        const model = new Model()
        const handles: (EntityHandle | undefined)[] = []
        for (const op of ops) applyOp(kit, model, handles, op)
        // The whole world (alive entities + their components + relations) round-trips bit-faithfully.
        checkSerializeRoundTrip(kit, model, handles)
      }),
      { numRuns: 80, seed: FUZZ_SEED },
    )
  })

  test('the .changed FILTER and changedSince PREDICATE agree on the written set (R-2), reached via the umbrella', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        checkReactivityAgreement()
      }),
      { numRuns: 25, seed: FUZZ_SEED },
    )
  })

  test('a system run through write(C) drives the Changed filter end-to-end (write log ↔ query.changed)', () => {
    // A miniature scheduler-free "system": iterate a write query, mutate, then assert the changed filter
    // names exactly the rows the system touched — the full write-tracking loop across core's query +
    // reactivity reached only through 'ecsia'.
    const kit = makeKit()
    const { world, D } = kit
    const handles: EntityHandle[] = []
    for (let i = 0; i < 10; i++) handles.push(world.spawnWith(D.Position, D.Velocity))
    for (let i = 0; i < handles.length; i++) {
      ;(world.entity(handles[i]!).write(D.Velocity) as { dx: number }).dx = i % 2 === 0 ? 1 : 0
    }

    // The .changed flavor reads from a LogPointer fixed at attach time — create it BEFORE the writes so
    // it observes this frame's writes (reactivity.md §5.1).
    const changedQ = world.query(read(D.Position)).changed()
    world.frameReset()
    const moveQ = world.query(read(D.Velocity), write(D.Position))
    moveQ.each((el) => {
      const v = el as unknown as { velocity: { dx: number }; position: { x: number } }
      if (v.velocity.dx !== 0) v.position.x += v.velocity.dx
    })

    const changed = new Set<number>()
    changedQ.eachChanged((el) => changed.add(world.decodeHandle(el.handle).index as number))
    const want = new Set<number>()
    for (let i = 0; i < handles.length; i++) {
      if (i % 2 === 0) want.add(world.decodeHandle(handles[i]!).index as number)
    }
    expect([...changed].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b))
  })
})
