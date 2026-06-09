// `defineTopic` — module-scope definition of a typed event queue, mirroring `defineComponent`:
// a pure descriptor with no world attached, interned (id minted) when a world first sees it.
// Topic payloads are schema'd rows: the same field-token set as components, MINUS the non-shareable
// tokens (`object<T>`, `'string'`) — an event row must be encodable to plain u32 words so it can
// live in the SAB-backed canonical ring and cross the worker boundary byte-deterministically.

import type {
  ComponentId,
  FieldDescriptor,
  FieldToken,
  FieldValue,
  ScalarToken,
  ScalarValue,
  Schema,
  TokenOf,
  VecToken,
} from '@ecsia/schema'
import { resolveDescriptor, UNREGISTERED } from '../component/index.js'

/**
 * A typed inter-system message queue ("this happened"), as opposed to an observer ("this component
 * changed"). Define once at module scope with `defineTopic`; systems declare interest with the
 * `publish:` / `consume:` keys on `defineSystem`, and code outside systems publishes between frames
 * via `world.publish`. `id` is the topic's virtual ComponentId, minted when a world registers it.
 */
export interface TopicDef<S extends Schema = Schema, N extends string = string> {
  readonly name: N
  readonly schema: S
  readonly fields: readonly FieldDescriptor[]
  /** The dense virtual ComponentId once registered with a world; -1 (UNREGISTERED) before. */
  id: ComponentId
  readonly __ecsiaTopic: true
}

/**
 * The value an event field decodes to on the consume side. Scalars decode like component reads;
 * `vec` fields decode to a plain readonly number array (events are copied rows, not live views).
 */
export type TopicFieldValue<F extends FieldToken> =
  TokenOf<F> extends VecToken<infer E, number> ? readonly ScalarValue<E>[] : FieldValue<TokenOf<F>>

/** One delivered event: a typed read view over the payload schema. Pooled — never store it. */
export type TopicEvent<S extends Schema> = {
  readonly [K in keyof S]: TopicFieldValue<S[K]>
}

/** The payload accepted by `publish` — missing fields take their schema defaults. */
export type TopicEventInit<S extends Schema> = {
  readonly [K in keyof S]?: TokenOf<S[K]> extends VecToken<ScalarToken, number>
    ? ArrayLike<number>
    : FieldValue<TokenOf<S[K]>>
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function isFieldSpec(token: unknown): token is { __fieldSpec: true; token: FieldToken; default: unknown } {
  return typeof token === 'object' && token !== null && (token as { __fieldSpec?: unknown }).__fieldSpec === true
}

/**
 * Define a typed event queue. `schema` uses the component field tokens (`'f32'`, `'eid'`, `vec`,
 * `staticString`, ...); `object<T>` and `'string'` fields are rejected — event rows are fixed-width
 * u32 words so the stream is shareable, byte-deterministic, and serializable.
 *
 * `eid` payload fields carry the full generational handle with NO liveness validation on delivery:
 * an event is a fact about the past, and the referenced entity may legitimately be dead by the time
 * a consumer reads it (especially on next-frame delivery). Check `world.isAlive(ev.target)` if the
 * consumer needs the entity.
 *
 * Like a `defineComponent` def, a topic def binds to ONE world: registration writes the minted id
 * into the def, so a second world (another test, an HMR cycle) must call `defineTopic` afresh
 * rather than reuse the module-scope def — reuse throws "already registered with another world".
 */
export function defineTopic<const S extends Schema, const N extends string>(name: N, schema: S): TopicDef<S, N> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('defineTopic: a non-empty topic name is required')
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`defineTopic('${name}'): schema must be a plain object`)
  }
  const fields: FieldDescriptor[] = []
  for (const fieldName of Object.keys(schema)) {
    if (!IDENT.test(fieldName) || fieldName.startsWith('__')) {
      throw new Error(`defineTopic('${name}'): invalid field name '${fieldName}' (reserved __ prefix or non-identifier)`)
    }
    const raw = schema[fieldName] as FieldToken
    const token = isFieldSpec(raw) ? raw.token : raw
    if (typeof token === 'object' && token !== null && (token as { kind?: string }).kind === 'object') {
      throw new Error(
        `defineTopic('${name}'): field '${fieldName}' is an object<T> field, but topic events must be fixed-width and serializable — use a scalar, vec, or staticString(...) field instead`,
      )
    }
    if (token === 'string') {
      throw new Error(
        `defineTopic('${name}'): field '${fieldName}' is a free-form 'string' field, but topic events must be fixed-width and serializable — use staticString([...]) for a known set of values`,
      )
    }
    const descriptor = isFieldSpec(raw)
      ? resolveDescriptor(fieldName, raw.token, raw.default)
      : resolveDescriptor(fieldName, raw)
    fields.push(descriptor)
  }
  const def = {
    name,
    schema,
    fields: Object.freeze(fields),
    __ecsiaTopic: true as const,
  } as TopicDef<S, N>
  // `id` is the registry's single commit point (mirrors ComponentRuntime): mutable so a world (or a
  // worker aligning ids from the boot manifest) can intern the def after construction.
  Object.defineProperty(def, 'id', { value: UNREGISTERED, enumerable: true, writable: true, configurable: true })
  return Object.preventExtensions(def)
}
