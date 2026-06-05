import { describe, expect, test } from 'vitest'
import { decodeEid, encodeEid, makeColumnLayout } from '@ecsia/core'
import { Buffers, probeCapabilities, selectBacking, stringIndexElement, tokenToColumnLayout } from '../src/internal.js'
import { vec, staticString, object } from '@ecsia/core'
import type { ColumnKey, RegionKey } from '@ecsia/core'

const k = (s: string): ColumnKey => s as ColumnKey

describe('buffer layer — backing selection (memory-buffers.md §4.3)', () => {
  test('single → resizable-ab when resizable AB is available', () => {
    expect(selectBacking('single', false, false, true)).toBe('resizable-ab')
    expect(selectBacking('single', false, false, false)).toBe('grow-patch-ab')
  })

  test("'sab' throws without SAB, picks resizable-sab when present", () => {
    expect(() => selectBacking('sab', false, false, true)).toThrow()
    expect(selectBacking('sab', true, true, true)).toBe('resizable-sab')
    expect(selectBacking('sab', true, false, true)).toBe('grow-patch-sab')
  })

  test("'auto' degrades to AB and emits a diagnostic when SAB is unavailable", () => {
    let msg = ''
    expect(selectBacking('auto', false, false, true, (m) => (msg = m))).toBe('resizable-ab')
    expect(msg).toMatch(/single-threaded/)
  })

  test('probeCapabilities returns a frozen record', () => {
    const caps = probeCapabilities('single')
    expect(Object.isFrozen(caps)).toBe(true)
    expect(caps.backing === 'resizable-ab' || caps.backing === 'grow-patch-ab').toBe(true)
  })
})

describe('field-type → ColumnLayout table (memory-buffers.md §3.2)', () => {
  test('eid → i32, -1 sentinel fill (C-2)', () => {
    const layout = tokenToColumnLayout('eid', -1)
    expect(layout?.element).toBe('i32')
    expect(layout?.stride).toBe(1)
    expect(layout?.fillOnInit).toBe(-1)
  })

  test('staticString → smallest uint covering choices', () => {
    expect(stringIndexElement(2)).toBe('u8')
    expect(stringIndexElement(256)).toBe('u8')
    expect(stringIndexElement(257)).toBe('u16')
    expect(stringIndexElement(70_000)).toBe('u32')
    expect(tokenToColumnLayout(staticString('a', 'b'))?.element).toBe('u8')
  })

  test('vecN → stride n', () => {
    expect(tokenToColumnLayout(vec('f32', 3))?.stride).toBe(3)
  })

  test('object<T> → no column', () => {
    expect(tokenToColumnLayout(object<{ mesh: number }>())).toBeNull()
  })

  test('encodeEid/decodeEid round-trips and reserves -1 for null', () => {
    expect(decodeEid(-1)).toBeNull()
    const h = 0x90000005
    expect(decodeEid(encodeEid(h))).toBe(h)
  })
})

describe('V-1 length-tracking growth (memory-buffers.md §7.1, §7.2)', () => {
  const buffers = (): Buffers =>
    new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

  test('a captured view widens after grow on the primary (resizable) path', () => {
    const caps = probeCapabilities('single')
    const b = new Buffers({ capabilities: caps, maxEntities: 1 << 20 })
    const layout = makeColumnLayout('f32', 1)
    const col = b.column(k('0:1.0'), layout, 4)
    const captured = col.view as Float32Array
    expect(captured.length).toBe(4)
    captured[3] = 42

    b.grow(col, 16)

    if (caps.backing === 'resizable-ab') {
      // PRIMARY: same view object, auto-widened, old data preserved.
      expect(col.view).toBe(captured)
      expect(captured.length).toBe(16)
      expect(captured[3]).toBe(42)
    } else {
      // FALLBACK: re-pointed, but data still preserved.
      expect((col.view as Float32Array).length).toBe(16)
      expect(col.view[3]).toBe(42)
    }
  })

  test('grow is a no-op when already large enough', () => {
    const b = buffers()
    const col = b.column(k('0:2.0'), makeColumnLayout('f32', 1), 16)
    const before = col.view
    b.grow(col, 8)
    expect(col.view).toBe(before)
  })

  test('eid column fills fresh AND grown rows with -1 (C-2)', () => {
    const b = buffers()
    const col = b.column(k('0:3.0'), makeColumnLayout('i32', 1, -1), 4)
    const view = col.view as Int32Array
    expect([...view]).toEqual([-1, -1, -1, -1])
    b.grow(col, 8)
    expect([...(col.view as Int32Array)]).toEqual([-1, -1, -1, -1, -1, -1, -1, -1])
  })

  test('column() is idempotent per key', () => {
    const b = buffers()
    const a = b.column(k('0:4.0'), makeColumnLayout('u32', 1), 4)
    const again = b.column(k('0:4.0'), makeColumnLayout('u32', 1), 4)
    expect(again).toBe(a)
  })
})

describe('region allocation (memory-buffers.md §5.4)', () => {
  test('fixed region holds maxEntities-sized capacity and a fill', () => {
    const b = new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })
    const reg = b.region('entity.archetypeId' as RegionKey, 'u32', 8, { fixed: true, fill: 7 })
    expect(reg.capacity()).toBe(8)
    expect([...(reg.view as Uint32Array)]).toEqual([7, 7, 7, 7, 7, 7, 7, 7])
  })
})
