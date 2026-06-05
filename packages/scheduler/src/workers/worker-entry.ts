// The worker thread body. Bootstraps the zero-copy world view from the SAB
// manifest in workerData, imports the user's kernel module (the dispatch mechanism: kernels are
// functions, resolved by importing the same source on the worker side — ), then
// runs a blocking dispatch loop driven entirely by Atomics (no per-wave postMessage on the hot path):
//
// 1. Atomics.wait on the wake word for the next dispatch generation (tier-2 blocking wait, OFF the
// main thread, so the Node main thread may itself block on the wave fence without deadlock).
// 2. Read the work descriptor (systemId, dt, matched entity indices) from the shared work SAB.
// 3. Run the system kernel over the indices — field writes to disjoint shared columns, structural
// ops deferred to THIS worker's SAB command buffer.
// 4. Store the buffer head into the shared heads SAB, then Atomics.sub-decrement the wave counter
// (the last decrementer notifies the main thread).
//
// The worker NEVER mutates shared structure mid-wave and NEVER reads the bitmask.

import { parentPort, workerData } from 'node:worker_threads'
import { makeEncoder, buildFieldCodec } from '../commands/index.js'
import type { CommandBuffer, ComponentFieldCodec } from '../commands/index.js'
import { buildWorkerWorldView, makeWriteCorralWriter } from './world-view.js'
import { completeWave, setWaveError } from './wave-sync.js'
import { takeReserved } from './reservation.js'
import type { WorkerReservationSab } from './reservation.js'
import type { WorkerBootstrap, ColumnsAddedMessage } from './manifest.js'
import type { WorkerSystemKernel } from './worker-system.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/schema'
import { NO_ENTITY } from '@ecsia/core'
import type { WaveCounter } from '../executor/seams.js'

const NO_ENTITY_BITS = (NO_ENTITY as unknown as number) >>> 0

interface KernelModule {
  buildWorkerKernels(): { kernels: Map<string, WorkerSystemKernel>; components: Map<string, ComponentDef<Schema>> }
}

const WAKE = 0
/** Work descriptor SAB layout: [0]=systemId [1]=count [2]=dtBits(f32) [3..]=entity indices (bytes 12). */
const WORK_INDICES_BYTE_OFFSET = 12

