// Untrusted-input hardening: the apply paths read lane/stride off the wire and use them as column
// offsets. For a schema-matched honest peer they're always in range, but a malformed/corrupt/malicious
// stream could otherwise drive an out-of-bounds (neighbor-row) write or a silent misalignment. These
// tests confirm the guards turn that into a loud "corrupt stream" throw.

import { describe, it, expect } from 'vitest'
import { createWorld, defineComponent, vec2 } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import {
  applyStructuralOps,
  createSnapshotSerializer,
  createSnapshotDeserializer,
  createDeltaSerializer,
  applyDelta,
} from '../src/index.js'

describe('wire hardening — out-of-range lane/stride throw instead of corrupting memory', () => {
  it('a structural ComponentAdd with a lane past the field stride throws', () => {
    const A = defineComponent({ x: 'f32' }, { name: 'a' })
    const world = createWorld({ components: [A as ComponentDef<Schema>] })
    const cid = (A as unknown as { id: number }).id
    // Hand-build: EntityCreate(1) then ComponentAdd(1, cid, one word name='x' lane=99 value=1).
    // 'x' is stride-1, so lane 99 is corrupt and must throw rather than write into a neighbor row.
    const buf = new Uint8Array(5 + 11 + 3 + 2 + 8)
    const dv = new DataView(buf.buffer)
    let p = 0
    buf[p++] = 0 // DeltaOp.EntityCreate
    dv.setUint32(p, 1, true)
    p += 4
    buf[p++] = 2 // DeltaOp.ComponentAdd
    dv.setUint32(p, 1, true)
    p += 4 // handle
    dv.setUint32(p, cid, true)
    p += 4 // componentId (local id for a pure structural stream)
    dv.setUint16(p, 1, true)
    p += 2 // word count
    dv.setUint16(p, 1, true)
    p += 2 // name length (1)
    buf[p++] = 'x'.charCodeAt(0)
    dv.setUint16(p, 99, true)
    p += 2 // lane = 99 (corrupt: stride is 1)
    dv.setFloat64(p, 1, true)
    p += 8 // value
    expect(() => applyStructuralOps(world, buf, new Map())).toThrow(/lane 99 is out of range/)
  })

  it('a snapshot with a tampered column stride throws on load', () => {
    const V = defineComponent({ p: vec2() }, { name: 'v' })
    const src = createWorld({ components: [V as ComponentDef<Schema>] })
    src.spawnWith(V as ComponentDef<Schema>)
    const bytes = createSnapshotSerializer(src).snapshotCopy()
    // The column header is [elementOrd:u8][stride:u8][byteLength:u32]. For one row of vec2-f32 the
    // stride is 2 and the byteLength is 8, so the byte run [2, 8, 0, 0, 0] locates the stride byte.
    const i = findRun(bytes, [2, 8, 0, 0, 0])
    expect(i).toBeGreaterThanOrEqual(0)
    bytes[i] = 99 // corrupt the stride
    const dstC = defineComponent({ p: vec2() }, { name: 'v' })
    const dst = createWorld({ components: [dstC as ComponentDef<Schema>] })
    expect(() => createSnapshotDeserializer(dst).load(bytes)).toThrow(/column stride 99 does not match/)
  })

  it('a delta with a tampered value-section stride throws on apply', () => {
    const V = defineComponent({ p: vec2() }, { name: 'v' })
    const src = createWorld({ components: [V as ComponentDef<Schema>] })
    const e = src.spawnWith(V as ComponentDef<Schema>)
    const dstC = defineComponent({ p: vec2() }, { name: 'v' })
    const dst = createWorld({ components: [dstC as ComponentDef<Schema>] })
    const { remap } = createSnapshotDeserializer(dst).load(createSnapshotSerializer(src).snapshotCopy())
    // Change the vec2 since T so the delta carries a value section for it.
    const T = src.currentTick()
    const ser = createDeltaSerializer(src, T)
    src.advanceTick()
    ;(src.entity(e).write(V) as { p: { x: number; y: number } }).p = { x: 1, y: 2 }
    const bytes = ser.deltaCopy()
    // Value-section column header: [elementOrd:u8][stride:u8] then per-row width = 8 bytes (vec2-f32).
    // Tamper every byte equal to 2 that sits before a plausible f32 payload, then assert the apply
    // rejects the corruption (the honest stride is 2; we flip one to 99 and expect a loud throw).
    const corrupted = tamperFirstStride(bytes)
    expect(corrupted).toBe(true)
    expect(() => applyDelta(dst, bytes, remap as Map<EntityHandle, EntityHandle>)).toThrow(
      /field stride 99 does not match/,
    )
  })
})

function findRun(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

// Flip the first plausible stride byte (value 2 immediately preceded by a small element ordinal — the
// value-section column header is [elementOrd][stride]). Returns whether a tamper was applied; the test
// itself validates the right byte was hit via the specific corrupt-stride throw it asserts.
function tamperFirstStride(bytes: Uint8Array): boolean {
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] === 2 && (bytes[i - 1] as number) <= 16) {
      bytes[i] = 99
      return true
    }
  }
  return false
}
