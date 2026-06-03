// M7 worker kernel module (the dispatch mechanism, serialization.md §3.3): the worker imports THIS
// module to obtain its system kernels by name + the component defs by name (for id alignment). It is a
// built .mjs so a raw worker_threads Worker (no TS transform) can load it; it resolves @ecsia/core via
// the package's node_modules symlink (dist).
//
// The SAME defineComponent calls run here and on the main thread (the test mirrors them); ids are
// aligned from the manifest by name, so view.readField/writeField address the right shared columns.

import { defineComponent } from '@ecsia/core'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })

// Two DISJOINT-WRITE systems: Regen writes Health (reads nothing else), Channel writes Mana. They
// touch different components, so the scheduler runs them concurrently on two workers in ONE round.
function regenKernel(view, indices) {
  const id = Health.id
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    view.writeField(idx, id, 0, view.readField(idx, id, 0) + 1)
  }
}

function channelKernel(view, indices) {
  const id = Mana.id
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    view.writeField(idx, id, 0, view.readField(idx, id, 0) - 1)
  }
}

// A STRUCTURAL kernel: for each matched entity, spawn a child (OP_CREATE via the reservation
// Atomics.sub take path) and add Mana to it (OP_ADD with an initial payload). The created handle is
// immediately usable as a record subject THIS wave (CB-3 create-then-use).
function spawnerKernel(view, indices) {
  const cmd = view.commands
  for (let i = 0; i < indices.length; i++) {
    const child = cmd.create()
    if ((child >>> 0) === 0xffffffff) continue // reservation exhausted (capped, not a crash)
    cmd.add(child, Mana, { mp: 7 })
  }
}

export function buildWorkerKernels() {
  const kernels = new Map([
    ['Regen', regenKernel],
    ['Channel', channelKernel],
    ['Spawner', spawnerKernel],
  ])
  const components = new Map([
    ['health', Health],
    ['mana', Mana],
  ])
  return { kernels, components }
}

export function systemNames() {
  return ['Regen', 'Channel', 'Spawner']
}
