// The worker pool + wave dispatch loop. At startup it allocates the per-worker
// control SABs, exports the world's shared buffer set ONCE (by reference, never per frame), and
// spawns a fixed worker pool. Per round it: tops up each worker's
// reservation (reserveEntityBlock — the Atomics.sub take path is now exercised on the worker side),
// flips world.phase to 'wave', writes each batch's matched entity indices + dt into the worker's work
// SAB, bumps the wake word, and waits on the Atomics wave fence; then flips back to 'serial' and merges
// the per-worker command buffers DETERMINISTICALLY (ascending worker index — flushAll). That fixed
// merge order is what makes the multi-worker run SERIAL-EQUIVALENT despite nondeterministic completion.
//
// Tier: chosen from the transport. Under the default node:worker_threads transport the main thread
// blocks on the wave fence directly (selectWaitTier → 'coordinator-block'); under the browser
// Web Worker transport the main thread takes the non-blocking Atomics.waitAsync tier. Workers block
// on their wake word OFF the main thread either way, so there is no deadlock. NO-SAB contexts are
// diagnosed at pool construction and the scheduler falls back to a single-threaded run — loud,
// never silent.
import type { World, ComponentId, TopicDef } from '@ecsia/core'
import { handleIndex, defineComponent } from '@ecsia/core'
import type { ComponentDef, Schema, SystemId } from '@ecsia/schema'
import { has } from '@ecsia/schema'
import { makeCommandBuffer, resetBuffer, flushAll, buildFieldCodec } from '../commands/index.js'
import type { CommandBuffer, WorldApply, ComponentFieldCodec } from '../commands/index.js'
import { makeWaveCounter, makeWaveSync, workerHead, waveErrored } from './wave-sync.js'
import type { WaveCounter } from '../executor/seams.js'
import { selectWaitTier } from '../executor/seams.js'
import { makeReservationSab, fillReservation, consumedCount } from './reservation.js'
import type { WorkerReservationSab } from './reservation.js'
import type { WorkerBootstrap, ComponentManifestEntry, RelationManifestEntry, ColumnsAddedMessage } from './manifest.js'
import type { WorkerSystemKernel } from './worker-system.js'
import type { WorkerPort, WorkerTransport } from './transport.js'
import { hasWaitAsync } from './atomics-shim.js'

/** A worker-eligible system registered with the pool, indexed by SystemId (registration order). */
export interface PoolSystem {
  readonly id: SystemId
  readonly name: string
  readonly matchComponents: readonly ComponentDef<Schema>[]
  readonly kernel: WorkerSystemKernel
  readonly maxSpawnsPerWave: number
  /**
   * Topics this system declares in `consume:`. The pool assigns each (system, topic) a cursor-table
   * slot at construction and ships the (topicId, readerSlot) windows to workers, so a worker-run
   * consumer reads its own cursor mid-wave and reports the advance back via OP_CONSUMED.
   */
  readonly consumeTopics?: readonly TopicDef<Schema>[]
}

/** One worker's full control-SAB set + transport port. */
interface WorkerSlot {
  readonly index: number
  readonly worker: WorkerPort
  readonly command: CommandBuffer // SAB-backed mirror of the worker's buffer (read after the fence)
  readonly reservation: WorkerReservationSab
  readonly work: { sab: SharedArrayBuffer; i32: Int32Array; f64: Float64Array }
  readonly wake: Int32Array
  /** Re-backing signal SAB ([0] = published column-growth generation). */
  readonly notice: Int32Array
  /** Write-corral mirror: [0]=count, then [index, componentId] pairs. */
  readonly writeCorral: Uint32Array
  ready: boolean
}

