// The snapshot deserializer (serialization.md §5): apply a snapshot image into a FRESH world. Builds
// the entity-ID remap table FIRST (PASS 1) so every eid field and relation pair forward-reference
// resolves; recreates archetypes from signatures and bulk-loads columns with ONE set() per column
// (PASS 1b); remaps eid columns in place (PASS 2); re-establishes relations through the relation
// provider's addPair, which re-mints the receiver-local pair id (PASS 3). Ids are remapped BY NAME
// (§5.2) — component/relation ids are producer-local.

import type { ComponentId, EntityHandle, RelationId } from '@ecsia/schema'
import type { World } from '@ecsia/core'
import { encodeEid } from '@ecsia/core'
import { ReadCursor } from './cursor.js'
import {
  FLAG_HAS_RELATIONS,
  NO_ENTITY_U32,
  SERIALIZATION_FORMAT_VERSION,
  SNAPSHOT_MAGIC,
  ordinalToElement,
  readString,
} from './format.js'
import { readPairPayload } from './payload.js'

export interface DeserializeResult {
  /** Old-handle → new-handle remap table (the entity-ID remap, §8.2). */
  readonly remap: ReadonlyMap<EntityHandle, EntityHandle>
  readonly entitiesCreated: number
  readonly tick: number
}

export interface SnapshotDeserializer {
  load(bytes: Uint8Array, mode?: 'replace' | 'merge'): DeserializeResult
}

interface ProducerComponent {
  readonly id: number
  readonly name: string
  readonly fieldCount: number
}
interface ProducerRelation {
  readonly id: number
  readonly name: string
}
interface ArchetypeRecord {
  readonly id: number
  readonly count: number
  readonly signature: number[]
}

