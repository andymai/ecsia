// M3 storage kernel suite (archetype-storage.md §11 invariants + bitmask §6). Exercises signature
// canonicalization/interning, the lazy edge graph, swap-pop removal, migration cost/correctness,
// spawnWith single-migration, multi-id atomic migration, the per-entity bitmask (serial-only +
// coherence), and the cold-archetype fragmentation cap.

import { describe, expect, test } from 'vitest'
import {
  canonicalize,
  createWorld,
  defineComponent,
  defineTag,
  sigEquals,
  sigHas,
  sigHash,
  sigWithAdded,
  sigWithRemoved,
  buildSigWords,
  signatureMatches,
} from '@ecsia/core'
import type { ComponentId, Signature } from '@ecsia/core'

const sig = (ids: number[]): Signature => canonicalize(ids as unknown as ComponentId[])

describe('Signature (archetype-storage.md §3.2, §3.8, §5.2 — SIG-1)', () => {
  test('canonicalize sorts ascending and de-dups (SIG-1)', () => {
    const s = sig([5, 1, 3, 1, 5, 2])
    expect([...s]).toEqual([1, 2, 3, 5])
  })

  test('structurally-equal signatures hash + compare equal regardless of order', () => {
    const a = sig([3, 1, 2])
    const b = sig([2, 3, 1])
    expect(sigEquals(a, b)).toBe(true)
    expect(sigHash(a)).toBe(sigHash(b))
  })

  test('sigWithAdded / sigWithRemoved keep the sorted invariant and are idempotent', () => {
    const s = sig([2, 4, 6])
    expect([...sigWithAdded(s, 3 as ComponentId)]).toEqual([2, 3, 4, 6])
    expect([...sigWithAdded(s, 8 as ComponentId)]).toEqual([2, 4, 6, 8])
    expect(sigWithAdded(s, 4 as ComponentId)).toBe(s) // idempotent add of a present id
    expect([...sigWithRemoved(s, 4 as ComponentId)]).toEqual([2, 6])
    expect(sigWithRemoved(s, 5 as ComponentId)).toBe(s) // remove of an absent id is a no-op
  })

  test('sigHas binary search + signatureMatches AND/NOT/OR', () => {
    const s = sig([1, 4, 9, 16])
    expect(sigHas(s, 9)).toBe(true)
    expect(sigHas(s, 8)).toBe(false)
    const words = buildSigWords(s, 1)
    const term = (c: number) => ({ wordIndex: c >>> 5, mask: 1 << (c & 31) })
    expect(signatureMatches(words, [term(4)], [term(2)], [])).toBe(true)
    expect(signatureMatches(words, [term(4), term(2)], [], [])).toBe(false) // 2 absent
    expect(signatureMatches(words, [], [term(9)], [])).toBe(false) // NOT 9 fails
    expect(signatureMatches(words, [], [], [term(2)])).toBe(false) // OR set unmet
  })
})

describe('Archetype interning + edge graph (AR-1, EDGE-1)', () => {
  test('AR-1: spawnWith two component orders interns the SAME archetype object', () => {
    const A = defineComponent({ x: 'f32' })
    const B = defineComponent({ y: 'f32' })
    const w = createWorld({ components: [A, B] })
    const store = (w as unknown as { __storageForTest?: never }) // not exposed; assert via record
    void store
    const e1 = w.spawnWith(A, B)
    const e2 = w.spawnWith(B, A)
    // Both land in the {A,B} archetype — same archetypeId in the record.
    const loc1 = w.entity(e1)
    const loc2 = w.entity(e2)
    expect((loc1 as unknown as { __archetypeId: number }).__archetypeId).toBe(
      (loc2 as unknown as { __archetypeId: number }).__archetypeId,
    )
  })

  test('add then remove round-trips back to the original archetype (edge reverse cached)', () => {
    const A = defineComponent({ x: 'f32' })
    const w = createWorld({ components: [A] })
    const e = w.spawn()
    const emptyArch = (w.entity(e) as unknown as { __archetypeId: number }).__archetypeId
    w.add(e, A)
    const withA = (w.entity(e) as unknown as { __archetypeId: number }).__archetypeId
    expect(withA).not.toBe(emptyArch)
    w.remove(e, A)
    expect((w.entity(e) as unknown as { __archetypeId: number }).__archetypeId).toBe(emptyArch)
  })
})

