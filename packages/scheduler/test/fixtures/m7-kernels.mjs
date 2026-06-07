// worker kernel module (the dispatch mechanism): the worker imports THIS
// module to obtain its system kernels by name + the component defs by name (for id alignment). It is a
// built .mjs so a raw worker_threads Worker (no TS transform) can load it; it resolves @ecsia/core via
// the package's node_modules symlink (dist).
//
// The SAME defineComponent calls run here and on the main thread (the test mirrors them); ids are
// aligned from the manifest by name, so view.readField/writeField address the right shared columns.

import { defineComponent, defineTopic } from '@ecsia/core'

const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
const Mana = defineComponent({ mp: 'i32' }, { name: 'mana' })
const Tally = defineComponent({ sum: 'u32', frames: 'u32' }, { name: 'tally' })
const Hits = defineTopic('hits', { n: 'i32' })

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
// immediately usable as a record subject THIS wave ( create-then-use).
function spawnerKernel(view, indices) {
  const cmd = view.commands
  for (let i = 0; i < indices.length; i++) {
    const child = cmd.create()
    if ((child >>> 0) === 0xffffffff) continue // reservation exhausted (capped, not a crash)
    cmd.add(child, Mana, { mp: 7 })
  }
}

// A PUBLISHING kernel: one OP_PUBLISH per matched entity, payload = the entity index — rides the
// worker's command buffer; the main thread canonicalizes by SystemId at the wave's serial slot.
function hitterKernel(view, indices) {
  const cmd = view.commands
  for (let i = 0; i < indices.length; i++) {
    cmd.publish(Hits, { n: indices[i] })
  }
}

// A CONSUMING kernel (worker-side consume): drains its (system, topic) cursor over the topic's
// frozen SAB ring and folds each payload into an order-sensitive checksum on the single matched
// Tally entity — the worker twin of the main-thread `for (const ev of consume(Hits))` loop. The
// cursor advance rides back as an OP_CONSUMED record automatically.
function loggerKernel(view, indices) {
  if (indices.length === 0) return // tally entity not spawned (pure-consumer rigs use LoggerPure)
  const idx = indices[0]
  const id = Tally.id
  let h = view.readField(idx, id, 0) >>> 0
  for (const ev of view.consume(Hits)) {
    h = (h * 31 + (ev.n >>> 0)) % 0x7fffffff
  }
  view.writeField(idx, id, 0, h)
  view.writeField(idx, id, 1, (view.readField(idx, id, 1) >>> 0) + 1)
}

// A PURE consumer (matches no components): must still be dispatched and drain events — the events
// are its input, not the entity set. It reports what it saw by publishing one Echo event per frame
// carrying the running count (observable main-side through the canonical stream).
const Echo = defineTopic('echo', { count: 'i32' })
let pureSeen = 0
function loggerPureKernel(view) {
  for (const ev of view.consume(Hits)) {
    void ev.n
    pureSeen += 1
  }
  view.commands.publish(Echo, { count: pureSeen })
}

export function buildWorkerKernels() {
  const kernels = new Map([
    ['Regen', regenKernel],
    ['Channel', channelKernel],
    ['Spawner', spawnerKernel],
    ['Hitter', hitterKernel],
    ['Logger', loggerKernel],
    ['LoggerPure', loggerPureKernel],
  ])
  const components = new Map([
    ['health', Health],
    ['mana', Mana],
    ['tally', Tally],
  ])
  const topics = new Map([
    ['hits', Hits],
    ['echo', Echo],
  ])
  return { kernels, components, topics }
}

export function systemNames() {
  return ['Regen', 'Channel', 'Spawner']
}
