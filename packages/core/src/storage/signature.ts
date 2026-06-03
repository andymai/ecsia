// Canonical archetype signatures (archetype-storage.md §3.2, §3.3, §3.8, §5.2, §8).
// A Signature is the sorted, de-duplicated Uint32Array of ComponentIds defining an archetype's
// exact component set. Sorting makes structurally-equal sets identical regardless of add order, so
// equality is a linear word compare and the lookup map keys on an FNV-1a hash of the sorted ids.

import type { ComponentId } from '@ecsia/schema'

/** Canonical, sorted, de-duplicated component ids. Owned (never aliased) per archetype (SIG-1). */
export type Signature = Uint32Array & { readonly __ecsiaSignature: unique symbol }

/** O(n) equality of two sorted signatures. */
export function sigEquals(a: Signature, b: Signature): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** FNV-1a over the sorted ids → 32-bit hash for the archetype lookup map. */
export function sigHash(a: Signature): number {
  let h = 0x811c9dc5
  for (let i = 0; i < a.length; i++) {
    h ^= a[i] as number
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Sort + de-dup an arbitrary id multiset into the canonical form (SIG-1 holds). */
export function canonicalize(ids: Iterable<ComponentId | number>): Signature {
  const arr = Uint32Array.from(new Set(ids as Iterable<number>))
  arr.sort()
  return arr as Signature
}

/** The neighbor signature reached by adding `c` (sorted insert). Idempotent if `c` already present. */
export function sigWithAdded(sig: Signature, c: ComponentId): Signature {
  const v = c as number
  // Binary-search the insertion point; if found, the signature is unchanged (idempotent add).
  let lo = 0
  let hi = sig.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const cur = sig[mid] as number
    if (cur === v) return sig
    if (cur < v) lo = mid + 1
    else hi = mid
  }
  const out = new Uint32Array(sig.length + 1)
  out.set(sig.subarray(0, lo), 0)
  out[lo] = v
  out.set(sig.subarray(lo), lo + 1)
  return out as Signature
}

/** The neighbor signature reached by removing `c`. Returns `sig` unchanged if `c` is absent. */
export function sigWithRemoved(sig: Signature, c: ComponentId): Signature {
  const v = c as number
  let lo = 0
  let hi = sig.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const cur = sig[mid] as number
    if (cur === v) {
      found = mid
      break
    }
    if (cur < v) lo = mid + 1
    else hi = mid - 1
  }
  if (found < 0) return sig
  const out = new Uint32Array(sig.length - 1)
  out.set(sig.subarray(0, found), 0)
  out.set(sig.subarray(found + 1), found)
  return out as Signature
}

/** Packed membership words for fast bitwise-AND query matching (§3.3). */
export function buildSigWords(sig: Signature, stride: number): Uint32Array {
  const w = new Uint32Array(stride)
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i] as number
    w[c >>> 5] = ((w[c >>> 5] as number) | (1 << (c & 31))) >>> 0
  }
  return w
}

/** Exact membership test against the sorted signature array, O(log |sig|) (§3.8). */
export function sigHas(sig: Signature, c: ComponentId | number): boolean {
  const v = c as number
  let lo = 0
  let hi = sig.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const cur = sig[mid] as number
    if (cur === v) return true
    if (cur < v) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/** One AND-term against a packed signature word (§8). */
export interface MatchTerm {
  readonly wordIndex: number
  readonly mask: number
}

/** Signature-AND helper the query module calls; exposed for testing (§8). */
export function signatureMatches(
  sigWords: Uint32Array,
  withW: readonly MatchTerm[],
  notW: readonly MatchTerm[],
  orW: readonly MatchTerm[],
): boolean {
  for (const t of notW) if (((sigWords[t.wordIndex] as number) & t.mask) !== 0) return false
  for (const t of withW) if (((sigWords[t.wordIndex] as number) & t.mask) !== t.mask) return false
  for (const c of orW) if (((sigWords[c.wordIndex] as number) & c.mask) === 0) return false
  return true
}
