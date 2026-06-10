// defineComponent / defineTag runtime. Maps a schema to a resolved
// FieldDescriptor set + a per-field ColumnLayout set, defaults options (tag → sparse, else
// packed), and produces a frozen ComponentDef whose `id` is UNREGISTERED until a world interns it
// The accessor factory is wired lazily once `id` is known.

import type {
  AccessorFactory,
  ComponentDef,
  ComponentId,
  ComponentOptions,
  FieldDescriptor,
  FieldToken,
  Schema,
} from '@ecsia/schema'
import type { ColumnLayout } from '../memory/index.js'
import { fieldToColumnLayout } from '../memory/index.js'
import { resolveDescriptor } from './descriptors.js'
import { makeAccessorFactory } from './accessor.js'

export const UNREGISTERED = -1 as ComponentId

export type DefKind = 'component' | 'relation-presence' | 'relation-overflow'

// The runtime def carries the
// component module owns: the resolved column layouts, the lazily-wired
// accessor factory, a defKind discriminator, and the derived restrictedToMainThread flag.
export interface ComponentRuntime<S extends Schema> extends ComponentDef<S> {
  id: ComponentId
  accessorFactory: AccessorFactory<S> | null
  readonly columnLayouts: readonly ColumnLayout[]
  readonly defKind: DefKind
  readonly restrictedToMainThread: boolean
  /** True iff the component carries >=1 rich (sidecar-backed) field. */
  readonly hasRichFields: boolean
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateSchema(schema: Schema): void {
  if (!isPlainObject(schema)) throw new Error('defineComponent: schema must be a plain object')
  const seen = new Set<string>()
  for (const name of Object.keys(schema)) {
    if (!IDENT.test(name) || name.startsWith('__')) {
      throw new Error(`defineComponent: invalid field name '${name}' (reserved __ prefix or non-identifier)`)
    }
    if (seen.has(name)) throw new Error(`defineComponent: duplicate field '${name}'`)
    seen.add(name)
    const token = schema[name] as FieldToken
    validateToken(name, token)
  }
}

function isFieldSpec(token: unknown): token is { __fieldSpec: true; token: FieldToken; default: unknown; persist?: boolean } {
  return typeof token === 'object' && token !== null && (token as { __fieldSpec?: unknown }).__fieldSpec === true
}

function validateToken(name: string, token: FieldToken): void {
  // A FieldSpec wrapper carries a user default; validate its inner token.
  if (isFieldSpec(token)) {
    validateToken(name, token.token)
    return
  }
  if (typeof token === 'string') return
  if (typeof token !== 'object' || token === null) {
    throw new Error(`defineComponent: field '${name}' is not a valid field token`)
  }
  const kind = (token as { kind?: string }).kind
  if (kind === 'vec') {
    const t = token as { elem: unknown; len: unknown }
    if (typeof t.elem !== 'string') throw new Error(`defineComponent: vec field '${name}' needs a scalar elem`)
    if (t.elem === 'bool' || t.elem === 'eid') {
      throw new Error(`defineComponent: vec field '${name}' element must be numeric, not '${t.elem}'`)
    }
    if (!Number.isInteger(t.len) || (t.len as number) < 1) {
      throw new Error(`defineComponent: vec field '${name}' len must be an integer >= 1`)
    }
  } else if (kind === 'staticString') {
    const choices = (token as { choices: readonly string[] }).choices
    if (choices.length < 1) throw new Error(`defineComponent: staticString field '${name}' needs >= 1 choice`)
    if (new Set(choices).size !== choices.length) {
      throw new Error(`defineComponent: staticString field '${name}' choices must be distinct`)
    }
    if (choices.length > 0xffffffff) throw new Error(`defineComponent: staticString field '${name}' exceeds u32 index ceiling`)
  } else if (kind !== 'object') {
    throw new Error(`defineComponent: field '${name}' has an unknown token kind`)
  }
}

function validateOptions(options?: ComponentOptions): void {
  if (options?.storage !== undefined && options.storage !== 'packed' && options.storage !== 'sparse') {
    throw new Error(`defineComponent: storage must be 'packed' or 'sparse'`)
  }
  if (options?.persist !== undefined && typeof options.persist !== 'boolean') {
    throw new Error('defineComponent: persist must be a boolean')
  }
}

// `B`/`N` capture the brand/name LITERALS so the returned def's `name` is the literal the query DSL
// lifts to a precise element key (CompKey). The runtime `name` is
// `brand ?? name`. A name (or brand) is REQUIRED: without it two anonymous defs would
// both key the element surface as `'Component'` and collide — so the options arg now mandates one and
// `defineComponent(schema)` is a compile error. defineTag and the relations runtime supply `brand`.
export function defineComponent<
  const S extends Schema,
  const B extends string = never,
  const N extends string = never,
>(
  schema: S,
  options: ComponentOptions & ({ readonly name: N; readonly brand?: B } | { readonly brand: B; readonly name?: N }),
): ComponentDef<S, [B] extends [never] ? N : B> {
  validateSchema(schema)
  validateOptions(options)
  if (options?.brand === undefined && options?.name === undefined) {
    throw new Error("defineComponent: a 'name' (or 'brand') option is required — it's the key you read the component by (entity.<name>) and keeps separate components from colliding")
  }

  // Component-level persist:false makes EVERY field non-persisted; a per-field FieldSpec
  // persist flag narrows further within a persisted component.
  const componentPersist = options?.persist ?? true
  const fields: FieldDescriptor[] = []
  for (const name of Object.keys(schema)) {
    const raw = schema[name] as FieldToken
    if (isFieldSpec(raw)) {
      fields.push(resolveDescriptor(name, raw.token, raw.default, componentPersist && (raw.persist ?? true)))
    } else {
      fields.push(resolveDescriptor(name, raw, undefined, componentPersist))
    }
  }

  const isTag = fields.length === 0
  const resolvedOptions: Required<ComponentOptions> = {
    storage: options?.storage ?? (isTag ? 'sparse' : 'packed'),
    persist: componentPersist,
  }

  const columnLayouts: ColumnLayout[] = []
  for (const f of fields) {
    const layout = fieldToColumnLayout(f)
    if (layout !== null) columnLayouts.push(layout)
  }

  const restrictedToMainThread = fields.some((f) => !f.shareable)
  const hasRichFields = fields.some((f) => f.rich !== undefined)

  const def = {
    schema,
    fields: Object.freeze(fields),
    name: (options.brand ?? options.name) as string,
    options: Object.freeze(resolvedOptions),
    columnLayouts: Object.freeze(columnLayouts),
    defKind: 'component' as const,
    restrictedToMainThread,
    hasRichFields,
  } as ComponentRuntime<S>

  // `id` and `accessorFactory` are the only mutable fields — the registry's single commit point
  // Everything else is read-only; the object stays non-extensible.
  Object.defineProperty(def, 'id', { value: UNREGISTERED, enumerable: true, writable: true, configurable: true })
  Object.defineProperty(def, 'accessorFactory', {
    value: null,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  if (options?.brand !== undefined) {
    Object.defineProperty(def, '__nominalBrand', { value: options.brand, enumerable: true, writable: false })
  }
  // The runtime def is built as ComponentRuntime<S> (name: string); the captured literal lives only
  // in the declared return type, so re-narrow here. The runtime value is unchanged.
  return Object.preventExtensions(def) as unknown as ComponentDef<S, [B] extends [never] ? N : B>
}

// A name is REQUIRED: it keys the tag's element/membership identity, so an anonymous tag
// can no longer collide with another on a default name.
export function defineTag<const N extends string>(name: N): ComponentDef<Record<never, never>, N> {
  if (name === undefined || (name as string) === '') {
    throw new Error("defineTag: a 'name' argument is required — it keys the tag's identity and prevents anonymous tags from colliding")
  }
  return defineComponent({}, { storage: 'sparse', brand: name }) as ComponentDef<Record<never, never>, N>
}

// Assign a dense ComponentId and wire the accessor factory now that `id` is known. The def
// is frozen, so `id`/`accessorFactory` are mutated through defineProperty (the registry's single
// commit point — analogous to the entity-record commit).
export function registerComponentId<S extends Schema>(def: ComponentDef<S>, id: ComponentId): void {
  const rt = def as ComponentRuntime<S>
  if (rt.id !== UNREGISTERED) {
    throw new Error(`component '${def.name}' is already registered to a world (id ${rt.id})`)
  }
  rt.id = id
  rt.accessorFactory = makeAccessorFactory(def)
}
