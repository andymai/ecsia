// The worker pool + wave dispatch loop (scheduler.md §7). At startup it allocates the per-worker
// control SABs, exports the world's shared buffer set ONCE (memory-buffers.md §6.3 — SABs posted by
// reference, never per frame), and spawns a fixed worker pool. Per round it: tops up each worker's
// reservation (reserveEntityBlock — the M1 Atomics.sub take path is now exercised on the worker side),
// flips world.phase to 'wave', writes each batch's matched entity indices + dt into the worker's work
// SAB, bumps the wake word, and waits on the Atomics wave fence; then flips back to 'serial' and merges
// the per-worker command buffers DETERMINISTICALLY (ascending worker index — flushAll). That fixed
// merge order is what makes the multi-worker run SERIAL-EQUIVALENT despite nondeterministic completion.
//
// Tier: Node main thread blocks on the wave fence directly (selectWaitTier → 'coordinator-block');
// workers block on their wake word OFF the main thread, so there is no deadlock. NO-SAB contexts take
// the postMessage fallback (transfer columns per wave) — emitted with a diagnostic, never silent.

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { World, ComponentId } from '@ecsia/core'
import { handleIndex } from '@ecsia/core'
import type { ComponentDef, Schema, SystemId } from '@ecsia/schema'
import { With } from '@ecsia/schema'
import { makeCommandBuffer, resetBuffer, flushAll, buildFieldCodec } from '../commands/index.js'
import type { CommandBuffer, WorldApply, ComponentFieldCodec } from '../commands/index.js'
import { makeWaveCounter, makeWaveSync, workerHead, waveErrored } from './wave-sync.js'
import type { WaveCounter } from '../executor/seams.js'
import { selectWaitTier } from '../executor/seams.js'
import { makeReservationSab, fillReservation, consumedCount } from './reservation.js'
import type { WorkerReservationSab } from './reservation.js'
import type { WorkerBootstrap, ComponentManifestEntry } from './manifest.js'
import type { WorkerSystemKernel } from './worker-system.js'

/** A worker-eligible system registered with the pool, indexed by SystemId (registration order). */
export interface PoolSystem {
  readonly id: SystemId
  readonly name: string
  readonly matchComponents: readonly ComponentDef<Schema>[]
  readonly kernel: WorkerSystemKernel
  readonly maxSpawnsPerWave: number
}

/** One worker's full control-SAB set + Node Worker handle. */
interface WorkerSlot {
  readonly index: number
  readonly worker: Worker
  readonly command: CommandBuffer // SAB-backed mirror of the worker's buffer (read after the fence)
  readonly reservation: WorkerReservationSab
  readonly work: { sab: SharedArrayBuffer; i32: Int32Array; f32: Float32Array }
  readonly wake: Int32Array
  ready: boolean
}

export interface PoolConfig {
  readonly world: World
  readonly workerCount: number
  /** Module URL the workers import for their kernels (the dispatch mechanism). */
  readonly kernelModule: string
  readonly systems: readonly PoolSystem[]
  /**
   * Every component a worker may touch — read, written, OR named as an add/set-payload target. Their
   * dense ids are aligned on the worker side (serialization.md §3.2). Defaults to the union of all
   * systems' matchComponents; pass the full registered set if a kernel adds a component it does not
   * also match (e.g. a spawner adding a component to a fresh entity).
   */
  readonly components?: readonly ComponentDef<Schema>[]
  /** Max matched entities per batch dispatch (work SAB sizing). Default: maxEntities. */
  readonly maxBatchEntities?: number
  readonly commandWords?: number
  readonly diagnostic?: (message: string) => void
  /**
   * Override the worker-entry module URL. Defaults to the dist sibling of this module. Tests running
   * over TS source (vitest aliases) MUST pass the BUILT `dist/workers/worker-entry.js` URL, because a
   * raw Node worker_threads Worker has no TS transform and no path aliasing.
   */
  readonly workerEntryUrl?: string
}

const WAKE = 0
const WORK_HEADER_WORDS = 3 // [systemId, count, dtBits]

export class WorkerPool {
  readonly #world: World
  readonly #systems: readonly PoolSystem[]
  readonly #slots: WorkerSlot[] = []
  readonly #waveCounter: WaveCounter
  readonly #waveSync: ReturnType<typeof makeWaveSync>
  readonly #diag: (message: string) => void
  readonly #defById = new Map<number, ComponentDef<Schema>>()
  readonly #codecById = new Map<number, ComponentFieldCodec>()
  #wakeGen = 0
  #disposed = false

