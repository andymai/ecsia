// pairKey64 (relations.md §2.1): the logical 64-bit key for the (relationId, targetIndex) mint map.
// Keyed by the target's INDEX (low handle bits), not the full handle, so a pair id is stable across
// the target slot's generation bumps (§2.1). The bigint is a MAP KEY ONLY — the stored artifact is
// always a plain integer ComponentId; no 64-bit value is ever written to a TypedArray.
//
// The index field width is the WORLD's indexBits (= 32 - generationBits, default 22), threaded in
// from RelationsHost.indexBits rather than hardcoded so a non-default generationBits keys the same
// targetIndex the world's handleIndex produces (§2.1). The high field (relationId / subjectIndex) is
// shifted by that same width, so the two fields never collide for any layout up to indexBits=32.

import type { RelationId } from '@ecsia/schema'

/** (relationId << indexBits) | targetIndex — the logical mint-map key (relations.md §2.1). */
export function pairKey64(relationId: RelationId, targetIndex: number, indexBits: number): bigint {
  return (BigInt(relationId as number) << BigInt(indexBits)) | BigInt(targetIndex >>> 0)
}

/** (subjectIndex << indexBits) | targetIndex — the overflow-table row key (relations.md §4.3). */
export function overflowKey64(subjectIndex: number, targetIndex: number, indexBits: number): bigint {
  return (BigInt(subjectIndex >>> 0) << BigInt(indexBits)) | BigInt(targetIndex >>> 0)
}
