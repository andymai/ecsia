// A small INTEGER-ONLY deterministic simulation the rollback tests re-simulate. Every decision it
// makes is a function of world state + the frame's inputs (never of JS-side state a rollback would
// not rewind), which is exactly the determinism contract the engine leans on.
//
// Its frame is the scheduler's, hand-rolled so the rollback package keeps no @ecsia/scheduler
// dependency: frameReset → systems → maintainStructural → observerDrain → flushLogs. It ends AFTER
// the drain, so the checkpoint the session takes next is at a frame boundary.

import { createWorld, defineComponent, onRemove, read, write } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'

export const OP_NONE = 0
export const OP_SPAWN = 1
export const OP_DESPAWN = 2
export const OP_NUDGE = 3

export function encodeInput(op: number, value: number): Uint8Array {
  return new Uint8Array([op & 3, value & 0xff])
}

export interface Actor {
  handle: number
  x: number
  y: number
  dx: number
  target: number
}

export interface Sim {
  readonly world: World
  /** Write one player's opaque input bytes into that player's control entity. */
  applyInput(player: number, input: Uint8Array): void
  /** ONE fixed step: exactly one `world.tick` increment, ending at a frame boundary. */
  step(): void
  /** The live actors in query order — the observable state two runs are compared on. */
  actors(): Actor[]
}

let simSeq = 0

export function createSim(playerCount = 1): Sim {
  simSeq += 1
  const Pos = defineComponent({ x: 'i32', y: 'i32' }, { name: `sim_pos_${simSeq}` })
  const Vel = defineComponent({ dx: 'i32', dy: 'i32' }, { name: `sim_vel_${simSeq}` })
  const Link = defineComponent({ target: 'eid' }, { name: `sim_link_${simSeq}` })
  const Ctrl = defineComponent({ op: 'i32', value: 'i32' }, { name: `sim_ctrl_${simSeq}` })
  const world = createWorld({ components: [Pos, Vel, Link, Ctrl], maxEntities: 4096 })

  world.observe(onRemove(Pos), () => {}) // arms the deferred-dead row hold, so a frame ends with a real drain

  const controls: EntityHandle[] = []
  for (let i = 0; i < playerCount; i++) controls.push(world.spawnWith([Ctrl, { op: OP_NONE, value: 0 }]))

  const actorQuery = world.query(write(Pos), write(Vel), read(Link))
  const ctrlQuery = world.query(read(Ctrl))

  const actorHandles = (): EntityHandle[] => {
    const out: EntityHandle[] = []
    actorQuery.each((e) => void out.push(e.handle as EntityHandle))
    return out
  }

  const spawnActor = (value: number): void => {
    const existing = actorHandles()
    const h = world.spawnWith([Pos, { x: value, y: world.tick }], [Vel, { dx: (value % 3) - 1, dy: 1 }], Link)
    world.entity(h).write(Link).target = existing[0] ?? (0 as unknown as EntityHandle)
  }

  return {
    world,
    applyInput(player: number, input: Uint8Array): void {
      const ctrl = world.entity(controls[player] as EntityHandle).write(Ctrl)
      ctrl.op = input[0] ?? OP_NONE
      ctrl.value = input[1] ?? 0
    },
    step(): void {
      world.frameReset()

      actorQuery.each((e) => {
        const el = e as unknown as Record<string, { x: number; y: number; dx: number; dy: number }>
        const pos = el[Pos.name] as { x: number; y: number }
        const vel = el[Vel.name] as { dx: number; dy: number }
        pos.x = (pos.x + vel.dx) & 0xffff
        pos.y = (pos.y + vel.dy) & 0xffff
      })

      // Read every control BEFORE acting: the ops below mutate the tables this query walks.
      const commands: { op: number; value: number }[] = []
      ctrlQuery.each((e) => {
        const el = e as unknown as Record<string, { op: number; value: number }>
        const ctrl = el[Ctrl.name] as { op: number; value: number }
        commands.push({ op: ctrl.op, value: ctrl.value })
      })
      for (const { op, value } of commands) {
        if (op === OP_SPAWN) {
          spawnActor(value)
        } else if (op === OP_DESPAWN) {
          const first = actorHandles()[0]
          if (first !== undefined) world.despawn(first)
        } else if (op === OP_NUDGE) {
          for (const h of actorHandles()) {
            const pos = world.entity(h).write(Pos)
            pos.x = (pos.x + value) & 0xffff
          }
        }
      }

      world.maintainStructural()
      world.observerDrain()
      world.flushLogs()
    },
    actors(): Actor[] {
      const out: Actor[] = []
      actorQuery.each((e) => {
        const el = e as unknown as Record<string, { x: number; y: number; dx: number; target: number }>
        const pos = el[Pos.name] as { x: number; y: number }
        const vel = el[Vel.name] as { dx: number }
        const link = el[Link.name] as { target: number }
        out.push({ handle: e.handle as number, x: pos.x, y: pos.y, dx: vel.dx, target: link.target >>> 0 })
      })
      return out
    },
  }
}
