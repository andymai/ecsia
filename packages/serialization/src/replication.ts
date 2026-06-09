// The thin replication envelope over the shipped snapshot/delta codecs — the recipe layer for
// ordered-reliable transports (WebSocket, WebTransport reliable stream, MessageChannel). It closes
// the five envelope-and-state-machine gaps the raw codecs leave to the caller:
// G1 schema-on-every-message (belt-and-braces — the v3 delta header carries schemaHash and
// applyDelta gates on it; the envelope check fails before bytes are even parsed),
// G2 ordering (tick-chaining enforced by the receiver),
// G3 the journal-gap resync signal (a producer-side gap silently emits a structural-section-free
// delta — indistinguishable from "nothing structural changed" — so tick() degrades to a baseline),
// G4 remap plumbing (the receiver owns ONE mutable remap for the stream's lifetime),
// G5 the message envelope itself (seq/kind + a 24-byte binary header).
//
// Loss model: the delta cursor advances on every emission and cannot rewind, so a dropped or
// reordered message means resync via a fresh baseline — there is no ack-based re-emission, and
// an unappliable message is refused whole. The one exception is a corrupt payload that throws
// MID-apply: that leaves partially-applied state, so the receiver poisons itself (every delta
// answers needBaseline) until a baseline's replace-load heals it.

import type { EntityHandle } from '@ecsia/schema'
import type { World } from '@ecsia/core'
import { WriteCursor, ReadCursor } from './cursor.js'
import { createSnapshotSerializer } from './snapshot.js'
import { createSnapshotDeserializer } from './deserialize.js'
import { createDeltaSerializer, applyDelta } from './delta.js'
import type { DeltaOptions } from './delta.js'
import type { OnUnserializable } from './rich.js'

/** One replication stream emission: the envelope fields + the unchanged snapshot/delta image. */
export interface ReplicationMessage {
  /**
   * Per-stream monotone emit counter. Baselines consume seq too, so a broadcast observer sees
   * gaps where joiner/resync baselines went out to someone else — seq is transport debugging
   * ONLY; ticks are the correctness chain.
   */
  readonly seq: number
  readonly kind: 'baseline' | 'delta'
  /** Extends the snapshot's schema gate to every message (G1). */
  readonly schemaHash: number
  /** The tick this delta chains from; 0 for baselines. */
  readonly baselineTick: number
  /** Snapshot tick / delta targetTick. */
  readonly tick: number
  /** The existing snapshot/delta image, unchanged — a detached buffer safe to transfer. */
  readonly bytes: Uint8Array
}

export interface ReplicationStreamOptions {
  /** Opt-in numeric epsilon tolerance for the delta value section (see {@link DeltaOptions}). */
  readonly epsilon?: number
  /** Policy for a rich value JSON cannot encode. Default: SKIP + dev-warn. */
  readonly onUnserializable?: OnUnserializable
}

/**
 * The producer side: one stream broadcasts to all clients on an ordered-reliable transport.
 * Both methods must run at a serial flush point (`world.phase === 'serial'`).
 */
export interface ReplicationStream {
  /**
   * Full state for a (re)joining client. Does not perturb the delta cursor.
   *
   * CHAINING INVARIANT: take the joiner's baseline at the SAME serial flush as a `tick()`
   * emission — the baseline's tick then equals that flush's delta targetTick, so the joiner
   * chains onto the broadcast stream with no window skipped or double-covered. A baseline taken
   * between flushes leaves the joiner mid-window: the next delta's baselineTick predates the
   * snapshot, the receiver reports `needBaseline`, and you re-baseline for nothing.
   */
  baseline(): ReplicationMessage
  /**
   * The next delta, covering (last emission, now]. Automatically a `'baseline'` when the bounded
   * structural journal cannot cover the window (gap ⇒ forced resync, closing G3) — receivers
   * rebase on any baseline, so the degradation needs no out-of-band signal.
   *
   * Call AFTER all of this tick's mutations, at the serial flush point. Selection is STRICT
   * (`> sinceTick`): a structural op journaled at tick T after `tick()` has already run falls
   * outside every later window — it is lost to the stream forever, and only a baseline re-covers
   * the missing entity/component on receivers.
   */
  tick(): ReplicationMessage
}

