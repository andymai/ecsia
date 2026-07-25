// The serial CA systems + the field twins. Paint and Particles read MainPin (an object<T>
// component) — that pins them to the main thread. The FieldStencil/FieldSwap bodies below are the
// arithmetic twins of kernels.ts (both call stepFieldBand/swapFieldBand from shared.ts).
//
// Determinism inventory: PRNG consumed only in Paint/Particles, in fixed row order; the pool never
// has structural ops after build; field kernels do pure column writes from previous-tick reads.

import { defineSystem, read, write } from '@ecsia/kit'
import type { SystemDef } from '@ecsia/kit'
import type { SimDefs } from './components.js'
import { paintTick, stepParticles } from './particles.js'
import type { FieldCols, PaintEvent, ParticleCols, SimCtx } from './particles.js'
import { BANDS, stepFieldBand, swapFieldBand, type BandArrays } from './shared.js'

export interface RunState {
  sim: SimCtx
  /** Consumes and returns this tick's paint segments (live input, scripts, and replays alike). */
  eventsFor(tick: number): PaintEvent[]
}

interface QueryChunk {
  count: number
  column(def: unknown, field: string): ArrayBufferView
}

interface ChunkQuery {
  eachChunk(fn: (chunk: QueryChunk) => void): void
}

function particleCols(q: ChunkQuery, def: SimDefs['Particle']): ParticleCols | null {
  let cols: ParticleCols | null = null
  q.eachChunk((chunk) => {
    cols = {
      elem: chunk.column(def, 'elem') as Int32Array,
      px: chunk.column(def, 'px') as Int32Array,
      py: chunk.column(def, 'py') as Int32Array,
      vx: chunk.column(def, 'vx') as Float32Array,
      vy: chunk.column(def, 'vy') as Float32Array,
      temp: chunk.column(def, 'temp') as Float32Array,
      life: chunk.column(def, 'life') as Int32Array,
      meta: chunk.column(def, 'meta') as Int32Array,
    }
  })
  return cols
}

function bandCols(q: ChunkQuery, def: SimDefs['FCur'][number] | SimDefs['FNew'][number]): Float32Array[] | null {
  let out: Float32Array[] | null = null
  q.eachChunk((chunk) => {
    out = [
      chunk.column(def, 't') as Float32Array,
      chunk.column(def, 'p') as Float32Array,
      chunk.column(def, 'vx') as Float32Array,
      chunk.column(def, 'vy') as Float32Array,
    ]
  })
  return out
}

export function makeSystems(defs: SimDefs, ctx: RunState): SystemDef[] {
  const { FCur, FNew, Particle, MainPin } = defs

  const Paint = defineSystem({
    name: 'Paint',
    read: [MainPin],
    write: [Particle],
    run({ query, tick }) {
      const t = tick as unknown as number
      const events = ctx.eventsFor(t)
      if (events.length === 0) return
      const cols = particleCols(query(write(Particle)) as unknown as ChunkQuery, Particle)
      if (cols !== null) paintTick(ctx.sim, cols, events)
    },
  })

  const Particles = defineSystem({
    name: 'Particles',
    read: [MainPin],
    write: [Particle, ...FCur],
    run({ query, tick }) {
      const t = tick as unknown as number
      const cols = particleCols(query(write(Particle)) as unknown as ChunkQuery, Particle)
      if (cols === null) return
      const f: FieldCols = { t: [], p: [], vx: [], vy: [] }
      for (let b = 0; b < BANDS; b++) {
        const cb = bandCols(query(write(FCur[b]!)) as unknown as ChunkQuery, FCur[b]!)
        if (cb === null) return
        f.t.push(cb[0]!)
        f.p.push(cb[1]!)
        f.vx.push(cb[2]!)
        f.vy.push(cb[3]!)
      }
      stepParticles(ctx.sim, cols, f, t)
    },
  })

  const stencils = Array.from({ length: BANDS }, (_, b) =>
    defineSystem({
      name: `FieldStencil${b}`,
      read: [...FCur],
      write: [FNew[b]!],
      run({ query }) {
        const tC: BandArrays = []
        const pC: BandArrays = []
        const vxC: BandArrays = []
        const vyC: BandArrays = []
        for (let k = 0; k < BANDS; k++) {
          const cb = bandCols(query(read(FCur[k]!)) as unknown as ChunkQuery, FCur[k]!)
          if (cb === null) return
          tC.push(cb[0]!)
          pC.push(cb[1]!)
          vxC.push(cb[2]!)
          vyC.push(cb[3]!)
        }
        const own = bandCols(query(write(FNew[b]!)) as unknown as ChunkQuery, FNew[b]!)
        if (own === null) return
        stepFieldBand(b, tC, pC, vxC, vyC, own[0]!, own[1]!, own[2]!, own[3]!)
      },
    }),
  )

  const swaps = Array.from({ length: BANDS }, (_, b) =>
    defineSystem({
      name: `FieldSwap${b}`,
      read: [FNew[b]!],
      write: [FCur[b]!],
      run({ query }) {
        const cur = bandCols(query(write(FCur[b]!)) as unknown as ChunkQuery, FCur[b]!)
        const nxt = bandCols(query(read(FNew[b]!)) as unknown as ChunkQuery, FNew[b]!)
        if (cur === null || nxt === null) return
        swapFieldBand(cur[0]!, cur[1]!, cur[2]!, cur[3]!, nxt[0]!, nxt[1]!, nxt[2]!, nxt[3]!)
      },
    }),
  )

  return [Paint, Particles, ...stencils, ...swaps]
}
