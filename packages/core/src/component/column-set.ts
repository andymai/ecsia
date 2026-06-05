// The (archetype, component) ColumnSet allocation + accessor instantiation.
// This is the binding seam: it allocates one column per column-backed field
// through Buffers.column, instantiates the component's accessor singleton over those columns, and
// registers the singleton as a ViewHolder for the fallback grow path.
//
// ARCHETYPE-BINDING SEAM: storage owns producing this from a real archetype's row store. For
// the caller passes any archetypeId (e.g. a single test/empty archetype) and the columns are
// allocated directly so the read/write paths are exercisable now.

import type { ComponentDef, ComponentId, EntityHandle, FieldDescriptor, Schema } from '@ecsia/schema'
import type { Buffers, Column } from '../memory/index.js'
import { columnKey } from '../memory/index.js'
import { bindingsFor } from './accessor.js'
import type { AccessorBinding, AccessorInstanceBase, AccessorWorld } from './accessor.js'
import type { ComponentRuntime } from './define.js'

export interface ColumnSet {
  readonly archetypeId: number
  readonly componentId: ComponentId
  readonly columns: readonly Column[]
  /** The monomorphic accessor singleton for this (archetype, component). */
  readonly accessor: AccessorInstanceBase
}

export interface BuildColumnSetParams {
  readonly buffers: Buffers
  readonly archetypeId: number
  readonly def: ComponentDef<Schema>
  readonly world: AccessorWorld
  readonly initialCapacity: number
}

export function buildColumnSet(params: BuildColumnSetParams): ColumnSet {
  const { buffers, archetypeId, def, world, initialCapacity } = params
  const rt = def as ComponentRuntime<Schema>
  const componentId = def.id as ComponentId
  if ((componentId as number) < 0) {
    throw new Error(`buildColumnSet: component '${def.name}' has no id (register it with a world first)`)
  }

  const columns: Column[] = []
  let fieldIndex = 0
  let layoutIndex = 0
  for (const f of def.fields as readonly FieldDescriptor[]) {
    if (f.ctor !== null) {
      const layout = rt.columnLayouts[layoutIndex]
      if (layout === undefined) throw new Error(`buildColumnSet: missing layout for field '${f.name}'`)
      const key = columnKey(archetypeId, componentId as number, fieldIndex)
      columns.push(buffers.column(key, layout, initialCapacity))
      layoutIndex += 1
    }
    fieldIndex += 1
  }

  const factory = rt.accessorFactory
  if (factory === null) throw new Error(`buildColumnSet: component '${def.name}' has no accessor factory`)
  const AccessorClass = factory(bindingsFor(columns))
  const accessor = new AccessorClass() as unknown as AccessorInstanceBase
  const binding: AccessorBinding = { world, componentId }
  accessor.__binding = binding

  // Register one ViewHolder PER column so a fallback grow re-binds exactly that field's view.
  // Each column owns a separate backing; a whole-instance rebind would alias every field onto the
  // single grown backing. `columns` is in accessor field-order, so the index is the rebind target.
  for (let i = 0; i < columns.length; i++) {
    const fieldIndex = i
    buffers.registerAccessor((columns[i] as Column).key, {
      __rebind(newBacking) {
        accessor.__rebindField(fieldIndex, newBacking)
      },
    })
  }

  return { archetypeId, componentId, columns, accessor }
}

// Point a column set's accessor singleton at a (row, entity). 's query/iteration loop pokes
// __idx; the entity read/write path pokes both before handing the view out.
export function bindAccessorRow(set: ColumnSet, row: number, eid: EntityHandle): AccessorInstanceBase {
  const a = set.accessor
  a.__idx = row
  a.__eid = eid
  return a
}
