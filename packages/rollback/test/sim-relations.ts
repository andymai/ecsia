// The relation-bearing sibling of sim.ts: the same INTEGER-ONLY deterministic frame, plus the three
// relation storage kinds a rollback must rewind — an exclusive (eid-column) relation that
// re-targets, a non-exclusive payloaded one (overflow table), and a payload-free tag one whose every
// distinct target MINTS a new synthetic pair id.
//
// Every decision is a function of world state + the frame's input, so a re-simulation from a
// checkpoint is bit-for-bit reproducible — unless a rollback leaves relation state behind.

import { createWorld, defineComponent, onRemove, read, write } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import type { RelationsApi } from '@ecsia/relations'

export const OP_NONE = 0
export const OP_SPAWN = 1
export const OP_DESPAWN = 2
export const OP_CHILD_OF = 3
export const OP_LIKES = 4
export const OP_UNLIKE = 5
export const OP_TAG = 6
export const OP_UNTAG = 7
export const OP_UNPARENT = 8

export function encodeInput(op: number, value: number): Uint8Array {
  return new Uint8Array([op & 15, value & 0xff])
}

export interface PairState {
  handle: number
  x: number
  parent: number
  likes: [number, number][]
  tags: number[]
}

export interface RelSim {
  readonly world: World
  readonly rel: RelationsApi
  applyInput(input: Uint8Array): void
  step(): void
  /** The full observable relation topology in query order — what two runs are compared on. */
  pairs(): PairState[]
  actorHandles(): EntityHandle[]
}

let simSeq = 0

export function createRelSim(): RelSim {
  simSeq += 1
  const Pos = defineComponent({ x: 'i32', y: 'i32' }, { name: `rel_pos_${simSeq}` })
  const Ctrl = defineComponent({ op: 'i32', value: 'i32' }, { name: `rel_ctrl_${simSeq}` })
  const world = createWorld({ components: [Pos, Ctrl], maxEntities: 4096 })
  const rel = createRelations(world)

  world.observe(onRemove(Pos), () => {}) // arms the deferred-dead row hold, so a frame ends with a real drain

  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'removeRelation' })
  const Likes = rel.defineRelation({ weight: 'i32' })
  const Tags = rel.defineRelation(null)

  const ctrl = world.spawnWith([Ctrl, { op: OP_NONE, value: 0 }])
  const actorQuery = world.query(write(Pos))
  const ctrlQuery = world.query(read(Ctrl))

  const actorHandles = (): EntityHandle[] => {
    const out: EntityHandle[] = []
    actorQuery.each((e) => void out.push(e.handle as EntityHandle))
    return out
  }

  const pick = (actors: readonly EntityHandle[], value: number): EntityHandle | null =>
    actors.length === 0 ? null : (actors[value % actors.length] as EntityHandle)

  const run = (op: number, value: number): void => {
    const actors = actorHandles()
    if (op === OP_SPAWN) {
      world.spawnWith([Pos, { x: value, y: world.tick }])
      return
    }
    const a = pick(actors, value)
    const b = pick(actors, value >> 3)
    if (a === null || b === null) return
    if (op === OP_DESPAWN) {
      world.despawn(a)
    } else if (op === OP_CHILD_OF) {
      if ((a as number) !== (b as number)) rel.addPair(a, ChildOf, b)
    } else if (op === OP_UNPARENT) {
      const t = rel.targetOf(a, ChildOf)
      if (t !== null) rel.removePair(a, ChildOf, t)
    } else if (op === OP_LIKES) {
      rel.addPair(a, Likes, b, { weight: (value & 31) + 1 })
    } else if (op === OP_UNLIKE) {
      rel.removePair(a, Likes, b)
    } else if (op === OP_TAG) {
      rel.addPair(a, Tags, b)
    } else if (op === OP_UNTAG) {
      rel.removePair(a, Tags, b)
    }
  }

  return {
    world,
    rel,
    applyInput(input: Uint8Array): void {
      const view = world.entity(ctrl).write(Ctrl)
      view.op = input[0] ?? OP_NONE
      view.value = input[1] ?? 0
    },
    step(): void {
      world.frameReset()

      actorQuery.each((e) => {
        const pos = (e as unknown as Record<string, { x: number; y: number }>)[Pos.name] as { x: number; y: number }
        pos.x = (pos.x + 1) & 0xffff
      })

      const commands: { op: number; value: number }[] = []
      ctrlQuery.each((e) => {
        const c = (e as unknown as Record<string, { op: number; value: number }>)[Ctrl.name] as { op: number; value: number }
        commands.push({ op: c.op, value: c.value })
      })
      for (const { op, value } of commands) run(op, value)

      world.maintainStructural()
      world.observerDrain()
      world.flushLogs()
    },
    pairs(): PairState[] {
      const out: PairState[] = []
      for (const h of actorHandles()) {
        const parent = rel.targetOf(h, ChildOf)
        const likes: [number, number][] = []
        for (const t of rel.targetsOf(h, Likes)) {
          const view = rel.getPair(h, Likes, t).read() as { weight: number }
          likes.push([t as number, view.weight])
        }
        const tags: number[] = []
        for (const t of rel.targetsOf(h, Tags)) tags.push(t as number)
        likes.sort((p, q) => p[0] - q[0])
        tags.sort((p, q) => p - q)
        out.push({
          handle: h as number,
          x: (world.entity(h).read(Pos) as { x: number }).x,
          parent: parent === null ? -1 : (parent as number),
          likes,
          tags,
        })
      }
      return out
    },
    actorHandles,
  }
}