export interface PoolConfig {
  readonly world: World
  readonly workers: number
  /**
   * Module URL the workers import for their kernels (the Node dispatch mechanism). REQUIRED under
   * the default node:worker_threads transport; unused under a browser transport, whose worker file
   * bundles its kernels statically (see browser-entry.ts).
   */
  readonly kernelModule?: string | undefined
  readonly systems: readonly PoolSystem[]
  /**
   * Every component a worker may touch — read, written, OR named as an add/set-payload target. Their
   * dense ids are aligned on the worker side. Defaults to the union of all
   * systems' matchComponents; pass the full registered set if a kernel adds a component it does not
   * also match (e.g. a spawner adding a component to a fresh entity).
   */
  readonly components?: readonly ComponentDef<Schema>[]
  /** Max matched entities per batch dispatch (work SAB sizing). Default: maxEntities. */
  readonly maxBatchEntities?: number
  readonly commandWords?: number
  /**
   * Max `(index, componentId)` value-write entries one worker may stage per wave (write-corral SAB
   * sizing). Default: maxBatchEntities × 4 (a kernel may write a few components
   * per matched entity). Excess writes are capped (diagnosed at merge), never dropped silently.
   */
  readonly writeCorralEntries?: number
  readonly diagnostic?: (message: string) => void
  /**
   * Override the worker-entry module URL (Node transport only). Defaults to the dist sibling of the
   * transport module. Tests running over TS source (vitest aliases) MUST pass the BUILT
   * `dist/workers/worker-entry.js` URL, because a raw Node worker_threads Worker has no TS transform
   * and no path aliasing.
   */
  readonly workerEntryUrl?: string
  /**
   * The worker spawn/message transport. Default: the node:worker_threads transport (loaded lazily so
   * browser bundles including this module stay clean). Browsers pass
   * `browserWorkerTransport(createWorker)` — see browser-transport.ts.
   */
  readonly transport?: WorkerTransport
}

const WAKE = 0
// Work descriptor header: [0]=systemId [1]=count, then dt as a FULL f64 at byte offset 8 (words
// 2..3). dt must cross the thread boundary losslessly — an f32 slot would hand kernels fround(dt)
// while serial bodies compute with the exact f64, a silent serial-equivalence break for any dt
// that isn't f32-exact (1/60 isn't).
const WORK_HEADER_WORDS = 4

export class WorkerPool {
  readonly #world: World
  readonly #systems: readonly PoolSystem[]
  readonly #slots: WorkerSlot[] = []
  readonly #waveCounter: WaveCounter
  readonly #waveSync: ReturnType<typeof makeWaveSync>
  readonly #diag: (message: string) => void
  readonly #defById = new Map<number, ComponentDef<Schema>>()
  readonly #codecById = new Map<number, ComponentFieldCodec>()
  /** relationId → pair-payload codec (main-side decode of worker ADD_PAIR payloads). */
  readonly #relationCodecById = new Map<number, ComponentFieldCodec>()
  #wakeGen = 0
  // The last column-growth generation we broadcast to the workers. A cheap `!==` against the
  // world's live generation gates the whole re-backing fence — zero work when nothing re-backed.
  #appliedGrowthGen = 0
  #disposed = false
  readonly #transport: WorkerTransport | undefined
  /** Resolves once every Worker is constructed (the transport lazy-load + spawn phase). */
  readonly #spawning: Promise<void>

