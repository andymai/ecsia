// relations — SERIAL-EQUIVALENCE property (carry from, / command-buffer ).
// Worker-staged OP_ADD_PAIR / OP_REMOVE_PAIR with FUZZED dead subjects/targets, applied through the
// real scheduler command-buffer flush, must produce the IDENTICAL relation state as a SERIAL direct
// application of the same logical ops (drop-if-dead enforced identically on both sides).
//
// This is the relation-specific extension of the generic validate-then-apply invariant: ADD_PAIR drops
// if EITHER subject or target is dead at apply time; REMOVE_PAIR drops if the subject is dead. The
// command-apply path (un-stubbed at ) routes to the same addPair/removePair createRelations installed
// into world.__apply, so the multi-worker merge is serial-equivalent to a single-threaded apply.
//
// The relations runtime imports @ecsia/core only; this TEST may import @ecsia/scheduler (tests are not
// source — the acyclic source boundary is unaffected).

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, handleIndex } from '@ecsia/core'
import type { ComponentDef, ComponentId, EntityHandle, RelationId, Schema, World } from '@ecsia/core'
import { flushAll, makeCommandBuffer, makeEncoder } from '../../scheduler/src/internal.js'
import type { CommandBuffer, CommandEncoder, WorldApply } from '../../scheduler/src/internal.js'
import { createRelations, Wildcard } from '../src/index.js'

type Rel = ReturnType<typeof createRelations>
type RelationDef = ReturnType<Rel['defineRelation']>

interface Kit {
  world: World
  rel: Rel
  Likes: RelationDef
  relId: RelationId
  ents: EntityHandle[]
}

function makeKit(entityCount: number): Kit {
  const world = createWorld({ maxEntities: 1 << 12 })
  const rel = createRelations(world)
  const Likes = rel.defineRelation(null) // tag relation: no payload codec needed for the encoder
  const relId = (Likes as unknown as { id: RelationId }).id
  const ents: EntityHandle[] = []
  for (let i = 0; i < entityCount; i++) ents.push(world.spawn())
  return { world, rel, Likes, relId, ents }
}

// Build the WorldApply the scheduler flush drives, INCLUDING the relation apply seams that
// createRelations filled into world.__apply (the un-stubbed OP_ADD_PAIR / OP_REMOVE_PAIR path).
function worldApplyOf(world: World, warn: (m: string) => void): WorldApply {
  const layout = world.handleLayout
  const apply = world.__apply
  return {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: () => undefined, // tag relations / no component payloads in this workload
    addMany: (h, defs: readonly ComponentDef<Schema>[]) => apply.addMany(h, defs),
    removeMany: (h, defs: readonly ComponentDef<Schema>[]) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    addPair: (s, r, t, p) => apply.addPair?.(s, r, t, p),
    removePair: (s, r, t) => apply.removePair?.(s, r, t),
    warn,
  }
}

function encoderOver(cb: CommandBuffer, warn: (m: string) => void): CommandEncoder {
  return makeEncoder({
    cb,
    infoOf: (def) => ({ id: (def as unknown as { id: number }).id as unknown as ComponentId, codec: undefined as never }),
    relationCodec: () => undefined,
    warn,
  })
}

// The logical relation workload: add/remove a Likes pair, or despawn an entity (creating dead refs).
type RelOp =
  | { kind: 'add'; s: number; t: number }
  | { kind: 'remove'; s: number; t: number }
  | { kind: 'despawn'; e: number }

const relOp = (n: number): fc.Arbitrary<RelOp> =>
  fc.oneof(
    fc.record({ kind: fc.constant('add' as const), s: fc.integer({ min: 0, max: n - 1 }), t: fc.integer({ min: 0, max: n - 1 }) }),
    fc.record({ kind: fc.constant('remove' as const), s: fc.integer({ min: 0, max: n - 1 }), t: fc.integer({ min: 0, max: n - 1 }) }),
    fc.record({ kind: fc.constant('despawn' as const), e: fc.integer({ min: 0, max: n - 1 }) }),
  )

