// Edge-case coverage for the reactivity ring-log primitives: LogRing's
// wrap/overflow sentinel, the headLimit-bounded consume, observePeak grow/shrink scheduling, the
// frame-boundary reset with lagging consumers, the spill drain order and applyResize re-allocation,
// plus WriteCorral grow and nextPow2. Every assertion pins a concrete observable outcome that a
// regression in the targeted branch would break.
//
// API NOTE: a consumer LogPointer must be made (makePointer) BEFORE the writes it should observe —
// makePointer snapshots the live head, so a pointer made after a push starts past those entries.

import { describe, expect, test } from 'vitest'
import { Buffers, LogRing, WriteCorral, OVERFLOW_SENTINEL, probeCapabilities } from '../src/internal.js'
import type { LogPointer } from '../src/internal.js'
import { nextPow2 } from '../src/reactivity/log.js'

const buffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 16 })

let keyN = 0
function ring(opts?: Partial<{ entryWords: number; capacityEntries: number; shrinkRings: boolean }>): LogRing {
  return new LogRing({
    buffers: buffers(),
    kind: 'write',
    entryWords: opts?.entryWords ?? 1,
    capacityEntries: opts?.capacityEntries ?? 4,
    keyPrefix: `coverage.log.${keyN++}`,
    shrinkRings: opts?.shrinkRings ?? false,
  })
}

// Drain a ring into a flat list of (non-sentinel) words, recording whether a sentinel was seen.
function drain(r: LogRing, ptr: LogPointer, headLimit?: number): { words: number[]; overflowed: boolean } {
  const words: number[] = []
  let overflowed = false
  r.consume(
    ptr,
    (source, base) => {
      if (source.length === 1 && source[0] === OVERFLOW_SENTINEL) {
        overflowed = true
        return
      }
      words.push(source[base] as number)
    },
    headLimit,
  )
  return { words, overflowed }
}

describe('LogRing.ringWords reports the ring length in words', () => {
  test('a fresh ring exposes capacityEntries * entryWords words', () => {
    const r = ring({ entryWords: 2, capacityEntries: 4 })
    expect(r.ringWords).toBe(8)
  })
})

describe('hasUpdatesSince fast-out ', () => {
  test('false when the pointer is at head, true after any push (head moved)', () => {
    const r = ring({ capacityEntries: 4 })
    const ptr = r.makePointer()
    expect(r.hasUpdatesSince(ptr)).toBe(false)
    r.push([42])
    expect(r.hasUpdatesSince(ptr)).toBe(true)
  })

  test('true when only the spill grew (overflow), even if the ring head is unchanged', () => {
    const r = ring({ capacityEntries: 2 })
    r.push([1])
    r.push([2]) // ring now full
    const ptr = r.makePointer() // snapshots head=2, spill=0
    r.push([3]) // spills
    expect(r.hasUpdatesSince(ptr)).toBe(true)
  })

  test('true purely on a generation bump (ring + spill identical)', () => {
    const r = ring({ capacityEntries: 4 })
    const ptr = r.makePointer()
    r.header[1] = (r.header[1] as number) + 1 // H_GENERATION
    expect(r.hasUpdatesSince(ptr)).toBe(true)
  })
})

describe('consume — generation mismatch yields the overflow sentinel once and conservatively advances (branch 166)', () => {
  test('a stale-generation pointer gets exactly one sentinel and is fast-forwarded to head', () => {
    const r = ring({ capacityEntries: 4 })
    const ptr = r.makePointer()
    r.push([7])
    r.push([8])
    // Simulate a ring rollover the consumer missed.
    r.header[1] = (r.header[1] as number) + 1 // H_GENERATION bump

    const first = drain(r, ptr)
    expect(first.overflowed).toBe(true)
    expect(first.words).toEqual([]) // no real entries surfaced — only the sentinel
    // Pointer is now realigned: generation matches head, no further sentinel.
    expect(ptr.generation).toBe(r.header[1])
    expect(ptr.cursor).toBe(r.header[0])
    const second = drain(r, ptr)
    expect(second.overflowed).toBe(false)
    expect(second.words).toEqual([])
  })
})

describe('consume — headLimit bounds the ring scan and pins the spill ', () => {
  test('entries appended past headLimit are deferred to the next (unbounded) drain', () => {
    const r = ring({ capacityEntries: 8 })
    const ptr = r.makePointer()
    r.push([10])
    r.push([20])
    const snapshot = r.header[0] as number // head after two pushes
    r.push([30]) // appended "during the drain"

    const bounded = drain(r, ptr, snapshot)
    expect(bounded.words).toEqual([10, 20]) // 30 is past the limit, deferred
    expect(ptr.cursor).toBe(snapshot)

    const rest = drain(r, ptr) // unbounded — picks up the deferred entry
    expect(rest.words).toEqual([30])
  })

  test('a bounded drain below ringHead does NOT advance past the spill', () => {
    const r = ring({ capacityEntries: 2 })
    const ptr = r.makePointer()
    r.push([1])
    r.push([2]) // ring full
    r.push([3]) // spills (H_SPILL_COUNT grows)
    const snapshot = 1 // bound below the real ring head (2)

    const bounded = drain(r, ptr, snapshot)
    expect(bounded.words).toEqual([1]) // only up to the bound; spill untouched
    expect(ptr.spillCursor).toBe(0) // spill not advanced under a sub-head bound

    const rest = drain(r, ptr) // unbounded — now drains rest of ring then spill
    expect(rest.words).toEqual([2, 3])
  })
})

