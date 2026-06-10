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
import { makeEncoder, buildFieldCodec, ensureWords, Op } from '../commands/index.js'
import type { CommandBuffer, ComponentFieldCodec } from '../commands/index.js'
import { buildWorkerWorldView, makeWriteCorralWriter } from './world-view.js'
import { completeWave, setWaveError } from './wave-sync.js'
import { takeReserved } from './reservation.js'
import type { WorkerReservationSab } from './reservation.js'
import type { WorkerBootstrap, ColumnsAddedMessage } from './manifest.js'
import type { WorkerSystemKernel } from './worker-system.js'
import type { ComponentDef, ComponentId, Schema } from '@ecsia/schema'
import { NO_ENTITY, buildTopicCodec, defineComponent, TOPIC_HEADER_WORDS, TOPIC_HDR_HEAD_REL, TOPIC_HDR_BASE_REL } from '@ecsia/core'
import type { TopicCodec, TopicDef } from '@ecsia/core'
import type { WaveCounter } from '../executor/seams.js'

const NO_ENTITY_BITS = (NO_ENTITY as unknown as number) >>> 0

interface KernelModule {
  buildWorkerKernels(): {
    kernels: Map<string, WorkerSystemKernel>
    components: Map<string, ComponentDef<Schema>>
    /** Worker-side defineTopic defs, aligned to the main thread's topic ids by name. */
    topics?: Map<string, TopicDef<Schema>>
  }
}

const WAKE = 0
/** Work descriptor SAB layout: [0]=systemId [1]=count [2]=dtBits(f32) [3..]=entity indices (bytes 12). */
const WORK_INDICES_BYTE_OFFSET = 12

