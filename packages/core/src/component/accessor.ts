// The factory-closure accessor class. ONE hidden
// class per (archetype, component), closing over the column views and reading a mutable __idx.
// This is NOT an ES Proxy on the accessor itself and NOT new Function() — it is a parameterised
// closure returning a plain JS class (the permitted technique).
//
// Each instance is the single monomorphic singleton for its (archetype, component): read()/the
// shorthand return it typed Readonly, write() returns it mutable. A getter reads the
// captured view at __idx; a setter writes the slot AND calls world.trackWrite. On the primary
// grow path captured views auto-widen (no rebind call); on the fallback path __rebind rebuilds
// them from the new backing.

import type {
  AccessorFactory,
  ColumnBinding,
  ComponentDef,
  ComponentId,
  EntityHandle,
  FieldDescriptor,
  Schema,
} from '@ecsia/schema'
import type { Backing, ColumnLayout, TypedArray } from '../memory/index.js'
import { columnKey, elementCtor } from '../memory/index.js'
import type { ElementKind } from '../memory/index.js'
import { sidecarKey } from './sidecar.js'
import type { RichKind, SidecarKey } from './sidecar.js'

// The seam the world hands the accessor: how a setter reports a tracked write. trackWrite is a
// no-op stub until; the call SITE is present and correct.
export interface AccessorWorld {
  trackWrite(index: number, componentId: ComponentId, fieldIndex?: number): void
  handleIndex(handle: EntityHandle): number
  // Shared single-bit "any write consumer exists" cell (recomputed on flavor/observer/changeVersion
  // (de)registration, NEVER per write). When `active` is false the entire trackWrite chain is provably
  // dead (write-log push gated off AND changeVersion stamping disabled), so the setter skips the
  // handleIndex decode + closure hops entirely — the per-write hot-path fast-out. Reading a live
  // shared cell (not a snapshot) keeps the semantics: the instant a consumer registers, `active` flips
  // and the very next write tracks, identical to calling trackWrite unconditionally.
  readonly tracking: { readonly active: boolean }
  // The rich-field seam: getters/setters for sidecar-backed fields delegate here
  // so accessor.ts stays free of any direct sidecar/entity dependency (same discipline as trackWrite).
  sidecarRead(key: SidecarKey, index: number, gen: number): unknown
  sidecarWrite(key: SidecarKey, index: number, gen: number, value: unknown): void
  /** The generation embedded in `handle` — the RF-HYGIENE stamp source. For a live entity this equals
   * the index's live generation; for an observer-window ref bound to a DYING handle it names the dead
   * tenant, so its rich reads hit the pending-clear stash and never alias a same-window re-mint. */
  handleGeneration(handle: EntityHandle): number
}

// The per-(archetype, component) binding context the world/storage builds. owns binding this
// against a real archetype's column set; for the column set is allocated directly.
export interface AccessorBinding {
  readonly world: AccessorWorld
  readonly componentId: ComponentId
}

// Every accessor instance carries the mutable cursor (__idx), the current entity handle (__eid,
// for the write-log index), the binding (the trackWrite seam), and the fallback rebind method.
export interface AccessorInstanceBase {
  __idx: number
  __eid: EntityHandle
  __binding: AccessorBinding | null
  __rebind(newBacking: Backing): void
  /**
   * Fallback-grow rebind for ONE column. Each column-bearing field owns a SEPARATE backing buffer
   * (one `buffers.column` per field), so a fallback grow re-points exactly that field's view. A
   * whole-instance `__rebind` would alias every field onto the single grown backing (corrupting the
   * other fields' columns); the buffers layer always targets the field that actually grew.
   */
  __rebindField(fieldIndex: number, newBacking: Backing): void
}

interface FieldPlan {
  readonly fieldIndex: number
  readonly name: string
  readonly stride: number
  readonly element: ElementKind
  readonly encode: (v: unknown) => number
  readonly decode: (slot: number) => unknown
  readonly isVec: boolean
}

// A sidecar-backed (rich) field's plan — installed as a getter/setter pair targeting the SidecarStore,
// independent of the column binding. The column-count assert is unchanged.
interface RichPlan {
  readonly fieldIndex: number
  readonly name: string
  readonly rich: RichKind
  readonly sidecarKey: SidecarKey
}

