// Copied component snapshots — the value type every value-bearing hook returns. The pooled
// EntityRef is rebound by every world.entity() call and throws on stale use; React renders are
// exactly the "held across calls" pattern that guard catches, so hooks hand out frozen plain-object
// COPIES instead: scalar/string fields copy by value, vec fields copy into plain number arrays,
// object<T> rich fields copy the REFERENCE (mutating the referenced object bypasses change
// tracking — the same caveat core documents for object fields).

import type {
  BaseFieldToken,
  ComponentDef,
  EntityHandle,
  FieldSpec,
  FieldToken,
  FieldValue,
  ScalarToken,
  ScalarValue,
  Schema,
  SchemaOf,
  VecToken,
} from '@ecsia/schema'
import type { EcsiaWorld } from './world.js'

type SnapshotFieldValue<F extends FieldToken> = F extends FieldSpec<infer Inner>
  ? SnapshotFieldValue<Inner>
  : F extends VecToken<infer E, number>
    ? readonly ScalarValue<E & ScalarToken>[]
    : FieldValue<F>

/** The frozen plain-object copy of a component's fields as of the last observer drain. */
export type ComponentSnapshot<C extends ComponentDef<Schema>> = {
  readonly [K in keyof SchemaOf<C>]: SnapshotFieldValue<SchemaOf<C>[K]>
}

const EMPTY_SNAPSHOT: Readonly<Record<string, unknown>> = Object.freeze({})

function unwrapToken(token: FieldToken): BaseFieldToken {
  return typeof token === 'object' && '__fieldSpec' in token ? token.token : token
}

/**
 * Compute the snapshot for (handle, def): `undefined` when the entity is dead or lacks the
 * component, else a frozen field-value copy read through the public accessor at a safe point.
 */
export function computeSnapshot(
  world: EcsiaWorld,
  handle: EntityHandle,
  def: ComponentDef<Schema>,
): Readonly<Record<string, unknown>> | undefined {
  if (!world.isAlive(handle) || !world.has(handle, def)) return undefined
  // Tags (defineTag) have no columns to resolve — core's accessor refuses to read them. Presence
  // alone is the value: an empty frozen snapshot.
  if (def.fields.length === 0) return EMPTY_SNAPSHOT
  const view = world.entity(handle).read(def) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of def.fields) {
    const token = unwrapToken(field.token)
    if (typeof token === 'object' && token.kind === 'vec') {
      const vec = view[field.name] as ArrayLike<number>
      const copy = new Array<number>(token.len)
      for (let i = 0; i < token.len; i++) copy[i] = vec[i] as number
      out[field.name] = Object.freeze(copy)
    } else {
      out[field.name] = view[field.name]
    }
  }
  return Object.freeze(out)
}

/**
 * Field-shallow equality between two snapshots: scalars/strings by `===`, arrays element-by-`===`
 * (vec copies, but also an array held in an `object<T>` field — two distinct arrays with identical
 * elements compare equal), other object refs by `===`. Used to keep the previous snapshot's
 * identity when a write lands the same values, so `useSyncExternalStore` sees no change and the
 * hook does not re-render.
 */
export function snapshotsEqual(
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  for (const key in a) {
    const va = a[key]
    const vb = b[key]
    if (va === vb) continue
    if (Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
      let same = true
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) {
          same = false
          break
        }
      }
      if (same) continue
    }
    return false
  }
  // Snapshots of one component def always share a key set, but keep the contract symmetric: a key
  // present only in `b` is a difference too.
  for (const key in b) {
    if (!(key in a)) return false
  }
  return true
}