export function createSnapshotDeserializer(world: World): SnapshotDeserializer {
  const s = world.__serialize

  function load(bytes: Uint8Array, mode: 'replace' | 'merge' = 'replace'): DeserializeResult {
    if (world.phase !== 'serial') {
      throw new Error('load() must run while the world is in its serial phase (outside scheduler.update / worker waves)')
    }
    const cur = new ReadCursor(bytes)

    // --- HEADER ---
    const magic = cur.u32()
    if (magic !== SNAPSHOT_MAGIC) throw new Error('serialization: bad magic (not an ecsia snapshot)')
    const version = cur.u16()
    if (version !== SERIALIZATION_FORMAT_VERSION) {
      throw new Error(`serialization: unsupported format version ${version}`)
    }
    const endian = cur.u8()
    if (endian !== 1) throw new Error('serialization: big-endian image unsupported (the wire format is little-endian)')
    const flags = cur.u8()
    const schemaHash = cur.u32()
    if (schemaHash !== s.schemaHash()) {
      throw new Error(
        'serialization: schemaHash mismatch — refusing to load. The snapshot was produced by a different ' +
          'component schema; load it into a world built with the same components.',
      )
    }
    const tick = cur.u32()
    const aliveCount = cur.u32()
    const archCount = cur.u32()
    const registryOffset = cur.u32()
    const structureOffset = cur.u32()

    if (mode === 'replace' && s.aliveCount() > 0) {
      s.clearAll()
    }

    // --- REGISTRY (id remap by name) ---
    cur.seek(registryOffset)
    const numComponents = cur.u32()
    const producerComponents: ProducerComponent[] = []
    const producerCidToLocal = new Map<number, ComponentId>()
    for (let i = 0; i < numComponents; i++) {
      const id = cur.u32()
      const name = readString(cur)
      const fieldCount = cur.u16()
      cur.u8() // storage strategy (unused — code on both sides)
      producerComponents.push({ id, name, fieldCount })
      const local = s.componentIdByName(name)
      if (local === undefined) throw new Error(`serialization: component '${name}' not registered on receiver`)
      const localFields = s.fieldsOf(local)
      if (localFields !== undefined && localFields.length !== fieldCount) {
        throw new Error(
          `serialization: component '${name}' field-count mismatch — the receiver's '${name}' has a different ` +
            `field layout than the snapshot's. Register matching component schemas on both sides.`,
        )
      }
      producerCidToLocal.set(id, local)
    }
    const numRelations = cur.u32()
    const producerRelations: ProducerRelation[] = []
    const producerRelToLocal = new Map<number, RelationId>()
    const relProvider = s.relations()
    const localRelByName = new Map<string, RelationId>()
    if (relProvider !== undefined) for (const r of relProvider.relations()) localRelByName.set(r.name, r.id)
    for (let i = 0; i < numRelations; i++) {
      const id = cur.u16()
      const name = readString(cur)
      cur.u8() // traits (exclusive/hasPayload) — code on both sides
      cur.u32() // presenceId (producer-local; never used on receiver)
      producerRelations.push({ id, name })
      const local = localRelByName.get(name)
      if (local !== undefined) producerRelToLocal.set(id, local)
    }
    const numStringTables = cur.u32()
    for (let i = 0; i < numStringTables; i++) {
      cur.u32() // componentId
      cur.u16() // fieldIndex
      const choiceCount = cur.u16()
      for (let c = 0; c < choiceCount; c++) readString(cur)
    }

    // --- STRUCTURE: read entity list, then per-archetype signatures ---
    cur.seek(structureOffset)
    const entityHandles = new Uint32Array(aliveCount)
    const entityArchId = new Uint32Array(aliveCount)
    for (let i = 0; i < aliveCount; i++) {
      entityHandles[i] = cur.u32()
      entityArchId[i] = cur.u32()
    }
    const archRecords: ArchetypeRecord[] = []
    const archById = new Map<number, ArchetypeRecord>()
    for (let i = 0; i < archCount; i++) {
      const id = cur.u32()
      const count = cur.u32()
      const sigLen = cur.u16()
      const signature: number[] = []
      for (let j = 0; j < sigLen; j++) signature.push(cur.u32())
      const rec: ArchetypeRecord = { id, count, signature }
      archRecords.push(rec)
      archById.set(id, rec)
    }

    // --- PASS 1: create entities + remap (no field data) ---
    const remap = new Map<EntityHandle, EntityHandle>()
    const newHandles = new Uint32Array(aliveCount)
    for (let i = 0; i < aliveCount; i++) {
      const oldHandle = entityHandles[i] as number
      const nh = s.spawn()
      newHandles[i] = nh as number
      remap.set(oldHandle as EntityHandle, nh)
    }

    // --- PASS 1b: recreate archetypes (migrate each entity to its local signature) ---
    // Entities are grouped by archetype id; placement order within an archetype matches the snapshot
    // structure order, so the SoA section's contiguous column slice writes with one set() at row 0.
    for (let i = 0; i < aliveCount; i++) {
      const rec = archById.get(entityArchId[i] as number)
      if (rec === undefined) continue
      const localIds: ComponentId[] = []
      for (const pcid of rec.signature) {
        const local = producerCidToLocal.get(pcid)
        // Pair / presence / synthetic ids are NOT in the registry — they are re-minted by addPair in
        // PASS 3, never recreated as raw signature members here.
        if (local !== undefined) localIds.push(local)
      }
      s.spawnInto(newHandles[i] as EntityHandle, localIds)
    }

    // --- SoA load + eid remap (PASS 1b columns + PASS 2) ---
    cur.alignTo4()
    // Build, per archetype, the ordered list of new handles in placement order so columns map row→row.
    const handlesByArch = new Map<number, number[]>()
    for (let i = 0; i < aliveCount; i++) {
      const a = entityArchId[i] as number
      let list = handlesByArch.get(a)
      if (list === undefined) {
        list = []
        handlesByArch.set(a, list)
      }
      list.push(newHandles[i] as number)
    }

    for (let ai = 0; ai < archCount; ai++) {
      const archId = cur.u32()
      const columnCount = cur.u16()
      const handles = handlesByArch.get(archId) ?? []
      const rec = archById.get(archId)
      const rowCount = rec?.count ?? handles.length
      for (let ci = 0; ci < columnCount; ci++) {
        const producerCid = cur.u32()
        const fieldCount = cur.u16()
        const localCid = producerCidToLocal.get(producerCid)
        for (let fi = 0; fi < fieldCount; fi++) {
          const elementOrd = cur.u8()
          const stride = cur.u8()
          const byteLength = cur.u32()
          const raw = cur.takeBytes(byteLength)
          cur.alignTo4()
          if (localCid === undefined || handles.length === 0) continue
          // Resolve the destination column from the FIRST placed handle (all rows share one ColumnSet).
          const dst = s.columnsOf(handles[0] as EntityHandle, localCid)
          if (dst === null) continue
          const col = dst.columns[fi]
          if (col === undefined) continue
          const element = ordinalToElement(elementOrd)
          // Reinterpret the raw bytes as the same typed array and copy into the destination column.
          writeColumnSlice(col, element, stride, raw, rowCount, dst.row)
        }
      }
    }

    // PASS 2 ran inline above (eid columns remapped in writeColumnSlice via the remap closure).
    remapEidColumns(world, handlesByArch, archById, producerCidToLocal, remap)

    // --- PASS 3: relations ---
    if ((flags & FLAG_HAS_RELATIONS) !== 0) {
      // Find the relations section: it follows the SoA section, which the cursor is now positioned at.
      cur.alignTo4()
      const pairCount = cur.u32()
      for (let i = 0; i < pairCount; i++) {
        const subjectH = cur.u32()
        const relationId = cur.u16()
        const targetH = cur.u32()
        const payload = readPairPayload(cur)
        if (relProvider === undefined) continue
        const localRel = producerRelToLocal.get(relationId)
        if (localRel === undefined) continue
        const subject = remap.get(subjectH as EntityHandle)
        if (subject === undefined) continue
        const target = targetH === NO_ENTITY_U32 ? null : remap.get(targetH as EntityHandle) ?? null
        if (targetH !== NO_ENTITY_U32 && target === null) continue // dangling target → drop (§8.3)
        relProvider.addPair(subject, localRel, target, payload)
      }
    }

    return { remap, entitiesCreated: aliveCount, tick }
  }

  return { load }
}

