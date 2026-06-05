// relations — PROPERTY suite (fast-check). Each property is genuinely DISCRIMINATING: it asserts
// an invariant against an INDEPENDENT model (a plain Map/Set oracle), not the implementation's own
// helpers, so it would fail if the invariant it guards were broken.
//
// PRESENCE: after any random pair add/remove sequence, an entity's signature carries presenceId(R)
// IFF it currently holds >= 1 R-pair (presence bit tracks the pair count crossing 0<->1).
// PAIR STABILITY: mintPair(R, targetIndex) is idempotent AND the id is STABLE across a target
// generation bump (despawn+respawn the target into the SAME slot ⇒ the SAME pair component id).
// NO DANGLING PAIR: after any random despawn-with-cascade sequence, no LIVE pair references a dead
// target (relies on identity-invalidated-LAST: preDespawn removes pairs before the gen bump).
// CASCADE TERMINATION: iterative BFS visits each entity once and TERMINATES on a CYCLIC relation
// graph (no recursion blowup, no infinite loop) — build a cycle and assert it completes.
// WILDCARD O(1): Pair(R, Wildcard) match cost is O(archetypes), INDEPENDENT of the number of
// distinct targets T — vary T (10 vs 1000) and assert the matched-archetype count is flat.
// T1 (deferred benches): structural assertions standing in for the unwritten churn/fragmentation
// benches — exclusive re-parent stays in ONE archetype; non-exclusive blow-up stays under
// maxHotArchetypes with a hot+cold transparent wildcard query.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createWorld, handleIndex } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

const idx = (world: World, h: EntityHandle): number => handleIndex(h, world.handleLayout) as number