  constructor(cfg: PoolConfig) {
    this.#world = cfg.world
    this.#systems = cfg.systems
    this.#diag = cfg.diagnostic ?? ((m) => console.warn(`[ecsia] ${m}`))
    const caps = cfg.world.options // (capabilities live on the world; tier from the probe below)
    void caps

    const manifest = cfg.world.__exportShared()
    if (manifest.regions.length === 0 && manifest.columns.length === 0) {
      this.#diag(
        'threaded:true requested but no SAB-backed buffers are available (cross-origin isolation absent or SAB unavailable); ' +
          'the pool cannot share columns by reference. Run single-threaded or use the postMessage fallback.',
      )
    }

    const components: ComponentManifestEntry[] = []
    const allDefs =
      cfg.components ?? [...new Set(cfg.systems.flatMap((s) => [...s.matchComponents]))]
    for (const def of allDefs) {
      const id = (def as unknown as { id: number }).id
      if (!this.#defById.has(id)) {
        const codec = buildFieldCodec(def)
        this.#defById.set(id, def)
        this.#codecById.set(id, codec)
        components.push({ name: def.name, id, fieldWords: [codec.totalWords] })
      }
    }

    this.#waveCounter = makeWaveCounter(cfg.workerCount)
    const tier = selectWaitTier({
      waitAsync: false, // Node main thread blocks directly (tier 2); browser-main would set this true
      waitBlocking: typeof Atomics.wait === 'function',
      sabAvailable: typeof SharedArrayBuffer === 'function',
    })
    this.#waveSync = makeWaveSync(tier)

    const maxBatch = cfg.maxBatchEntities ?? cfg.world.options.maxEntities
    const reservationCap = Math.max(...cfg.systems.map((s) => s.maxSpawnsPerWave), 1)
    const here = fileURLToPath(import.meta.url)
    const entryUrl = cfg.workerEntryUrl ?? here.replace(/pool\.(js|ts)$/, 'worker-entry.$1')

    for (let i = 0; i < cfg.workerCount; i++) {
      const command = makeCommandBuffer(i, cfg.commandWords ?? 1 << 14, true)
      const reservation = makeReservationSab(reservationCap)
      const workSab = new SharedArrayBuffer((WORK_HEADER_WORDS + maxBatch) * 4)
      const wakeSab = new SharedArrayBuffer(4)
      const boot: WorkerBootstrap = {
        workerIndex: i,
        kernelModule: cfg.kernelModule,
        systemNames: cfg.systems.map((s) => s.name),
        buffers: manifest,
        indexBitsMask: cfg.world.handleLayout.indexMask,
        components,
        commandSab: command.words.buffer as SharedArrayBuffer,
        reservationSab: reservation.sab,
        reservationCapacity: reservation.capacity,
        waveSab: this.#waveCounter.sab,
        workSab,
        wakeSab,
      }
      const worker = new Worker(entryUrl, { workerData: boot })
      const slot: WorkerSlot = {
        index: i,
        worker,
        command,
        reservation,
        work: { sab: workSab, i32: new Int32Array(workSab), f32: new Float32Array(workSab) },
        wake: new Int32Array(wakeSab),
        ready: false,
      }
      worker.on('message', (msg: { kind: string; message?: string; workerIndex?: number }) => {
        if (msg.kind === 'ready') slot.ready = true
        else if (msg.kind === 'diagnostic' || msg.kind === 'error') this.#diag(msg.message ?? 'worker error')
      })
      worker.on('error', (err) => this.#diag(`worker ${i} crashed: ${String(err)}`))
      this.#slots.push(slot)
    }
  }

  /** Wait until every spawned worker has posted 'ready' (bootstrap complete). */
  async ready(): Promise<void> {
    const deadline = Date.now() + 5000
    while (this.#slots.some((s) => !s.ready)) {
      if (Date.now() > deadline) throw new Error('worker pool bootstrap timed out')
      await new Promise<void>((r) => setTimeout(r, 1))
    }
  }

