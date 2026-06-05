// The zero-copy worker bootstrap (serialization.md §3 — Layer 1). NO value serialization: the worker
// gets (a) the SAME SAB-backed buffer set by reference and (b) a replicated registry so it maps
// ComponentDef → ComponentId → ColumnKey identically. The bootstrap manifest carries HANDLES, never
// component value bytes — the transport separation is structural (S-1): bootstrapForWorker returns no
// byte arrays, snapshot/delta return no SAB handles.

import type {
  ColumnLayout,
  ColumnKey,
  ElementKind,
  HandleLayout,
  RegionKey,
  RuntimeCapabilities,
  SharedHandleManifest,
  StorageStrategy,
  TypedArray,
  World,
} from '@ecsia/core'
import { elementCtor } from '@ecsia/core'

export interface SerializedRegistry {
  /** Stable schema hash; the worker recomputes from the handed registry and MUST match (§3.3). */
  readonly schemaHash: number
  readonly components: ReadonlyArray<{
    readonly name: string
    readonly id: number
    readonly fieldCount: number
    readonly storage: StorageStrategy
    /** Field (name, token) in declaration order — lets attachWorld recompute schemaHash from the manifest (§3.3). */
    readonly fields: ReadonlyArray<{ readonly name: string; readonly token: string }>
  }>
  readonly relations: ReadonlyArray<{ readonly name: string; readonly id: number; readonly exclusive: boolean; readonly hasPayload: boolean; readonly presenceId: number }>
  readonly numComponentTypes: number
}

export interface WorldBootstrap {
  /** True iff buffers are SAB-backed and sharable by reference (memory-buffers §6.2). */
  readonly shared: boolean
  readonly handleLayout: HandleLayout
  readonly capabilities: RuntimeCapabilities
  /** Buffer set: every column + region SAB, keyed identically on both sides (from exportSharedHandles). */
  readonly buffers: SharedHandleManifest
  readonly registry: SerializedRegistry
  readonly tick: number
}

/** A worker-side re-wrap of the shared buffer set: live views over the SAME SABs (no value copy). */
export interface WorkerWorldView {
  readonly columns: Map<ColumnKey, { layout: ColumnLayout; view: TypedArray; backing: SharedArrayBuffer }>
  readonly regions: Map<RegionKey, { element: ElementKind; view: TypedArray; backing: SharedArrayBuffer }>
  readonly handleLayout: HandleLayout
  readonly capabilities: RuntimeCapabilities
  schemaHash: number
  tick: number
}

/** A post-bootstrap lazily-created-archetype broadcast (§3.4): new column SABs to re-wrap before next wave. */
export interface ColumnsAdded {
  readonly kind: 'columns-added'
  readonly columns: ReadonlyArray<{ key: ColumnKey; backing: SharedArrayBuffer; layout: ColumnLayout }>
}

export function bootstrapForWorker(world: World): WorldBootstrap {
  if (world.phase !== 'serial') {
    throw new Error('bootstrapForWorker must run while the world is in its serial phase (outside scheduler.update / worker waves)')
  }
  const s = world.__serialize
  const manifest = world.__exportShared()
  const relProvider = s.relations()
  const registry: SerializedRegistry = {
    schemaHash: s.schemaHash(),
    components: s.components().map((c) => {
      const fields = (s.fieldsOf(c.id) ?? []).map((f) => ({
        name: f.name,
        token: typeof f.token === 'string' ? f.token : JSON.stringify(f.token),
      }))
      return { name: c.name, id: c.id as number, fieldCount: c.fieldCount, storage: c.storage, fields }
    }),
    relations:
      relProvider === undefined
        ? []
        : relProvider.relations().map((r) => ({
            name: r.name,
            id: r.id as number,
            exclusive: r.exclusive,
            hasPayload: r.hasPayload,
            presenceId: r.presenceId as number,
          })),
    numComponentTypes: s.numComponentTypes(),
  }
  const caps = s.capabilities()
  return {
    // `shared` iff the buffer set is SAB-backed; exportSharedHandles only emits SAB backings, so a
    // non-empty manifest means the worker can re-wrap by reference (the zero-copy path, §3).
    shared: caps.sabAvailable && (manifest.columns.length > 0 || manifest.regions.length > 0),
    handleLayout: world.handleLayout,
    capabilities: caps,
    buffers: manifest,
    registry,
    tick: world.currentTick(),
  }
}

export function attachWorld(bootstrap: WorldBootstrap): WorkerWorldView {
  if (!bootstrap.shared) {
    throw new Error('attachWorld requires a shared (SharedArrayBuffer) bootstrap; use the postMessage-fallback path instead')
  }
  // §3.3 / §10: single-arg. Recompute the local schema hash from the registry the worker was handed
  // (the dense component/relation id assignment is the producer-specific datum, §3.2) and assert it
  // matches the producer's — a fail-fast guard against a worker re-wrapping a mismatched buffer set.
  const localSchemaHash = computeRegistryHash(bootstrap.registry)
  if (localSchemaHash !== bootstrap.registry.schemaHash) {
    throw new Error('attachWorld: schemaHash mismatch — the worker was built from a different component schema than the host (stale worker code)')
  }
  const columns = new Map<ColumnKey, { layout: ColumnLayout; view: TypedArray; backing: SharedArrayBuffer }>()
  for (const c of bootstrap.buffers.columns) {
    const Ctor = elementCtor(c.layout.element)
    columns.set(c.key, { layout: c.layout, view: new Ctor(c.backing), backing: c.backing })
  }
  const regions = new Map<RegionKey, { element: ElementKind; view: TypedArray; backing: SharedArrayBuffer }>()
  for (const r of bootstrap.buffers.regions) {
    const Ctor = elementCtor(r.element)
    regions.set(r.key, { element: r.element, view: new Ctor(r.backing), backing: r.backing })
  }
  return {
    columns,
    regions,
    handleLayout: bootstrap.handleLayout,
    capabilities: bootstrap.capabilities,
    schemaHash: bootstrap.registry.schemaHash,
    tick: bootstrap.tick,
  }
}

/**
 * Recompute the schema hash from the handed registry (§3.3). Mirrors the world's FNV-1a over
 * (componentName, fieldName, fieldToken)* + relation names exactly, so it reproduces the producer's
 * canonical `schemaHash` — the single-arg `attachWorld` gate against a stale-code worker.
 */
function computeRegistryHash(registry: SerializedRegistry): number {
  let h = 0x811c9dc5
  const fnv = (str: string): void => {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
  }
  for (const c of registry.components) {
    fnv(c.name)
    for (const f of c.fields) {
      fnv(f.name)
      fnv(f.token)
    }
  }
  for (const r of registry.relations) fnv(r.name)
  return h >>> 0
}

/** Re-wrap newly-broadcast column SABs before the next wave (§3.4 / G-7). */
export function applyColumnsAdded(view: WorkerWorldView, notice: ColumnsAdded): void {
  for (const c of notice.columns) {
    const Ctor = elementCtor(c.layout.element)
    view.columns.set(c.key, { layout: c.layout, view: new Ctor(c.backing), backing: c.backing })
  }
}
