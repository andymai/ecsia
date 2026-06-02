// The buffer layer (memory-buffers.md §3–§7). Owns the physical column/region representation,
// the SAB-vs-ArrayBuffer decision (the single B-1 site, §5.5), and the growth protocol with its
// load-bearing correctness invariant — accessor view-invalidation (Must-Fix #5):
//   PRIMARY  (§7.2): length-tracking views over a resizable backing auto-widen on `.grow()`,
//                    so growth re-points NOTHING (Invariant V-1).
//   FALLBACK (§7.5): a non-resizable backing is re-allocated, copied, and every live ViewHolder
//                    is re-bound via `__rebind` (the live-accessor registry).

import type { ColumnLayout, ElementKind, TypedArray } from './layout.js'
import { elementCtor } from './layout.js'

export type Backing = SharedArrayBuffer | ArrayBuffer
export type ColumnKey = string & { readonly __columnKey: unique symbol }
export type RegionKey = string & { readonly __regionKey: unique symbol }

// --- §4 capability probe ---------------------------------------------------

export type WorkerMode = 'single' | 'sab' | 'postMessage-fallback' | 'auto'

export type BackingStrategy = 'resizable-sab' | 'grow-patch-sab' | 'resizable-ab' | 'grow-patch-ab'

export interface RuntimeCapabilities {
  readonly sabAvailable: boolean
  readonly resizableSab: boolean
  readonly resizableAb: boolean
  readonly waitAsync: boolean
  readonly waitBlocking: boolean
  readonly crossOriginIsolated: boolean | undefined
  readonly backing: BackingStrategy
}

// Resizable {Shared}ArrayBuffer is ES2024; lib is ES2023. The maxByteLength option and `.grow()`
// are typed through these localized ctor shims (mirroring allocU32.ts) rather than widening lib.
type ResizableCtor<B> = new (byteLength: number, options: { maxByteLength: number }) => B
const ResizableSab = SharedArrayBuffer as unknown as ResizableCtor<SharedArrayBuffer>
const ResizableAb = ArrayBuffer as unknown as ResizableCtor<ArrayBuffer>
interface Growable {
  readonly maxByteLength?: number
  grow?: (byteLength: number) => void
  resize?: (byteLength: number) => void
}

const tryCtor = (make: () => unknown): boolean => {
  try {
    make()
    return true
  } catch {
    return false
  }
}

export function selectBacking(
  req: WorkerMode,
  sabAvailable: boolean,
  resizableSab: boolean,
  resizableAb: boolean,
  emitDiagnostic: (message: string) => void = () => {},
): BackingStrategy {
  switch (req) {
    case 'single':
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
    case 'sab':
      if (!sabAvailable) {
        throw new Error("workers:'sab' requires SharedArrayBuffer + cross-origin isolation")
      }
      return resizableSab ? 'resizable-sab' : 'grow-patch-sab'
    case 'postMessage-fallback':
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
    case 'auto':
      if (sabAvailable) return resizableSab ? 'resizable-sab' : 'grow-patch-sab'
      emitDiagnostic('SAB/cross-origin-isolation unavailable; running single-threaded')
      return resizableAb ? 'resizable-ab' : 'grow-patch-ab'
  }
}