function columnElementOf(f: FieldDescriptor): ElementKind {
  const ctor = f.ctor
  if (ctor === Float32Array) return 'f32'
  if (ctor === Float64Array) return 'f64'
  if (ctor === Int8Array) return 'i8'
  if (ctor === Uint8Array) return 'u8'
  if (ctor === Uint8ClampedArray) return 'u8c'
  if (ctor === Int16Array) return 'i16'
  if (ctor === Uint16Array) return 'u16'
  if (ctor === Int32Array) return 'i32'
  if (ctor === Uint32Array) return 'u32'
  throw new Error(
    `internal: field '${f.name}' has an unsupported column element ctor '${(ctor as { name?: string } | null)?.name ?? String(ctor)}'`,
  )
}

function planFields(def: ComponentDef<Schema>): { columnPlans: FieldPlan[]; richPlans: RichPlan[] } {
  const columnPlans: FieldPlan[] = []
  const richPlans: RichPlan[] = []
  const componentId = def.id as ComponentId as unknown as number
  let fieldIndex = 0
  for (const f of def.fields as readonly FieldDescriptor[]) {
    if (f.ctor !== null) {
      columnPlans.push({
        fieldIndex,
        name: f.name,
        stride: f.stride,
        element: columnElementOf(f),
        encode: f.encode,
        decode: f.decode,
        isVec: f.stride > 1,
      })
    } else if (f.rich !== undefined) {
      // Rich (sidecar-backed) field: gets a getter/setter pair targeting the sidecar. Its field
      // index is still consumed so column keys stay stable across the field set.
      richPlans.push({ fieldIndex, name: f.name, rich: f.rich, sidecarKey: sidecarKey(componentId, fieldIndex) })
    }
    fieldIndex += 1
  }
  return { columnPlans, richPlans }
}

// Build the per-(archetype, component) ColumnBinding[] for a column set the caller allocated. The
// archetype-binding seam will produce these from a real archetype's columns; for the
// caller passes the freshly-allocated columns directly.
export function bindingsFor(
  columns: ReadonlyArray<{ view: TypedArray; layout: ColumnLayout }>,
): ColumnBinding[] {
  return columns.map((c) => ({
    view: c.view as unknown as ColumnBinding['view'],
    byteOffset: (c.view as unknown as { byteOffset: number }).byteOffset,
    element: c.layout.element,
  }))
}

const AXIS_NAMES = ['x', 'y', 'z', 'w'] as const

