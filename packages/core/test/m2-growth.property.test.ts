// property suite.
// Random .grow() sequences interleaved with writes pin the three serial-phase observable invariants:
// a view CAPTURED BEFORE growth still reads values written AFTER growth at high rows
// (length-tracking widening). NEGATIVE CONTROL proves the test discriminates: a view built
// WITH an explicit length does NOT widen.
// view.length === capacity()*stride at every observable point.
// column .buffer identity is stable across growth on the primary (resizable) path.
//
// This env probes 'resizable-ab' (Node, single mode) so the primary path is exercised. Each test
// asserts the primary-path property only under a resizable backing and degrades its assertion to the
// fallback contract otherwise, so the suite stays correct on a non-resizable engine too.

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { makeColumnLayout } from '@ecsia/core'
import { Buffers, probeCapabilities } from '../src/internal.js'
import type { ColumnKey } from '@ecsia/core'

const k = (s: string): ColumnKey => s as ColumnKey

const caps = probeCapabilities('single')
const isPrimary = caps.backing === 'resizable-ab'
const newBuffers = (): Buffers => new Buffers({ capabilities: caps, maxEntities: 1 << 20 })

// A growth plan: a strictly increasing sequence of target capacities plus a row to write at each
// step. Targets stay <= 4000 and columns start at initialCapacity 256 so the
// (256*16 = 4096 rows) covers every target — the PRIMARY in-place `.grow()` is exercised throughout
// (exceeding the reservation would legitimately escalate to the fallback re-alloc, a separate path).
const RESERVE_INITIAL = 256
const growPlan = fc
  .array(fc.integer({ min: 1, max: 4000 }), { minLength: 1, maxLength: 12 })
  .map((caps_) => [...caps_].sort((a, b) => a - b))

describe(': a pre-grow length-tracking view widens to read post-grow high-row writes', () => {
  test('captured view reads values written after grow at high rows', () => {
    fc.assert(
      fc.property(growPlan, fc.float({ noNaN: true, min: -1e6, max: 1e6 }), (targets, value) => {
        const b = newBuffers()
        const col = b.column(k(`vg:${targets.join('-')}.0`), makeColumnLayout('f32', 1), RESERVE_INITIAL)
        // Capture the view BEFORE any grow (the accessor-closure analogue).
        const captured = col.view as Float32Array

        let lastRow = -1
        for (const target of targets) {
          b.grow(col, target)
          // Write to the highest row the (now-grown) capacity allows, through the LIVE column view.
          const row = col.capacity() - 1
          ;(col.view as Float32Array)[row] = Math.fround(value)
          lastRow = row
        }

        if (isPrimary) {
          // Same view object, auto-widened: the pre-grow capture reads the post-grow high-row write.
          expect(col.view).toBe(captured)
          expect(captured[lastRow]).toBe(Math.fround(value))
        } else {
          // Fallback: col.view is re-pointed; the live view still reads correctly.
          expect((col.view as Float32Array)[lastRow]).toBe(Math.fround(value))
        }
      }),
      { numRuns: 200 },
    )
  })

  // NEGATIVE CONTROL: a view built WITH an explicit length does NOT widen. If 's library code
  // ever built views with an explicit length, the positive test above would read garbage at high
  // rows; this control proves the captured-view test discriminates that difference.
  test('NEGATIVE CONTROL: an explicit-length view does NOT widen on grow', () => {
    if (!isPrimary) {
      // The control is only meaningful on a resizable backing (the only place widening is possible).
      return
    }
    const b = newBuffers()
    const col = b.column(k('vg-neg.0'), makeColumnLayout('f32', 1), 1)
    // Explicit-length view (the BUG forbids): frozen window at construction.
    const frozen = new Float32Array(col.backing, 0, col.capacity())
    expect(frozen.length).toBe(1)

    b.grow(col, 64)

    // The length-tracking column view widened…
    expect(col.view.length).toBe(64)
    // …but the explicit-length view did NOT (proving the positive test discriminates).
    expect(frozen.length).toBe(1)
  })
})

describe(': view.length === capacity()*stride at every observable point', () => {
  test('holds across random grow sequences for scalar and vec strides', () => {
    fc.assert(
      fc.property(growPlan, fc.constantFrom(1, 2, 3, 4), (targets, stride) => {
        const b = newBuffers()
        const col = b.column(k(`c1:${stride}:${targets.join('-')}.0`), makeColumnLayout('f32', stride), 1)
        // Invariant at allocation.
        expect(col.view.length).toBe(col.capacity() * stride)
        for (const target of targets) {
          b.grow(col, target)
          expect(col.view.length).toBe(col.capacity() * stride)
        }
      }),
      { numRuns: 200 },
    )
  })
})

describe(': column SAB/AB identity is stable across growth on the primary path', () => {
  // Start with initialCapacity 256 so the (initial*16 = 4096 rows) comfortably
  // covers every grow target below — the primary in-place `.grow()` is exercised the whole way, so
  // backing identity MUST be preserved. (Exceeding the reservation legitimately escalates to the
  // fallback re-alloc,; that path is covered by /'s fallback branches, not here.)
  const INITIAL = 256
  const withinReservation = fc
    .array(fc.integer({ min: 1, max: 4000 }), { minLength: 1, maxLength: 12 })
    .map((c) => [...c].sort((a, b) => a - b))

  test('backing identity is preserved across a random in-reservation grow sequence (resizable path)', () => {
    fc.assert(
      fc.property(withinReservation, (targets) => {
        const b = newBuffers()
        const col = b.column(k(`b2:${targets.join('-')}.0`), makeColumnLayout('u32', 1), INITIAL)
        const backing0 = col.backing
        for (const target of targets) b.grow(col, target)
        if (isPrimary) {
          // Same buffer object after every grow — what makes zero-copy worker sharing safe.
          expect(col.backing).toBe(backing0)
        } else {
          // Non-resizable engine: fallback re-allocates; the view still length-matches capacity.
          expect(col.view.length).toBe(col.capacity())
        }
      }),
      { numRuns: 200 },
    )
  })
})