// A relation-state fingerprint: the sorted set of (subjectIndex, targetIndex) pairs that hold over all
// LIVE entities, plus the per-entity hasRelation bit. Order-insensitive, independent of internals.
function fingerprint(kit: Kit): { pairs: string[]; presence: boolean[]; alive: boolean[] } {
  const { world, rel, Likes, ents } = kit
  const layout = world.handleLayout
  const pairs: string[] = []
  for (let s = 0; s < ents.length; s++) {
    if (!world.isAlive(ents[s]!)) continue
    for (let t = 0; t < ents.length; t++) {
      if (!world.isAlive(ents[t]!)) continue
      if (rel.hasPair(ents[s]!, Likes, ents[t]!)) {
        pairs.push(`${handleIndex(ents[s]!, layout)}->${handleIndex(ents[t]!, layout)}`)
      }
    }
  }
  pairs.sort()
  const presence = ents.map((e) => (world.isAlive(e) ? rel.hasRelation(e, Likes) : false))
  const alive = ents.map((e) => world.isAlive(e))
  return { pairs, presence, alive }
}

describe('SERIAL-EQUIVALENCE — worker-staged OP_ADD_PAIR/OP_REMOVE_PAIR vs serial apply ', () => {
  test('a fuzzed multi-worker relation workload (with dead subjects/targets) matches the serial result', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(relOp(6), { maxLength: 6 }), { minLength: 1, maxLength: 4 }), // per-worker programs
        (perWorker) => {
          const N = 6

          // --- SERIAL reference: apply the SAME logical ops directly, in fixed worker-index then
          // append order (the deterministic merge order flushAll enforces). drop-if-dead applies
          // here too because addPair/removePair guard on isAlive(subject)/isAlive(target). ---
          const ref = makeKit(N)
          for (const ops of perWorker) {
            for (const op of ops) {
              if (op.kind === 'add') ref.rel.addPair(ref.ents[op.s]!, ref.Likes, ref.ents[op.t]!)
              else if (op.kind === 'remove') ref.rel.removePair(ref.ents[op.s]!, ref.Likes, ref.ents[op.t]!)
              else if (ref.world.isAlive(ref.ents[op.e]!)) ref.world.despawn(ref.ents[op.e]!)
            }
          }
          const refFp = fingerprint(ref)

          // --- COMMAND-BUFFER path: encode each worker's program into its buffer, flush deterministically.
          const cb = makeKit(N)
          const bufs: CommandBuffer[] = []
          perWorker.forEach((ops, wi) => {
            const buf = makeCommandBuffer(wi, 512, false)
            const enc = encoderOver(buf, () => {})
            for (const op of ops) {
              if (op.kind === 'add') enc.setRelation(cb.ents[op.s]!, cb.relId, cb.ents[op.t]!)
              else if (op.kind === 'remove') enc.unsetRelation(cb.ents[op.s]!, cb.relId, cb.ents[op.t]!)
              else enc.destroy(cb.ents[op.e]!)
            }
            bufs.push(buf)
          })
          flushAll(worldApplyOf(cb.world, () => {}), bufs)
          const cbFp = fingerprint(cb)

          // DEEP-COMPARE: identical alive set, identical presence bits, identical live-pair set. Any
          // divergence (a dangling pair applied to a recycled slot, a missed drop-if-dead) would fail.
          expect(cbFp).toEqual(refFp)
        },
      ),
      { numRuns: 150 },
    )
  })

  test('ADD_PAIR to a target destroyed earlier in the SAME flush is dropped (relation drop-if-dead)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (victims) => {
        const N = 6
        const kit = makeKit(N)
        // Worker 0 destroys the first `victims` entities (as targets); worker 1 (applied AFTER) tries to
        // add a Likes pair to each. Every such ADD_PAIR must drop — a relation to a dead target is
        // meaningless (command-buffer ) — so NO survivor holds a Likes pair to a destroyed target.
        const w0 = makeCommandBuffer(0, 512, false)
        const w1 = makeCommandBuffer(1, 512, false)
        const enc0 = encoderOver(w0, () => {})
        const warns: string[] = []
        const enc1 = encoderOver(w1, (m) => warns.push(m))
        for (let i = 0; i < victims; i++) enc0.destroy(kit.ents[i]!)
        for (let i = 0; i < victims; i++) enc1.setRelation(kit.ents[N - 1]!, kit.relId, kit.ents[i]!)

        flushAll(worldApplyOf(kit.world, (m) => warns.push(m)), [w0, w1])

        for (let i = 0; i < victims; i++) expect(kit.world.isAlive(kit.ents[i]!)).toBe(false)
        // The live subject gained no pair to any destroyed target → it holds no Likes relation at all.
        expect(kit.rel.hasRelation(kit.ents[N - 1]!, kit.Likes)).toBe(false)
        expect(kit.world.query(kit.rel.Pair(kit.Likes, Wildcard) as never).count).toBe(0)
        expect(warns.length).toBeGreaterThanOrEqual(victims) // each dropped op warns
      }),
      { numRuns: 80 },
    )
  })
})
