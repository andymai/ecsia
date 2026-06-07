// PROPERTY — the worker-visible topic mirrors. Worker-side consume reads ONLY three SAB surfaces:
// the canonical ring, the hdr region [tail, head, baseSeq], and its cursor-table slot. This suite
// hammers the store with random serial-slot traffic (outside-update bursts, staged merges, frame
// resets, reader consumption both main-path and worker-path) and asserts after EVERY mutation:
//
//   1. hdr words mirror the store's (tail, head, baseSeq) exactly;
//   2. the retained stream contains NO spill — everything a worker could be pointed at lives in
//      the ring (the fold-at-serial-slot invariant);
//   3. a worker-style read — decode rows [cursorSlot, head) straight off the ring via the hdr —
//      delivers exactly the payloads the store's own consume() would deliver.
//
// The world is created threaded so regions are SAB-backed (the only mode the mirrors matter in).

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineTopic, TOPIC_HEADER_WORDS, TOPIC_HDR_HEAD_REL, TOPIC_HDR_BASE_REL } from '@ecsia/core'
import type { TopicDef, World } from '@ecsia/core'
import type { Schema } from '@ecsia/schema'

interface Rig {
  world: World
  T: TopicDef<Schema>
  ringView(): Uint32Array
  hdrView(): Uint32Array
  cursorsView(): Uint32Array
}

function makeRig(): Rig {
  const T = defineTopic(`mirror_${Math.random().toString(36).slice(2)}`, { v: 'u32' }) as unknown as TopicDef<Schema>
  const world = createWorld({ components: [], maxEntities: 256, threaded: true })
  world.publish(T, { v: 0 }) // register via first use; one seed event
  const region = (suffix: string): (() => Uint32Array) => {
    return () => {
      const reg = world.__exportShared().regions.find((r) => (r.key as unknown as string) === `topic.${T.name}.${suffix}`)
      if (reg === undefined) throw new Error(`region topic.${T.name}.${suffix} missing from the shared manifest`)
      return new Uint32Array(reg.backing)
    }
  }
  return { world, T, ringView: region('ring'), hdrView: region('hdr'), cursorsView: region('cursors') }
}

const ROW = TOPIC_HEADER_WORDS + 1 // 1 payload word ('v': u32)

/**
 * What a WORKER would deliver from a tail-relative cursor `rel`: rows [rel, headRel) read straight
 * off the SAB surfaces — exactly the worker-entry math (wire values are all tail-relative).
 */
function workerRead(rig: Rig, rel: number): number[] {
  const hdr = rig.hdrView()
  const ring = rig.ringView()
  const headRel = hdr[TOPIC_HDR_HEAD_REL]! >>> 0
  const baseRel = hdr[TOPIC_HDR_BASE_REL]! >>> 0
  const out: number[] = []
  for (let s = Math.max(rel, 0); s < headRel; s++) {
    out.push(ring[(baseRel + s) * ROW + TOPIC_HEADER_WORDS]! >>> 0)
  }
  return out
}

/** The store's own truth: the payload column of the retained canonical stream. */
function storePayloads(rig: Rig): number[] {
  const topics = rig.world.__topics
  const rows = topics.streamWords(rig.T)
  const out: number[] = []
  for (let at = 0; at < rows.length; at += ROW) out.push(rows[at + TOPIC_HEADER_WORDS]! >>> 0)
  return out
}

type Step =
  | { kind: 'burst'; n: number }
  | { kind: 'frameReset' }
  | { kind: 'mainConsume' }
  | { kind: 'workerConsume' }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('burst' as const), n: fc.integer({ min: 1, max: 600 }) }),
  fc.constant({ kind: 'frameReset' as const }),
  fc.constant({ kind: 'mainConsume' as const }),
  fc.constant({ kind: 'workerConsume' as const }),
)

describe('worker-visible topic mirrors (hdr + ring + cursor table)', () => {
  test('hdr mirrors bounds, spill never survives a serial slot, worker reads equal store reads', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        const rig = makeRig()
        const topics = rig.world.__topics
        const READER = 'mirror-reader'
        topics.initCursor(rig.T, READER)
        const slot = topics.readerSlotFor(rig.T, READER)
        let next = 1 // payload counter (0 was the seed)
        let cursor = topics.bounds(rig.T).tail // independent model of the reader's cursor

        const checkMirrors = (): void => {
          const { tail, head } = topics.bounds(rig.T)
          const hdr = rig.hdrView()
          expect(hdr[TOPIC_HDR_HEAD_REL]! >>> 0).toBe((head - tail) >>> 0)
          // The whole retained window must live in the ring, VALUE-EXACT (no main-only spill, no
          // stale baseRel): the worker-style read of the full window equals the store's own stream
          // payloads. An out-of-bounds or mis-anchored read decodes wrong VALUES, not a short
          // array — comparing values is what makes this non-vacuous.
          expect(workerRead(rig, 0)).toEqual(storePayloads(rig))
        }

        for (const step of steps) {
          switch (step.kind) {
            case 'burst': {
              for (let i = 0; i < step.n; i++) rig.world.publish(rig.T, { v: next++ })
              break
            }
            case 'frameReset': {
              rig.world.frameReset()
              break
            }
            case 'mainConsume': {
              // The store's own consume — the single-thread truth. Mirrors must track per yield.
              const { tail: t0 } = topics.bounds(rig.T)
              const got: number[] = []
              for (const ev of topics.consume(rig.T, READER)) got.push((ev as { v: number }).v >>> 0)
              const expected = workerRead(rig, Math.max(cursor, t0) - t0)
              expect(got).toEqual(expected)
              cursor = topics.bounds(rig.T).head
              expect(rig.cursorsView()[slot]! >>> 0).toBe((cursor - topics.bounds(rig.T).tail) >>> 0)
              break
            }
            case 'workerConsume': {
              // A worker-style drain: read off the SABs (tail-relative wire), then replay the
              // advance exactly as the OP_CONSUMED record would.
              const { tail, head } = topics.bounds(rig.T)
              const rel = Math.max(cursor, tail) - tail
              const got = workerRead(rig, rel)
              expect(got).toEqual(storePayloads(rig).slice(rel))
              topics.advanceFromWorker((rig.T as { id?: number }).id as number, READER, head - tail)
              cursor = head
              expect(rig.cursorsView()[slot]! >>> 0).toBe((cursor - tail) >>> 0)
              break
            }
          }
          checkMirrors()
        }
      }),
      { numRuns: 40 },
    )
  })
})