export function makeAccessorFactory<S extends Schema>(def: ComponentDef<S>): AccessorFactory<S> {
  const { columnPlans: plans, richPlans } = planFields(def as ComponentDef<Schema>)
  const componentId = def.id as ComponentId

  return ((columns: ReadonlyArray<ColumnBinding>) => {
    // The assert counts ONLY column-bearing plans: a rich-only or mixed
    // component binds against its column subset, and the rich getters install independently below.
    if (columns.length !== plans.length) {
      throw new Error(`accessor factory for '${def.name}': expected ${plans.length} columns, got ${columns.length}`)
    }

    // Captured per-field state, closed over by every getter/setter. `views` is mutated in place on
    // a fallback rebind so the closures keep seeing the live view without regeneration.
    const views: TypedArray[] = columns.map((c) => c.view as unknown as TypedArray)
    const offsets: number[] = columns.map((c) => c.byteOffset)
    const elements: ElementKind[] = columns.map((c) => c.element as ElementKind)

    // One reusable VecView per vec field (no allocation on read). Lazily built on first get
    // and cached here, then re-returned for every subsequent get; it reads owner.__idx lazily so it
    // stays correct as __idx is re-poked, and resolves the live view from `views[i]` so a fallback
    // rebind is transparent.
    const vecViews: Array<VecAccess | undefined> = plans.map(() => undefined)

    class Accessor implements AccessorInstanceBase {
      __idx = 0
      __eid = 0 as unknown as EntityHandle
      __binding: AccessorBinding | null = null

      __rebind(newBacking: Backing): void {
        for (let i = 0; i < views.length; i++) this.__rebindField(i, newBacking)
      }

      __rebindField(fieldIndex: number, newBacking: Backing): void {
        const Ctor = elementCtor(elements[fieldIndex] as ElementKind)
        // No length argument: rebuild the length-tracking view at the captured byteOffset.
        views[fieldIndex] = new Ctor(newBacking as ArrayBufferLike, offsets[fieldIndex]) as TypedArray
      }
    }

    plans.forEach((plan, i) => {
      const stride = plan.stride
      const decode = plan.decode
      const encode = plan.encode
      const fieldIndex = plan.fieldIndex

      // fieldIndex is forwarded ONLY by field-granular setters. There is no changeTracking
      // surface, so vec setters pass withField=true unconditionally. TODO: gate withField on the
      // per-component changeTrackingDefault when reactivity config lands, so component-granular
      // components omit fieldIndex.
      const track = (self: Accessor, withField: boolean): void => {
        const b = self.__binding
        if (b === null) return
        // Fast-out: no write consumer ⇒ trackWrite is a no-op anyway, so skip the handleIndex decode
        // and the two closure hops entirely ( write-path gate). See AccessorWorld.tracking.
        if (!b.world.tracking.active) return
        if (withField) b.world.trackWrite(b.world.handleIndex(self.__eid), componentId, fieldIndex)
        else b.world.trackWrite(b.world.handleIndex(self.__eid), componentId)
      }

      if (plan.isVec) {
        Object.defineProperty(Accessor.prototype, plan.name, {
          enumerable: true,
          configurable: true,
          get(this: Accessor): unknown {
            let v = vecViews[i]
            if (v === undefined) {
              v = makeVecView(views, i, stride, this, decode, encode, () => track(this, true))
              vecViews[i] = v
            }
            return v
          },
          set(this: Accessor, value: ArrayLike<number>): void {
            const view = views[i] as TypedArray
            const base = this.__idx * stride
            for (let a = 0; a < stride; a++) view[base + a] = encode(value[a])
            track(this, true)
          },
        })
      } else {
        Object.defineProperty(Accessor.prototype, plan.name, {
          enumerable: true,
          configurable: true,
          get(this: Accessor): unknown {
            const view = views[i] as TypedArray
            return decode(view[this.__idx] as number)
          },
          set(this: Accessor, value: unknown): void {
            const view = views[i] as TypedArray
            view[this.__idx] = encode(value)
            track(this, false)
          },
        })
      }
    })

    // Rich (sidecar-backed) getters/setters. The getter returns the live JS
    // reference (string primitive / object<T>); the setter writes the sidecar slot AND routes through
    // the SAME field-granular trackWrite numeric setters use, so Changed/observers fire identically
    // (RF-CHANGED). In-place mutation of an object<T> reference is NOT tracked — only re-assignment is.
    richPlans.forEach((plan) => {
      const key = plan.sidecarKey
      const fieldIndex = plan.fieldIndex
      Object.defineProperty(Accessor.prototype, plan.name, {
        enumerable: true,
        configurable: true,
        get(this: Accessor): unknown {
          const b = this.__binding
          if (b === null) return undefined
          const idx = b.world.handleIndex(this.__eid)
          return b.world.sidecarRead(key, idx, b.world.handleGeneration(this.__eid))
        },
        set(this: Accessor, value: unknown): void {
          const b = this.__binding
          if (b === null) return
          const idx = b.world.handleIndex(this.__eid)
          b.world.sidecarWrite(key, idx, b.world.handleGeneration(this.__eid), value)
          b.world.trackWrite(idx, componentId, fieldIndex)
        },
      })
    })

    return Accessor as unknown as new () => never
  }) as unknown as AccessorFactory<S>
}

interface VecAccess {
  readonly length: number
  [index: number]: number
}

// A thin vec view, built ONCE per (accessor, vec field) and reused across gets (no allocation
// on read). It reads `owner.__idx` lazily so the single cached wrapper stays correct as __idx is
// re-poked, and resolves the live view from `views[viewIndex]` so a fallback rebind is transparent.
// Indexed/named axis reads decode; writes encode + report a field-granular write.
function makeVecView(
  views: TypedArray[],
  viewIndex: number,
  stride: number,
  owner: { __idx: number },
  decode: (slot: number) => unknown,
  encode: (v: unknown) => number,
  trackWrite: () => void,
): VecAccess {
  const read = (axis: number): unknown => decode((views[viewIndex] as TypedArray)[owner.__idx * stride + axis] as number)
  const write = (axis: number, value: unknown): void => {
    ;(views[viewIndex] as TypedArray)[owner.__idx * stride + axis] = encode(value)
    trackWrite()
  }
  const obj: Record<string | number, unknown> = { length: stride }
  for (let a = 0; a < stride; a++) {
    const axis = a
    const def: PropertyDescriptor = {
      enumerable: true,
      get: () => read(axis),
      set: (v: unknown) => write(axis, v),
    }
    Object.defineProperty(obj, axis, def)
    if (axis < AXIS_NAMES.length) Object.defineProperty(obj, AXIS_NAMES[axis] as string, def)
  }
  return obj as unknown as VecAccess
}

export { columnKey }
export type { ColumnKey } from '../memory/index.js'
