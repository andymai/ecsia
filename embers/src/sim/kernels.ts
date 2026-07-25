// The worker-side field kernels — arithmetic twins of the FieldStencil/FieldSwap system bodies in
// systems.ts (both call stepFieldBand/swapFieldBand from shared.ts). Bundled statically into
// worker.js (ecsiaWorker), never imported by the page bundle.
//
// Row ↔ cell contract: field entities are the FIRST spawns in world.ts, band-major and row-major,
// and nothing structural ever happens after build — so archetype row i IS band cell i, and band
// k's first entity index is exactly `indices[0] + (k - band) * BAND_CELLS`. The serial twins index
// chunk columns the same way, which is what keeps serial == threaded byte-identical.

import type { WorkerKernelsBundle, WorkerSystemKernel, WorkerWorldView } from '@ecsia/scheduler/workers'
import { makeDefs, type SimDefs } from './components.js'
import { BANDS, BAND_CELLS, stepFieldBand, swapFieldBand, type BandArrays } from './shared.js'

function bandColumns(
  view: WorkerWorldView,
  archIds: ArrayLike<number>,
  base: number,
  band: number,
  ownBand: number,
  compId: number,
): Float32Array[] | null {
  const idx = base + (band - ownBand) * BAND_CELLS
  if (idx < 0) return null
  const aid = archIds[idx]! >>> 0
  const out: Float32Array[] = []
  for (let field = 0; field < 4; field++) {
    const col = view.columnView(aid, compId, field)?.view as Float32Array | undefined
    if (col === undefined) return null
    out.push(col)
  }
  return out
}

function makeStencilKernel(defs: SimDefs, band: number): WorkerSystemKernel {
  return (view: WorkerWorldView, indices: Int32Array): void => {
    if (indices.length === 0) return
    const archIds = view.regionView('entity.archetypeId')
    if (archIds === undefined) return
    const base = indices[0]!
    const tC: BandArrays = []
    const pC: BandArrays = []
    const vxC: BandArrays = []
    const vyC: BandArrays = []
    for (let k = 0; k < BANDS; k++) {
      const curId = (defs.FCur[k] as unknown as { id: number }).id
      const cols = bandColumns(view, archIds, base, k, band, curId)
      if (cols === null) return
      tC.push(cols[0]!)
      pC.push(cols[1]!)
      vxC.push(cols[2]!)
      vyC.push(cols[3]!)
    }
    const newId = (defs.FNew[band] as unknown as { id: number }).id
    const own = bandColumns(view, archIds, base, band, band, newId)
    if (own === null) return
    stepFieldBand(band, tC, pC, vxC, vyC, own[0]!, own[1]!, own[2]!, own[3]!)
  }
}

function makeSwapKernel(defs: SimDefs, band: number): WorkerSystemKernel {
  return (view: WorkerWorldView, indices: Int32Array): void => {
    if (indices.length === 0) return
    const archIds = view.regionView('entity.archetypeId')
    if (archIds === undefined) return
    const base = indices[0]!
    const curId = (defs.FCur[band] as unknown as { id: number }).id
    const newId = (defs.FNew[band] as unknown as { id: number }).id
    const cur = bandColumns(view, archIds, base, band, band, curId)
    const nxt = bandColumns(view, archIds, base, band, band, newId)
    if (cur === null || nxt === null) return
    swapFieldBand(cur[0]!, cur[1]!, cur[2]!, cur[3]!, nxt[0]!, nxt[1]!, nxt[2]!, nxt[3]!)
  }
}

export function buildWorkerKernels(): WorkerKernelsBundle {
  const defs = makeDefs()
  const kernels = new Map<string, WorkerSystemKernel>()
  const components = new Map()
  for (let b = 0; b < BANDS; b++) {
    kernels.set(`FieldStencil${b}`, makeStencilKernel(defs, b))
    kernels.set(`FieldSwap${b}`, makeSwapKernel(defs, b))
    components.set(`fcur${b}`, defs.FCur[b]!)
    components.set(`fnew${b}`, defs.FNew[b]!)
  }
  return { kernels, components, topics: new Map() } as WorkerKernelsBundle
}
