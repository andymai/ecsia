// Edge-case coverage for the memory layer's reachable corners: tokenToColumnLayout's unknown-token
// throws + the object/vec/staticString branches, fieldToColumnLayout's null-default → eid fill,
// Buffers.get lookup, the zero-copy snapshotInto / rowSlice / sharedBacking serialization helpers,
// region idempotency, and the grow primary-path "reservation exhausted" clamp. The resizable-ctor
// try/catch fallbacks (allocU32.ts:51-52,59-60,118; buffers.ts:48-49) are UNREACHABLE on this Node
// runtime (resizable {Shared}ArrayBuffer + plain-AB resize() are all present) — noted, not gamed.

import { describe, expect, test } from 'vitest'
import { makeColumnLayout, staticString, vec } from '@ecsia/core'
import { Buffers, fieldToColumnLayout, probeCapabilities, resolveDescriptor, rowSlice, sharedBacking, snapshotInto, tokenToColumnLayout } from '../src/internal.js'
import type { ColumnKey, FieldToken, RegionKey, RuntimeCapabilities } from '@ecsia/core'

const k = (s: string): ColumnKey => s as ColumnKey
const r = (s: string): RegionKey => s as RegionKey

const caps = (backing: RuntimeCapabilities['backing']): RuntimeCapabilities =>
  Object.freeze({
    sabAvailable: backing.includes('sab'),
    resizableSab: backing === 'resizable-sab',
    resizableAb: backing === 'resizable-ab',
    waitAsync: false,
    waitBlocking: false,
    crossOriginIsolated: undefined,
    backing,
  })

const newBuffers = (): Buffers => new Buffers({ capabilities: probeCapabilities('single'), maxEntities: 1 << 20 })

describe('layout — tokenToColumnLayout / fieldToColumnLayout branches', () => {
  test('an unknown scalar token throws (layout.ts:127)', () => {
    expect(() => tokenToColumnLayout('nope' as unknown as FieldToken)).toThrow(/unsupported scalar field type/)
  })

  test('an unknown vec element token throws (layout.ts:132)', () => {
    expect(() => tokenToColumnLayout({ kind: 'vec', elem: 'bogus', len: 2 } as unknown as FieldToken)).toThrow(
      /unsupported vec element type/,
    )
  })

  test('vec / staticString tokens project to stride / smallest-uint layouts (layout.ts:130,135)', () => {
    expect(tokenToColumnLayout(vec('f64', 4))).toMatchObject({ element: 'f64', stride: 4 })
    expect(tokenToColumnLayout(staticString('a', 'b'))).toMatchObject({ element: 'u8', stride: 1 })
  })

  test('fieldToColumnLayout: an object field yields null; an eid field fills -1 (layout.ts:144-145,153)', () => {
    const objField = resolveDescriptor('mesh', { kind: 'object' } as unknown as FieldToken)
    expect(fieldToColumnLayout(objField)).toBeNull()

    // eid's resolved default is null/undefined-equivalent → toFillValue falls through to EID_NULL (-1).
    const eidField = resolveDescriptor('target', 'eid')
    expect(eidField.needsExplicitInit).toBe(true)
    expect(fieldToColumnLayout(eidField)?.fillOnInit).toBe(-1)
  })

  test('fieldToColumnLayout encodes a non-zero user scalar default into fillOnInit (layout.ts:154)', () => {
    const field = resolveDescriptor('hp', 'u8', 5)
    expect(field.needsExplicitInit).toBe(true)
    expect(fieldToColumnLayout(field)?.fillOnInit).toBe(5)
  })
})