async function main(): Promise<void> {
  const boot = workerData as WorkerBootstrap
  const mod = (await import(boot.kernelModule)) as unknown as KernelModule
  const { kernels, components: defByName } = mod.buildWorkerKernels()
  // The SystemId→name mapping is the POOL's registration order (the bootstrap), NOT the kernel
  // module's own order — so the worker runs the system the pool dispatched, by name.
  const names = boot.systemNames

  // Align each worker-side ComponentDef id to the main thread's dense assignment
  // so column keys and command-buffer componentIds match byte-for-byte. The kernel
  // module's defineComponent calls leave id UNREGISTERED; the manifest carries the authoritative ids.
  for (const c of boot.components) {
    const def = defByName.get(c.name) as unknown as { id: number } | undefined
    if (def !== undefined) def.id = c.id
  }

  const reservation: WorkerReservationSab = {
    sab: boot.reservationSab,
    view: new Int32Array(boot.reservationSab),
    capacity: boot.reservationCapacity,
  }
  const cb: CommandBuffer = {
    workerIndex: boot.workerIndex,
    words: new Uint32Array(boot.commandSab),
    head: 0,
    recordCount: 0,
    reservation: { handles: [] },
    reservationCursor: 0,
    appliedCreateCount: 0,
    // The worker's buffer is the SAB the main thread reads in place — it is FIXED, never grown off the
    // shared backing (review issue #3). On overflow `ensureWords` caps and sets `overflowed`.
    fixed: true,
    overflowed: false,
  }

  const codecCache = new Map<number, ComponentFieldCodec>()
  const codecOf = (def: ComponentDef<Schema>): ComponentFieldCodec => {
    const id = (def as unknown as { id: number }).id
    let c = codecCache.get(id)
    if (c === undefined) {
      c = buildFieldCodec(def)
      codecCache.set(id, c)
    }
    return c
  }

  const encoder = makeEncoder({
    cb,
    infoOf(def) {
      const id = (def as unknown as { id: number }).id as unknown as ComponentId
      return { id, codec: codecOf(def) }
    },
    relationCodec() {
      // Relation payload schemas are not yet replicated into the worker
      // boot manifest, so no payload codec is available here → setRelation emits payloadWordCount=0. The
      // pair add itself still flows (subject, relationId, target); only the payload leg is deferred.
      return undefined
    },
    warn(message) {
      parentPort?.postMessage({ kind: 'diagnostic', message })
    },
  })

  // OP_CREATE on the worker takes its handle from the SAB reservation cursor (Atomics.sub take path).
  // On exhaustion takeReserved returns NO_ENTITY (0xffffffff): per
  // NOTHING and return NO_ENTITY — NOT route a NO_ENTITY handle through baseCreate (which would append a
  // spurious OP_CREATE 0xffffffff that the apply path would try to spawn → record-table corruption).
  const baseCreate = encoder.create
  ;(encoder as { create: typeof baseCreate }).create = (): ReturnType<typeof baseCreate> => {
    const h = takeReserved(reservation)
    if ((h as unknown as number) >>> 0 === NO_ENTITY_BITS) {
      parentPort?.postMessage({ kind: 'diagnostic', message: 'command-buffer: reservation exhausted; raise maxSpawnsPerWave (spawn capped)' })
      return h
    }
    cb.reservation = { handles: [h] }
    cb.reservationCursor = 0
    return baseCreate()
  }

  const writeCorral = makeWriteCorralWriter(boot.writeCorralSab)
  const view = buildWorkerWorldView(boot.buffers, boot.indexBitsMask, encoder, writeCorral)
  const wake = new Int32Array(boot.wakeSab)
  const work = new Int32Array(boot.workSab)
  const workF32 = new Float32Array(boot.workSab)
  const heads = new Int32Array(boot.waveSab) // word 4+: per-worker head (after the 4 counter words)
  const waveCounter: WaveCounter = { sab: boot.waveSab, view: new Int32Array(boot.waveSab) }
  const notice = new Int32Array(boot.noticeSab) // [0] = main thread's published re-backing generation
  const HEAD_WORD = 4 + boot.workerIndex

  // Pending `columns-added` broadcasts. The dispatch loop blocks on Atomics, so
  // a posted message only drains when the loop yields to the event loop; on a NOTICE round the loop
  // `await`s here so the queued broadcast is delivered before we re-wrap.
  const noticeQueue: ColumnsAddedMessage[] = []
  let noticeWaiter: (() => void) | undefined
  let appliedNoticeGen = 0
  parentPort?.on('message', (msg: { kind?: string }) => {
    if (msg?.kind === 'columns-added') {
      noticeQueue.push(msg as ColumnsAddedMessage)
      noticeWaiter?.()
    }
  })
  const nextNotice = async (): Promise<ColumnsAddedMessage> => {
    if (noticeQueue.length > 0) return noticeQueue.shift()!
    await new Promise<void>((resolve) => {
      noticeWaiter = resolve
    })
    noticeWaiter = undefined
    return noticeQueue.shift()!
  }

  let lastWake = 0
  parentPort?.postMessage({ kind: 'ready', workerIndex: boot.workerIndex })

  while (true) {
    Atomics.wait(wake, WAKE, lastWake)
    const signal = Atomics.load(wake, WAKE)
    if (signal === lastWake) continue
    lastWake = signal
    if (signal < 0) return // shutdown sentinel

    // NOTICE round: a column re-backed on the main thread. Drain the queued
    // `columns-added` broadcast(s) up to the published generation, re-wrap the new SABs, then ACK by
    // completing the wave fence. No system runs this wave; the next dispatch proceeds only after this.
    const publishedGen = Atomics.load(notice, 0)
    if (publishedGen !== appliedNoticeGen) {
      try {
        while (appliedNoticeGen !== publishedGen) {
          const msg = await nextNotice()
          view.applyColumnGrowth(
            msg.columns.map((c) => ({ key: c.key as never, backing: c.backing, layout: c.layout })),
          )
          appliedNoticeGen = msg.generation
        }
      } catch (err) {
        setWaveError(waveCounter)
        parentPort?.postMessage({ kind: 'error', message: String(err) })
      }
      completeWave(waveCounter)
      continue
    }

    const systemId = Atomics.load(work, 0)
    const count = Atomics.load(work, 1)
    const dt = workF32[2]!
    cb.head = 0
    cb.recordCount = 0
    cb.overflowed = false
    writeCorral.reset()
    const name = names[systemId]
    const kernel = name !== undefined ? kernels.get(name) : undefined
    try {
      if (kernel !== undefined && count > 0) {
        const indices = new Int32Array(boot.workSab, WORK_INDICES_BYTE_OFFSET, count)
        kernel(view, indices, dt)
      }
    } catch (err) {
      setWaveError(waveCounter)
      parentPort?.postMessage({ kind: 'error', message: String(err) })
    }
    if (cb.overflowed) {
      // The fixed SAB buffer filled: records were capped (not lost off-SAB, not a crash). `head` still
      // lands on a record boundary <= the SAB length, so the main-thread apply reads exactly what fit.
      parentPort?.postMessage({ kind: 'diagnostic', message: `command-buffer overflow on worker ${boot.workerIndex}; raise commandWords (records capped this wave)` })
    }
    Atomics.store(heads, HEAD_WORD, cb.head)
    completeWave(waveCounter)
  }
}

void main()
