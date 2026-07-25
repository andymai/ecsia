// The worker-side steering kernels — the arithmetic twins of the Steer system bodies in systems.ts.
// Both call stepEnemy() from shared.ts; this file only feeds it columns. Bundled statically into
// worker.js (ecsiaWorker), never imported by the page bundle.
//
// Hot-loop shape: resolve the raw column views ONCE per archetype via view.columnView (the worker
// analog of eachChunk) and index rows directly — readField/writeField per field would be ~10× too
// slow at horde scale. Raw-view writes skip the write corral: nothing observes cohort columns, so
// untracked is correct here (documented tradeoff on columnView).

import type { WorkerKernelsBundle, WorkerWorldView } from '@ecsia/scheduler/workers'
import type { WorkerSystemKernel } from '@ecsia/scheduler/workers'
import { makeDefs, type SimDefs } from './components.js'
import { COHORTS, stepEnemy } from './shared.js'

const out = new Float32Array(5)
const beacons = new Float32Array(16 * 2)

function makeSteerKernel(defs: SimDefs, cohort: number): WorkerSystemKernel {
  const Pos = defs.EPos[cohort]!
  const Vel = defs.EVel[cohort]!
  return (view: WorkerWorldView, indices: Int32Array, dt: number): void => {
    let bn = 0
    if (view.consume !== undefined) {
      for (const ev of view.consume(defs.Beacon)) {
        if ((ev['alive'] as number) !== 0 && bn < 16) {
          beacons[bn * 2] = ev['x'] as number
          beacons[bn * 2 + 1] = ev['y'] as number
          bn++
        }
      }
    }
    if (indices.length === 0 || bn === 0) return

    const pid = (Pos as unknown as { id: number }).id
    const vid = (Vel as unknown as { id: number }).id
    const archIds = view.regionView('entity.archetypeId')
    const rows = view.regionView('entity.archetypeRow')
    if (archIds === undefined || rows === undefined) return

    let boundArch = -1
    let cx: Float32Array | null = null
    let cy: Float32Array | null = null
    let cvx: Float32Array | null = null
    let cvy: Float32Array | null = null
    let cph: Float32Array | null = null
    let cag: Float32Array | null = null

    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!
      const aid = archIds[idx]! >>> 0
      if (aid !== boundArch) {
        boundArch = aid
        cx = (view.columnView(aid, pid, 0)?.view as Float32Array) ?? null
        cy = (view.columnView(aid, pid, 1)?.view as Float32Array) ?? null
        cvx = (view.columnView(aid, vid, 0)?.view as Float32Array) ?? null
        cvy = (view.columnView(aid, vid, 1)?.view as Float32Array) ?? null
        cph = (view.columnView(aid, vid, 2)?.view as Float32Array) ?? null
        cag = (view.columnView(aid, vid, 3)?.view as Float32Array) ?? null
      }
      if (cx === null || cy === null || cvx === null || cvy === null || cph === null || cag === null) continue
      const row = rows[idx]! >>> 0
      const x = cx[row]!
      const y = cy[row]!
      // Nearest alive beacon — identical selection order to the serial twin.
      let tx = beacons[0]!
      let ty = beacons[1]!
      let best = (tx - x) * (tx - x) + (ty - y) * (ty - y)
      for (let b = 1; b < bn; b++) {
        const bx = beacons[b * 2]!
        const by = beacons[b * 2 + 1]!
        const d = (bx - x) * (bx - x) + (by - y) * (by - y)
        if (d < best) {
          best = d
          tx = bx
          ty = by
        }
      }
      stepEnemy(x, y, cvx[row]!, cvy[row]!, cph[row]!, cag[row]!, tx, ty, dt, out)
      cx[row] = out[0]!
      cy[row] = out[1]!
      cvx[row] = out[2]!
      cvy[row] = out[3]!
      cph[row] = out[4]!
    }
  }
}

export function buildWorkerKernels(): WorkerKernelsBundle {
  const defs = makeDefs()
  const kernels = new Map<string, WorkerSystemKernel>()
  const components = new Map()
  for (let c = 0; c < COHORTS; c++) {
    kernels.set(`Steer${c}`, makeSteerKernel(defs, c))
    components.set(`epos${c}`, defs.EPos[c]!)
    components.set(`evel${c}`, defs.EVel[c]!)
  }
  const topics = new Map([['beacon', defs.Beacon]])
  return { kernels, components, topics } as WorkerKernelsBundle
}