describe('migration correctness (MIG-1, ROW-1) + spawnWith', () => {
  test('spawnWith is a SINGLE migration: values written then read back', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' })
    const w = createWorld({ components: [Position, Velocity] })
    const e = w.spawnWith(Position, Velocity)
    const ref = w.entity(e)
    const p = ref.write(Position) as { x: number; y: number }
    p.x = 3
    p.y = 4
    const v = ref.write(Velocity) as { dx: number; dy: number }
    v.dx = -1
    expect((w.entity(e).read(Position) as { x: number }).x).toBe(3)
    expect((w.entity(e).read(Velocity) as { dx: number }).dx).toBe(-1)
  })

  test('column growth past the 1024 reserve keeps per-field views correctly mapped (GROW-1)', () => {
    // INITIAL_ROWS (64) × GROWTH_RESERVE_FACTOR (16) = 1024 reserved rows; spawning the 1025th entity
    // exhausts the resizable reservation and forces the fallback grow (column re-alloc + view rebind).
    // The rebind must re-point ONLY the grown field's view — a whole-instance rebind aliases the
    // second f32 field onto the first field's backing, so every entity reads dy's data for dx.
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const w = createWorld({ components: [Velocity] })
    const n = 1025
    const handles: number[] = []
    for (let i = 0; i < n; i++) {
      const h = w.spawnWith(Velocity)
      const v = w.entity(h).write(Velocity) as { dx: number; dy: number }
      v.dx = 1
      v.dy = 0.5
      handles.push(h as unknown as number)
    }
    for (let i = 0; i < n; i++) {
      const v = w.entity(handles[i] as never).read(Velocity) as { dx: number; dy: number }
      expect(v.dx).toBe(1) // NOT 0.5 (the dy column aliased over dx pre-fix)
      expect(v.dy).toBe(0.5)
    }
  })

  test('adding a component PRESERVES existing column values (K-shared copy)', () => {
    const Position = defineComponent({ x: 'f32' })
    const Tag = defineComponent({ n: 'i32' })
    const w = createWorld({ components: [Position, Tag] })
    const e = w.spawnWith(Position)
    ;(w.entity(e).write(Position) as { x: number }).x = 7
    w.add(e, Tag)
    // Position's value survived the migration into the {Position, Tag} archetype.
    expect((w.entity(e).read(Position) as { x: number }).x).toBe(7)
  })

  test('swap-pop keeps sibling rows resolvable after a middle entity migrates (ROW-1/MIG-1)', () => {
    const P = defineComponent({ x: 'f32' })
    const Q = defineComponent({ q: 'i32' })
    const w = createWorld({ components: [P, Q] })
    const a = w.spawnWith(P)
    const b = w.spawnWith(P)
    const c = w.spawnWith(P)
    ;(w.entity(a).write(P) as { x: number }).x = 10
    ;(w.entity(b).write(P) as { x: number }).x = 20
    ;(w.entity(c).write(P) as { x: number }).x = 30
    // Migrate the MIDDLE entity (b) out → c shuffle-pops into b's old row in {P}.
    w.add(b, Q)
    expect((w.entity(a).read(P) as { x: number }).x).toBe(10)
    expect((w.entity(b).read(P) as { x: number }).x).toBe(20) // moved to {P,Q}, value intact
    expect((w.entity(c).read(P) as { x: number }).x).toBe(30) // shuffled, still correct
  })

  test('removing a component drops it; the rest survive', () => {
    const P = defineComponent({ x: 'f32' })
    const Q = defineComponent({ q: 'i32' })
    const w = createWorld({ components: [P, Q] })
    const e = w.spawnWith(P, Q)
    ;(w.entity(e).write(P) as { x: number }).x = 5
    w.remove(e, Q)
    expect((w.entity(e).read(P) as { x: number }).x).toBe(5)
    expect(() => w.entity(e).read(Q)).toThrow() // no longer held
  })

  test('idempotent add/remove is a no-op (no spurious migration)', () => {
    const P = defineComponent({ x: 'f32' })
    const w = createWorld({ components: [P] })
    const e = w.spawnWith(P)
    const arch1 = (w.entity(e) as unknown as { __archetypeId: number }).__archetypeId
    w.add(e, P) // already held
    expect((w.entity(e) as unknown as { __archetypeId: number }).__archetypeId).toBe(arch1)
    const P2 = defineComponent({ x: 'f32' })
    const Q = defineComponent({ q: 'i32' })
    const w2 = createWorld({ components: [P2, Q] })
    const e2 = w2.spawnWith(P2)
    const arch2 = (w2.entity(e2) as unknown as { __archetypeId: number }).__archetypeId
    w2.remove(e2, Q) // not held
    expect((w2.entity(e2) as unknown as { __archetypeId: number }).__archetypeId).toBe(arch2)
  })
})

