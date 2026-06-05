// Coverage: commands/op.ts recordLen (REMOVE=3, ADD_PAIR variable len, corrupt-opcode throw) and
// commands/buffer.ts ensureWords growth from a zero-length view (the `newLen === 0? need` branch).

import { describe, expect, test } from 'vitest'
import { recordLen, Op, makeCommandBuffer, ensureWords } from '../src/internal.js'
import type { CommandBuffer } from '../src/internal.js'

describe('op.ts: recordLen is self-describing per opcode ', () => {
  test('fixed-arity ops report their constant length', () => {
    const w = new Uint32Array(8)
    w[0] = Op.CREATE
    expect(recordLen(w, 0)).toBe(2)
    w[0] = Op.DESTROY
    expect(recordLen(w, 0)).toBe(2)
    w[0] = Op.REMOVE // line 32 — the 3-word REMOVE record
    expect(recordLen(w, 0)).toBe(3)
    w[0] = Op.REMOVE_PAIR
    expect(recordLen(w, 0)).toBe(4)
  })

  test('ADD / SET_PAYLOAD length = 4 + fieldWordCount (variable, read from word[at+3])', () => {
    const w = new Uint32Array(8)
    w[0] = Op.ADD
    w[3] = 5 // fieldWordCount
    expect(recordLen(w, 0)).toBe(9)
    w[0] = Op.SET_PAYLOAD
    w[3] = 0 // tag-style add, zero payload
    expect(recordLen(w, 0)).toBe(4)
  })

  test('ADD_PAIR length = 5 + payloadWordCount (read from word[at+4])', () => {
    const w = new Uint32Array(8)
    w[0] = Op.ADD_PAIR
    w[4] = 3 // payloadWordCount
    expect(recordLen(w, 0)).toBe(8)
    w[4] = 0 // deferred tag pair
    expect(recordLen(w, 0)).toBe(5)
  })

  test('recordLen reads at an arbitrary offset (the merge loop advances `at`)', () => {
    const w = new Uint32Array(16)
    w[6] = Op.ADD
    w[9] = 2 // fieldWordCount at offset 6+3
    expect(recordLen(w, 6)).toBe(6)
  })

  test('a corrupt opcode throws naming the offset (line 41, branch 40)', () => {
    const w = new Uint32Array(4)
    w[0] = 42 // not a valid Op
    expect(() => recordLen(w, 0)).toThrow(/corrupt command buffer: bad opcode 42 at 0/)
  })
})

describe('buffer.ts: ensureWords growth (branch 95)', () => {
  test('a growable buffer doubles to fit and preserves already-written words', () => {
    const cb = makeCommandBuffer(0, 16, false)
    cb.words[0] = 0xabcd
    cb.head = 16 // full
    expect(cb.words.length).toBe(16)
    expect(ensureWords(cb, 8)).toBe(true) // must grow
    expect(cb.words.length).toBeGreaterThanOrEqual(24)
    expect(cb.words[0]).toBe(0xabcd) // prior content carried over (next.set(subarray))
  })

  test('ensureWords on a zero-length view jumps straight to `need` (newLen === 0 branch)', () => {
    // Force the degenerate `newLen === 0` path: a growable buffer whose backing view is length 0.
    const cb: CommandBuffer = {
      workerIndex: 0,
      words: new Uint32Array(0),
      head: 0,
      recordCount: 0,
      reservation: { handles: [] },
      reservationCursor: 0,
      appliedCreateCount: 0,
      fixed: false,
      overflowed: false,
      overflowWarned: false,
    }
    expect(ensureWords(cb, 5)).toBe(true)
    // newLen started at 0 → the loop took the `newLen === 0? need` arm rather than `0 * 2` (stuck at 0).
    expect(cb.words.length).toBeGreaterThanOrEqual(5)
  })

  test('a fixed (SAB) buffer does NOT grow: it caps and flags overflow', () => {
    const cb = makeCommandBuffer(0, 16, /* shared */ true)
    const sab = cb.words.buffer
    cb.head = 16
    expect(ensureWords(cb, 4)).toBe(false) // capped, not grown
    expect(cb.overflowed).toBe(true)
    expect(cb.words.buffer).toBe(sab) // still the same SAB
  })

  test('ensureWords returns true without growing when the record already fits', () => {
    const cb = makeCommandBuffer(0, 16, false)
    cb.head = 4
    expect(ensureWords(cb, 8)).toBe(true)
    expect(cb.words.length).toBe(16) // no growth needed
  })
})