export function probeCapabilities(
  req: WorkerMode,
  emitDiagnostic?: (message: string) => void,
): RuntimeCapabilities {
  const sabCtor = typeof SharedArrayBuffer === 'function'
  const coi =
    typeof (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== 'undefined'
      ? (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
      : undefined
  const sabAvailable = sabCtor && coi !== false
  const resizableSab = sabAvailable && tryCtor(() => new ResizableSab(8, { maxByteLength: 16 }))
  const resizableAb = tryCtor(() => new ResizableAb(8, { maxByteLength: 16 }))
  // Atomics.waitAsync is ES2024; lib is ES2023, so it is probed through a localized cast.
  const waitAsync =
    sabAvailable && typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function'
  const waitBlocking = sabAvailable && typeof Atomics.wait === 'function'
  const backing = selectBacking(req, sabAvailable, resizableSab, resizableAb, emitDiagnostic)
  return Object.freeze({
    sabAvailable,
    resizableSab,
    resizableAb,
    waitAsync,
    waitBlocking,
    crossOriginIsolated: coi,
    backing,
  })
}

// --- §3.1 Column / Region --------------------------------------------------

export interface Column<TA extends TypedArray = TypedArray> {
  readonly layout: ColumnLayout
  readonly key: ColumnKey
  // MUTABLE: re-pointed only on the fallback grow path (§7.5); stable on the primary path (§7.2).
  view: TA
  // MUTABLE identity ONLY on the fallback path; the SAB identity is stable on the primary path (B-2).
  backing: Backing
  capacity(): number
}

export interface Region<TA extends TypedArray = TypedArray> {
  view: TA
  backing: Backing
  readonly key: RegionKey
  capacity(): number
}

export interface RegionOpts {
  readonly fixed?: boolean
  readonly maxLength?: number
  readonly fill?: number
}

// Anything holding a captured view that must be re-bound on a fallback grow (§5.1, §7.5).
export interface ViewHolder {
  __rebind(newBacking: Backing): void
}

// --- §7.7 reservation sizing ----------------------------------------------

export interface BuffersConfig {
  readonly capabilities: RuntimeCapabilities
  readonly maxEntities: number
  /** §7.7 GROWTH_RESERVE_FACTOR — multiplies initialCapacity for the address-space reservation. */
  readonly growthReserveFactor?: number
  /** §7.7 MIN_RESERVE_ROWS — floor on a column's reserved capacity. */
  readonly minReserveRows?: number
}

const DEFAULT_GROWTH_RESERVE_FACTOR = 16
const DEFAULT_MIN_RESERVE_ROWS = 1024

const isResizable = (strategy: BackingStrategy): boolean =>
  strategy === 'resizable-sab' || strategy === 'resizable-ab'
const isSab = (strategy: BackingStrategy): boolean =>
  strategy === 'resizable-sab' || strategy === 'grow-patch-sab'

function makeView(element: ElementKind, backing: Backing): TypedArray {
  // No length argument: the view length-tracks the (possibly resizable) backing (V-1).
  const Ctor = elementCtor(element)
  return new Ctor(backing)
}

function fillRange(view: TypedArray, start: number, end: number, value: number): void {
  view.fill(value, start, end)
}

function nextCapacityBytes(currentBytes: number, requiredBytes: number, maxBytes: number): number {
  // Doubling needs a non-zero base: from currentBytes===0 the doubling loop never progresses
  // (0*2===0) and spins forever. Seed from requiredBytes so a grow off a zero-capacity backing
  // still terminates at the required size.
  let target = currentBytes > 0 ? currentBytes : requiredBytes
  while (target < requiredBytes) target = target * 2
  return Math.min(target, maxBytes)
}

export interface ExportedColumnHandle {
  readonly key: ColumnKey
  readonly backing: SharedArrayBuffer
  readonly layout: ColumnLayout
}
export interface ExportedRegionHandle {
  readonly key: RegionKey
  readonly backing: SharedArrayBuffer
  readonly element: ElementKind
}
export interface SharedHandleManifest {
  readonly columns: ReadonlyArray<ExportedColumnHandle>
  readonly regions: ReadonlyArray<ExportedRegionHandle>
}

export class Buffers {
  readonly capabilities: RuntimeCapabilities
  readonly #maxEntities: number
  readonly #growthReserveFactor: number
  readonly #minReserveRows: number
  // One registry of column/region objects, keyed for idempotent allocation (§5.2).
  readonly #registry = new Map<string, Column | Region>()
  readonly #regionElement = new Map<string, ElementKind>()
  // The live-accessor registry: walked ONLY on the fallback grow path (R-1, §7.5).
  readonly #accessors = new Map<string, Set<ViewHolder>>()

  constructor(config: BuffersConfig) {
    this.capabilities = config.capabilities
    this.#maxEntities = config.maxEntities
    this.#growthReserveFactor = config.growthReserveFactor ?? DEFAULT_GROWTH_RESERVE_FACTOR
    this.#minReserveRows = config.minReserveRows ?? DEFAULT_MIN_RESERVE_ROWS
  }

  #maxCapacityFor(initialCapacity: number): number {
    return Math.min(
      Math.max(initialCapacity * this.#growthReserveFactor, this.#minReserveRows),
      this.#maxEntities,
    )
  }

  #allocBacking(byteLen: number, maxBytes: number): Backing {
    switch (this.capabilities.backing) {
      case 'resizable-sab':
        return new ResizableSab(byteLen, { maxByteLength: maxBytes })
      case 'resizable-ab':
        return new ResizableAb(byteLen, { maxByteLength: maxBytes })
      case 'grow-patch-sab':
        return new SharedArrayBuffer(byteLen)
      case 'grow-patch-ab':
        return new ArrayBuffer(byteLen)
    }
  }

  // §5.3: allocate (or fetch existing) a column. Idempotent per key.
  column(key: ColumnKey, layout: ColumnLayout, initialCapacity: number): Column {
    const existing = this.#registry.get(key)
    if (existing !== undefined) return existing as Column

    const rowBytes = layout.rowBytes
    const byteLen = rowBytes * initialCapacity
    const maxBytes = rowBytes * this.#maxCapacityFor(initialCapacity)
    const backing = this.#allocBacking(byteLen, maxBytes)
    const view = makeView(layout.element, backing)
    const col: Column = {
      layout,
      key,
      view,
      backing,
      capacity(): number {
        return this.backing.byteLength / rowBytes
      },
    }
    if (layout.fillOnInit !== 0) {
      fillRange(view, 0, view.length, layout.fillOnInit)
    }
    this.#registry.set(key, col)
    return col
  }

  // §5.4: a flat global region (entity records, bitmask words, log rings).
  region(key: RegionKey, element: ElementKind, length: number, opts: RegionOpts = {}): Region {
    const existing = this.#registry.get(key)
    if (existing !== undefined) return existing as Region

    const elementBytes = elementCtor(element).BYTES_PER_ELEMENT
    const byteLen = length * elementBytes
    const fixed = opts.fixed === true
    const maxRows = fixed ? length : (opts.maxLength ?? this.#maxCapacityFor(length))
    const maxBytes = maxRows * elementBytes
    // A fixed region never grows; over a resizable strategy reserve exactly its length so the
    // reservation == length and `.grow()` would refuse anyway.
    const backing = this.#allocBacking(byteLen, Math.max(maxBytes, byteLen))
    const view = makeView(element, backing)
    const fill = opts.fill ?? 0
    if (fill !== 0) fillRange(view, 0, view.length, fill)
    const reg: Region = {
      view,
      backing,
      key,
      capacity(): number {
        return this.backing.byteLength / elementBytes
      },
    }
    this.#registry.set(key, reg)
    this.#regionElement.set(key, element)
    return reg
  }

  // §7.2 PRIMARY path. Grow a column to >= newCapacity rows. Returns the (possibly re-pointed) Column.
  grow(col: Column, newCapacity: number): Column {
    const rowBytes = col.layout.rowBytes
    const required = newCapacity * rowBytes
    if (required <= col.backing.byteLength) return col

    const oldCapacity = col.backing.byteLength / rowBytes
    const growable = col.backing as Growable
    const resizeFn = isResizable(this.capabilities.backing) ? (growable.grow ?? growable.resize) : undefined
    const max = growable.maxByteLength
    if (typeof resizeFn === 'function' && typeof max === 'number') {
      const target = nextCapacityBytes(col.backing.byteLength, required, max)
      if (target >= required) {
        try {
          resizeFn.call(growable, target)
          // No view re-point, no registry walk, no worker re-broadcast (R-1): the length-tracking
          // view (and every captured view) auto-widens. C-2: fill to the ACTUAL post-grow capacity
          // (the doubling protocol over-allocates beyond newCapacity), else eid rows in
          // [newCapacity, actualCapacity) read 0 — a valid entity index, not the -1 null sentinel.
          this.#fillGrownTail(col.view, col.layout, oldCapacity, col.backing.byteLength / rowBytes)
          return col
        } catch {
          return this.#growFallback(col, newCapacity)
        }
      }
      // Reservation exhausted: clamp failed to cover required → exact alloc, no cap (§7.7 valve).
    }
    return this.#growFallback(col, newCapacity)
  }

  // §7.5 FALLBACK path. PRECONDITION (V-2): serial flush point, no worker executing.
  #growFallback(col: Column, newCapacity: number): Column {
    const rowBytes = col.layout.rowBytes
    const oldView = col.view
    const oldCapacity = col.backing.byteLength / rowBytes
    const newByteLen = newCapacity * rowBytes
    const newBacking: Backing = isSab(this.capabilities.backing)
      ? new SharedArrayBuffer(newByteLen)
      : new ArrayBuffer(newByteLen)
    const newView = makeView(col.layout.element, newBacking)
    newView.set(oldView as unknown as ArrayLike<number>)
    this.#fillGrownTail(newView, col.layout, oldCapacity, newCapacity)
    col.backing = newBacking
    col.view = newView
    const holders = this.#accessors.get(col.key)
    if (holders !== undefined) {
      for (const holder of holders) holder.__rebind(newBacking)
    }
    return col
  }

  // §7.3: only eid columns need an explicit fill (their zero is a valid entity); everything else
  // relies on the runtime zero-init of the grown region.
  #fillGrownTail(view: TypedArray, layout: ColumnLayout, oldCapacity: number, newCapacity: number): void {
    if (layout.fillOnInit === 0) return
    // Upper bound clamped to the view's real length: the grown capacity is derived from the backing
    // (the doubling protocol over-allocates), so the eid -1 fill must cover the whole tail.
    const end = Math.min(newCapacity * layout.stride, view.length)
    fillRange(view, oldCapacity * layout.stride, end, layout.fillOnInit)
  }

  registerAccessor(key: ColumnKey, accessor: ViewHolder): void {
    let set = this.#accessors.get(key)
    if (set === undefined) {
      set = new Set()
      this.#accessors.set(key, set)
    }
    set.add(accessor)
  }

  unregisterAccessor(key: ColumnKey, accessor: ViewHolder): void {
    this.#accessors.get(key)?.delete(accessor)
  }

  get(key: ColumnKey | RegionKey): Column | Region | undefined {
    return this.#registry.get(key)
  }

  // §6.3: the worker-relevant SAB handles, posted once at worker startup.
  exportSharedHandles(): SharedHandleManifest {
    const columns: ExportedColumnHandle[] = []
    const regions: ExportedRegionHandle[] = []
    for (const entry of this.#registry.values()) {
      if (!(entry.backing instanceof SharedArrayBuffer)) continue
      if ('layout' in entry) {
        columns.push({ key: entry.key, backing: entry.backing, layout: entry.layout })
      } else {
        const element = this.#regionElement.get(entry.key)
        if (element !== undefined) regions.push({ key: entry.key, backing: entry.backing, element })
      }
    }
    return { columns, regions }
  }
}

// §6.4 serialization boundary: zero-copy SAB vs copy snapshot.
export function sharedBacking(col: Column): SharedArrayBuffer | null {
  return col.backing instanceof SharedArrayBuffer ? col.backing : null
}

export function snapshotInto(col: Column, count: number, out: TypedArray, outOffset: number): number {
  const elements = count * col.layout.stride
  out.set(
    (col.view as unknown as { subarray(s: number, e: number): TypedArray }).subarray(0, elements) as unknown as ArrayLike<number>,
    outOffset,
  )
  return elements
}

// §3.6 zero-copy slice for one vec row.
export function rowSlice(col: Column, row: number): TypedArray {
  const n = col.layout.stride
  return (col.view as unknown as { subarray(s: number, e: number): TypedArray }).subarray(row * n, row * n + n)
}

export function columnKey(archetypeId: number, componentTypeId: number, fieldIndex: number): ColumnKey {
  return `${archetypeId}:${componentTypeId}.${fieldIndex}` as ColumnKey
}