// Write a raw column slice into the destination column. Non-eid: a direct typed-array set(). eid
// columns are deferred — they are remapped in a single pass after all columns load (remapEidColumns),
// because an eid may forward-reference an entity placed later. Here we just copy the producer words.
function writeColumnSlice(
  col: { view: { set(src: ArrayLike<number>, off: number): void }; layout: { stride: number } },
  element: string,
  stride: number,
  raw: Uint8Array,
  rowCount: number,
  destRow: number,
): void {
  const elems = rowCount * stride
  const src = reinterpret(element, raw, elems)
  col.view.set(src as unknown as ArrayLike<number>, destRow * col.layout.stride)
}

function reinterpret(element: string, raw: Uint8Array, elems: number): ArrayLike<number> {
  // raw is a subarray of the snapshot buffer whose byteOffset is NOT guaranteed multiple-of-N aligned
  // (the section is word-aligned from buffer start, but the source Uint8Array's own offset can be odd).
  // Copy into a fresh, zero-offset ArrayBuffer so the typed-array view is always validly aligned.
  const copy = raw.slice()
  const buf = copy.buffer
  const off = copy.byteOffset
  switch (element) {
    case 'u8':
      return new Uint8Array(buf, off, elems)
    case 'u8c':
      return new Uint8ClampedArray(buf, off, elems)
    case 'i8':
      return new Int8Array(buf, off, elems)
    case 'u16':
      return new Uint16Array(buf, off, elems)
    case 'i16':
      return new Int16Array(buf, off, elems)
    case 'u32':
      return new Uint32Array(buf, off, elems)
    case 'i32':
      return new Int32Array(buf, off, elems)
    case 'f32':
      return new Float32Array(buf, off, elems)
    case 'f64':
      return new Float64Array(buf, off, elems)
    default:
      throw new Error(`serialization: unknown element '${element}'`)
  }
}



// PASS 2: every eid field column now holds PRODUCER handles. Translate each through the remap table
// in place; -1 (NO_ENTITY) passes through untouched; a non-snapshotted reference is nulled (§5.4).
function remapEidColumns(
  world: World,
  handlesByArch: Map<number, number[]>,
  archById: Map<number, ArchetypeRecord>,
  producerCidToLocal: Map<number, ComponentId>,
  remap: Map<EntityHandle, EntityHandle>,
): void {
  const s = world.__serialize
  for (const [archId, handles] of handlesByArch) {
    const rec = archById.get(archId)
    if (rec === undefined || handles.length === 0) continue
    for (const pcid of rec.signature) {
      const local = producerCidToLocal.get(pcid)
      if (local === undefined) continue
      const fields = s.fieldsOf(local)
      if (fields === undefined) continue
      // Which column-backed field indices are eid (within this component's ColumnSet)?
      const eidColIndices: number[] = []
      let colIndex = 0
      for (const f of fields) {
        if (f.ctor === null) continue
        if (f.token === 'eid') eidColIndices.push(colIndex)
        colIndex += 1
      }
      if (eidColIndices.length === 0) continue
      // Resolve each handle's own (column set, row) so a non-contiguous placement still remaps right.
      for (const h of handles) {
        const dst = s.columnsOf(h as EntityHandle, local)
        if (dst === null) continue
        for (const ci of eidColIndices) {
          const col = dst.columns[ci]
          if (col === undefined) continue
          const view = col.view as unknown as { [i: number]: number }
          const slot = dst.row * col.layout.stride
          const stored = view[slot] as number
          if (stored === -1) continue
          const nh = remap.get((stored >>> 0) as EntityHandle)
          view[slot] = nh === undefined ? -1 : encodeEid(nh)
        }
      }
    }
  }
}
