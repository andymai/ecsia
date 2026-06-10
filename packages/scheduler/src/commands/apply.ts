// Command-buffer flush + deterministic merge + validate-then-apply.
// The main thread merges every worker's buffer in FIXED worker-index order, applies each record
// serially (validate-then-apply, drop-if-dead with an in-flush tombstone set), coalesces per-entity
// adds/removes into ONE migration each, and returns unused reserved ids. This is what makes a
// multi-worker run SERIAL-EQUIVALENT to the single-threaded executor: encoding order across workers is
// nondeterministic, but applying order is fixed (ascending worker index, then append order).

import { Op, recordLen } from './op.js'
import type { CommandBuffer } from './buffer.js'
import type { ComponentFieldCodec } from './fields.js'
import type { ComponentDef, ComponentId, RelationId, Schema } from '@ecsia/schema'
import { NO_ENTITY } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'

const NO_ENTITY_BITS = (NO_ENTITY as unknown as number) >>> 0

/** A staged structural intent (legacy seam, kept for compatibility). */
export interface StructuralIntent {
  readonly op: Op
}

export interface CommandSink {
  flushAll(): void
}

/** The single-thread sink: structural ops never deferred, so the flush is empty work. */
export const directApplySink: CommandSink = {
  flushAll(): void {
    // Zero workers → zero command buffers → no-op.
  },
}

/**
 * The main-thread world verbs the apply path drives. Built from the World's
 * public surface by the scheduler. Every call runs serial/main-thread (PHASE-2 flush slot).
 */
export interface WorldApply {
  isAlive(h: EntityHandle): boolean
  handleIndex(h: EntityHandle): number
  /** Place an already-reserved (alive) handle into the EMPTY archetype + emit Create. */
  spawnReserved(h: EntityHandle): void
  despawn(h: EntityHandle): void
  /** id → registered ComponentDef (for migration + write-view). */
  defOf(id: ComponentId): ComponentDef<Schema> | undefined
  /** Field codec for a component id (payload decode). */
  codecOf(id: ComponentId): ComponentFieldCodec | undefined
  /** One migration adding several components. */
  addMany(h: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  removeMany(h: EntityHandle, defs: readonly ComponentDef<Schema>[]): void
  /** Is `def` currently present on `h`? (SET_PAYLOAD requires presence). */
  has(h: EntityHandle, def: ComponentDef<Schema>): boolean
  /** Write decoded field values into `h`'s current row + emit the `.changed` write-log entry. */
  writePayload(h: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  /** Reclaim the unconsumed reservation tail after this worker's creates are applied. */
  returnUnused(cb: CommandBuffer): void
  /** Relation apply (best-effort; relations land at ). */
  addPair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload: Record<string, unknown> | undefined): void
  removePair?(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
  /** Field codec for a relation's payload schema (pair-payload decode); undefined for a tag relation. */
  relationCodecOf?(relationId: RelationId): ComponentFieldCodec | undefined
  /**
   * Topic publish staging (OP_PUBLISH): hand the raw payload field words to the world's topic
   * store, keyed by topicId + publishing SystemId, for the wave's serial-slot canonical merge.
   * Undefined in a topic-free wiring.
   */
  stagePublish?(topicId: number, systemId: number, words: Uint32Array, at: number, fieldWords: number): void
  /**
   * Worker consume-cursor advance (OP_CONSUMED): a worker-run consumer observed events up to `seq`
   * (exclusive) mid-wave. Replayed here so cursor state stays main-thread-owned and lazy — a kernel
   * that never calls consume emits no record and its cursor does not move (main-thread parity).
   */
  advanceConsume?(topicId: number, systemId: number, seq: number): void
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
  const newlyCreated = new Set<number>() // (by handle bit-pattern)
  const tombstones = new Set<number>() //
  // Ascending workerIndex is the deterministic merge order. Buffers are passed in index order
  // by the caller; sort defensively so the invariant holds regardless of array order.
  const ordered = [...buffers].sort((a, b) => a.workerIndex - b.workerIndex)
  for (const cb of ordered) applyBuffer(world, cb, newlyCreated, tombstones)
  for (const cb of ordered) world.returnUnused(cb)
}

function validateSubject(world: WorldApply, h: EntityHandle, newlyCreated: Set<number>, tombstones: Set<number>): boolean {
  if (newlyCreated.has(h as number)) return true // reserved-and-created THIS flush → alive
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
    // removes before adds so a remove-then-add of distinct ids lands in the final archetype.
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
        // Belt-and-suspenders: a reserved handle is ALWAYS alive, so a
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
              p.payloads.set(cid, values) // fold into the add's payload
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
        const payloadWords = words[at + 4] as number
        // ADD_PAIR drops if EITHER subject or target is dead (a relation to a
        // destroyed target is meaningless). Both go through the drop-if-dead gate.
        if (
          validateSubject(world, s, newlyCreated, tombstones) &&
          validateSubject(world, t, newlyCreated, tombstones)
        ) {
          drain(s)
          if (world.addPair !== undefined) {
            // Decode the pair payload the worker encoded (payloadWordCount>0), rebuilt from the
            // relation's replicated payload schema — so a worker-issued payloaded addPair matches a
            // serial one. A tag relation carries no payload words (payloadWords===0) → undefined.
            let payload: Record<string, unknown> | undefined
            if (payloadWords > 0) payload = world.relationCodecOf?.(rid)?.decode(words, at + 5)
            world.addPair(s, rid, t, payload)
          } else {
            world.warn('ADD_PAIR encountered but relations are not wired')
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
      case Op.PUBLISH: {
        // Not entity-targeted: skips validateSubject entirely. eid payload fields carry handles with
        // no liveness check — an event is a fact about the past; consumers check isAlive if needed.
        const topicId = words[at + 1] as number
        const systemId = words[at + 2] as number
        const f = words[at + 3] as number
        if (world.stagePublish !== undefined) world.stagePublish(topicId, systemId, words, at + 4, f)
        else world.warn('OP_PUBLISH encountered but topics are not wired')
        break
      }
      case Op.CONSUMED: {
        // Not entity-targeted (skips validateSubject). Idempotent: the store advances by max().
        const topicId = words[at + 1] as number
        const systemId = words[at + 2] as number
        const seq = words[at + 3] as number
        if (world.advanceConsume !== undefined) world.advanceConsume(topicId, systemId, seq)
        else world.warn('OP_CONSUMED encountered but topics are not wired')
        break
      }
      default:
        throw new Error(`corrupt command buffer: bad opcode ${op} at ${at}`)
    }
    at += len
  }

  // Drain any entity still pending at end-of-buffer.
  for (const key of [...pending.keys()]) drain(key as unknown as EntityHandle)
  cb.appliedCreateCount = appliedCreates
}

function setPending(map: Map<number, PendingStructural>, h: EntityHandle): PendingStructural {
  const p = newPending()
  map.set(h as number, p)
  return p
}