export function createReplicationStream(world: World, opts: ReplicationStreamOptions = {}): ReplicationStream {
  const s = world.__serialize
  const deltaOpts: DeltaOptions = {
    ...(opts.epsilon !== undefined ? { epsilon: opts.epsilon } : {}),
    ...(opts.onUnserializable !== undefined ? { onUnserializable: opts.onUnserializable } : {}),
  }
  const snap = createSnapshotSerializer(world, opts.onUnserializable !== undefined ? { onUnserializable: opts.onUnserializable } : {})
  const ser = createDeltaSerializer(world, world.currentTick(), deltaOpts)
  let seq = 0

  function baselineMessage(): ReplicationMessage {
    // The snapshot delivers EXACT values, but the epsilon shadow holds last-EMITTED ones — a
    // receiver rebased on this baseline would otherwise be epsilon-compared against stale
    // emissions and could drift up to 2·epsilon before a held-back row re-crossed tolerance.
    ser.refreshEpsilonShadow()
    return {
      seq: seq++,
      kind: 'baseline',
      schemaHash: s.schemaHash(),
      baselineTick: 0,
      tick: world.currentTick(),
      bytes: snap.snapshotCopy(),
    }
  }

  return {
    baseline: baselineMessage,
    tick(): ReplicationMessage {
      // G3: peek the journal window through the seam. drainStructuralSince is a non-destructive
      // ring read (delta() itself re-reads the same window), so this probe costs one extra scan
      // and consumes nothing. A gap means (sinceTick, now] cannot be structurally reconstructed —
      // the raw delta would silently omit the structural section, diverging every receiver.
      if (s.drainStructuralSince(ser.sinceTick).gap) {
        // Advance the delta cursor past the gap with a discarded emission, so the NEXT tick()
        // chains from this baseline's tick (baselineMessage snaps the epsilon shadow itself).
        ser.delta()
        return baselineMessage()
      }
      const baselineTick = ser.sinceTick
      const tick = world.currentTick()
      return { seq: seq++, kind: 'delta', schemaHash: s.schemaHash(), baselineTick, tick, bytes: ser.deltaCopy() }
    },
  }
}

export interface ReplicationApplyResult {
  readonly applied: boolean
  /** True when the chain is broken: ask the producer for a fresh `baseline()`. */
  readonly needBaseline: boolean
  /** The receiver's last applied tick after this call (-1 before the first baseline). */
  readonly tick: number
}

/**
 * The consumer side: mirrors one producer stream into a DEDICATED world. Every baseline rebases
 * via a replace-load that clears ALL entities in the receiver world first — receiver-local
 * entities do not survive a join, a resync, or a journal-gap baseline, so keep non-replicated
 * state in a separate world.
 */
export interface ReplicationReceiver {
  /**
   * Validates schemaHash (throws — G1) and tick-chaining (G2): a delta applies only when its
   * `baselineTick` equals the last applied tick; any baseline rebases (full reload + fresh remap);
   * an already-covered delta (`tick <= lastApplied`, e.g. the same-flush delta arriving right
   * after a join baseline) is skipped idempotently; anything else → `needBaseline`.
   * No partial apply across messages. Must run at a serial flush point.
   *
   * CORRUPT PAYLOAD: a delta whose bytes throw mid-apply leaves PARTIALLY-APPLIED state (its
   * structural ops may have landed before the bad bytes were hit), and only a baseline's full
   * replace-load heals it. `apply` catches the throw, answers `needBaseline: true`, and refuses
   * every subsequent delta the same way until a baseline rebases the world.
   */
  apply(msg: ReplicationMessage): ReplicationApplyResult
  /** The stream-lifetime producer→receiver entity remap, owned by the receiver (G4). */
  readonly remap: ReadonlyMap<EntityHandle, EntityHandle>
}

