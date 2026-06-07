// The world-owned topic store: one canonical event stream per topic plus the per-system staging
// segments and per-(reader, topic) consume cursors.
//
// THE DETERMINISM CONTRACT (the reason this module exists): the total order of events within a
// topic is `(frame, wave, publishing SystemId ascending, per-system FIFO append order)`.
// `publish()` therefore NEVER appends to the canonical stream directly — it appends to a
// per-(topic, system) staging segment, and the wave's serial slot performs ONE segment sort by
// SystemId (`mergeStaged`). Worker publishes arrive in the same staging via OP_PUBLISH records
// replayed at the command flush; main-thread publishes stage directly. One code path, every
// execution mode, byte-identical stream — direct append would expose round/worker order, which
// varies with workerCount and greedy round packing.
//
// The canonical stream is mutated ONLY while world.phase === 'serial' (asserted): the merge runs in
// the wave's serial slot, so a system mid-wave reads a frozen stream with plain loads.
//
// Retention is double-buffered by frame (Bevy's model): at the frame reset entering frame N, every
// event belonging to frame N-2 or earlier is dropped, so every event is visible for at least one
// complete frame after the frame it was published in. `world.publish` calls between updates are
// stamped for the UPCOMING frame. Overflow inside one frame spills to a main-thread array and the
// ring is regrown to 2x the observed peak at the next frame reset — never a hard throw.

import type { Schema } from '@ecsia/schema'
import type { Buffers, Region, RegionKey } from '../memory/index.js'
import { isSharedBacking } from '../memory/buffers.js'
import { UNREGISTERED } from '../component/index.js'
import { buildTopicCodec } from './codec.js'
import type { TopicCodec } from './codec.js'
import type { TopicDef } from './define.js'

/** Reserved-zero metadata words per event row (future: tick + publishing system; payload-only v1). */
export const TOPIC_HEADER_WORDS = 2

/**
 * Shared per-topic header region (`topic.<name>.hdr`, u32×4): [headRel, baseRel, 0, 0], where
 * `headRel = head - tail` (the retained row count) and `baseRel = tail - baseSeq` (the ring-front
 * offset of the oldest retained row). Written by the main thread ONLY at serial slots; read by
 * worker consumers mid-wave with plain loads — frozen for the wave by the same quiescence argument
 * as archetype columns.
 *
 * Everything on the worker wire is TAIL-RELATIVE (hdr words, cursor-table slots, OP_CONSUMED seq):
 * absolute sequence numbers are unbounded JS integers main-side, and a wrapped u32 absolute would
 * stall consumers for ~2^32 events at the wrap boundary (max(unwrapped, wrapped) pins the cursor).
 * Relative values are bounded by the retained window — which fits u32 by construction — so the
 * wire is wrap-safe forever. The main thread reconstructs absolutes from its own `rt.tail`, which
 * cannot move during an update (retention drops only at the frame reset).
 */
export const TOPIC_HDR_HEAD_REL = 0
export const TOPIC_HDR_BASE_REL = 1
export const TOPIC_HDR_WORDS = 4

const INITIAL_CAPACITY_ROWS = 256
const INITIAL_READER_SLOTS = 16
const MAX_READER_SLOTS = 4096
const NO_SPILL = Number.MAX_SAFE_INTEGER

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