  constructor(cfg: PoolConfig) {
    this.#world = cfg.world
    this.#systems = cfg.systems
    this.#diag = cfg.diagnostic ?? ((m) => console.warn(`[ecsia] ${m}`))
    this.#transport = cfg.transport
    if (cfg.transport === undefined && cfg.kernelModule === undefined) {
      throw new Error(
        "WorkerPool: the default node transport requires 'kernelModule' (workers import their kernels from it); browser transports bundle kernels into the worker file instead",
      )
    }

    const manifest = cfg.world.__exportShared()
    if (manifest.regions.length === 0 && manifest.columns.length === 0) {
      this.#diag(
        'threaded:true requested but no SAB-backed buffers are available (cross-origin isolation absent or SAB unavailable); ' +
          'the pool cannot share columns by reference. Run single-threaded instead.',
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

    // Relation payload manifest + main-side decode codecs. Relations attach via createRelations(world)
    // and the scheduler never imports @ecsia/relations, so the payload SCHEMA (POJO tokens) rides the
    // existing __serialize provider; both sides rebuild the codec from it (defineComponent → codec),
    // aligning by relationId — the same align-by-schema mechanism components/topics already use.
    const relations: RelationManifestEntry[] = []
    for (const r of cfg.world.__serialize.relations()?.relations() ?? []) {
      const id = r.id as unknown as number
      relations.push({ name: r.name, id, payloadSchema: r.payloadSchema })
      if (r.payloadSchema !== null && !this.#relationCodecById.has(id)) {
        this.#relationCodecById.set(id, buildFieldCodec(defineComponent(r.payloadSchema, { brand: `rel$${id}$payload` })))
      }
    }

    this.#waveCounter = makeWaveCounter(cfg.workers)
    // The transport knows whether THIS thread may block in Atomics.wait: Node main blocks directly
    // (tier 2, the default transport); a browser main thread must take Atomics.waitAsync (tier 1,
    // falling back to the promise-poll tier on engines without waitAsync).
    const mayBlock = cfg.transport?.mainThreadMayBlock ?? true
    const tier = selectWaitTier({
      waitAsync: !mayBlock && hasWaitAsync(),
      waitBlocking: mayBlock && typeof Atomics.wait === 'function',
      sabAvailable: typeof SharedArrayBuffer === 'function',
    })
    this.#waveSync = makeWaveSync(tier)

    const maxBatch = cfg.maxBatchEntities ?? cfg.world.options.maxEntities
    const corralEntries = cfg.writeCorralEntries ?? maxBatch * 4

    // Per-system consume windows: assign each (system, topic) its cursor-table slot now (slots are
    // name-keyed in the store, so a re-created pool resumes the same cursors). Indexed by SystemId.
    const topicsStore = cfg.world.__topics
    const consumes = cfg.systems.map((s) =>
      (s.consumeTopics ?? []).map((t) => ({
        topicId: topicsStore.idOf(t),
        readerSlot: topicsStore.readerSlotFor(t, s.name),
      })),
    )
    const reservationCap = Math.max(...cfg.systems.map((s) => s.maxSpawnsPerWave), 1)

    const boots: { boot: WorkerBootstrap; command: CommandBuffer; reservation: WorkerReservationSab; workSab: SharedArrayBuffer; wakeSab: SharedArrayBuffer; noticeSab: SharedArrayBuffer; writeCorralSab: SharedArrayBuffer }[] = []
    for (let i = 0; i < cfg.workers; i++) {
      const command = makeCommandBuffer(i, cfg.commandWords ?? 1 << 14, true)
      const reservation = makeReservationSab(reservationCap)
      const workSab = new SharedArrayBuffer((WORK_HEADER_WORDS + maxBatch) * 4)
      const wakeSab = new SharedArrayBuffer(4)
      const noticeSab = new SharedArrayBuffer(4) // [0] = published column-growth generation
      // Write-corral SAB: 1 header word (count) + 2 words per staged entry.
      const writeCorralSab = new SharedArrayBuffer((1 + corralEntries * 2) * 4)
      const boot: WorkerBootstrap = {
        workerIndex: i,
        kernelModule: cfg.kernelModule,
        systemNames: cfg.systems.map((s) => s.name),
        buffers: manifest,
        indexBitsMask: cfg.world.handleLayout.indexMask,
        components,
        // Topic ids are snapshotted ONCE here, like the component manifest: create the scheduler
        // (which registers declared topics) BEFORE the pool, and recreate the pool after any
        // re-plan that introduces new topics — a worker publish to an unaligned topic is dropped
        // with a diagnostic, never silently misrouted.
        topics: cfg.world.__topics.manifest(),
        // Relation ids/schemas snapshotted ONCE here, like components/topics: register relations
        // before pool construction; recreate the pool if relations are added after. A worker
        // setRelation for an unaligned relation falls back to payloadWordCount=0, never misroutes.
        relations,
        consumes,
        commandSab: command.words.buffer as SharedArrayBuffer,
        reservationSab: reservation.sab,
        reservationCapacity: reservation.capacity,
        waveSab: this.#waveCounter.sab,
        workSab,
        wakeSab,
        noticeSab,
        writeCorralSab,
      }
      boots.push({ boot, command, reservation, workSab, wakeSab, noticeSab, writeCorralSab })
    }

    this.#spawning = this.#spawn(boots, cfg.workerEntryUrl)
  }

  #spawned = false

  async #spawn(
    boots: readonly { boot: WorkerBootstrap; command: CommandBuffer; reservation: WorkerReservationSab; workSab: SharedArrayBuffer; wakeSab: SharedArrayBuffer; noticeSab: SharedArrayBuffer; writeCorralSab: SharedArrayBuffer }[],
    workerEntryUrl: string | undefined,
  ): Promise<void> {
    // The node transport loads lazily so a browser bundle that merely includes this module never
    // touches node:*.
    const transport = this.#transport ?? (await import('./node-transport.js')).nodeWorkerTransport

    for (const b of boots) {
      if (this.#disposed) return
      const i = b.boot.workerIndex
      const port = await transport.spawn(b.boot, { workerEntryUrl })
      const slot: WorkerSlot = {
        index: i,
        worker: port,
        command: b.command,
        reservation: b.reservation,
        work: { sab: b.workSab, i32: new Int32Array(b.workSab), f64: new Float64Array(b.workSab, 8, 1) },
        wake: new Int32Array(b.wakeSab),
        notice: new Int32Array(b.noticeSab),
        writeCorral: new Uint32Array(b.writeCorralSab),
        ready: false,
      }
      port.onMessage((raw) => {
        const msg = raw as { kind?: string; message?: string; workerIndex?: number }
        if (msg?.kind === 'ready') slot.ready = true
        else if (msg?.kind === 'diagnostic' || msg?.kind === 'error') this.#diag(msg.message ?? 'worker error')
      })
      port.onError((err) => this.#diag(`worker ${i} crashed: ${String(err)}`))
      this.#slots.push(slot)
    }
    this.#spawned = true
  }

  /** Wait until every spawned worker has posted 'ready' (bootstrap complete). */
  async ready(): Promise<void> {
    await this.#spawning
    const deadline = Date.now() + 5000
    while (this.#slots.some((s) => !s.ready)) {
      if (Date.now() > deadline)
        throw new Error(
          'worker pool bootstrap timed out — a worker did not report ready within 5s (it likely threw while importing its kernel module; check the worker console for the real error)',
        )
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
    // Workers now spawn asynchronously (lazy node:* load) — before ready() resolves there are no
    // slots, and silently dispatching to zero workers would read as "ran instantly". Fail loud.
    if (!this.#spawned) throw new Error('worker pool not ready — await pool.ready() before runRound()')
    const active = batches.filter((b) => b.workerIndex >= 0 && b.workerIndex < this.#slots.length)
    if (active.length === 0) return

    // ---- re-backing fence: re-wrap any column that moved to a NEW SAB since the last dispatch
    // BEFORE this one proceeds. One generation `!==` per wave when nothing grew (zero steady-state cost).
    await this.#drainColumnGrowth()

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
      const work = slot.work
      const count = this.#fillMatchedIndices(sys, work.i32)
      Atomics.store(work.i32, 0, b.systemId as unknown as number)
      Atomics.store(work.i32, 1, count)
      work.f64[0] = dt
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

    // ---- wait on the wave fence (blocking tier 2 on Node; waitAsync tier under a browser transport) ----
    const r = this.#waveSync.await(this.#waveCounter)
    if (r !== undefined) await r

    // ---- serial flush slot: flip back, merge command buffers deterministically ----
    this.#world.__setPhase('serial')
    if (waveErrored(this.#waveCounter)) this.#diag('a worker system threw; its command buffer is applied/dropped per CB-SAFE')

    // Merge each worker's value-write corral into the shared write log in ASCENDING worker-index order
    // BEFORE the command buffers apply — mirroring single-thread run-wave's
    // mergeCorrals()→flushAll() order. This is what makes onChange observers + `.changed` filters fire
    // for worker field writes (and stamp changeVersion) deterministically.
    const writers = active.map((b) => b.workerIndex).sort((a, z) => a - z)
    const corralHeader = 1
    for (const wi of writers) {
      const slot = this.#slots[wi]!
      const corral = slot.writeCorral
      const count = corral[0]! >>> 0
      const capPairs = (corral.length - corralHeader) >>> 1
      if (count > capPairs) {
        this.#diag(`worker ${wi} write-corral overflow (${count} > ${capPairs} entries); merged ${capPairs} (raise writeCorralEntries)`)
      }
      const merged = Math.min(count, capPairs)
      if (merged > 0) {
        this.#world.__mergeWorkerWrites(corral.subarray(corralHeader, corralHeader + merged * 2), merged)
      }
      corral[0] = 0
    }

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

  /**
   * (the world's
   * growth generation advanced), broadcast the new backings to EVERY worker and block on the wave fence
   * until all have re-wrapped + ACKed — so no dispatch ever reads a worker's stale (abandoned-SAB) view.
   * Steady state is a single generation `!==`; the drain + broadcast happen only on an actual re-backing.
   */
  async #drainColumnGrowth(): Promise<void> {
    const log = this.#world.__columnGrowth()
    if (log.generation === this.#appliedGrowthGen) return // nothing re-backed — the steady-state path

    const gen = log.generation
    const notices = log.drain()
    if (notices.length > 0) {
      // Split column re-backs from region re-backs (TopicRingGrown): the worker re-wraps columns
      // into its column map and regions (topic rings / cursor tables) into its regions map.
      const cols = notices.filter((n): n is Extract<typeof n, { layout: unknown }> => 'layout' in n)
      const regs = notices.filter((n): n is Exclude<typeof n, { layout: unknown }> => !('layout' in n))
      const msg: ColumnsAddedMessage = {
        kind: 'columns-added',
        generation: gen,
        columns: cols.map((n) => ({ key: n.key as unknown as string, backing: n.backing, layout: n.layout })),
        regions: regs.map((n) => ({ key: n.key as unknown as string, backing: n.backing, element: n.element })),
      }
      // Arm the fence for every worker (each ACKs by completing the wave once it has re-wrapped).
      this.#world.__setPhase('wave')
      this.#waveSync.begin(this.#waveCounter, this.#slots.length)
      this.#wakeGen += 1
      for (const slot of this.#slots) {
        slot.worker.postMessage(msg) // SAB references can ONLY ride postMessage, not a SAB
        Atomics.store(slot.notice, 0, gen)
        Atomics.store(slot.wake, WAKE, this.#wakeGen)
        Atomics.notify(slot.wake, WAKE)
      }
      const r = this.#waveSync.await(this.#waveCounter)
      if (r !== undefined) await r
      this.#world.__setPhase('serial')
    }
    this.#appliedGrowthGen = gen
  }

  /**
   * Write the matched entity indices for `sys` into `dst` after the header; returns the count.
   * Fast path: bulk-copy the matched set's dense prefix (denseView — SAME order as the iterator, so
   * command-emitting kernels keep their apply order). At horde scale per-element iterator-protocol
   * iteration alone costs more than the whole wave, which is why the bulk copy is the primary path;
   * plain iteration is only the fallback when denseView is absent.
   */
  #fillMatchedIndices(sys: PoolSystem, dst: Int32Array): number {
    if (sys.matchComponents.length === 0) return 0
    const terms = sys.matchComponents.map((c) => has(c))
    const q = (this.#world.query as unknown as (...t: unknown[]) => { current: Iterable<number> & { denseView?(): Uint32Array } })(
      ...terms,
    )
    const cap = dst.length - WORK_HEADER_WORDS
    const dense = q.current.denseView?.()
    if (dense !== undefined) {
      const n = Math.min(dense.length, cap)
      dst.set(n === dense.length ? dense : dense.subarray(0, n), WORK_HEADER_WORDS)
      if (n < dense.length) {
        this.#diag(`system '${sys.name}' matched more entities than the work SAB holds (${cap}); batch truncated — raise maxBatchEntities`)
      }
      return n
    }
    let k = 0
    for (const idx of q.current) {
      if (k >= cap) {
        this.#diag(`system '${sys.name}' matched more entities than the work SAB holds (${cap}); batch truncated — raise maxBatchEntities`)
        break
      }
      dst[WORK_HEADER_WORDS + k] = idx
      k += 1
    }
    return k
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
      // Relation apply: forward to the core __apply surface that @ecsia/relations
      // fills in via createRelations(world). The scheduler does NOT import @ecsia/relations.
      addPair: (s, rid, t, payload) => apply.addPair?.(s, rid, t, payload),
      removePair: (s, rid, t) => apply.removePair?.(s, rid, t),
      relationCodecOf: (rid) => this.#relationCodecById.get(rid as unknown as number),
      stagePublish: (topicId, systemId, words, at, fieldWords) =>
        world.__topics.stageWords(topicId, systemId, words, at, fieldWords),
      advanceConsume: (topicId, systemId, seq) => {
        const name = this.#systems[systemId]?.name
        if (name === undefined) {
          this.#diag(`OP_CONSUMED names unknown system id ${systemId}; record dropped`)
          return
        }
        world.__topics.advanceFromWorker(topicId, name, seq)
      },
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
    await this.#spawning.catch(() => {}) // settle the spawn phase so no worker outlives dispose
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
