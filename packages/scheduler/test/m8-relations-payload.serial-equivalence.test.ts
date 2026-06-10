// relations PAYLOAD serial-equivalence: a payloaded pair add encoded into a worker command buffer
// (the worker rebuilds the pair-payload codec from the replicated relation schema) must decode and
// apply to the IDENTICAL payload as a serial `rel.addPair(s, R, t, payload)`. The pre-fix worker
// encoder dropped payloads (payloadWordCount=0) — this pins that they now survive byte-for-byte.
//
// The harness mirrors the manifest plumbing at the command-buffer level: a codec per relationId built
// the SAME way both sides do — `buildFieldCodec(defineComponent(payloadSchema))` — fed to the
// encoder's relationCodec and the apply's relationCodecOf.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, handleIndex } from '@ecsia/core'
import type { ComponentDef, ComponentId, EntityHandle, Schema, World } from '@ecsia/core'
import type { RelationId } from '@ecsia/schema'
import { flushAll, makeCommandBuffer, makeEncoder, buildFieldCodec } from '../src/internal.js'
import type { CommandBuffer, CommandEncoder, ComponentFieldCodec, WorldApply } from '../src/internal.js'
import { createRelations } from '@ecsia/relations'

function makeKit(entityCount: number, exclusive: boolean) {
  const world = createWorld({ maxEntities: 1 << 12 })
  const rel = createRelations(world)
  const Owes = rel.defineRelation({ weight: 'u32', kind: 'u8' }, exclusive ? { exclusive: true } : undefined)
  const relId = (Owes as unknown as { id: RelationId }).id
  // The codec the manifest+worker rebuild from the replicated payload schema (same on both sides).
  const codec = buildFieldCodec(defineComponent({ weight: 'u32', kind: 'u8' }, { brand: `rel$${relId as number}$payload` }))
  const ents: EntityHandle[] = []
  for (let i = 0; i < entityCount; i++) ents.push(world.spawn())
  return { world, rel, Owes, relId, codec, ents }
}
type Kit = ReturnType<typeof makeKit>

function worldApplyOf(kit: Kit, warn: (m: string) => void): WorldApply {
  const { world, codec, relId } = kit
  const layout = world.handleLayout
  const apply = world.__apply
  return {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: () => undefined,
    addMany: (h, defs: readonly ComponentDef<Schema>[]) => apply.addMany(h, defs),
    removeMany: (h, defs: readonly ComponentDef<Schema>[]) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    addPair: (s, r, t, p) => apply.addPair?.(s, r, t, p),
    removePair: (s, r, t) => apply.removePair?.(s, r, t),
    relationCodecOf: (rid) => ((rid as unknown as number) === (relId as unknown as number) ? codec : undefined),
    warn,
  }
}

function encoderOver(kit: Kit, cb: CommandBuffer, warn: (m: string) => void): CommandEncoder {
  return makeEncoder({
    cb,
    infoOf: (def) => ({ id: (def as unknown as { id: number }).id as unknown as ComponentId, codec: undefined as never }),
    relationCodec: (rid) => ((rid as unknown as number) === (kit.relId as unknown as number) ? kit.codec : undefined),
    warn,
  })
}

// A payload op: add (s,t) with a COMPLETE payload. A worker-encoded addPair always carries a full
// payload (the fixed-layout codec fills omitted fields with schema defaults), so the byte-identical
// guarantee is over full payloads — which also covers idempotent re-adds (a full re-add rewrites every
// field the same on both sides). A PARTIAL-payload idempotent re-add is a main-thread-only refinement
// (it updates only the named fields) and is deliberately not asserted here.
type Op = { s: number; t: number; weight: number; kind: number }
const op = (n: number): fc.Arbitrary<Op> =>
  fc.record({
    s: fc.integer({ min: 0, max: n - 1 }),
    t: fc.integer({ min: 0, max: n - 1 }),
    weight: fc.integer({ min: 0, max: 0xffffffff }),
    kind: fc.integer({ min: 0, max: 255 }),
  })

const payloadOf = (o: Op): Record<string, number> => ({ weight: o.weight, kind: o.kind })

// Fingerprint: every live pair's (s,t) + its read-back payload, sorted. Order-insensitive.
function fingerprint(kit: Kit): string[] {
  const { world, rel, Owes, ents } = kit
  const out: string[] = []
  for (let s = 0; s < ents.length; s++) {
    if (!world.isAlive(ents[s]!)) continue
    for (let t = 0; t < ents.length; t++) {
      if (!world.isAlive(ents[t]!)) continue
      if (!rel.hasPair(ents[s]!, Owes, ents[t]!)) continue
      const p = rel.getPair(ents[s]!, Owes, ents[t]!).read() as { weight: number; kind: number }
      out.push(`${s}->${t}:w=${p.weight},k=${p.kind}`)
    }
  }
  return out.sort()
}

for (const exclusive of [false, true]) {
  describe(`relation PAYLOAD serial-equivalence (${exclusive ? 'exclusive' : 'overflow'})`, () => {
    test('worker-encoded payload decodes byte-identical to a serial addPair', () => {
      fc.assert(
        fc.property(fc.array(op(5), { minLength: 1, maxLength: 8 }), (ops) => {
          // SERIAL reference: apply payloads directly.
          const ref = makeKit(5, exclusive)
          for (const o of ops) ref.rel.addPair(ref.ents[o.s]!, ref.Owes, ref.ents[o.t]!, payloadOf(o))
          const refFp = fingerprint(ref)

          // COMMAND-BUFFER path: encode each add (with payload) into a worker buffer, flush.
          const cb = makeKit(5, exclusive)
          const buf = makeCommandBuffer(0, 512, false)
          const enc = encoderOver(cb, buf, () => {})
          for (const o of ops) enc.setRelation(cb.ents[o.s]!, cb.relId, cb.ents[o.t]!, payloadOf(o))
          flushAll(worldApplyOf(cb, () => {}), [buf])

          expect(fingerprint(cb)).toEqual(refFp)
        }),
        { numRuns: 200 },
      )
    })
  })
}
