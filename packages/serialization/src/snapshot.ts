// The snapshot serializer: a self-describing little-endian image of the whole
// world at one tick — header + registry + structure + SoA + relations. SoA columns are written with
// ONE contiguous byte copy per column from the archetype's column slice (rejecting the bitECS
// per-entity gather / per-call slice). Relations serialize as the logical
// (subject, relationId, target, payload) triple — never the synthetic pair id.

import type { World } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/schema'
import { WriteCursor } from './cursor.js'
import {
  FLAG_HAS_RELATIONS,
  FLAG_HAS_RICH,
  NO_ENTITY_U32,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  assertPlatformLittleEndian,
  createPersistedColumnsCache,
  elementOrdinal,
  writeJsonBytes,
  writeString,
} from './format.js'
import { writePairPayload } from './payload.js'
import { encodeRichValue, richKindOrdinal, type OnUnserializable } from './rich.js'

export interface SnapshotOptions {
  /** Serialize relations (default true). */
  readonly includeRelations?: boolean
  /** Initial reusable-output byte size; doubles on overflow. */
  readonly initialOutputBytes?: number
  /** Policy for a rich value JSON cannot encode. Default: SKIP + dev-warn. */
  readonly onUnserializable?: OnUnserializable
}

/**
 * A reusable whole-world snapshot serializer (v2 wire). Rich fields ('string' / object<T>) ride a JSON
 * sidecar section; only WRITTEN values are emitted (default slots re-default on
 * load). Non-serializable rich values follow the `onUnserializable` policy (SKIP + dev-warn by default).
 *
 * BIT-EXACTNESS CARVE-OUT: a snapshot round-trip is bit-exact for PERSISTED fields only. A field
 * declared `field(token, { persist: false })` (or any field of a `persist: false` component) is
 * never written; on load it takes its declared default. Component MEMBERSHIP (the signature bit)
 * always persists — `persist` controls values, not structure. The persisted-field subset is folded
 * into the schemaHash, so an image produced under different persist flags is rejected on load.
 *
 * LIMITATION — RF-NOREMAP: an `EntityHandle` stored INSIDE an `object<T>` rich
 * field is serialized as a raw number and is NOT remapped on deserialize — the JSON path cannot
 * introspect an opaque object graph for handles. After a round-trip such a handle refers to the
 * PRODUCER's index space and is almost certainly invalid. To carry an entity reference that survives the
 * wire, use a dedicated `eid` COLUMN field (which IS remapped) or store a stable application id and
 * resolve it via `createStableIndex` after load. `'string'` fields have no eid concern.
 */
export interface SnapshotSerializer {
  /** Serialize the whole world; returns a view onto the reusable buffer, valid until the next call. */
  snapshot(): Uint8Array
  /** As above but a fresh detached buffer safe to transfer/persist. */
  snapshotCopy(): Uint8Array
}

