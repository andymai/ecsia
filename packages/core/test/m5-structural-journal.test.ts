// Direct unit suite for the persistent STRUCTURAL JOURNAL (). Drives the bounded drop-oldest ring, the evicted-tick gap flag, the
// lazy-enable opt-out, and tick-wrap reset — the branches the world-driven suites never reach.

import { describe, expect, test } from 'vitest'
import { StructuralJournal } from '../src/reactivity/structural-journal.js'
import { ShapeKind } from '../src/reactivity/log.js'

const j = (cap?: number): StructuralJournal => new StructuralJournal(cap)

describe('StructuralJournal — lazy opt-in', () => {
  test('disabled journal records nothing and drainSince returns no gap', () => {
    const sj = j()
    // default-disabled: every record is a no-op (zero record cost until a serializer attaches).
    sj.record(5, ShapeKind.Create, 0xaaaa, 0, 0)
    sj.record(6, ShapeKind.Add, 0xbbbb, 7, 0)
    const drained = sj.drainSince(0)
    expect(drained.records).toEqual([])
    expect(drained.gap).toBe(false)
  })

  test('enabling mid-stream only captures ops appended after enable', () => {
    const sj = j()
    sj.record(1, ShapeKind.Create, 0x1, 0, 0) // dropped (disabled)
    sj.enabled = true
    sj.record(2, ShapeKind.Add, 0x2, 9, 0)
    const { records } = sj.drainSince(0)
    expect(records.map((r) => r.tick)).toEqual([2])
    expect(records[0]?.handle).toBe(0x2)
    expect(records[0]?.componentId).toBe(9)
  })
})

describe('StructuralJournal — drainSince filtering + record fidelity', () => {
  test('returns only ops with tick strictly greater than `since`, in commit order', () => {
    const sj = j()
    sj.enabled = true
    sj.record(1, ShapeKind.Create, 0x10, 0, 0)
    sj.record(2, ShapeKind.Add, 0x11, 4, 0)
    sj.record(2, ShapeKind.AddPair, 0x12, 5, 0x99) // same tick, later commit
    sj.record(3, ShapeKind.Remove, 0x13, 6, 0)

    const { records, gap } = sj.drainSince(2)
    expect(gap).toBe(false)
    // tick <= 2 excluded; tick 3 kept (strict >).
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ tick: 3, kind: ShapeKind.Remove, handle: 0x13, componentId: 6, target: 0 })
  })

  test('pair record carries target handle; commit order preserved across equal ticks', () => {
    const sj = j()
    sj.enabled = true
    sj.record(5, ShapeKind.AddPair, 0x20, 8, 0x77)
    sj.record(5, ShapeKind.RemovePair, 0x21, 8, 0x78)
    const { records } = sj.drainSince(4)
    expect(records.map((r) => [r.kind, r.handle, r.target])).toEqual([
      [ShapeKind.AddPair, 0x20, 0x77],
      [ShapeKind.RemovePair, 0x21, 0x78],
    ])
  })

  test('drainSince at/after the newest tick yields nothing (no spurious replay)', () => {
    const sj = j()
    sj.enabled = true
    sj.record(7, ShapeKind.Add, 0x30, 1, 0)
    expect(sj.drainSince(7).records).toEqual([])
    expect(sj.drainSince(8).records).toEqual([])
  })
})

describe('StructuralJournal — bounded ring drop-oldest + evicted-gap flag', () => {
  test('within capacity: full history is resident, no gap for since < oldest', () => {
    const sj = j(16) // capacity clamps to a minimum of 16
    sj.enabled = true
    for (let t = 1; t <= 16; t++) sj.record(t, ShapeKind.Add, t, t, 0)
    const { records, gap } = sj.drainSince(0)
    expect(gap).toBe(false)
    expect(records).toHaveLength(16)
    expect(records.map((r) => r.tick)).toEqual([...Array(16)].map((_, i) => i + 1))
  })

  test('overflow drops the oldest records; a since predating the live window flags a gap', () => {
    const cap = 16
    const sj = j(cap)
    sj.enabled = true
    // Append 24 (> cap) — the first 8 ticks (1..8) are evicted; window is ticks 9..24.
    for (let t = 1; t <= 24; t++) sj.record(t, ShapeKind.Add, t, t, 0)

    // since=5 predates the oldest resident (tick 9) → gap, caller must resync from a snapshot.
    const old = sj.drainSince(5)
    expect(old.gap).toBe(true)
    // Even with a gap, the resident records are returned (caller decides to discard + resync).
    expect(old.records.map((r) => r.tick)).toEqual([...Array(16)].map((_, i) => i + 9))

    // since=12 is inside the live window → no gap, only ticks 13..24.
    const fresh = sj.drainSince(12)
    expect(fresh.gap).toBe(false)
    expect(fresh.records.map((r) => r.tick)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  })

  test('since exactly equal to oldest resident tick is NOT a gap (boundary is strict <)', () => {
    const cap = 16
    const sj = j(cap)
    sj.enabled = true
    for (let t = 1; t <= 20; t++) sj.record(t, ShapeKind.Add, t, t, 0) // evicts 1..4, oldest resident = 5
    const at = sj.drainSince(5)
    expect(at.gap).toBe(false) // since === oldestResidentTick → not < it
    expect(at.records.map((r) => r.tick)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })
})

describe('StructuralJournal — tick-wrap reset', () => {
  test('resetAll clears the window so subsequent records start fresh with no gap', () => {
    const cap = 16
    const sj = j(cap)
    sj.enabled = true
    for (let t = 1; t <= 30; t++) sj.record(t, ShapeKind.Add, t, t, 0)
    expect(sj.drainSince(2).gap).toBe(true) // pre-reset: evicted

    sj.resetAll()
    // After reset count=0: a drain sees nothing and never reports a gap.
    expect(sj.drainSince(0)).toEqual({ records: [], gap: false })

    // New records after reset replay cleanly from tick 0.
    sj.record(1, ShapeKind.Create, 0xfeed, 0, 0)
    const after = sj.drainSince(0)
    expect(after.gap).toBe(false)
    expect(after.records).toHaveLength(1)
    expect(after.records[0]?.handle).toBe(0xfeed)
  })
})