  /**
   * Run one round: dispatch each (systemId, workerIndex) batch to its worker, wait on the fence, then
   * merge the per-worker command buffers in fixed worker-index order. `world.phase` is 'wave' across
   * the dispatch (PHASE-2) and flipped back to 'serial' for the merge/apply flush slot.
   */
  async runRound(batches: readonly { systemId: SystemId; workerIndex: number }[], dt: number): Promise<void> {
    if (this.#disposed) throw new Error('worker pool disposed')
    const active = batches.filter((b) => b.workerIndex >= 0 && b.workerIndex < this.#slots.length)
    if (active.length === 0) return

    // ---- reservation top-up (serial) ----
    for (const b of active) {
      const slot = this.#slots[b.workerIndex]!
      const sys = this.#systems[b.systemId as unknown as number]!
      const block = this.#world.reserveEntityBlock(b.workerIndex, sys.maxSpawnsPerWave)
      fillReservation(slot.reservation, block)
      slot.command.lastReservation = block
      resetBuffer(slot.command)
    }

    // ---- compute matched entity indices on the MAIN thread (bitmask-free archetype matching) ----
    for (const b of active) {
      const slot = this.#slots[b.workerIndex]!
      const sys = this.#systems[b.systemId as unknown as number]!
      const indices = this.#matchedIndices(sys)
      const work = slot.work
      Atomics.store(work.i32, 0, b.systemId as unknown as number)
      Atomics.store(work.i32, 1, indices.length)
      work.f32[2] = dt
      indices.forEach((idx, k) => {
        work.i32[WORK_HEADER_WORDS + k] = idx
      })
    }

    // ---- dispatch: flip to 'wave', arm the fence, wake the workers ----
    this.#world.__setPhase('wave')
    this.#waveSync.begin(this.#waveCounter, active.length)
    this.#wakeGen += 1
    for (const b of active) {
      const slot = this.#slots[b.workerIndex]!
      Atomics.store(slot.wake, WAKE, this.#wakeGen)
      Atomics.notify(slot.wake, WAKE)
    }

    // ---- wait on the wave fence (Node main blocks directly, tier 2) ----
    const r = this.#waveSync.await(this.#waveCounter)
    if (r !== undefined) await r

    // ---- serial flush slot: flip back, merge command buffers deterministically ----
    this.#world.__setPhase('serial')
    if (waveErrored(this.#waveCounter)) this.#diag('a worker system threw; its command buffer is applied/dropped per CB-SAFE')

    const bufs: CommandBuffer[] = []
    for (const b of active) {
      const slot = this.#slots[b.workerIndex]!
      const reported = workerHead(this.#waveCounter, b.workerIndex)
      const cap = slot.command.words.length
      // Hard clamp: the worker writes the SAB in place, so a `head` that exceeds the SAB length would
      // make the apply decode read past the backing (undefined → NaN opcode → 'corrupt command buffer').
      // The worker's overflow cap (ensureWords/fixed) should make this unreachable; clamp + diagnose so
      // a corrupt/over-large head can never crash apply (review issue #3).
      if (reported > cap) {
        this.#diag(`worker ${b.workerIndex} reported head ${reported} > command SAB capacity ${cap}; clamped (records lost — raise commandWords)`)
        slot.command.head = cap
      } else {
        slot.command.head = reported
      }
      bufs.push(slot.command)
    }
    bufs.sort((a, z) => a.workerIndex - z.workerIndex)
    flushAll(this.#worldApply(), bufs)
  }

  #matchedIndices(sys: PoolSystem): Int32Array {
    if (sys.matchComponents.length === 0) return new Int32Array(0)
    const terms = sys.matchComponents.map((c) => With(c))
    const q = (this.#world.query as unknown as (...t: unknown[]) => { current: Iterable<number> })(...terms)
    const out: number[] = []
    for (const idx of q.current) out.push(idx)
    return Int32Array.from(out)
  }

  #worldApply(): WorldApply {
    const world = this.#world
    const layout = world.handleLayout
    const apply = world.__apply
    const codecById = this.#codecById
    return {
      isAlive: (h) => world.isAlive(h),
      handleIndex: (h) => handleIndex(h, layout) as number,
      spawnReserved: (h) => world.__spawnReserved(h),
      despawn: (h) => world.despawn(h),
      defOf: (id) => apply.defOf(id),
      codecOf: (id) => codecById.get(id as unknown as number),
      addMany: (h, defs) => apply.addMany(h, defs),
      removeMany: (h, defs) => apply.removeMany(h, defs),
      has: (h, def) => world.has(h, def),
      writePayload: (h, def, values) => apply.writePayload(h, def, values),
      // Relation apply (relations.md §5.6): forward to the core __apply surface that @ecsia/relations
      // fills via createRelations(world). The scheduler does NOT import @ecsia/relations.
      addPair: (s, rid, t, payload) => apply.addPair?.(s, rid, t, payload),
      removePair: (s, rid, t) => apply.removePair?.(s, rid, t),
      returnUnused: (cb) => {
        const slot = this.#slots[cb.workerIndex]
        const block = slot?.command.lastReservation
        if (slot !== undefined && block !== undefined) {
          const filled = Math.min(block.handles.length, slot.reservation.capacity)
          const consumed = consumedCount(slot.reservation, filled)
          // returnReservedIds reclaims the unconsumed tail [consumed..]; clamp to the block size.
          world.returnReservedIds(block, Math.min(consumed, block.handles.length))
        }
      },
      warn: (m) => this.#diag(m),
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#wakeGen = -1
    for (const slot of this.#slots) {
      Atomics.store(slot.wake, WAKE, -1)
      Atomics.notify(slot.wake, WAKE)
    }
    await Promise.all(this.#slots.map((s) => s.worker.terminate()))
  }

  get codecById(): ReadonlyMap<number, ComponentFieldCodec> {
    return this.#codecById
  }
}
