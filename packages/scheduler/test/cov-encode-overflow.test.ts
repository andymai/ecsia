// Coverage: commands/encode.ts — the worker-side encode API overflow/exhaustion bails
// On a FIXED (SAB) buffer every encoder must CAP (write nothing, leave
// head untouched) and warn ONCE per wave; create() must additionally bail on reservation exhaustion
// WITHOUT consuming a reserved handle. Also pins the relation-payload encode path (setRelation).

import { describe, expect, test } from 'vitest'
import { defineComponent } from '@ecsia/core'
import { makeCommandBuffer, makeEncoder, buildFieldCodec, Op } from '../src/internal.js'
import type { CommandBuffer, ComponentFieldCodec } from '../src/internal.js'
import type { ComponentDef, ComponentId, RelationId, Schema } from '@ecsia/schema'
import type { EntityHandle } from '@ecsia/core'

const NO_ENTITY_BITS = 0xffffffff

function envOf(cb: CommandBuffer, warns: string[], relCodec?: ComponentFieldCodec) {
  const Comp = defineComponent({ hp: 'i32' }, { name: `enc_${Math.random().toString(36).slice(2)}` }) as ComponentDef<Schema>
  const enc = makeEncoder({
    cb,
    infoOf: (def) => ({ id: (def as unknown as { id: number }).id as unknown as ComponentId, codec: buildFieldCodec(def) }),
    relationCodec: () => relCodec,
    warn: (m) => warns.push(m),
  })
  return { enc, Comp }
}

/** Fill a fixed buffer to exactly `head`, leaving `free` words below capacity. */
function fillToLeave(cb: CommandBuffer, free: number): void {
  cb.head = cb.words.length - free
}

describe('encode.ts: create() reservation exhaustion bails without burning a handle ', () => {
  test('create() past the reservation cap returns NO_ENTITY, warns, emits no record, and does not advance the cursor', () => {
    const cb = makeCommandBuffer(0, 64, false)
    cb.reservation = { handles: [1 as EntityHandle, 2 as EntityHandle] }
    cb.reservationCursor = 0
    const warns: string[] = []
    const { enc } = envOf(cb, warns)

    expect((enc.create() as unknown as number) >>> 0).toBe(1)
    expect((enc.create() as unknown as number) >>> 0).toBe(2)
    const headAfterTwo = cb.head
    const countAfterTwo = cb.recordCount

    // Third create: reservation is exhausted.
    const third = enc.create()
    expect((third as unknown as number) >>> 0).toBe(NO_ENTITY_BITS) // capped → NO_ENTITY
    expect(cb.reservationCursor).toBe(2) // cursor NOT advanced past the block (handle not burned)
    expect(cb.head).toBe(headAfterTwo) // no OP_CREATE record emitted
    expect(cb.recordCount).toBe(countAfterTwo)
    expect(warns.some((m) => /reservation exhausted|maxSpawnsPerWave/i.test(m))).toBe(true)
  })

  test('create() on a FIXED buffer with no room caps BEFORE consuming the reservation handle (no leak)', () => {
    const cb = makeCommandBuffer(0, 16, /* shared */ true)
    cb.reservation = { handles: [7 as EntityHandle, 8 as EntityHandle] }
    cb.reservationCursor = 0
    fillToLeave(cb, 1) // OP_CREATE needs 2 words; only 1 free → overflow before reserving
    const warns: string[] = []
    const { enc } = envOf(cb, warns)

    const h = enc.create()
    expect((h as unknown as number) >>> 0).toBe(NO_ENTITY_BITS)
    expect(cb.overflowed).toBe(true)
    expect(cb.reservationCursor).toBe(0) // reserved id was NOT consumed → reclaimable by returnUnused
    expect(warns.some((m) => /buffer full|raise commandWords/i.test(m))).toBe(true)
  })
})