describe('tag components contribute no ColumnSet (§3.4)', () => {
  test('an entity holding only a tag is in a non-empty archetype with no readable columns', () => {
    const Alive = defineTag('Alive')
    const w = createWorld({ components: [Alive] })
    const e = w.spawn()
    const emptyArch = (w.entity(e) as unknown as { __archetypeId: number }).__archetypeId
    w.add(e, Alive)
    const tagArch = (w.entity(e) as unknown as { __archetypeId: number }).__archetypeId
    expect(tagArch).not.toBe(emptyArch) // a real, distinct archetype
    expect(() => w.entity(e).read(Alive)).toThrow() // tag: nothing to read
  })
})

describe('bitmask membership index (§6 — BM-1, BM-2, BM-3)', () => {
  test('BM-2 coherence: bitmask membership matches the entity signature after each op', () => {
    const P = defineComponent({ x: 'f32' })
    const Q = defineComponent({ q: 'i32' })
    const w = createWorld({ components: [P, Q] })
    const bm = (w as unknown as { __bm?: never })
    void bm
    const e = w.spawnWith(P)
    // has() reads the bitmask serially.
    expect(w.has(e, P)).toBe(true)
    expect(w.has(e, Q)).toBe(false)
    w.add(e, Q)
    expect(w.has(e, P)).toBe(true)
    expect(w.has(e, Q)).toBe(true)
    w.remove(e, P)
    expect(w.has(e, P)).toBe(false)
    expect(w.has(e, Q)).toBe(true)
  })

  test('has() returns false for a dead handle without throwing (no bitmask read)', () => {
    const P = defineComponent({ x: 'f32' })
    const w = createWorld({ components: [P] })
    const e = w.spawnWith(P)
    w.despawn(e)
    expect(w.has(e, P)).toBe(false)
  })

  test('despawn clears membership; a recycled index starts empty', () => {
    const P = defineComponent({ x: 'f32' })
    const w = createWorld({ components: [P] })
    const e = w.spawnWith(P)
    w.despawn(e)
    const e2 = w.spawn() // recycles the same index slot, empty signature
    expect(w.has(e2, P)).toBe(false)
  })
})

describe('cold-archetype fragmentation cap (FRAG-1, §10.3)', () => {
  test('with maxHotArchetypes=2 the 3rd distinct signature is cold but still queryable via has()', () => {
    const A = defineComponent({ a: 'f32' })
    const B = defineComponent({ b: 'f32' })
    const C = defineComponent({ c: 'f32' })
    // hot budget: EMPTY(0) is created eagerly and counts as 1 hot; {A} is the 2nd hot; {B}/{C} cold.
    const w = createWorld({ components: [A, B, C], maxHotArchetypes: 2 })
    const eA = w.spawnWith(A)
    const eB = w.spawnWith(B)
    expect(w.has(eA, A)).toBe(true)
    expect(w.has(eB, B)).toBe(true)
    expect(w.has(eB, A)).toBe(false)
    // The cold entity's column value still round-trips through the cold store.
    ;(w.entity(eB).write(B) as { b: number }).b = 42
    expect((w.entity(eB).read(B) as { b: number }).b).toBe(42)
  })
})
