// Worker kernel module for the heavy worker-pool speedup bench (mirrors
// packages/scheduler/test/fixtures/m7-kernels.mjs). A raw worker_threads Worker loads THIS built .mjs
// by URL (closures can't cross threads), resolving @ecsia/core via the package's node_modules symlink.
//
// The workload is CPU-HEAVY and DISJOINT-WRITE: each of W component groups (g0..g7) carries a Body
// (px,py,pz, vx,vy,vz) and each group's system writes ONLY its own group's Body. So the W systems have
// disjoint write-sets, land in one schedule round, and run concurrently on W workers — genuine OS-thread
// parallelism, not a trivial hp+1.
//
// Per entity per frame we run an ITERATED damped-oscillator integrator: HEAVY_ITERS sub-steps of
// transcendental math (sin/cos/sqrt/exp) accumulating into the entity's OWN position+velocity. Fields
// are read into locals ONCE and written back ONCE, so the cost is the float math, not field-access
// overhead — this is what amortizes the wave-sync/dispatch cost so the parallel run actually wins.
//
// HEAVY_KERNEL_DEF + makeBodies are exported so the main-thread bench builds the matching defineSystem
// twins from the SAME constants and SAME inner loop (serial-equivalence by construction).

import { defineComponent } from '@ecsia/core'

export const GROUP_COUNT = 8
export const HEAVY_ITERS = 512 // inner sub-steps per entity per frame (the per-entity FLOP knob)
const DT = 1 / 60
const OMEGA = 6.0 // oscillator angular frequency
const DAMP = 0.015 // damping per sub-step

// One Body component per group (disjoint columns ⇒ disjoint write-sets across groups).
export const Bodies = []
for (let g = 0; g < GROUP_COUNT; g++) {
  Bodies.push(
    defineComponent(
      { px: 'f32', py: 'f32', pz: 'f32', vx: 'f32', vy: 'f32', vz: 'f32' },
      { name: `body${g}` },
    ),
  )
}

// The heavy per-entity integrator, shared by the worker kernel and the main-thread twin. Reads the six
// fields, runs HEAVY_ITERS transcendental sub-steps, returns the new six-tuple. Pure float math on
// locals — no allocation in the hot loop.
export function integrateBody(px, py, pz, vx, vy, vz) {
  const h = DT / HEAVY_ITERS
  for (let k = 0; k < HEAVY_ITERS; k++) {
    const r = Math.sqrt(px * px + py * py + pz * pz) + 1e-3
    const inv = 1 / r
    // Central restoring force + a swirling, distance-modulated transcendental term (heavy on FLOPs).
    const s = Math.sin(OMEGA * r + k * 0.1)
    const c = Math.cos(OMEGA * r - k * 0.1)
    const att = Math.exp(-DAMP * r)
    const ax = (-OMEGA * OMEGA * px + s * py - c * pz) * inv * att
    const ay = (-OMEGA * OMEGA * py + s * pz - c * px) * inv * att
    const az = (-OMEGA * OMEGA * pz + s * px - c * py) * inv * att
    vx = (vx + ax * h) * (1 - DAMP * h)
    vy = (vy + ay * h) * (1 - DAMP * h)
    vz = (vz + az * h) * (1 - DAMP * h)
    px += vx * h
    py += vy * h
    pz += vz * h
  }
  return [px, py, pz, vx, vy, vz]
}

function makeKernel(group) {
  // Read `id` INSIDE the kernel (call time), not at closure-build time: the worker aligns each def's
  // dense id from the manifest AFTER importing this module, so capturing Bodies[group].id eagerly would
  // freeze the pre-registration (undefined) id. fieldIndex order = schema key order: px=0..vz=5.
  return (view, indices) => {
    const id = Bodies[group].id
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]
      const px = view.readField(idx, id, 0)
      const py = view.readField(idx, id, 1)
      const pz = view.readField(idx, id, 2)
      const vx = view.readField(idx, id, 3)
      const vy = view.readField(idx, id, 4)
      const vz = view.readField(idx, id, 5)
      const out = integrateBody(px, py, pz, vx, vy, vz)
      view.writeField(idx, id, 0, out[0])
      view.writeField(idx, id, 1, out[1])
      view.writeField(idx, id, 2, out[2])
      view.writeField(idx, id, 3, out[3])
      view.writeField(idx, id, 4, out[4])
      view.writeField(idx, id, 5, out[5])
    }
  }
}

export function buildWorkerKernels() {
  const kernels = new Map()
  const components = new Map()
  for (let g = 0; g < GROUP_COUNT; g++) {
    kernels.set(`Integrate${g}`, makeKernel(g))
    components.set(`body${g}`, Bodies[g])
  }
  return { kernels, components }
}

export function systemNames() {
  const out = []
  for (let g = 0; g < GROUP_COUNT; g++) out.push(`Integrate${g}`)
  return out
}
