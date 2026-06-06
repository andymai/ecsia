// Version gating: v1 snapshot images load in the current reader (range check + per-section
// gating); the writer stamps the current version; a too-new image is rejected. Compatibility is
// one-way: an old build rejects a newer image via its own strict check. We synthesize a v1 image by
// down-converting a current snapshot of a rich-FREE world (the v1 wire is the v2+ wire minus the
// 4-byte richSectionOffset header word, with the two section offsets shifted down by 4 and the
// FLAG_HAS_RICH bit absent — which a rich-free world already satisfies; the snapshot layout is
// unchanged since v2 — v3 changed only the DELTA header, v4 only the DELTA rich row flag).

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createSnapshotSerializer, createSnapshotDeserializer } from '../src/index.js'
import { SERIALIZATION_FORMAT_VERSION, MIN_SUPPORTED_VERSION } from '../src/format.js'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

/** Down-convert a v2 (rich-free) snapshot to the v1 wire layout: drop the byte-32 richSectionOffset word,
 * set version=1, and shift the byte-24/28 section offsets down by 4. */
function toV1(v2: Uint8Array): Uint8Array {
  const src = new DataView(v2.buffer, v2.byteOffset, v2.byteLength)
  const registryOff = src.getUint32(24, true)
  const structureOff = src.getUint32(28, true)
  // New buffer: header is 32 bytes (no rich offset word); body after byte 36 shifts to byte 32.
  const out = new Uint8Array(v2.byteLength - 4)
  const dv = new DataView(out.buffer)
  // Copy header bytes 0..32 (magic..sectionStructureOffset), then the body from v2 byte 36 onward.
  out.set(v2.subarray(0, 32), 0)
  out.set(v2.subarray(36), 32)
  dv.setUint16(4, 1, true) // version = 1
  dv.setUint32(24, registryOff - 4, true)
  dv.setUint32(28, structureOff - 4, true)
  return out
}

describe('RICH — version gating', () => {
  it('the writer stamps the current SERIALIZATION_FORMAT_VERSION', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    src.spawnWith(P)
    const bytes = createSnapshotSerializer(src).snapshotCopy()
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true)).toBe(4)
    expect(SERIALIZATION_FORMAT_VERSION).toBe(4)
    expect(MIN_SUPPORTED_VERSION).toBe(1)
  })

  it('a v1 image loads in the current reader (range check + per-section gating)', () => {
    const P = defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    const e1 = src.spawnWith(P)
    const e2 = src.spawnWith(P)
    ;(src.entity(e1).write(P) as { x: number; y: number }).x = 3.5
    ;(src.entity(e2).write(P) as { x: number; y: number }).y = -7

    const v1 = toV1(createSnapshotSerializer(src).snapshotCopy())
    expect(new DataView(v1.buffer, v1.byteOffset).getUint16(4, true)).toBe(1)

    const R = defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: asComps(R) })
    const { remap } = createSnapshotDeserializer(dst).load(v1)
    const n1 = remap.get(e1 as never) as EntityHandle
    const n2 = remap.get(e2 as never) as EntityHandle
    expect((dst.entity(n1).read(R) as { x: number }).x).toBe(3.5)
    expect((dst.entity(n2).read(R) as { y: number }).y).toBe(-7)
  })

  it('a too-new image is rejected with an explicit range error', () => {
    const P = defineComponent({ x: 'f32' }, { name: 'p' })
    const src = createWorld({ components: asComps(P) })
    src.spawnWith(P)
    const bytes = createSnapshotSerializer(src).snapshotCopy()
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, 99, true) // forge a future version
    const R = defineComponent({ x: 'f32' }, { name: 'p' })
    const dst = createWorld({ components: asComps(R) })
    expect(() => createSnapshotDeserializer(dst).load(bytes)).toThrow(/unsupported format version 99/)
  })
})