describe('encode.ts: every encoder caps in place on a FIXED overflow (onOverflow per-op branches)', () => {
  test('destroy() over a full fixed buffer writes nothing and warns (branch 72)', () => {
    const cb = makeCommandBuffer(0, 16, true)
    fillToLeave(cb, 1) // destroy needs 2 words
    const warns: string[] = []
    const { enc } = envOf(cb, warns)
    const headBefore = cb.head
    enc.destroy(5 as EntityHandle)
    expect(cb.head).toBe(headBefore) // no record
    expect(cb.overflowed).toBe(true)
    expect(warns.length).toBe(1)
  })

  test('remove() over a full fixed buffer writes nothing and warns (lines 95-103, branch 95)', () => {
    const cb = makeCommandBuffer(0, 16, true)
    fillToLeave(cb, 2) // remove needs 3 words
    const warns: string[] = []
    const { enc, Comp } = envOf(cb, warns)
    const headBefore = cb.head
    enc.remove(5 as EntityHandle, Comp)
    expect(cb.head).toBe(headBefore)
    expect(cb.overflowed).toBe(true)
    expect(warns.length).toBe(1)
  })

  test('remove() with room emits a 3-word OP_REMOVE record (lines 95-103 happy path)', () => {
    const cb = makeCommandBuffer(0, 64, false)
    const warns: string[] = []
    const { enc, Comp } = envOf(cb, warns)
    enc.remove(9 as EntityHandle, Comp)
    expect(cb.head).toBe(3)
    expect(cb.words[0]).toBe(Op.REMOVE)
    expect(cb.words[1]).toBe(9)
    expect(cb.words[2]).toBe((Comp as unknown as { id: number }).id >>> 0)
    expect(cb.recordCount).toBe(1)
    expect(warns.length).toBe(0)
  })

  test('setRelation() over a full fixed buffer caps and warns (branch 107-108)', () => {
    const cb = makeCommandBuffer(0, 16, true)
    fillToLeave(cb, 4) // tag setRelation needs 5 words
    const warns: string[] = []
    const { enc } = envOf(cb, warns)
    const headBefore = cb.head
    enc.setRelation(1 as EntityHandle, 0 as RelationId, 2 as EntityHandle)
    expect(cb.head).toBe(headBefore)
    expect(cb.overflowed).toBe(true)
    expect(warns.length).toBe(1)
  })

  test('unsetRelation() over a full fixed buffer caps and warns (branch 121)', () => {
    const cb = makeCommandBuffer(0, 16, true)
    fillToLeave(cb, 3) // unsetRelation needs 4 words
    const warns: string[] = []
    const { enc } = envOf(cb, warns)
    const headBefore = cb.head
    enc.unsetRelation(1 as EntityHandle, 0 as RelationId, 2 as EntityHandle)
    expect(cb.head).toBe(headBefore)
    expect(cb.overflowed).toBe(true)
    expect(warns.length).toBe(1)
  })

  test('onOverflow warns ONCE per wave: a second capped record is silent (branch 46)', () => {
    const cb = makeCommandBuffer(0, 16, true)
    fillToLeave(cb, 1) // every op overflows
    const warns: string[] = []
    const { enc } = envOf(cb, warns)
    enc.destroy(1 as EntityHandle)
    enc.destroy(2 as EntityHandle)
    enc.unsetRelation(1 as EntityHandle, 0 as RelationId, 2 as EntityHandle)
    expect(cb.overflowed).toBe(true)
    expect(warns.length).toBe(1) // only the FIRST cap is loud; subsequent caps are silent
  })
})

describe('encode.ts: setRelation payload path (branch 115 — codec present and p>0)', () => {
  test('a relation WITH a payload codec encodes payloadWordCount and the payload words', () => {
    const cb = makeCommandBuffer(0, 64, false)
    const PayloadComp = defineComponent({ strength: 'i32' }, { name: 'rel_payload' }) as ComponentDef<Schema>
    const relCodec = buildFieldCodec(PayloadComp)
    expect(relCodec.totalWords).toBe(1)
    const warns: string[] = []
    const { enc } = envOf(cb, warns, relCodec)

    enc.setRelation(3 as EntityHandle, 1 as RelationId, 4 as EntityHandle, { strength: 99 })
    expect(cb.words[0]).toBe(Op.ADD_PAIR)
    expect(cb.words[1]).toBe(3) // subject
    expect(cb.words[2]).toBe(1) // relationId
    expect(cb.words[3]).toBe(4) // target
    expect(cb.words[4]).toBe(1) // payloadWordCount = codec.totalWords
    // The payload word decodes back to the encoded value.
    expect(relCodec.decode(cb.words, 5)).toEqual({ strength: 99 })
    expect(cb.head).toBe(6)
  })

  test('a TAG relation (no codec) emits payloadWordCount 0 and no payload words', () => {
    const cb = makeCommandBuffer(0, 64, false)
    const warns: string[] = []
    const { enc } = envOf(cb, warns, undefined)
    enc.setRelation(3 as EntityHandle, 1 as RelationId, 4 as EntityHandle, { ignored: 1 })
    expect(cb.words[4]).toBe(0) // payloadWordCount = 0
    expect(cb.head).toBe(5)
  })
})
