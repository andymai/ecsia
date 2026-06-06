// Shared helpers for the RICH (sidecar JSON) section of snapshots and deltas. Rich
// fields ('string' / object<T>) hold arbitrary JS values that cannot ride the raw SoA byte-copy path, so
// they serialize as length-prefixed UTF-8 JSON. This module owns the kind ordinal mapping and the
// non-serializable-value policy (onUnserializable) so the snapshot and delta writers stay in sync.

import type { ComponentId, EntityHandle } from '@ecsia/schema'

export const RICH_KIND_STRING = 0
export const RICH_KIND_OBJECT = 1

export function richKindOrdinal(kind: 'string' | 'object'): number {
  return kind === 'string' ? RICH_KIND_STRING : RICH_KIND_OBJECT
}

/** Context handed to `onUnserializable` when a rich value cannot be JSON-encoded. */
export interface UnserializableContext {
  readonly componentId: ComponentId
  readonly fieldIndex: number
  readonly fieldName: string
  readonly handle: EntityHandle
  readonly value: unknown
  readonly error: unknown
}

/**
 * Called when a rich value cannot be JSON-encoded (cycles, BigInt). Return a replacement value to encode,
 * or `undefined` to SKIP the field for that entity (snapshot: the fresh receiver entity reads the field
 * default; delta: the receiver KEEPS its current value — a skip never clobbers).
 * Default policy (no hook): SKIP + a dev-mode console.warn naming (component, field, handle).
 */
export type OnUnserializable = (ctx: UnserializableContext) => unknown

/**
 * Encode one rich value to its JSON string, applying the onUnserializable policy. Returns the JSON string
 * to write, or `undefined` to skip the field for this entity (snapshot: absent on the wire, so the fresh
 * receiver reads the default; delta: RICH_ROW_KEEP, so the receiver keeps its current value).
 * `JSON.stringify` of `undefined`/`function`/`Symbol` does NOT throw (JSON silently omits
 * them) — only cycles/BigInt throw and reach the hook; that omission is documented as lossy.
 */
export function encodeRichValue(
  value: unknown,
  ctx: Omit<UnserializableContext, 'error'>,
  onUnserializable: OnUnserializable | undefined,
): string | undefined {
  try {
    const json = JSON.stringify(value)
    // JSON.stringify(undefined) === undefined (a top-level undefined / function / symbol). Treat as skip.
    return json
  } catch (error) {
    const replacement = onUnserializable?.({ ...ctx, error })
    if (replacement === undefined) {
      if (typeof console !== 'undefined') {
        console.warn(
          `[ecsia] rich field '${ctx.fieldName}' (component ${ctx.componentId as number}, entity ` +
            `${ctx.handle as number}) holds a non-serializable value; skipping it from the wire. ` +
            `Provide onUnserializable to encode a replacement.`,
        )
      }
      return undefined
    }
    // A second throw here propagates: the hook returned junk, which is a programming error, not data.
    return JSON.stringify(replacement)
  }
}
