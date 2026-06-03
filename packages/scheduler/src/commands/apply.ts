// Command-buffer flush + deterministic merge + validate-then-apply (command-buffer.md §7, §8, §9).
// The main thread merges every worker's buffer in FIXED worker-index order, applies each record
// serially (validate-then-apply, drop-if-dead with an in-flush tombstone set), coalesces per-entity
// adds/removes into ONE migration each, and returns unused reserved ids. This is what makes a
// multi-worker run SERIAL-EQUIVALENT to the single-threaded executor: encoding order across workers is
// nondeterministic, but applying order is fixed (ascending worker index, then append order, §7.2).

import { Op, recordLen } from './op.js'
import type { CommandBuffer } from './buffer.js'
import type { ComponentFieldCodec } from './fields.js'
import type { ComponentDef, ComponentId, RelationId, Schema } from '@ecsia/schema'
import { NO_ENTITY } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'

const NO_ENTITY_BITS = (NO_ENTITY as unknown as number) >>> 0

/** A staged structural intent (legacy M6 seam, kept for compatibility). */
export interface StructuralIntent {
  readonly op: Op
}

export interface CommandSink {
  flushAll(): void
}

/** The M6 single-thread sink: structural ops never deferred, so the flush is empty work (CB-6). */
export const directApplySink: CommandSink = {
  flushAll(): void {
    // command-buffer.md §7.1 degenerate case: zero workers → zero command buffers → no-op.
  },
}

/**
 * The main-thread world verbs the apply path drives (command-buffer.md §9). Built from the World's
 * public surface by the scheduler. Every call runs serial/main-thread (PHASE-2 flush slot).
 */
