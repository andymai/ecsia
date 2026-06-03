// The snapshot serializer (serialization.md §4): a self-describing little-endian image of the whole
// world at one tick — header + registry + structure + SoA + relations. SoA columns are written with
// ONE contiguous byte copy per column from the archetype's column slice (rejecting the bitECS
// per-entity gather / per-call slice, §4.3). Relations serialize as the logical
// (subject, relationId, target, payload) triple — never the synthetic pair id (§8.3).

import type { World } from '@ecsia/core'
import { WriteCursor } from './cursor.js'
import {
  FLAG_HAS_RELATIONS,
  NO_ENTITY_U32,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
  elementOrdinal,
  writeString,
} from './format.js'
import { writePairPayload } from './payload.js'

export interface SnapshotOptions {
  /** Serialize relations (default true). */
  readonly includeRelations?: boolean
  /** Initial reusable-output byte size; doubles on overflow (§9.1). */
  readonly initialOutputBytes?: number
}

export interface SnapshotSerializer {
  /** Serialize the whole world; returns a view onto the reusable buffer, valid until the next call. */
  snapshot(): Uint8Array
  /** As above but a fresh detached buffer safe to transfer/persist (§9.3). */
  snapshotCopy(): Uint8Array
}

export function createSnapshotSerializer(world: World, opts: SnapshotOptions = {}): SnapshotSerializer {
  assertPlatformLittleEndian()
  const includeRelations = opts.includeRelations ?? true
  const cur = new WriteCursor(opts.initialOutputBytes ?? 64 * 1024)

  function write(): void {
    if (world.phase !== 'serial') {
      throw new Error('snapshot() must run at a serial flush point (serialization.md §4.3 / §11 S-11)')
    }
    const s = world.__serialize
    const relProvider = includeRelations ? s.relations() : undefined
    const pairs = relProvider !== undefined ? relProvider.livePairs() : []
    const hasRelations = relProvider !== undefined

    cur.reset()
    const archs = s.archetypes()
    let aliveCount = 0
    for (const a of archs) aliveCount += a.count

    // --- SECTION 0: HEADER (32 bytes, offsets back-patched) ---
    cur.u32(SNAPSHOT_MAGIC) // 0
    cur.u16(SERIALIZATION_FORMAT_VERSION) // 4
    cur.u8(1) // 6 ENDIAN = little
    cur.u8(hasRelations ? FLAG_HAS_RELATIONS : 0) // 7 flags (isDelta = 0)
    cur.u32(s.schemaHash()) // 8
    cur.u32(world.currentTick()) // 12
    cur.u32(aliveCount) // 16
    cur.u32(archs.length) // 20
    const offRegistryAt = cur.pos
    cur.u32(0) // 24 sectionRegistryOffset
    const offStructureAt = cur.pos
    cur.u32(0) // 28 sectionStructureOffset

    // --- SECTION 1: REGISTRY ---
    cur.patchU32(offRegistryAt, cur.pos)
    const comps = s.components()
    cur.u32(comps.length)
    for (const c of comps) {
      cur.u32(c.id as number)
      writeString(cur, c.name)
      cur.u16(c.fieldCount)
      cur.u8(c.storage === 'sparse' ? 1 : 0)
    }
    const rels = relProvider !== undefined ? relProvider.relations() : []
    cur.u32(rels.length)
    for (const r of rels) {
      cur.u16(r.id as number)
      writeString(cur, r.name)
      cur.u8((r.exclusive ? 1 : 0) | (r.hasPayload ? 2 : 0))
      cur.u32(r.presenceId as number)
    }
    // staticString choices tables (§4.1): emitted per component field that is a staticString.
    const stringTables: { componentId: number; fieldIndex: number; choices: readonly string[] }[] = []
    for (const c of comps) {
      const fields = s.fieldsOf(c.id)
      if (fields === undefined) continue
      for (let fi = 0; fi < fields.length; fi++) {
        const f = fields[fi]
        if (f !== undefined && f.choices !== undefined) {
          stringTables.push({ componentId: c.id as number, fieldIndex: fi, choices: f.choices })
        }
      }
    }
    cur.u32(stringTables.length)
    for (const t of stringTables) {
      cur.u32(t.componentId)
      cur.u16(t.fieldIndex)
      cur.u16(t.choices.length)
      for (const ch of t.choices) writeString(cur, ch)
    }

    // --- SECTION 2: STRUCTURE (entity identity + membership) ---
    cur.patchU32(offStructureAt, cur.pos)
    // One record per alive entity, (archetype id asc, row asc).
    for (const a of archs) {
      for (let r = 0; r < a.count; r++) {
        cur.u32(a.rows[r] as number) // FULL handle
        cur.u32(a.id)
      }
    }
    // Per-archetype signature so the receiver can recreate it.
    for (const a of archs) {
      cur.u32(a.id)
      cur.u32(a.count)
      cur.u16(a.signature.length)
      for (const cid of a.signature) cur.u32(cid)
    }

    // --- SECTION 3: SoA DATA (one set() per column) ---
    cur.alignTo4()
    for (const a of archs) {
      cur.u32(a.id)
      cur.u16(a.components.length)
      for (const comp of a.components) {
        cur.u32(comp.componentId as number)
        cur.u16(comp.columns.length)
        for (let i = 0; i < comp.columns.length; i++) {
          const col = comp.columns[i]
          if (col === undefined) continue
          const stride = col.layout.stride
          const elems = a.count * stride
          cur.u8(elementOrdinal(col.layout.element))
          cur.u8(stride)
          const slice = (col.view as unknown as { subarray(s: number, e: number): ArrayBufferView }).subarray(0, elems)
          cur.u32(elems * col.layout.elementBytes)
          cur.copyBytes(slice) // ONE copy from the contiguous column slice (§4.3)
          cur.alignTo4()
        }
      }
    }

    // --- SECTION 4: RELATIONS ---
    if (hasRelations) {
      cur.alignTo4()
      cur.u32(pairs.length)
      for (const p of pairs) {
        cur.u32((p.subject as number) >>> 0)
        cur.u16(p.relationId as number)
        cur.u32(p.target === null ? NO_ENTITY_U32 : (p.target as number) >>> 0)
        writePairPayload(cur, p.payload)
      }
    }
  }

  return {
    snapshot(): Uint8Array {
      write()
      return cur.bytesView()
    },
    snapshotCopy(): Uint8Array {
      write()
      return cur.bytesCopy()
    },
  }
}

