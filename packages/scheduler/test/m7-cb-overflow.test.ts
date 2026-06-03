// M7 — SAB command-buffer overflow protocol (command-buffer.md §3.3/§3.5; review issue #3). A FIXED
// (SAB-backed) buffer MUST NOT reassign `words` off the shared backing on overflow: the main thread
// reads the same SAB in place, so a worker-private grow would (a) hide overflow records and (b) push
// `head` past the SAB → NaN-opcode crash in the apply decode. Instead the worker CAPS encoding, sets
// `overflowed`, keeps `head <= words.length`, and the records that fit are applied without loss or
// throw. A GROWABLE (plain-AB, postMessage-fallback) buffer still doubles and never caps.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, handleIndex } from '@ecsia/core'
import type { World } from '@ecsia/core'
import { flushAll, makeCommandBuffer, makeEncoder, buildFieldCodec, recordLen, Op } from '@ecsia/scheduler'
import type { CommandBuffer, ComponentFieldCodec, WorldApply } from '@ecsia/scheduler'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/schema'

function kit() {
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const world = createWorld({ components: [Health], maxEntities: 1 << 12 })
  const codecById = new Map<number, ComponentFieldCodec>([[(Health as unknown as { id: number }).id, buildFieldCodec(Health)]])
  return { world, Health, codecById }
}

function worldApplyOf(world: World, codecById: ReadonlyMap<number, ComponentFieldCodec>, warn: (m: string) => void): WorldApply {
  const layout = world.handleLayout
  const apply = world.__apply
  return {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: (id) => codecById.get(id as unknown as number),
    addMany: (h, defs) => apply.addMany(h, defs),
    removeMany: (h, defs) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    warn,
  }
}

function encoderOver(cb: CommandBuffer, Health: ComponentDef<Schema>, warn: (m: string) => void) {
  return makeEncoder({
    cb,
    infoOf: (def) => ({ id: (def as unknown as { id: number }).id as unknown as ComponentId, codec: buildFieldCodec(def) }),
    relationCodec: () => undefined,
    warn,
  })
}

describe('SAB command-buffer overflow caps in place (no record loss off-SAB, no apply crash)', () => {
  test('a FIXED (shared) buffer overflowed by encoding caps: head stays <= capacity, words stays the same SAB, overflowed flagged', () => {
    const { world, Health, codecById } = kit()
    // 16-word capacity is the floor (makeCommandBuffer clamps to >=16). An OP_ADD (i32) is 5 words.
    const cb = makeCommandBuffer(0, 16, /* shared */ true)
    const sab = cb.words.buffer
    const cap = cb.words.length
    const warns: string[] = []
    const enc = encoderOver(cb, Health, (m) => warns.push(m))

    const block = world.reserveEntityBlock(0, 32)
    cb.reservation = { handles: block.handles }
    cb.reservationCursor = 0

    // Encode many more records than fit. Each create()=2 words, add()=5 words ⇒ overflow well before 32.
    const created: number[] = []
    for (let i = 0; i < 32; i++) {
      const child = enc.create()
      if ((child as unknown as number) >>> 0 !== 0xffffffff) {
        created.push(child as unknown as number)
        enc.add(child, Health, { hp: i })
      }
    }

    expect(cb.overflowed).toBe(true) // the cap fired
    expect(cb.words.buffer).toBe(sab) // STILL the original SAB — never reassigned off the shared backing
    expect(cb.words.buffer instanceof SharedArrayBuffer).toBe(true)
    expect(cb.head).toBeLessThanOrEqual(cap) // head never ran past the SAB length

    // The records that FIT form a valid record stream landing exactly on `head` (CB-LEN): the decode
    // never reads a partial/garbage record → no 'corrupt command buffer' throw possible at apply.
    let at = 0
    let records = 0
    while (at < cb.head) {
      const op = cb.words[at] as Op
      expect(op === Op.CREATE || op === Op.ADD).toBe(true)
      at += recordLen(cb.words, at)
      records++
    }
    expect(at).toBe(cb.head) // lands exactly on a record boundary
    expect(records).toBe(cb.recordCount)
    expect(warns.some((m) => /buffer full|raise commandWords/i.test(m))).toBe(true) // never silent
  })

  test('apply of an overflowed FIXED buffer does not throw and applies exactly the records that fit', () => {
    const { world, Health, codecById } = kit()
    const cb = makeCommandBuffer(0, 16, true)
    const enc = encoderOver(cb, Health, () => {})
    const block = world.reserveEntityBlock(0, 32)
    cb.reservation = { handles: block.handles }
    cb.reservationCursor = 0

    const created: import('@ecsia/core').EntityHandle[] = []
    for (let i = 0; i < 32; i++) {
      const child = enc.create()
      if ((child as unknown as number) >>> 0 !== 0xffffffff) {
        created.push(child)
        enc.add(child, Health, { hp: i })
      }
    }
    expect(cb.overflowed).toBe(true)

    // Mirror the main-thread reader's defensive clamp: head must never exceed the SAB it holds.
    expect(cb.head).toBeLessThanOrEqual(cb.words.length)
    expect(() => flushAll(worldApplyOf(world, codecById, () => {}), [cb])).not.toThrow()

    // Genuinely capped (fewer creates than attempted), every applied create is alive AND carries the
    // Health the OP_ADD that fit alongside it added — no loss of any record the buffer actually holds.
    const appliedCreates = cb.appliedCreateCount
    expect(appliedCreates).toBeLessThan(32)
    expect(appliedCreates).toBeGreaterThan(0)
    // Every applied create is alive. Its paired OP_ADD applied too, EXCEPT possibly the very last
    // create whose following add was the record that overflowed — so Health-carriers are
    // appliedCreates or appliedCreates-1 (the boundary record), never fewer (no interior loss).
    let withHealth = 0
    for (let i = 0; i < appliedCreates; i++) {
      expect(world.isAlive(created[i]!)).toBe(true)
      if (world.has(created[i]!, Health)) withHealth++
    }
    expect(withHealth).toBeGreaterThanOrEqual(appliedCreates - 1)
  })

  test('a GROWABLE (plain-AB) buffer still doubles past its initial size and never caps (fallback transport)', () => {
    const { world, Health, codecById } = kit()
    const cb = makeCommandBuffer(0, 16, /* shared */ false)
    const enc = encoderOver(cb, Health, () => {})
    const block = world.reserveEntityBlock(0, 64)
    cb.reservation = { handles: block.handles }
    cb.reservationCursor = 0

    const created: import('@ecsia/core').EntityHandle[] = []
    for (let i = 0; i < 64; i++) {
      const child = enc.create()
      expect((child as unknown as number) >>> 0).not.toBe(0xffffffff) // never capped — it grows
      created.push(child)
      enc.add(child, Health, { hp: i })
    }
    expect(cb.overflowed).toBe(false) // a growable buffer never overflows
    expect(cb.words.length).toBeGreaterThan(16) // it grew
    expect(cb.words.buffer instanceof SharedArrayBuffer).toBe(false) // private AB
    flushAll(worldApplyOf(world, codecById, () => {}), [cb])
    // ALL 64 records applied: every child is alive AND carries Health.
    expect(cb.appliedCreateCount).toBe(64)
    for (const child of created) {
      expect(world.isAlive(child)).toBe(true)
      expect(world.has(child, Health)).toBe(true)
    }
  })
})