export function createReplicationReceiver(world: World): ReplicationReceiver {
  const s = world.__serialize
  const deser = createSnapshotDeserializer(world)
  const remap = new Map<EntityHandle, EntityHandle>()
  let lastAppliedTick = -1
  // Set when a delta threw mid-apply: the world holds partially-applied state that only a
  // baseline's replace-load can heal, so every delta is refused until one arrives.
  let poisoned = false

  return {
    apply(msg: ReplicationMessage): ReplicationApplyResult {
      if (msg.schemaHash !== s.schemaHash()) {
        throw new Error(
          `serialization: replication schemaHash mismatch — refusing to apply (receiver ${s.schemaHash()}, message ${msg.schemaHash}). ` +
            'The message was produced by a different set of component schemas; register the same components, in the same order, on both sides.',
        )
      }
      if (msg.kind === 'baseline') {
        const result = deser.load(msg.bytes, 'replace')
        // Rebase: the load minted all-new handles, so prior remap entries are dead. The Map
        // identity is preserved (callers may hold the `remap` reference).
        remap.clear()
        for (const [producer, local] of result.remap) remap.set(producer, local)
        lastAppliedTick = result.tick
        poisoned = false
        return { applied: true, needBaseline: false, tick: lastAppliedTick }
      }
      if (poisoned) {
        return { applied: false, needBaseline: true, tick: lastAppliedTick }
      }
      if (lastAppliedTick >= 0 && msg.baselineTick === lastAppliedTick) {
        try {
          // applyDelta extends the mutable remap with handles for entities this delta created.
          lastAppliedTick = applyDelta(world, msg.bytes, remap)
        } catch {
          poisoned = true
          return { applied: false, needBaseline: true, tick: lastAppliedTick }
        }
        return { applied: true, needBaseline: false, tick: lastAppliedTick }
      }
      if (lastAppliedTick >= 0 && msg.tick <= lastAppliedTick) {
        // Already covered by the applied baseline/deltas. Applying would REPLAY the structural
        // section (re-spawning duplicates) — value idempotence does not extend to structure.
        return { applied: false, needBaseline: false, tick: lastAppliedTick }
      }
      return { applied: false, needBaseline: true, tick: lastAppliedTick }
    },
    get remap(): ReadonlyMap<EntityHandle, EntityHandle> {
      return remap
    },
  }
}

// --- binary envelope: a 24-byte header + the payload bytes ----------------------------------
// For binary transports (WebSocket etc.). MessageChannel/Worker users can skip these — the
// ReplicationMessage object structured-clones as-is.
// Layout: MAGIC u32, VERSION u16, kind u8 (0 baseline / 1 delta), reserved u8, seq u32,
// schemaHash u32, baselineTick u32, tick u32, then the payload bytes (the remainder — the
// envelope is per-message, so no length word is needed).

export const REPLICATION_MAGIC = 0x45435250 // 'ECRP'
export const REPLICATION_ENVELOPE_VERSION = 1
export const REPLICATION_HEADER_BYTES = 24

export function encodeReplicationMessage(msg: ReplicationMessage): Uint8Array {
  const cur = new WriteCursor(REPLICATION_HEADER_BYTES + msg.bytes.byteLength)
  cur.u32(REPLICATION_MAGIC)
  cur.u16(REPLICATION_ENVELOPE_VERSION)
  cur.u8(msg.kind === 'baseline' ? 0 : 1)
  cur.u8(0)
  cur.u32(msg.seq)
  cur.u32(msg.schemaHash)
  cur.u32(msg.baselineTick)
  cur.u32(msg.tick)
  cur.copyBytes(msg.bytes)
  return cur.bytesCopy()
}

/** Decode an envelope produced by {@link encodeReplicationMessage}. The returned `bytes` is a
 * zero-copy view into the input buffer — copy it if the input is reused. */
export function decodeReplicationMessage(bytes: Uint8Array): ReplicationMessage {
  if (bytes.byteLength < REPLICATION_HEADER_BYTES) {
    throw new Error('serialization: replication envelope truncated (shorter than the 24-byte header)')
  }
  const cur = new ReadCursor(bytes)
  const magic = cur.u32()
  if (magic !== REPLICATION_MAGIC) throw new Error('serialization: bad magic (not an ecsia replication envelope)')
  const version = cur.u16()
  if (version !== REPLICATION_ENVELOPE_VERSION) {
    throw new Error(
      `serialization: replication envelope version ${version} can't be read by this build (it reads ${REPLICATION_ENVELOPE_VERSION}) — upgrade both peers to the same @ecsia/serialization version`,
    )
  }
  const kindOrdinal = cur.u8()
  if (kindOrdinal !== 0 && kindOrdinal !== 1) throw new Error(`serialization: unknown replication message kind ${kindOrdinal}`)
  cur.u8() // reserved
  const seq = cur.u32()
  const schemaHash = cur.u32()
  const baselineTick = cur.u32()
  const tick = cur.u32()
  // Zero-copy: `bytes` borrows the caller's buffer. Copy it before reusing the input (ring buffers).
  return {
    seq,
    kind: kindOrdinal === 0 ? 'baseline' : 'delta',
    schemaHash,
    baselineTick,
    tick,
    bytes: bytes.subarray(REPLICATION_HEADER_BYTES),
  }
}
