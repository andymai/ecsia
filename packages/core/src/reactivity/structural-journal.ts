// The persistent, bounded, tick-keyed STRUCTURAL JOURNAL — the since-T structural source the
// delta serializer consumes. The per-frame shape log (log.ts) is RECYCLED at every frame
// boundary, so a "since tick T" serializer cannot pin that ring across frames. Exactly as
// `changeVersion` is the persistent
// since-T source for VALUE changes, this journal is the persistent since-T source for STRUCTURAL
// changes (Create/Destroy/ComponentAdd/ComponentRemove/AddPair/RemovePair/SetPayload).
//
// It is appended SYNCHRONOUSLY at the structural commit point (from trackShape/trackShapePair), so the
// dying entity's FULL handle is still resolvable (Destroy is emitted BEFORE identity
// invalidation). Each record is keyed by the current frame tick; drainSince(T) returns the ops
// with tick > T in commit order. The journal is a bounded ring (drop-oldest); when a requested T has
// been evicted, the caller must resync from a fresh snapshot (the delta-gap rule).
// LAZILY enabled: zero memory/zero record cost until a delta serializer attaches.

import type { ShapeKind } from './log.js'

export interface StructuralRecord {
  readonly tick: number
  readonly kind: ShapeKind
  /** The FULL (generational) subject/entity handle, resolved at commit time (portable across boundary). */
  readonly handle: number
  /** User/synthetic component id (Add/Remove) or synthetic pair id (AddPair/RemovePair). 0 for Create/Destroy. */
  readonly componentId: number
  /** The FULL pair-target handle (AddPair/RemovePair/SetPayload), resolved at commit time; else 0. */
  readonly target: number
}

const FIELDS_PER_RECORD = 5

export class StructuralJournal {
  /** False ⇒ zero record cost (no delta serializer attached). Mirrors ChangeVersionStore.enabled. */
  enabled = false
  /** A flat ring: [tick, kind, handle, componentId, target] × capacity. Drop-oldest on overflow. */
  #ring: Uint32Array
  readonly #capacity: number
  /** Total records ever appended (monotonic). The live window is [count-capacity, count). */
  #count = 0
  /** The oldest tick still resident; a drainSince(T) with T < this floor signals an evicted gap. */
  #oldestResidentTick = 0

  constructor(initialCapacityRecords = 1024) {
    this.#capacity = Math.max(16, initialCapacityRecords)
    this.#ring = new Uint32Array(this.#capacity * FIELDS_PER_RECORD)
  }

  /** Append one structural op at `tick`. O(1); drops the oldest record once the ring is full. */
  record(tick: number, kind: ShapeKind, handle: number, componentId: number, target: number): void {
    if (!this.enabled) return
    const slot = (this.#count % this.#capacity) * FIELDS_PER_RECORD
    if (this.#count >= this.#capacity) {
      // About to overwrite the oldest live record — advance the resident-floor to its successor's tick.
      const nextOldest = ((this.#count + 1) % this.#capacity) * FIELDS_PER_RECORD
      this.#oldestResidentTick = this.#ring[nextOldest] as number
    }
    this.#ring[slot] = tick >>> 0
    this.#ring[slot + 1] = kind >>> 0
    this.#ring[slot + 2] = handle >>> 0
    this.#ring[slot + 3] = componentId >>> 0
    this.#ring[slot + 4] = target >>> 0
    this.#count += 1
  }

  /**
   * Records with tick > since, in commit (append) order. Returns `gap: true` if `since` predates the
   * oldest resident record (the live window evicted it — the caller must resync from a snapshot).
   */
  drainSince(since: number): { records: StructuralRecord[]; gap: boolean } {
    const out: StructuralRecord[] = []
    if (!this.enabled) return { records: out, gap: false }
    const gap = this.#count > this.#capacity && since < this.#oldestResidentTick
    const start = this.#count > this.#capacity ? this.#count - this.#capacity : 0
    for (let i = start; i < this.#count; i++) {
      const slot = (i % this.#capacity) * FIELDS_PER_RECORD
      const tick = this.#ring[slot] as number
      if (tick <= since) continue
      out.push({
        tick,
        kind: this.#ring[slot + 1] as ShapeKind,
        handle: this.#ring[slot + 2] as number,
        componentId: this.#ring[slot + 3] as number,
        target: this.#ring[slot + 4] as number,
      })
    }
    return { records: out, gap }
  }

  /**: clear the journal at a serial flush (alongside changeVersion.resetAll). */
  resetAll(): void {
    this.#count = 0
    this.#oldestResidentTick = 0
  }
}
