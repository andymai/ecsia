// Growth-boundary worker kernels (sibling of m7-kernels.mjs). A built .mjs so a raw worker_threads
// Worker resolves @ecsia/core via the dist symlink. The same defineComponent names run here and on the
// main thread; ids are aligned from the manifest by name.
//
// Health + Mana, one archetype. Three kernels:
// Regen — Health += 1 (the disjoint-write twin used for serial-equivalence)
// Copy — Mana := Health (READ-BACK proof: the worker reads Health and surfaces it in a
// DIFFERENT column. After a re-backing, a main-thread sentinel written at a high Health row
// must reappear in that entity's Mana iff the worker re-wrapped onto the NEW backing.)
// Spawner — create child + add Mana=7 (worker-staged OP_CREATE; its serial-slot apply may grow a col)

import { defineComponent } from '@ecsia/core'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })

function regenKernel(view, indices) {
  const id = Health.id
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    view.writeField(idx, id, 0, view.readField(idx, id, 0) + 1)
  }
}

function copyKernel(view, indices) {
  const hid = Health.id
  const mid = Mana.id
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    view.writeField(idx, mid, 0, view.readField(idx, hid, 0))
  }
}

function spawnerKernel(view, indices) {
  const cmd = view.commands
  for (let i = 0; i < indices.length; i++) {
    const child = cmd.create()
    if ((child >>> 0) === 0xffffffff) continue
    cmd.add(child, Health, { hp: 4242 })
  }
}

export function buildWorkerKernels() {
  const kernels = new Map([
    ['Regen', regenKernel],
    ['Copy', copyKernel],
    ['Spawner', spawnerKernel],
  ])
  const components = new Map([
    ['health', Health],
    ['mana', Mana],
  ])
  return { kernels, components }
}

export function systemNames() {
  return ['Regen', 'Copy', 'Spawner']
}