export interface WorldApply {
  isAlive(h: EntityHandle): boolean
  handleIndex(h: EntityHandle): number
  /** Place an already-reserved (alive) handle into the EMPTY archetype + emit Create (§7.4). */
  spawnReserved(h: EntityHandle): void
  despawn(h: EntityHandle): void
  /** id → registered ComponentDef (for migration + write-view). */
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  /** Field codec for a component id (payload decode). */
  codecOf(id: ComponentId): ComponentFieldCodec | undefined
  /** One migration adding several components (archetype-storage.md §5.6a; C-MIG-1). */
  addMany(h: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  removeMany(h: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** Is `def` currently present on `h`? (SET_PAYLOAD requires presence, §9.2). */
  has(h: EntityHandle, def: ComponentDef<Schema>): boolean
  /** Write decoded field values into `h`'s current row + emit the `.changed` write-log entry. */
  writePayload(h: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  /** Reclaim the unconsumed reservation tail after this worker's creates are applied (§6.3). */
  returnUnused(cb: CommandBuffer): void
  /** Relation apply (best-effort; relations land at M8). */
  addPair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined): void
  removePair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
  warn(message: string): void
}

interface PendingStructural {
  adds: ComponentId[]
  removes: ComponentId[]
  payloads: Map<ComponentId, Record<string, unknown>>
}

function newPending(): PendingStructural {
  return { adds: [], removes: [], payloads: new Map() }
}

function pushUnique(arr: ComponentId[], c: ComponentId): void {
  if (!arr.includes(c)) arr.push(c)
}
function removeFrom(arr: ComponentId[], c: ComponentId): void {
  const i = arr.indexOf(c)
  if (i >= 0) arr.splice(i, 1)
}

/**
 * Apply every worker's command buffer to the world in fixed worker-index order. `world.phase` MUST be
 * 'serial' (the scheduler flips it back before calling this). Returns the number of records applied
 * (diagnostics).
 */
export function flushAll(world: WorldApply, buffers: readonly CommandBuffer[]): void {
  const newlyCreated = new Set<number>() // §8.5 reserved-handle whitelist (by handle bit-pattern)
  const tombstones = new Set<number>() // §8.2 entity INDICES destroyed THIS flush
  // Ascending workerIndex is the deterministic merge order (§7.2). Buffers are passed in index order
  // by the caller; sort defensively so the invariant holds regardless of array order.
  const ordered = [...buffers].sort((a, b) => a.workerIndex - b.workerIndex)
  for (const cb of ordered) applyBuffer(world, cb, newlyCreated, tombstones)
  for (const cb of ordered) world.returnUnused(cb)
}

function validateSubject(world: WorldApply, h: EntityHandle, newlyCreated: Set<number>, tombstones: Set<number>): boolean {
  if (newlyCreated.has(h as number)) return true // reserved-and-created THIS flush → alive (§8.5)
  if (tombstones.has(world.handleIndex(h))) {
    world.warn(`command references entity destroyed earlier this flush (handle ${h})`)
    return false
  }
  if (!world.isAlive(h)) {
    world.warn(`command references dead entity (handle ${h})`)
    return false
  }
  return true
}

function applyBuffer(world: WorldApply, cb: CommandBuffer, newlyCreated: Set<number>, tombstones: Set<number>): void {
  const pending = new Map<number, PendingStructural>()
  const words = cb.words
  let at = 0
  let appliedCreates = 0

  const drain = (h: EntityHandle): void => {
    const p = pending.get(h as number)
    if (p === undefined) return
    // removes before adds (§9.3) so a remove-then-add of distinct ids lands in the final archetype.
    if (p.removes.length > 0) {
      const defs = p.removes.map((c) => world.defOf(c)).filter((d): d is ComponentDef<Schema> => d !== undefined)
      if (defs.length > 0) world.removeMany(h, defs)
    }
    if (p.adds.length > 0) {
      const defs = p.adds.map((c) => world.defOf(c)).filter((d): d is ComponentDef<Schema> => d !== undefined)
      if (defs.length > 0) world.addMany(h, defs)
    }
    for (const [cid, values] of p.payloads) {
      const def = world.defOf(cid)
      if (def !== undefined) world.writePayload(h, def, values)
    }
    pending.delete(h as number)
  }

  while (at < cb.head) {
    const op = words[at] as Op
    const len = recordLen(words, at)
    switch (op) {
      case Op.CREATE: {
        const h = words[at + 1] as unknown as EntityHandle
        // Belt-and-suspenders (command-buffer.md §6.4): a reserved handle is ALWAYS alive, so a
        // well-formed OP_CREATE never names NO_ENTITY. Guard anyway so a corrupt/exhaustion-fabricated
        // record can never reach spawnReserved(0xffffffff) → handleIndex(NO_ENTITY) → record-table
        // corruption. Dropped: emits nothing, not counted toward appliedCreates (no reservation slot
        // was consumed for it).
        if ((h as unknown as number) >>> 0 === NO_ENTITY_BITS) {
          world.warn('OP_CREATE names NO_ENTITY (reservation exhausted upstream); dropped')
          break
        }
        world.spawnReserved(h)
        newlyCreated.add(h as number)
        appliedCreates += 1
        break
      }
      case Op.DESTROY: {
        const h = words[at + 1] as unknown as EntityHandle
        if (validateSubject(world, h, newlyCreated, tombstones)) {
          drain(h) // flush any pending structure before the entity disappears
          world.despawn(h)
          tombstones.add(world.handleIndex(h))
        }
        break
      }
      case Op.ADD: {
        const h = words[at + 1] as unknown as EntityHandle
        const cid = words[at + 2] as unknown as ComponentId
        const f = words[at + 3] as number
        if (validateSubject(world, h, newlyCreated, tombstones)) {
          const p = pending.get(h as number) ?? setPending(pending, h)
          removeFrom(p.removes, cid)
          pushUnique(p.adds, cid)
          if (f > 0) {
            const codec = world.codecOf(cid)
            if (codec !== undefined) p.payloads.set(cid, codec.decode(words, at + 4))
          }
        }
        break
      }
      case Op.REMOVE: {
        const h = words[at + 1] as unknown as EntityHandle
        const cid = words[at + 2] as unknown as ComponentId
        if (validateSubject(world, h, newlyCreated, tombstones)) {
          const p = pending.get(h as number) ?? setPending(pending, h)
          removeFrom(p.adds, cid)
          pushUnique(p.removes, cid)
          p.payloads.delete(cid)
        }
        break
      }
      case Op.SET_PAYLOAD: {
        const h = words[at + 1] as unknown as EntityHandle
        const cid = words[at + 2] as unknown as ComponentId
        if (validateSubject(world, h, newlyCreated, tombstones)) {
          const codec = world.codecOf(cid)
          const def = world.defOf(cid)
          if (codec !== undefined && def !== undefined) {
            const values = codec.decode(words, at + 4)
            const p = pending.get(h as number)
            if (p !== undefined && p.adds.includes(cid)) {
              p.payloads.set(cid, values) // fold into the add's payload (§9.2)
            } else {
              drain(h) // ensure the component is present at its current row before overwriting
              if (world.has(h, def)) world.writePayload(h, def, values)
              else world.warn(`SET_PAYLOAD on absent component (handle ${h}, id ${cid})`)
            }
          }
        }
        break
      }
      case Op.ADD_PAIR: {
        const s = words[at + 1] as unknown as EntityHandle
        const rid = words[at + 2] as unknown as RelationId
        const t = words[at + 3] as unknown as EntityHandle
        // command-buffer.md §8.3: ADD_PAIR drops if EITHER subject or target is dead (a relation to a
        // destroyed target is meaningless). Both go through the drop-if-dead gate.
        if (
          validateSubject(world, s, newlyCreated, tombstones) &&
          validateSubject(world, t, newlyCreated, tombstones)
        ) {
          drain(s)
          if (world.addPair !== undefined) {
            // Relation payload decode lands with relations (M8): no relation codec is wired at M7, so
            // the payload is undefined here. recordLen() still skips the payload words correctly (§4.6).
            world.addPair(s, rid, t, undefined)
          } else {
            world.warn('ADD_PAIR encountered but relations are not wired (M8)')
          }
        }
        break
      }
      case Op.REMOVE_PAIR: {
        const s = words[at + 1] as unknown as EntityHandle
        const rid = words[at + 2] as unknown as RelationId
        const t = words[at + 3] as unknown as EntityHandle
        if (validateSubject(world, s, newlyCreated, tombstones)) {
          drain(s)
          if (world.removePair !== undefined) world.removePair(s, rid, t)
        }
        break
      }
      default:
        throw new Error(`corrupt command buffer: bad opcode ${op} at ${at}`)
    }
    at += len
  }

  // Drain any entity still pending at end-of-buffer (§9.4 unconditional tail drain).
  for (const key of [...pending.keys()]) drain(key as unknown as EntityHandle)
  cb.appliedCreateCount = appliedCreates
}

function setPending(map: Map<number, PendingStructural>, h: EntityHandle): PendingStructural {
  const p = newPending()
  map.set(h as number, p)
  return p
}