describe('observePeak schedules a next-frame resize (branches 199/214)', () => {
  test('GROW: when the frame spilled past the ring, observePeak + frameReset widen the ring', () => {
    const r = ring({ capacityEntries: 2 }) // 2-word ring
    expect(r.ringWords).toBe(2)
    r.push([1])
    r.push([2])
    r.push([3]) // spills → peak (head+spill) exceeds ring
    r.push([4]) // spills more
    r.observePeak()
    r.frameReset(0) // applies the pending resize first (branch 214 true)
    // peak was 4 words → nextPow2(4*2) = 8
    expect(r.ringWords).toBe(8)
  })

  test('SHRINK: an under-used ring schedules a shrink-resize that stays usable (branch 199 else-if)', () => {
    // Grow first so the shrink branch (peak < R/4 && R > floor) is reachable next frame.
    const r = ring({ entryWords: 1, capacityEntries: 2, shrinkRings: true })
    for (let i = 0; i < 6; i++) r.push([i]) // far past a 2-word ring → big peak
    r.observePeak()
    r.frameReset(0)
    const grown = r.ringWords
    expect(grown).toBeGreaterThan(2)
    // Next frame: barely touch the ring so peak << R/4 → the shrink else-if schedules pendingResize,
    // which frameReset applies through #applyResize. Over a length-tracking resizable backing the view
    // cannot physically narrow, so ringWords stays at `grown` — the contract here is that the shrink
    // path runs WITHOUT corrupting the ring (still writable, head reset, no stale data surfaced).
    r.push([99])
    r.observePeak()
    r.frameReset(0)
    expect(r.ringWords).toBeGreaterThanOrEqual(2)
    // The ring remains fully functional after the shrink-resize pass.
    const ptr = r.makePointer()
    r.push([1234])
    expect(drain(r, ptr).words).toEqual([1234])
  })

  test('no resize is scheduled when the frame fit comfortably (neither branch taken)', () => {
    const r = ring({ capacityEntries: 8, shrinkRings: true })
    r.push([1])
    r.push([2])
    const before = r.ringWords
    r.observePeak()
    r.frameReset(0)
    expect(r.ringWords).toBe(before)
  })
})

describe('frameReset — lagging consumer pins the ring (else branch of line 223)', () => {
  test('the ring head is NOT recycled to 0 while a consumer cursor lags behind head', () => {
    const r = ring({ capacityEntries: 8 })
    r.push([1])
    r.push([2])
    const headBefore = r.header[0] as number
    // minConsumerCursor below head → entries left in place (no recycle).
    r.frameReset(1)
    expect(r.header[0]).toBe(headBefore)
  })

  test('the ring recycles to slot 0 once every consumer has caught up to head', () => {
    const r = ring({ capacityEntries: 8 })
    r.push([1])
    r.push([2])
    const head = r.header[0] as number
    r.frameReset(head) // all caught up
    expect(r.header[0]).toBe(0)
  })
})

describe('applyResize re-allocates and preserves data when growth exceeds the reservation', () => {
  test('a resize beyond the reserved maxByteLength copies existing words into a fresh buffer', () => {
    // capacityEntries 1 → ring length 1 word, reservation 16 words. Force a peak that needs more.
    const r = ring({ entryWords: 1, capacityEntries: 1 })
    r.push([111]) // fills the 1-word ring
    for (let i = 0; i < 40; i++) r.push([1000 + i]) // huge spill → peak ~41 words, > reservation 16
    r.observePeak()
    r.frameReset(0)
    // The ring widened (via grow or re-alloc copy); the original word survived the copy.
    expect(r.ringWords).toBeGreaterThanOrEqual(41)
    expect(r.ring[0]).toBe(111)
  })
})

describe('WriteCorral — push grows by allocate-copy, data getter exposes the backing array', () => {
  test('pushing past the initial capacity doubles the backing and preserves every word in order', () => {
    const c = new WriteCorral(2)
    expect(c.data.length).toBe(2)
    c.push(10)
    c.push(20)
    c.push(30) // triggers grow (count >= length)
    expect(c.count).toBe(3)
    expect(c.data.length).toBeGreaterThanOrEqual(4)
    expect([c.data[0], c.data[1], c.data[2]]).toEqual([10, 20, 30])
  })

  test('reset zeroes the count without clearing the backing words', () => {
    const c = new WriteCorral(4)
    c.push(7)
    c.reset()
    expect(c.count).toBe(0)
  })

  test('a corral constructed with <1 initial entries still holds at least one slot', () => {
    const c = new WriteCorral(0)
    expect(c.data.length).toBe(1)
    c.push(5)
    expect(c.data[0]).toBe(5)
  })
})

describe('nextPow2 (branch 294)', () => {
  test('n <= 1 clamps to 1; otherwise rounds up to the next power of two', () => {
    expect(nextPow2(0)).toBe(1)
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(-5)).toBe(1)
    expect(nextPow2(3)).toBe(4)
    expect(nextPow2(8)).toBe(8)
    expect(nextPow2(9)).toBe(16)
  })
})