export function createSnapshotSerializer(world: World, opts: SnapshotOptions = {}): SnapshotSerializer {
  assertPlatformLittleEndian()
  const includeRelations = opts.includeRelations ?? true
  const cur = new WriteCursor(opts.initialOutputBytes ?? 64 * 1024)
  const persistedColumnsOf = createPersistedColumnsCache()

  function write(): void {
    if (world.phase !== 'serial') {
      throw new Error('snapshot() must run while the world is in its serial phase (outside scheduler.update / worker waves)')
    }
    const s = world.__serialize
    const relProvider = includeRelations ? s.relations() : undefined
    const pairs = relProvider !== undefined ? relProvider.livePairs() : []
    const hasRelations = relProvider !== undefined

    cur.reset()
    const archs = s.archetypes()
    let aliveCount = 0
    for (const a of archs) aliveCount += a.count

    // --- SECTION 0: HEADER (36 bytes in v2; offsets + flags back-patched) ---
    // v2 grows the header from 32→36 bytes with a back-patched `richSectionOffset` word so the
    // RICH section is directly seekable, independent of the relations-present split.
    cur.u32(SNAPSHOT_MAGIC) // 0
    cur.u16(SERIALIZATION_FORMAT_VERSION) // 4
    cur.u8(1) // 6 ENDIAN = little
    const flagsAt = cur.pos
    cur.u8(hasRelations ? FLAG_HAS_RELATIONS : 0) // 7 flags (isDelta = 0; FLAG_HAS_RICH back-patched)
    cur.u32(s.schemaHash()) // 8
    cur.u32(world.currentTick()) // 12
    cur.u32(aliveCount) // 16
    cur.u32(archs.length) // 20
    const offRegistryAt = cur.pos
    cur.u32(0) // 24 sectionRegistryOffset
    const offStructureAt = cur.pos
    cur.u32(0) // 28 sectionStructureOffset
    const offRichAt = cur.pos
    cur.u32(0) // 32 sectionRichOffset (v2; 0 when no RICH section)

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
    // staticString choices tables: emitted per component field that is a staticString.
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

    // --- SECTION 3: SoA DATA (one set() per column; PERSISTED columns only) ---
    cur.alignTo4()
    for (const a of archs) {
      // Persisted columns only; a component whose every column is non-persisted is omitted entirely.
      // The receiver derives the same wire-position → column mapping from its own (schemaHash-matched)
      // descriptors, so the positional grammar stays aligned.
      const persisted = persistedColumnsOf(a)
      cur.u32(a.id)
      cur.u16(persisted.length)
      for (const pc of persisted) {
        const comp = a.components[pc.compIndex]
        if (comp === undefined) continue
        cur.u32(comp.componentId as number)
        cur.u16(pc.colIndices.length)
        for (const ci of pc.colIndices) {
          const col = comp.columns[ci]
          if (col === undefined) continue
          const stride = col.layout.stride
          const elems = a.count * stride
          cur.u8(elementOrdinal(col.layout.element))
          cur.u8(stride)
          const slice = (col.view as unknown as { subarray(s: number, e: number): ArrayBufferView }).subarray(0, elems)
          cur.u32(elems * col.layout.elementBytes)
          cur.copyBytes(slice) // ONE copy from the contiguous column slice
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

    // --- SECTION 5: RICH (JSON sidecar) — present iff the world has rich fields with present values ---
    // Enumerated by joining each alive entity's signature with s.richFields() (NOT a.components, which
    // strips rich fields — ). Only present (written) values are emitted; a default/empty slot is
    // skipped and the receiver re-defaults it. Sparse by construction.
    const richFields = s.richFields()
    if (richFields.length > 0) {
      // Group rich fields by component id for an O(1) per-entity lookup against its signature.
      type RF = (typeof richFields)[number]
      const byComponent = new Map<number, RF[]>()
      for (const rf of richFields) {
        if (!rf.persist) continue
        let bucket = byComponent.get(rf.componentId as number)
        if (bucket === undefined) {
          bucket = []
          byComponent.set(rf.componentId as number, bucket)
        }
        bucket.push(rf)
      }
      cur.alignTo4()
      const richOffset = cur.pos
      const countAt = cur.pos
      cur.u32(0) // richEntryCount (back-patched)
      let richEntryCount = 0
      for (const a of archs) {
        for (let r = 0; r < a.count; r++) {
          const handle = a.rows[r] as number
          for (const cid of a.signature) {
            const fields = byComponent.get(cid)
            if (fields === undefined) continue
            for (const rf of fields) {
              // Emit only WRITTEN slots: a never-written / default slot is skipped and re-defaulted
              // on the receiver. This distinguishes "wrote the empty string '' " (present) from "never
              // touched the field" (absent) — both of which read back as '' through richValueOf.
              if (!s.richIsPresent(handle as EntityHandle, rf.componentId, rf.fieldIndex)) continue
              const value = s.richValueOf(handle as EntityHandle, rf.componentId, rf.fieldIndex)
              if (value === undefined) continue // object default (undefined) explicitly written → skip
              const json = encodeRichValue(
                value,
                {
                  componentId: rf.componentId,
                  fieldIndex: rf.fieldIndex,
                  fieldName: rf.name,
                  handle: handle as EntityHandle,
                  value,
                },
                opts.onUnserializable,
              )
              if (json === undefined) continue // non-serializable → skipped (policy)
              cur.u32(handle >>> 0)
              cur.u32(rf.componentId as number)
              cur.u16(rf.fieldIndex)
              cur.u8(richKindOrdinal(rf.kind))
              writeJsonBytes(cur, json)
              cur.alignTo4()
              richEntryCount += 1
            }
          }
        }
      }
      if (richEntryCount > 0) {
        cur.patchU32(countAt, richEntryCount)
        cur.patchU32(offRichAt, richOffset)
        cur.patchU8(flagsAt, (hasRelations ? FLAG_HAS_RELATIONS : 0) | FLAG_HAS_RICH)
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