interface TopicRuntime {
  readonly def: TopicDef<Schema>
  readonly id: number
  readonly name: string
  readonly codec: TopicCodec
  /** Words per event row: TOPIC_HEADER_WORDS + payload field words. */
  readonly rowWords: number
  readonly region: Region<Uint32Array>
  ring: Uint32Array
  /** Sequence number of the row stored at physical ring row 0. */
  baseSeq: number
  /** Oldest retained event (inclusive) / next event to be appended (exclusive). */
  tail: number
  head: number
  /** Overflow rows (raw row words); seqs >= spillStartSeq live here, in order. */
  spill: number[]
  spillStartSeq: number
  /** Sequence where the previous frame's events begin (the retention drop point). */
  prevFrameStart: number
  /** Head captured at the end of the last update; -1 when no update ended since the last reset. */
  frameEndHead: number
  /** High-water retained row count this frame (ring resize sizing). */
  peakRows: number
  /** Per-publishing-system staging segments: SystemId -> FIFO field words + event count. */
  readonly staged: Map<number, { words: number[]; events: number }>
  stagedEvents: number
  /**
   * Per-reader consume cursors (sequence numbers), keyed by a stable reader key (system name).
   * Name-keyed entries are retained across re-plans INTENTIONALLY: a consumer removed and re-added
   * under the same name resumes its cursor, preserving exactly-once delivery across the re-plan
   * (head-init would silently skip events; replay would double-deliver). The cost is one map entry
   * per never-returning name — bounded by distinct consumer names ever planned, never per-event.
   */
  readonly cursors: Map<string, number>
  /**
   * Worker-visible mirrors: the hdr region carries [tail, head, baseSeq]; the cursors region carries
   * one u32 sequence per assigned reader slot. Main-thread-written at serial slots only.
   */
  readonly hdrRegion: Region<Uint32Array>
  readonly cursorsRegion: Region<Uint32Array>
  /** Reader key (system name) → cursor-table slot, assigned on first sight, stable across re-plans. */
  readonly readerSlots: Map<string, number>
  /** The pooled consume view + its rebind hook (one per topic; never store the view). */
  readonly view: Record<string, unknown>
  bind(words: ArrayLike<number>, base: number): void
  scratchRow: Uint32Array
  overflowWarned: boolean
}

export interface TopicsConfig {
  readonly buffers: Buffers
  /** Mint the next dense ComponentId (the topic's virtual id; same space as relations' synthetics). */
  readonly allocId: () => number
  readonly phase: () => 'serial' | 'wave'
  readonly dev: boolean
  readonly warn: (message: string) => void
}

export class Topics {
  readonly #buffers: Buffers
  readonly #allocId: () => number
  readonly #phase: () => 'serial' | 'wave'
  readonly #dev: boolean
  readonly #warn: (message: string) => void
  readonly #byDef = new Map<TopicDef<Schema>, TopicRuntime>()
  readonly #byId = new Map<number, TopicRuntime>()
  readonly #byName = new Map<string, TopicRuntime>()
  /** Topics with >= 1 staged segment this cycle — the O(1) merge-skip gate, not an event count. */
  #stagedTopics = 0
  #inUpdate = false
  /**
   * Has any update (or manual merge) ever run? Discriminates the FIRST plan from a late re-plan:
   * a consumer in the first plan must see `world.publish` events appended before the plan existed
   * (the input-event contract — "every system sees it next update"), while a consumer added by a
   * re-plan after frames have run starts at the head (no replay of stale retained events).
   */
  #everUpdated = false

  constructor(cfg: TopicsConfig) {
    this.#buffers = cfg.buffers
    this.#allocId = cfg.allocId
    this.#phase = cfg.phase
    this.#dev = cfg.dev
    this.#warn = cfg.warn
  }

  /** Number of topics registered with this world. Zero ⇒ every per-frame hook is a no-op. */
  get count(): number {
    return this.#byDef.size
  }