async function main(): Promise<void> {
  const boot = workerData as WorkerBootstrap
  const mod = (await import(boot.kernelModule)) as unknown as KernelModule
  const { kernels, components: defByName, topics: topicByName } = mod.buildWorkerKernels()
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
  // Topic ids align the same way components do: the manifest carries the authoritative dense ids.
  for (const t of boot.topics ?? []) {
    const def = topicByName?.get(t.name) as unknown as { id: number } | undefined
    if (def !== undefined) def.id = t.id
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

  // The publishing SystemId rides every OP_PUBLISH record so the main thread's serial-slot merge
  // can canonicalize the stream independent of which worker carried the bytes. Set per dispatch.
  let currentSystemId = 0
  const topicCodecCache = new Map<number, TopicCodec>()
  // Rebuild a pair-payload codec per relationId from the replicated payload SCHEMA — defineComponent
  // resolves the live encode/decode descriptors locally (functions can't cross the worker boundary),
  // and buildFieldCodec filters by `shareable` exactly as the main side does, so totalWords + field
  // order match byte-for-byte. Tag relations (payloadSchema===null) get no entry → payloadWordCount=0.
  const relationCodecById = new Map<number, ComponentFieldCodec>()
  for (const r of boot.relations ?? []) {
    if (r.payloadSchema === null) continue
    relationCodecById.set(r.id, buildFieldCodec(defineComponent(r.payloadSchema, { brand: `rel$${r.id}$payload` })))
  }
  const encoder = makeEncoder({
    cb,
    infoOf(def) {
      const id = (def as unknown as { id: number }).id as unknown as ComponentId
      return { id, codec: codecOf(def) }
    },
    topicInfoOf(def) {
      const id = (def as unknown as { id: number }).id
      if (id < 0) return undefined
      let codec = topicCodecCache.get(id)
      if (codec === undefined) {
        codec = buildTopicCodec(def.fields)
        topicCodecCache.set(id, codec)
      }
      return { id, codec }
    },
    publisherSystemId() {
      return currentSystemId
    },
    relationCodec(relationId) {
      // Resolved from the replicated relation manifest; undefined for tag relations (no payload words).
      return relationCodecById.get(relationId as unknown as number)
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
    // Capacity check BEFORE the Atomics take, mirroring the base encoder's ordering contract: a full
    // buffer must not burn a reservation slot. takeReserved's decrement is what consumedCount counts,
    // so a slot consumed with no OP_CREATE emitted is a handle minted alive that nothing ever places
    // or reclaims — a permanent leak, one per capped create per overflow wave.
    if (!ensureWords(cb, 2)) {
      if (!cb.overflowWarned) {
        cb.overflowWarned = true
        parentPort?.postMessage({ kind: 'diagnostic', message: 'command-buffer: fixed (SAB) buffer full; record dropped (raise commandWords)' })
      }
      return NO_ENTITY
    }
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

  // ---- worker-side topic consume ----------------------------------------------------------------
  // A consumer system's kernel iterates the topic's SAB canonical ring directly: the stream is
  // mutated only at serial slots, so [tail, head, baseSeq] (the hdr region) and the ring rows are
  // frozen for the wave. The (system, topic) cursor lives in the topic's SAB cursor table, OWNED by
  // the main thread — the worker reads its slot at consume entry and reports its advance back as an
  // OP_CONSUMED record, replayed at the serial flush. The record is appended before the first yield
  // and its seq word PATCHED per yield (advance-before-yield parity: a kernel that breaks mid-loop
  // has still observed the yielded prefix). A kernel that never calls consume emits no record, so
  // its cursor never moves — identical to the main-thread lazy-consume contract.
  interface WorkerTopicRt {
    readonly rowWords: number
    readonly ringKey: string
    readonly hdrKey: string
    readonly cursorsKey: string
    readonly view: Record<string, unknown>
    bind(words: ArrayLike<number>, base: number): void
  }
  const topicRtById = new Map<number, WorkerTopicRt>()
  const topicRtOf = (def: TopicDef<Schema>): WorkerTopicRt | undefined => {
    const id = (def as unknown as { id: number }).id
    if (id < 0) return undefined
    let rt = topicRtById.get(id)
    if (rt === undefined) {
      const codec = buildTopicCodec(def.fields)
      const pooled: Record<string, unknown> = {}
      let curWords: ArrayLike<number> = []
      let curBase = 0
      for (const f of codec.fields) {
        Object.defineProperty(pooled, f.name, {
          enumerable: true,
          get: () => f.decode(curWords, curBase + f.offset),
        })
      }
      rt = {
        rowWords: TOPIC_HEADER_WORDS + codec.fieldWords,
        ringKey: `topic.${def.name}.ring`,
        hdrKey: `topic.${def.name}.hdr`,
        cursorsKey: `topic.${def.name}.cursors`,
        view: pooled,
        bind(words, base) {
          curWords = words
          curBase = base
        },
      }
      topicRtById.set(id, rt)
    }
    return rt
  }
  // Per-dispatch consume state: the declared (topicId → readerSlot) window for the running system,
  // plus local progress so a SECOND consume call in the same run resumes where the first stopped
  // (the SAB slot only updates at the flush — without this, a re-call would redeliver).
  const consumesBySystem: ReadonlyArray<ReadonlyMap<number, number>> = (boot.consumes ?? []).map(
    (list) => new Map(list.map((c) => [c.topicId, c.readerSlot])),
  )
  let currentConsumes: ReadonlyMap<number, number> = new Map()
  const localCursors = new Map<number, number>()

  function emitConsumed(topicId: number, seq: number): number {
    if (!ensureWords(cb, 4)) return -1 // overflow: events redeliver next wave (never lost), diagnosed via cb.overflowed
    const w = cb.head
    cb.words[w] = Op.CONSUMED
    cb.words[w + 1] = topicId >>> 0
    cb.words[w + 2] = currentSystemId >>> 0
    cb.words[w + 3] = seq >>> 0
    cb.head += 4
    cb.recordCount += 1
    return w
  }

  function* consumeTopic(def: TopicDef<Schema>): IterableIterator<Record<string, unknown>> {
    const id = (def as unknown as { id: number }).id
    const slot = id >= 0 ? currentConsumes.get(id) : undefined
    if (slot === undefined) {
      throw new Error(
        `system '${names[currentSystemId] ?? currentSystemId}' consumes topic '${def.name}' without declaring it — add it to the system's consume: [...] so the scheduler can order it after publishers`,
      )
    }
    const rt = topicRtOf(def)!
    const hdr = view.regionView(rt.hdrKey) as Uint32Array | undefined
    const cursors = view.regionView(rt.cursorsKey) as Uint32Array | undefined
    const ring = view.regionView(rt.ringKey) as Uint32Array | undefined
    if (hdr === undefined || cursors === undefined || ring === undefined) {
      throw new Error(`topic '${def.name}': shared ring/hdr/cursor regions missing from the worker manifest`)
    }
    // Everything here is TAIL-RELATIVE (see TOPIC_HDR_* in core): wrap-safe by construction, and
    // the retention snap is free — a behind-tail cursor mirrors as 0.
    const headRel = hdr[TOPIC_HDR_HEAD_REL]! >>> 0
    const baseRel = hdr[TOPIC_HDR_BASE_REL]! >>> 0
    let rel = cursors[slot]! >>> 0
    const local = localCursors.get(id)
    if (local !== undefined && local > rel) rel = local
    if (rel >= headRel) return
    const rec = emitConsumed(id, rel)
    if (rec < 0) {
      // The command buffer is full, so the cursor advance cannot reach the main thread. Delivering
      // anyway would mean the kernel observes these events TWICE (again next wave, after the cursor
      // failed to move) — a silent serial-equivalence break. Deliver NOTHING: the events arrive
      // exactly once next wave through the same cursor. The cap is already diagnosed via overflow.
      parentPort?.postMessage({
        kind: 'diagnostic',
        message: `command-buffer full before OP_CONSUMED for topic '${def.name}'; consume deferred one wave (raise commandWords)`,
      })
      return
    }
    for (let s = rel; s < headRel; s++) {
      cb.words[rec + 3] = (s + 1) >>> 0
      localCursors.set(id, s + 1)
      rt.bind(ring, (baseRel + s) * rt.rowWords + TOPIC_HEADER_WORDS)
      yield rt.view
    }
  }
  ;(view as { consume?: typeof consumeTopic }).consume = consumeTopic
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
  const missingKernelWarned = new Set<string>()
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
          if (msg.regions !== undefined && msg.regions.length > 0) view.applyRegionGrowth(msg.regions)
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
    currentSystemId = systemId
    currentConsumes = consumesBySystem[systemId] ?? new Map()
    localCursors.clear()
    cb.head = 0
    cb.recordCount = 0
    cb.overflowed = false
    writeCorral.reset()
    const name = names[systemId]
    const kernel = name !== undefined ? kernels.get(name) : undefined
    // The kernel runs UNCONDITIONALLY, zero matched entities included — the single-thread executor
    // runs every system body every frame, and a count gate silently starves any side-effecting
    // zero-match kernel (pure consumers reading events, pure publishers emitting them, spawners).
    if (kernel === undefined && name !== undefined && !missingKernelWarned.has(name)) {
      missingKernelWarned.add(name)
      parentPort?.postMessage({
        kind: 'diagnostic',
        message: `no worker kernel named '${name}' in the kernel module — the system is a no-op on this worker (add it to buildWorkerKernels())`,
      })
    }
    try {
      if (kernel !== undefined) {
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