describe('Buffers — get / region idempotency / serialization helpers', () => {
  test('get returns the registered column, undefined for an unknown key (buffers.ts:355)', () => {
    const b = newBuffers()
    const col = b.column(k('a:0.0'), makeColumnLayout('u32', 1), 4)
    expect(b.get(col.key)).toBe(col)
    expect(b.get(k('missing:9.9'))).toBeUndefined()
  })

  test('region is idempotent per key — a second call returns the SAME object (buffers.ts:254)', () => {
    const b = newBuffers()
    const reg1 = b.region(r('reg:once'), 'u32', 8)
    const reg2 = b.region(r('reg:once'), 'u32', 8)
    expect(reg2).toBe(reg1)
  })

  test('sharedBacking returns the SAB for a shared column, null for a plain-AB column (buffers.ts:377)', () => {
    const sabBuf = new Buffers({ capabilities: caps('grow-patch-sab'), maxEntities: 1 << 16 })
    const sabCol = sabBuf.column(k('s:0.0'), makeColumnLayout('u32', 1), 4)
    expect(sharedBacking(sabCol)).toBe(sabCol.backing)
    expect(sharedBacking(sabCol)).toBeInstanceOf(SharedArrayBuffer)

    const abBuf = new Buffers({ capabilities: caps('grow-patch-ab'), maxEntities: 1 << 16 })
    const abCol = abBuf.column(k('a:0.0'), makeColumnLayout('u32', 1), 4)
    expect(sharedBacking(abCol)).toBeNull()
  })

  test('snapshotInto copies `count` rows (stride-aware) into the out array (buffers.ts:381-387)', () => {
    const b = newBuffers()
    // vec3 column: stride 3, so snapshotInto(count=2) copies 6 elements.
    const col = b.column(k('snap:0.0'), makeColumnLayout('f32', 3), 4)
    const view = col.view as Float32Array
    for (let i = 0; i < 6; i++) view[i] = i + 1 // rows 0,1 = [1,2,3],[4,5,6]
    const out = new Float32Array(8)
    const written = snapshotInto(col, 2, out, 1)
    expect(written).toBe(6) // count(2) * stride(3)
    expect([...out]).toEqual([0, 1, 2, 3, 4, 5, 6, 0])
  })

  test('rowSlice returns a zero-copy subarray for one vec row (buffers.ts:391-393)', () => {
    const b = newBuffers()
    const col = b.column(k('slice:0.0'), makeColumnLayout('i32', 3), 4)
    const view = col.view as Int32Array
    view.set([10, 20, 30], 3) // row 1
    const slice = rowSlice(col, 1) as Int32Array
    expect([...slice]).toEqual([10, 20, 30])
    // Zero-copy: writing through the slice mutates the column.
    slice[0] = 99
    expect((col.view as Int32Array)[3]).toBe(99)
  })
})

describe('Buffers.grow — primary path (buffers.ts:290-303)', () => {
  test('a resizable column grows in place; the length-tracking view widens (no fallback)', () => {
    const b = new Buffers({ capabilities: caps('resizable-ab'), maxEntities: 1 << 16 })
    const col = b.column(k('grow:0.0'), makeColumnLayout('u32', 1), 4)
    const before = col.view
    ;(before as Uint32Array)[3] = 0xfeed
    b.grow(col, 64)
    // Resizable in place: same backing object, view auto-widened, data preserved.
    expect(col.view).toBe(before)
    expect((col.view as Uint32Array)[3]).toBe(0xfeed)
    expect((col.view as Uint32Array).length).toBeGreaterThanOrEqual(64)
  })

  test('growing past the reserved max falls back to an exact re-alloc (buffers.ts:301 else → fallback)', () => {
    // reservation = max(initialCapacity*16, 1024) = 1024 rows; growing to 2000 exceeds it, so the
    // doubling clamp cannot reach `required` and the primary path drops to #growFallback (exact alloc).
    const b = new Buffers({ capabilities: caps('resizable-ab'), maxEntities: 1 << 20, growthReserveFactor: 16, minReserveRows: 1024 })
    const col = b.column(k('grow:1.0'), makeColumnLayout('u32', 1), 4)
    ;(col.view as Uint32Array)[2] = 0xabcd
    const beforeView = col.view
    b.grow(col, 2000)
    // Fallback re-allocated a fresh, exactly-sized backing; data copied; the old view is replaced.
    expect(col.view).not.toBe(beforeView)
    expect((col.view as Uint32Array).length).toBe(2000)
    expect((col.view as Uint32Array)[2]).toBe(0xabcd)
  })
})