  /** Intern a topic with this world (idempotent): mints its virtual ComponentId + canonical ring. */
  register(def: TopicDef<Schema>): void {
    if (this.#byDef.has(def)) return
    if ((def.id as number) !== (UNREGISTERED as number)) {
      throw new Error(`topic '${def.name}' is already registered with another world`)
    }
    const collision = this.#byName.get(def.name)
    if (collision !== undefined) {
      throw new Error(`a different topic named '${def.name}' is already registered with this world — topic names must be unique per world`)
    }
    const id = this.#allocId()
    def.id = id as TopicDef<Schema>['id']
    const codec = buildTopicCodec(def.fields)
    const rowWords = TOPIC_HEADER_WORDS + codec.fieldWords
    const capacityWords = INITIAL_CAPACITY_ROWS * rowWords
    const region = this.#buffers.region(`topic.${def.name}.ring` as RegionKey, 'u32', capacityWords, {
      maxLength: capacityWords * 16,
    }) as Region<Uint32Array>
    const hdrRegion = this.#buffers.region(`topic.${def.name}.hdr` as RegionKey, 'u32', TOPIC_HDR_WORDS, {
      fixed: true,
    }) as Region<Uint32Array>
    const cursorsRegion = this.#buffers.region(`topic.${def.name}.cursors` as RegionKey, 'u32', INITIAL_READER_SLOTS, {
      maxLength: MAX_READER_SLOTS,
    }) as Region<Uint32Array>

    const view: Record<string, unknown> = {}
    let curWords: ArrayLike<number> = region.view
    let curBase = 0
    for (const f of codec.fields) {
      Object.defineProperty(view, f.name, {
        enumerable: true,
        get: () => f.decode(curWords, curBase + f.offset),
      })
    }

    const rt: TopicRuntime = {
      def,
      id,
      name: def.name,
      codec,
      rowWords,
      region,
      ring: region.view,
      baseSeq: 0,
      tail: 0,
      head: 0,
      spill: [],
      spillStartSeq: NO_SPILL,
      prevFrameStart: 0,
      frameEndHead: -1,
      peakRows: 0,
      staged: new Map(),
      stagedEvents: 0,
      cursors: new Map(),
      hdrRegion,
      cursorsRegion,
      readerSlots: new Map(),
      view,
      bind(words, base) {
        curWords = words
        curBase = base
      },
      scratchRow: new Uint32Array(Math.max(codec.fieldWords, 1)),
      overflowWarned: false,
    }
    this.#byDef.set(def, rt)
    this.#byId.set(id, rt)
    this.#byName.set(def.name, rt)
  }

  #runtimeOf(def: TopicDef<Schema>): TopicRuntime {
    const rt = this.#byDef.get(def)
    if (rt === undefined) {
      throw new Error(
        `topic '${def.name}' is not registered with this world — declare it in a system's publish/consume or publish it once via world.publish`,
      )
    }
    return rt
  }

  /** The topic's virtual ComponentId, or -1 if not registered. */
  idOf(def: TopicDef<Schema>): number {
    return this.#byDef.get(def)?.id ?? -1
  }

  /** `(name, id)` pairs for worker id alignment (the boot manifest). */
  manifest(): readonly { name: string; id: number }[] {
    return [...this.#byId.values()].map((rt) => ({ name: rt.name, id: rt.id }))
  }

  /** Scheduler frame hooks: world.publish is illegal while an update is in progress. */
  beginUpdate(): void {
    if (this.#inUpdate) {
      throw new Error('topics: beginUpdate re-entered — a world update is already in progress (nested scheduler.update?)')
    }
    this.#inUpdate = true
    this.#everUpdated = true
  }

  endUpdate(): void {
    this.#inUpdate = false
    if (this.#byDef.size === 0) return
    for (const rt of this.#byId.values()) rt.frameEndHead = rt.head
  }

  /**
   * `world.publish` — the outside-systems path (input/network handlers, between frames). Appends
   * directly to the canonical stream in call order, ahead of wave 0 of the next frame. Registers
   * the topic on first use. Serial phase only; inside a system body use `ctx.publish` instead
   * (direct appends mid-update would bypass the SystemId canonicalization).
   */
  publishOutside(def: TopicDef<Schema>, init: Record<string, unknown> | undefined): void {
    if (this.#inUpdate) {
      throw new Error(
        `world.publish('${def.name}') called during world update — world.publish is for code outside systems; use the system's ctx.publish so the event enters the canonical (frame, wave, SystemId, FIFO) order`,
      )
    }
    if (!this.#byDef.has(def)) this.register(def)
    const rt = this.#runtimeOf(def)
    rt.codec.encode(init, rt.scratchRow, 0)
    this.#appendRow(rt, rt.scratchRow, 0)
    this.#syncWorkerVisible(rt)
  }

  /** `ctx.publish` (main-thread system) — encode now, stage to the system's segment. */
  stageValues(def: TopicDef<Schema>, systemId: number, init: Record<string, unknown> | undefined): void {
    const rt = this.#runtimeOf(def)
    rt.codec.encode(init, rt.scratchRow, 0)
    this.#stage(rt, systemId, rt.scratchRow, 0)
  }

  /** OP_PUBLISH apply (worker publishes replayed at the command flush) — stage raw field words. */
  stageWords(topicId: number, systemId: number, words: ArrayLike<number>, at: number, fieldWords: number): void {
    const rt = this.#byId.get(topicId)
    if (rt === undefined) {
      this.#warn(`OP_PUBLISH names unknown topic id ${topicId}; record dropped`)
      return
    }
    if (fieldWords !== rt.codec.fieldWords) {
      this.#warn(`OP_PUBLISH for topic '${rt.name}' carries ${fieldWords} field words, expected ${rt.codec.fieldWords}; record dropped`)
      return
    }
    this.#stage(rt, systemId, words, at)
  }

  #stage(rt: TopicRuntime, systemId: number, words: ArrayLike<number>, at: number): void {
    let segment = rt.staged.get(systemId)
    if (segment === undefined) {
      segment = { words: [], events: 0 }
      rt.staged.set(systemId, segment)
      if (rt.staged.size === 1) this.#stagedTopics += 1
    }
    for (let i = 0; i < rt.codec.fieldWords; i++) segment.words.push(words[at + i]! >>> 0)
    segment.events += 1
    rt.stagedEvents += 1
  }

  /**
   * The wave's serial-slot merge: for every topic with staged events, sort the staging segments by
   * publishing SystemId ascending and append each segment FIFO to the canonical stream. Runs once
   * per wave, after the wave's command flush — the single canonicalization point for every
   * execution mode.
   */
  mergeStaged(): void {
    this.#everUpdated = true
    if (this.#stagedTopics === 0) return
    if (this.#phase() !== 'serial') {
      throw new Error('topics: canonical stream merge attempted outside the serial phase')
    }
    for (const rt of this.#byId.values()) {
      if (rt.stagedEvents === 0) continue
      const systemIds = [...rt.staged.keys()].sort((a, b) => a - b)
      const f = rt.codec.fieldWords
      for (const sid of systemIds) {
        const segment = rt.staged.get(sid)!
        for (let e = 0; e < segment.events; e++) this.#appendRow(rt, segment.words, e * f)
      }
      rt.staged.clear()
      rt.stagedEvents = 0
      this.#syncWorkerVisible(rt)
    }
    this.#stagedTopics = 0
  }

  /**
   * After every serial-slot mutation of a SHARED (worker-visible) topic: fold any spill into the
   * ring — a worker consumer reads ONLY the SAB ring, so the retained stream must live there in its
   * entirety before the next wave dispatches — then publish [tail, head, baseSeq] to the hdr region.
   * A re-back past the ring's reservation is journaled (buffers.rebackRegion), so the pool's
   * TopicRingGrown notice re-wraps worker views at the wave fence. Plain-AB (single-thread) worlds
   * skip the fold: the spill stays until the frame reset, exactly the pre-worker behavior.
   */
  #syncWorkerVisible(rt: TopicRuntime): void {
    if (!isSharedBacking(rt.region.backing)) return
    if (rt.spillStartSeq !== NO_SPILL) {
      const neededBytes = (rt.head - rt.baseSeq) * rt.rowWords * 4
      this.#buffers.rebackRegion(rt.region, neededBytes)
      rt.ring = rt.region.view
      const f = rt.rowWords
      for (let seq = rt.spillStartSeq; seq < rt.head; seq++) {
        const src = (seq - rt.spillStartSeq) * f
        const dst = (seq - rt.baseSeq) * f
        for (let i = 0; i < f; i++) rt.ring[dst + i] = rt.spill[src + i]!
      }
      rt.spill = []
      rt.spillStartSeq = NO_SPILL
    }
    const hdr = rt.hdrRegion.view
    hdr[TOPIC_HDR_HEAD_REL] = (rt.head - rt.tail) >>> 0
    hdr[TOPIC_HDR_BASE_REL] = (rt.tail - rt.baseSeq) >>> 0
  }

  /**
   * Re-anchor every assigned cursor slot to the CURRENT tail. Must run whenever tail moves (the
   * frame reset): slot values are tail-relative, so a stale anchor would make a worker reconstruct
   * a cursor that is off by exactly the dropped row count.
   */
  #remirrorCursors(rt: TopicRuntime): void {
    for (const [key] of rt.readerSlots) {
      this.#mirrorCursor(rt, key, rt.cursors.get(key) ?? rt.tail)
    }
  }

  #appendRow(rt: TopicRuntime, words: ArrayLike<number>, at: number): void {
    if (this.#phase() !== 'serial') {
      throw new Error(`topics: canonical stream for '${rt.name}' mutated outside the serial phase`)
    }
    const seq = rt.head
    const f = rt.codec.fieldWords
    if (rt.spillStartSeq === NO_SPILL && (seq - rt.baseSeq + 1) * rt.rowWords <= rt.ring.length) {
      const base = (seq - rt.baseSeq) * rt.rowWords
      for (let i = 0; i < TOPIC_HEADER_WORDS; i++) rt.ring[base + i] = 0
      for (let i = 0; i < f; i++) rt.ring[base + TOPIC_HEADER_WORDS + i] = words[at + i]! >>> 0
    } else {
      if (rt.spillStartSeq === NO_SPILL) rt.spillStartSeq = seq
      for (let i = 0; i < TOPIC_HEADER_WORDS; i++) rt.spill.push(0)
      for (let i = 0; i < f; i++) rt.spill.push(words[at + i]! >>> 0)
      if (this.#dev && !rt.overflowWarned) {
        rt.overflowWarned = true
        this.#warn(
          `topic '${rt.name}' ring overflowed (${Math.floor(rt.ring.length / rt.rowWords)} rows); spilling — the ring grows to 2x peak at the next frame reset`,
        )
      }
    }
    rt.head = seq + 1
    const retained = rt.head - rt.tail
    if (retained > rt.peakRows) rt.peakRows = retained
  }

  /**
   * Eagerly position a reader's cursor at plan time. Before the first update has ever run
   * (the FIRST plan), the cursor starts at the oldest retained event so `world.publish` calls made
   * before `createScheduler` are still delivered; once any update has run, a newly-added reader
   * (a late re-plan join) starts at the current head — no replay of stale retained events.
   */
  initCursor(def: TopicDef<Schema>, readerKey: string): void {
    const rt = this.#runtimeOf(def)
    if (!rt.cursors.has(readerKey)) rt.cursors.set(readerKey, this.#everUpdated ? rt.head : rt.tail)
    // Plan-time slot assignment doubles as the SAB sync point for readers that previously ran on
    // the main thread (their map cursor advanced without a slot to mirror into).
    this.#mirrorCursor(rt, readerKey, rt.cursors.get(readerKey)!)
  }

  /**
   * The cursor-table slot for `(def, readerKey)`, assigned on first request and stable for the
   * world's lifetime (re-plans re-request and get the same slot — cursor continuity mirrors the
   * name-keyed map). The pool ships this to workers at boot; a worker consumer reads its own slot
   * mid-wave (frozen — the main thread writes cursors only at serial slots or for systems running
   * in OTHER batches, never the one reading it).
   */
  readerSlotFor(def: TopicDef<Schema>, readerKey: string): number {
    const rt = this.#runtimeOf(def)
    let slot = rt.readerSlots.get(readerKey)
    if (slot === undefined) {
      slot = rt.readerSlots.size
      if (slot >= MAX_READER_SLOTS) {
        throw new Error(`topic '${rt.name}': more than ${MAX_READER_SLOTS} distinct consumer names — raise MAX_READER_SLOTS`)
      }
      rt.readerSlots.set(readerKey, slot)
      this.#buffers.rebackRegion(rt.cursorsRegion, (slot + 1) * 4)
      this.#mirrorCursor(rt, readerKey, rt.cursors.get(readerKey) ?? rt.tail)
    }
    return slot
  }

  #mirrorCursor(rt: TopicRuntime, readerKey: string, seq: number): void {
    const slot = rt.readerSlots.get(readerKey)
    // Tail-relative, clamped at 0: a cursor behind the tail mirrors as "at the oldest retained
    // event" — the retention-snap semantic, computed worker-side for free.
    if (slot !== undefined) rt.cursorsRegion.view[slot] = Math.max(0, seq - rt.tail) >>> 0
  }

  /**
   * OP_CONSUMED apply: a worker-run consumer observed events up to `seq` (exclusive) mid-wave.
   * Idempotent and monotonic — `max` absorbs duplicate records and replays. The missed-events
   * warning fires here with the same wording as the main-thread consume path: the cursor the worker
   * started from is the map value, and `tail` cannot have moved since the wave started (retention
   * drops only at the frame reset).
   */
  advanceFromWorker(topicId: number, readerKey: string, relSeq: number): void {
    const rt = this.#byId.get(topicId)
    if (rt === undefined) {
      this.#warn(`OP_CONSUMED names unknown topic id ${topicId}; record dropped`)
      return
    }
    const current = rt.cursors.get(readerKey) ?? rt.tail
    if (this.#dev && current < rt.tail) {
      this.#warn(
        `topic '${rt.name}': reader '${readerKey}' missed ${rt.tail - current} event(s) dropped by retention; cursor snapped to the oldest retained event`,
      )
    }
    // relSeq is tail-relative as of the wave the record was written in — and rt.tail cannot have
    // moved since (retention drops only at the frame reset, never mid-update), so the
    // reconstruction is exact. max() absorbs duplicate records and replays.
    const next = Math.max(current, rt.tail + (relSeq >>> 0))
    rt.cursors.set(readerKey, next)
    this.#mirrorCursor(rt, readerKey, next)
  }

  /**
   * Iterate the reader's unseen events up to the current visible head and advance its cursor —
   * exactly-once per (reader, topic), independent cursors per reader (no drain stealing). The
   * yielded view is pooled: read fields inside the loop, never store the view itself.
   *
   * A reader with no cursor starts at the oldest retained event (the manual-consumption default);
   * scheduler consumers are positioned eagerly via `initCursor` at plan time — at the oldest
   * retained event for the first plan (pre-plan `world.publish` events are delivered), at the
   * current head for a re-plan join (no replay).
   */
  *consume(def: TopicDef<Schema>, readerKey: string): IterableIterator<Record<string, unknown>> {
    const rt = this.#runtimeOf(def)
    let cursor = rt.cursors.get(readerKey) ?? rt.tail
    if (cursor < rt.tail) {
      if (this.#dev) {
        this.#warn(
          `topic '${rt.name}': reader '${readerKey}' missed ${rt.tail - cursor} event(s) dropped by retention; cursor snapped to the oldest retained event`,
        )
      }
      cursor = rt.tail
    }
    // The visible head is frozen for the duration of this iteration: merges happen only at serial
    // slots, never while a system body runs, so `end` is the head as of the consumer's wave start.
    const end = rt.head
    rt.cursors.set(readerKey, cursor)
    this.#mirrorCursor(rt, readerKey, cursor) // the retention snap must reach the SAB slot too
    for (let seq = cursor; seq < end; seq++) {
      // Advance BEFORE the yield: a consumer that breaks out of the loop has still observed the
      // yielded event, and exactly-once means it must not be redelivered next consume. The SAB
      // mirror tracks in lockstep so a re-plan that moves this reader onto a worker resumes right.
      rt.cursors.set(readerKey, seq + 1)
      this.#mirrorCursor(rt, readerKey, seq + 1)
      if (seq >= rt.spillStartSeq) {
        rt.bind(rt.spill, (seq - rt.spillStartSeq) * rt.rowWords + TOPIC_HEADER_WORDS)
      } else {
        rt.bind(rt.ring, (seq - rt.baseSeq) * rt.rowWords + TOPIC_HEADER_WORDS)
      }
      yield rt.view
    }
  }

  /**
   * Frame reset (serial, quiescent): drop events two frames old, fold any spill back into the ring
   * (regrowing it to 2x the observed peak), and compact retained rows to the ring front.
   */
  frameReset(): void {
    if (this.#byDef.size === 0) return
    for (const rt of this.#byId.values()) {
      // Frame boundary: events appended after the last update ended belong to the UPCOMING frame
      // (the world.publish input-event path). Without a scheduler (no endUpdate), everything
      // appended so far belongs to the frame now ending.
      const boundary = rt.frameEndHead >= 0 ? rt.frameEndHead : rt.head
      const newTail = Math.max(rt.tail, rt.prevFrameStart)
      rt.prevFrameStart = boundary
      rt.frameEndHead = -1
      this.#compact(rt, newTail)
      rt.peakRows = rt.head - rt.tail
      rt.overflowWarned = false
      this.#syncWorkerVisible(rt)
      this.#remirrorCursors(rt) // tail moved: every tail-relative cursor slot must re-anchor
    }
  }

  #compact(rt: TopicRuntime, newTail: number): void {
    const retained = rt.head - newTail
    const needWords = retained * rt.rowWords
    const hadSpill = rt.spillStartSeq !== NO_SPILL
    if (hadSpill || needWords > rt.ring.length) {
      // Regrow to 2x the frame's peak (never below what must be retained right now), then re-place
      // every retained row contiguously from the front.
      const targetRows = Math.max(retained, nextPow2(rt.peakRows * 2))
      const rows: number[][] = []
      for (let seq = newTail; seq < rt.head; seq++) {
        const src: ArrayLike<number> =
          seq >= rt.spillStartSeq ? rt.spill : rt.ring
        const base =
          seq >= rt.spillStartSeq
            ? (seq - rt.spillStartSeq) * rt.rowWords
            : (seq - rt.baseSeq) * rt.rowWords
        const row: number[] = []
        for (let i = 0; i < rt.rowWords; i++) row.push(src[base + i]!)
        rows.push(row)
      }
      this.#growRing(rt, targetRows * rt.rowWords)
      for (let r = 0; r < rows.length; r++) {
        const base = r * rt.rowWords
        for (let i = 0; i < rt.rowWords; i++) rt.ring[base + i] = rows[r]![i]!
      }
      rt.spill = []
      rt.spillStartSeq = NO_SPILL
    } else if (newTail > rt.baseSeq) {
      // Reclaim the dropped prefix in place so appends keep landing inside the ring.
      rt.ring.copyWithin(0, (newTail - rt.baseSeq) * rt.rowWords, (rt.head - rt.baseSeq) * rt.rowWords)
    }
    rt.baseSeq = newTail
    rt.tail = newTail
  }

  #growRing(rt: TopicRuntime, requiredWords: number): void {
    // In-place resizable grow when the reservation allows, else allocate-copy re-back — both via
    // the buffers registry so a SHARED re-back is journaled and the pool's TopicRingGrown notice
    // re-wraps worker-captured views at the next wave fence (serial quiescent point either way).
    this.#buffers.rebackRegion(rt.region, requiredWords * 4)
    rt.ring = rt.region.view
  }

  // ---- introspection (tests, diagnostics) ------------------------------------------------------

  /** Oldest retained / next sequence numbers for `def`. */
  bounds(def: TopicDef<Schema>): { tail: number; head: number } {
    const rt = this.#runtimeOf(def)
    return { tail: rt.tail, head: rt.head }
  }

  /**
   * A copy of the retained canonical stream `[tail, head)` in sequence order — the byte-identity
   * surface the serial-equivalence suite compares across worker counts and transports.
   */
  streamWords(def: TopicDef<Schema>): Uint32Array {
    const rt = this.#runtimeOf(def)
    const out = new Uint32Array((rt.head - rt.tail) * rt.rowWords)
    let w = 0
    for (let seq = rt.tail; seq < rt.head; seq++) {
      const src: ArrayLike<number> = seq >= rt.spillStartSeq ? rt.spill : rt.ring
      const base =
        seq >= rt.spillStartSeq ? (seq - rt.spillStartSeq) * rt.rowWords : (seq - rt.baseSeq) * rt.rowWords
      for (let i = 0; i < rt.rowWords; i++) out[w++] = src[base + i]!
    }
    return out
  }
}