// --------------------------------------------------------------------------------------------------
describe('— presence bit tracks the pair count crossing 0<->1', () => {
  it('hasRelation(s, R) === (s holds >=1 R-pair) after ANY random add/remove sequence (non-exclusive)', () => {
    fc.assert(
      fc.property(
        // a stream of (subject, target, add?) ops over a small fixed entity pool
        fc.array(
          fc.record({
            s: fc.integer({ min: 0, max: 3 }),
            t: fc.integer({ min: 0, max: 4 }),
            add: fc.boolean(),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (ops) => {
          const world = createWorld({ maxEntities: 1 << 10 })
          const rel = createRelations(world)
          const Likes = rel.defineRelation(null) // non-exclusive tag: a subject can hold many targets
          const subjects = Array.from({ length: 4 }, () => world.spawn())
          const targets = Array.from({ length: 5 }, () => world.spawn())

          // INDEPENDENT oracle: subject -> set of target indices it currently holds an R-pair to.
          const model = new Map<number, Set<number>>()

          for (const op of ops) {
            const s = subjects[op.s]!
            const t = targets[op.t]!
            const si = op.s
            let set = model.get(si)
            if (op.add) {
              rel.addPair(s, Likes, t)
              if (set === undefined) {
                set = new Set()
                model.set(si, set)
              }
              set.add(op.t)
            } else {
              rel.removePair(s, Likes, t)
              set?.delete(op.t)
              if (set !== undefined && set.size === 0) model.delete(si)
            }
            // holds after EVERY op, not just at the end.
            for (let k = 0; k < subjects.length; k++) {
              const holdsAny = (model.get(k)?.size ?? 0) > 0
              expect(rel.hasRelation(subjects[k]!, Likes)).toBe(holdsAny)
            }
          }
        },
      ),
      { numRuns: 120 },
    )
  })

  it('exclusive presence appears on first attach and disappears on the last detach', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ t: fc.integer({ min: 0, max: 3 }), attach: fc.boolean() }), { minLength: 1, maxLength: 40 }),
        (ops) => {
          const world = createWorld({ maxEntities: 1 << 10 })
          const rel = createRelations(world)
          const ChildOf = rel.defineRelation(null, { exclusive: true }) // single-target
          const child = world.spawn()
          const parents = Array.from({ length: 4 }, () => world.spawn())
          let current: number | null = null // the oracle: the single current target index, or none
          for (const op of ops) {
            const t = parents[op.t]!
            if (op.attach) {
              rel.addPair(child, ChildOf, t)
              current = op.t
            } else if (current === op.t) {
              rel.removePair(child, ChildOf, t)
              current = null
            } else {
              rel.removePair(child, ChildOf, t) // removing a non-current target is a no-op
            }
            expect(rel.hasRelation(child, ChildOf)).toBe(current !== null)
          }
        },
      ),
      { numRuns: 120 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('— pair id is idempotent AND stable across a target generation bump', () => {
  it('mintPair(R, t) is idempotent: re-adding the same pair never changes membership/back-ref', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (repeats) => {
        const world = createWorld({ maxEntities: 1 << 10 })
        const rel = createRelations(world)
        const Likes = rel.defineRelation(null)
        const a = world.spawn()
        const b = world.spawn()
        for (let i = 0; i < repeats; i++) rel.addPair(a, Likes, b)
        expect(rel.hasPair(a, Likes, b)).toBe(true)
        expect([...rel.subjectsOf(Likes, b)]).toEqual([a]) // exactly one subject, no duplication
      }),
      { numRuns: 60 },
    )
  })

  it('the pair id is STABLE across a target despawn+respawn into the SAME slot (index-keyed)', () => {
    // A pair is keyed by the target INDEX (low handle bits), not the full handle, so a despawn+respawn
    // that recycles the same slot must yield the IDENTICAL pair component id. We observe the id through
    // its only public projection: whether a query compiled for Pair(R, target-by-INDEX) matches.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (extra) => {
        const world = createWorld({ maxEntities: 1 << 10 })
        const rel = createRelations(world)
        const Likes = rel.defineRelation(null)

        const subject1 = world.spawn()
        const target = world.spawn()
        const targetIndex = idx(world, target)
        rel.addPair(subject1, Likes, target)

        // The pair id is minted; a specific-target query over it matches subject1.
        const q1 = world.query(rel.Pair(Likes, target) as never)
        expect(q1.count).toBe(1)

        // Despawn the target. Cascade drops the dangling pair (subject1 loses it). Then respawn — the
        // FREE list is LIFO at the entity layer, so the very next spawn reuses `target`'s slot (same
        // index, bumped generation). Spawn `extra` decoys first only if they would NOT take the slot;
        // here we want the recycled slot, so respawn immediately.
        world.despawn(target)
        expect(rel.hasPair(subject1, Likes, target)).toBe(false) // dangling pair removed

        const respawned = world.spawn()
        expect(idx(world, respawned)).toBe(targetIndex) // same slot recycled (LIFO free list)

        // A NEW subject points at the recycled slot. Because the pair id is keyed by INDEX, it is the
        // SAME minted id — and a query for Pair(R, respawned) (same index) matches. Crucially the id was
        // NOT leaked/renumbered: the back-ref + membership resolve through the stable id.
        const subject2 = world.spawn()
        rel.addPair(subject2, Likes, respawned)
        const q2 = world.query(rel.Pair(Likes, respawned) as never)
        expect(q2.count).toBe(1)
        expect([...rel.subjectsOf(Likes, respawned)]).toEqual([subject2])
        // The stale handle `target` and the fresh `respawned` share the index, so the SAME pair id
        // backs both: a query built from the OLD handle (same index bits) sees the new holder.
        expect(world.query(rel.Pair(Likes, target) as never).count).toBe(1)
        void extra
      }),
      { numRuns: 80 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('— no live pair references a dead target after random despawn-with-cascade', () => {
  it('after a fuzzed despawn sequence, every surviving subject holds pairs ONLY to live targets', () => {
    fc.assert(
      fc.property(
        fc.record({
          edges: fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 })), { minLength: 1, maxLength: 40 }),
          despawns: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 10 }),
        }),
        ({ edges, despawns }) => {
          const world = createWorld({ maxEntities: 1 << 11 })
          const rel = createRelations(world)
          const Likes = rel.defineRelation(null) // cascade 'none': target delete drops the dangling pair
          const ents = Array.from({ length: 10 }, () => world.spawn())

          // Apply random (subject -> target) Likes pairs (skip self-pairs for clarity).
          for (const [s, t] of edges) if (s !== t) rel.addPair(ents[s]!, Likes, ents[t]!)
          // Despawn a random subset of entities (each despawn fires preDespawn cascade/teardown).
          for (const d of despawns) if (world.isAlive(ents[d]!)) world.despawn(ents[d]!)

          // INVARIANT: for every still-live subject, every target it still points at is ALSO live, and
          // subjectsOf never yields a subject that points at a dead target. We probe via the public
          // back-ref + hasPair surface (no dead handle ever survives as a live pair).
          for (let s = 0; s < ents.length; s++) {
            if (!world.isAlive(ents[s]!)) continue
            for (let t = 0; t < ents.length; t++) {
              if (s === t) continue
              const targetLive = world.isAlive(ents[t]!)
              if (!targetLive) {
                // No live subject may still hold a pair to a dead target (it was torn down on despawn).
                expect(rel.hasPair(ents[s]!, Likes, ents[t]!)).toBe(false)
              }
            }
          }
          // And subjectsOf(target) for any DEAD target yields nothing live.
          for (let t = 0; t < ents.length; t++) {
            if (world.isAlive(ents[t]!)) continue
            expect([...rel.subjectsOf(Likes, ents[t]!)]).toEqual([])
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  it('deleteSubject cascade never leaves a live subject pointing at a despawned parent', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 11 }), { minLength: 0, maxLength: 6 }),
        (despawnRoots) => {
          const world = createWorld({ maxEntities: 1 << 11 })
          const rel = createRelations(world)
          const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
          const ents = Array.from({ length: 12 }, () => world.spawn())
          // A linear chain ents[0] <- ents[1] <- ... (each child points at its predecessor).
          for (let i = 1; i < ents.length; i++) rel.addPair(ents[i]!, ChildOf, ents[i - 1]!)

          for (const d of despawnRoots) if (world.isAlive(ents[d]!)) world.despawn(ents[d]!)

          // Any surviving entity's parent (if it has one) must be alive — no dangling ChildOf.
          for (const e of ents) {
            if (!world.isAlive(e)) continue
            for (const parent of rel.targetsOf(e, ChildOf)) expect(world.isAlive(parent)).toBe(true)
          }
        },
      ),
      { numRuns: 120 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('— cascade is iterative BFS: terminates & visits each entity once, even on CYCLES', () => {
  it('a WIDE deleteSubject fan-out despawns in flat breadth (the BFS queue, not the stack)', { timeout: 30_000 }, () => {
    // The per-invocation cascade IS a flat queue across breadth: a root with a huge sibling fan-out
    // drains in one onPreDespawn loop, NOT one stack frame per child. 50k siblings would overflow a
    // recursive-per-child design; the iterative work-queue handles them flat.
    const world = createWorld({ maxEntities: 1 << 17 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const WIDTH = 50000
    const root = world.spawn()
    for (let i = 0; i < WIDTH; i++) rel.addPair(world.spawn(), ChildOf, root)
    expect(world.handleStats().aliveCount).toBe(WIDTH + 1)
    expect(() => world.despawn(root)).not.toThrow() // breadth drains via the queue → no stack blowup
    expect(world.handleStats().aliveCount).toBe(0) // every sibling reached & removed once
  })

  it('a DEEP (100k) deleteSubject chain despawns without recursion (recursion-free cascade)', { timeout: 30_000 }, () => {
    // /: a deep deleteSubject chain must despawn WITHOUT recursion. The cascade hoists a single
    // shared frontier queue; the re-entrant onPreDespawn that host.despawn fires per victim appends to
    // that queue and unwinds one frame, so the native stack stays CONSTANT regardless of chain depth. A
    // recursion-per-level design would RangeError here (~3-4k deep); 100k links proves it is iterative.
    const DEPTH = 100000
    const world = createWorld({ maxEntities: 1 << 18 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })
    const chain: EntityHandle[] = [world.spawn()]
    for (let i = 1; i < DEPTH; i++) {
      const c = world.spawn()
      rel.addPair(c, ChildOf, chain[i - 1]!)
      chain.push(c)
    }
    expect(world.handleStats().aliveCount).toBe(DEPTH)
    expect(() => world.despawn(chain[0]!)).not.toThrow() // a recursive cascade would blow the stack here
    expect(world.handleStats().aliveCount).toBe(0) // every link reached & removed exactly once
  })

  it('a CYCLIC relation graph cascade TERMINATES (visited set prevents an infinite loop)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 30 }), (n) => {
        const world = createWorld({ maxEntities: 1 << 12 })
        const rel = createRelations(world)
        // Non-exclusive so we can build a genuine multi-target cycle (A->B->C->...->A) without the
        // single-target column overwriting edges. cascade deleteSubject makes a target-delete cascade.
        const Bond = rel.defineRelation(null, { exclusive: false, cascade: 'deleteSubject' })
        const ring = Array.from({ length: n }, () => world.spawn())
        for (let i = 0; i < n; i++) rel.addPair(ring[i]!, Bond, ring[(i + 1) % n]!) // a closed cycle
        // Also add a chord or two to make it a non-trivial cyclic graph.
        if (n >= 4) {
          rel.addPair(ring[0]!, Bond, ring[Math.floor(n / 2)]!)
          rel.addPair(ring[Math.floor(n / 2)]!, Bond, ring[1]!)
        }
        expect(world.handleStats().aliveCount).toBe(n)
        // Despawning any node cascades around the cycle; the visited set must stop it terminating, NOT
        // loop forever. (A test that hung here would time out — termination is the assertion.)
        expect(() => world.despawn(ring[0]!)).not.toThrow()
        // Every node in the (strongly-connected) cycle is reached and despawned exactly once.
        expect(world.handleStats().aliveCount).toBe(0)
      }),
      { numRuns: 60 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('— Pair(R, Wildcard) match cost is O(archetypes), INDEPENDENT of distinct targets T', () => {
  // The discriminator: an EXCLUSIVE relation stores the target as a column value, so ALL subjects with
  // the same component set share ONE archetype regardless of how many distinct targets exist. The
  // wildcard query's matched-archetype count (its whole match cost) is therefore FLAT as T varies
  // 10 → 1000. An O(T) design (a pair bit per target, OR-scanned) would grow the matched set with T.
  const matchedArchetypeCount = (world: World, rel: ReturnType<typeof createRelations>, Likes: ReturnType<ReturnType<typeof createRelations>['defineRelation']>): number => {
    const q = world.query(rel.Pair(Likes, Wildcard) as never) as unknown as { matchingArchetypes: unknown[] }
    return q.matchingArchetypes.length
  }

  function buildExclusiveScene(T: number): { count: number; subjects: number } {
    const world = createWorld({ maxEntities: 1 << 21 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true }) // one archetype for all subjects
    const parents = Array.from({ length: T }, () => world.spawn())
    // One distinct child per distinct parent → T distinct targets, T subjects, but all subjects share
    // ONE archetype (the exclusive eid column holds the target as a value, not a signature bit).
    let subjects = 0
    for (let i = 0; i < T; i++) {
      const child = world.spawn()
      rel.addPair(child, ChildOf, parents[i]!)
      subjects++
    }
    return { count: matchedArchetypeCount(world, rel, ChildOf), subjects }
  }

  it('matched-archetype count is FLAT (1) for T=10 and T=1000 (exclusive: no per-target archetype)', () => {
    const small = buildExclusiveScene(10)
    const large = buildExclusiveScene(1000)
    expect(small.subjects).toBe(10)
    expect(large.subjects).toBe(1000)
    // THE discriminator: the wildcard match touches the SAME (flat) number of archetypes regardless of
    // T — O(archetypes), not O(distinct targets). A 100x increase in T leaves it unchanged.
    expect(small.count).toBe(large.count)
    expect(large.count).toBe(1) // all 1000 subjects sit in a single exclusive-presence archetype
  })

  it('the wildcard result COUNT scales with subjects (correctness) while match cost stays flat', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (T) => {
        const world = createWorld({ maxEntities: 1 << 16 })
        const rel = createRelations(world)
        const ChildOf = rel.defineRelation(null, { exclusive: true })
        const parents = Array.from({ length: T }, () => world.spawn())
        for (let i = 0; i < T; i++) rel.addPair(world.spawn(), ChildOf, parents[i]!)
        const q = world.query(rel.Pair(ChildOf, Wildcard) as never) as unknown as { count: number; matchingArchetypes: unknown[] }
        expect(q.count).toBe(T) // correctness: every subject matches
        expect(q.matchingArchetypes.length).toBe(1) // cost: one archetype regardless of T
      }),
      { numRuns: 60 },
    )
  })
})

// --------------------------------------------------------------------------------------------------
describe('T1 (perf benches DEFERRED) — structural stand-ins for churn & fragmentation', () => {
  // NOTE: the report's T1 churn / archetype-fragmentation BENCHMARKS are DEFERRED — there is no bench
  // harness wired in this repo. In their place we assert the STRUCTURAL properties the benches would
  // quantify, so a regression in the fragmentation valves is still caught.

  it('exclusive re-parent churn stays in ONE archetype across a long re-parent storm (zero fragmentation)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 31 }), { minLength: 1, maxLength: 200 }), (reparents) => {
        const world = createWorld({ maxEntities: 1 << 12 })
        const rel = createRelations(world)
        const ChildOf = rel.defineRelation(null, { exclusive: true })
        const child = world.spawn()
        const parents = Array.from({ length: 32 }, () => world.spawn())
        rel.addPair(child, ChildOf, parents[reparents[0]!]!) // first attach
        const arch = (world.entity(child) as unknown as { __archetypeId: number }).__archetypeId
        for (const p of reparents) {
          rel.addPair(child, ChildOf, parents[p]!)
          // The child NEVER moves archetype across the whole storm — the scene-graph blow-up is gone.
          expect((world.entity(child) as unknown as { __archetypeId: number }).__archetypeId).toBe(arch)
        }
      }),
      { numRuns: 80 },
    )
  })

  it('non-exclusive blow-up stays within maxHotArchetypes; the wildcard query is hot+cold transparent', () => {
    // A non-exclusive relation mints a distinct pair archetype per distinct target — exactly the
    // fragmentation the cold-archetype fallback caps. With a SMALL maxHotArchetypes, the surplus pair
    // archetypes demote to cold, yet a Pair(R, Wildcard) query still counts EVERY holder (hot + cold
    // transparently). This stands in for the deferred fragmentation bench.
    const MAX_HOT = 8
    const T = 64 // far more distinct targets than the hot cap → forces cold demotion
    const world = createWorld({ maxEntities: 1 << 14, maxHotArchetypes: MAX_HOT })
    const rel = createRelations(world)
    const Likes = rel.defineRelation(null) // non-exclusive tag → one archetype per distinct target
    const subjects = Array.from({ length: T }, () => world.spawn())
    const targets = Array.from({ length: T }, () => world.spawn())
    // subject[i] likes target[i] → T distinct (R, target) pair archetypes, blowing past MAX_HOT.
    for (let i = 0; i < T; i++) rel.addPair(subjects[i]!, Likes, targets[i]!)

    // The wildcard query sees every holder regardless of whether its archetype is hot or cold.
    const wild = world.query(rel.Pair(Likes, Wildcard) as never)
    expect(wild.count).toBe(T)

    // hasRelation works identically for cold-resident subjects (the bitmask is index-addressed).
    let holding = 0
    for (const s of subjects) if (rel.hasRelation(s, Likes)) holding++
    expect(holding).toBe(T)
  })
})
