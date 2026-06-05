// The worker-side encode API (command-buffer.md §5): the methods a system calls mid-wave. NONE
// mutates shared structure — each appends one record to the owning worker's buffer (and, for create,
// consumes a reserved handle). The ergonomic surface (entity.add, world.spawn inside a worker) routes
// here via the worker's structuralOp seam (workers/worker-context.ts).

import { Op } from './op.js'
import { ensureWords } from './buffer.js'
import type { CommandBuffer } from './buffer.js'
import type { ComponentFieldCodec } from './fields.js'
import type { ComponentDef, ComponentId, RelationId, Schema } from '@ecsia/schema'
import { NO_ENTITY } from '@ecsia/core'
import type { EntityHandle } from '@ecsia/core'

/** Per-component encode metadata the worker resolves from its replicated registry. */
export interface ComponentEncodeInfo {
  readonly id: ComponentId
  readonly codec: ComponentFieldCodec
}

export interface CommandEncoder {
  /** Reserve-and-return a usable handle NOW; emits OP_CREATE. Mid-wave safe (§6). */
  create(): EntityHandle
  destroy(h: EntityHandle): void
  add(h: EntityHandle, def: ComponentDef<Schema>, init?: Record<string, unknown>): void
  remove(h: EntityHandle, def: ComponentDef<Schema>): void
  setPayload(h: EntityHandle, def: ComponentDef<Schema>, values: Record<string, unknown>): void
  setRelation(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload?: Record<string, unknown>): void
  unsetRelation(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void
}

export interface EncoderEnv {
  readonly cb: CommandBuffer
  /** Resolve a registered ComponentDef → its dense id + field codec. */
  infoOf(def: ComponentDef<Schema>): ComponentEncodeInfo
  /** Field codec for a relation payload schema (or undefined for a tag relation). */
  relationCodec(relationId: RelationId): ComponentFieldCodec | undefined
  /** Dev diagnostic sink (e.g. reservation exhaustion). */
  warn(message: string): void
}

export function makeEncoder(env: EncoderEnv): CommandEncoder {
  const { cb } = env

  /** Emit the overflow diagnostic ONCE per wave (the first capped record); subsequent caps are silent. */
  function onOverflow(): void {
    if (!cb.overflowed || cb.overflowWarned) return
    cb.overflowWarned = true
    env.warn('command-buffer: fixed (SAB) buffer full; record dropped (raise commandWords)')
  }

  function create(): EntityHandle {
    if (cb.reservationCursor >= cb.reservation.handles.length) {
      env.warn('command-buffer: reservation exhausted; raise maxSpawnsPerWave (spawn capped)')
      return NO_ENTITY
    }
    // Check capacity BEFORE consuming the reservation handle: an overflow must not burn a reserved id
    // (and must emit no OP_CREATE) so the handle is reclaimed by returnUnused, not leaked.
    if (!ensureWords(cb, 2)) {
      onOverflow()
      return NO_ENTITY
    }
    const h = cb.reservation.handles[cb.reservationCursor]!
    cb.reservationCursor += 1
    const w = cb.head
    cb.words[w] = Op.CREATE
    cb.words[w + 1] = h as number
    cb.head += 2
    cb.recordCount += 1
    return h
  }

  function destroy(h: EntityHandle): void {
    if (!ensureWords(cb, 2)) return onOverflow()
    const w = cb.head
    cb.words[w] = Op.DESTROY
    cb.words[w + 1] = h as number
    cb.head += 2
    cb.recordCount += 1
  }

  function fieldRecord(op: Op.ADD | Op.SET_PAYLOAD, h: EntityHandle, def: ComponentDef<Schema>, init?: Record<string, unknown>): void {
    const info = env.infoOf(def)
    const f = info.codec.totalWords
    if (!ensureWords(cb, 4 + f)) return onOverflow()
    const w = cb.head
    cb.words[w] = op
    cb.words[w + 1] = h as number
    cb.words[w + 2] = info.id as number
    cb.words[w + 3] = f
    info.codec.encode(init, cb.words, w + 4)
    cb.head += 4 + f
    cb.recordCount += 1
  }

  function remove(h: EntityHandle, def: ComponentDef<Schema>): void {
    const info = env.infoOf(def)
    if (!ensureWords(cb, 3)) return onOverflow()
    const w = cb.head
    cb.words[w] = Op.REMOVE
    cb.words[w + 1] = h as number
    cb.words[w + 2] = info.id as number
    cb.head += 3
    cb.recordCount += 1
  }

  function setRelation(subject: EntityHandle, relationId: RelationId, target: EntityHandle, payload?: Record<string, unknown>): void {
    const codec = env.relationCodec(relationId)
    const p = codec?.totalWords ?? 0
    if (!ensureWords(cb, 5 + p)) return onOverflow()
    const w = cb.head
    cb.words[w] = Op.ADD_PAIR
    cb.words[w + 1] = subject as number
    cb.words[w + 2] = relationId as number
    cb.words[w + 3] = target as number
    cb.words[w + 4] = p
    if (codec !== undefined && p > 0) codec.encode(payload, cb.words, w + 5)
    cb.head += 5 + p
    cb.recordCount += 1
  }

  function unsetRelation(subject: EntityHandle, relationId: RelationId, target: EntityHandle): void {
    if (!ensureWords(cb, 4)) return onOverflow()
    const w = cb.head
    cb.words[w] = Op.REMOVE_PAIR
    cb.words[w + 1] = subject as number
    cb.words[w + 2] = relationId as number
    cb.words[w + 3] = target as number
    cb.head += 4
    cb.recordCount += 1
  }

  return {
    create,
    destroy,
    add: (h, def, init) => fieldRecord(Op.ADD, h, def, init),
    remove,
    setPayload: (h, def, values) => fieldRecord(Op.SET_PAYLOAD, h, def, values),
    setRelation,
    unsetRelation,
  }
}
