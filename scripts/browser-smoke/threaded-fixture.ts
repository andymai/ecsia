// Shared between the page entry (entry.ts) and the Web Worker (worker.ts): the component defs and
// the worker kernels for the threaded browser smoke. Component defs mint per call (ids assign at
// world registration; the worker aligns ids by NAME from the bootstrap manifest), so each side —
// serial world, threaded world, worker — calls makeDefs() for its own set.
//
// The kernels are the arithmetic twins of the defineSystem bodies in entry.ts: ONE arithmetic,
// expressed twice (ergonomic body for the main thread, index kernel for workers) — byte-equal
// output between the serial and threaded runs is the assertion.

import { defineComponent } from '../../packages/ecsia/dist/index.js'
import type { WorkerKernelsBundle } from '../../packages/ecsia/dist/index.js'

export const POSITION_STEP = 1.5
export const ENERGY_STEP = 0.5

export function makeDefs() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Energy = defineComponent({ e: 'f32' }, { name: 'energy' })
  return { Position, Energy }
}

export function buildWorkerKernels(): WorkerKernelsBundle {
  const { Position, Energy } = makeDefs()
  const pid = () => (Position as unknown as { id: number }).id
  const eid = () => (Energy as unknown as { id: number }).id
  return {
    kernels: new Map([
      [
        'MoveX',
        (view, indices, dt) => {
          const id = pid()
          for (let i = 0; i < indices.length; i++) {
            const idx = indices[i]!
            view.writeField(idx, id, 0, view.readField(idx, id, 0) + dt * POSITION_STEP)
          }
        },
      ],
      [
        'Drain',
        (view, indices, dt) => {
          const id = eid()
          for (let i = 0; i < indices.length; i++) {
            const idx = indices[i]!
            view.writeField(idx, id, 0, view.readField(idx, id, 0) - dt * ENERGY_STEP)
          }
        },
      ],
    ]),
    components: new Map([
      ['position', Position],
      ['energy', Energy],
    ]),
  }
}
