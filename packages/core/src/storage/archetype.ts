// The archetype table: a ColumnSet per column-bearing component in the
// signature + a dense entity-row list. Tag / zero-field components contribute NO ColumnSet
// (presence is pure signature membership). The rows list is itself a u32 column allocated
// through Buffers so it grows under the same length-tracking protocol as data columns.

import type { ComponentId, ComponentDef, Schema } from '@ecsia/schema'
import type { ArchetypeId } from '@ecsia/schema'
import type { Buffers, Column } from '../memory/index.js'
import { columnKey, makeColumnLayout } from '../memory/index.js'
import { buildColumnSet } from '../component/index.js'
import type { AccessorWorld, ColumnSet, ComponentRuntime } from '../component/index.js'
import type { Signature } from './signature.js'
import { buildSigWords } from './signature.js'

/** Synthetic component id keying each archetype's row-list column (never in any signature). */
const ROWLIST_COMPONENT_ID = 0xffff_fffe

const ROW_LAYOUT = makeColumnLayout('u32', 1, 0)

export interface Archetype {
  readonly id: ArchetypeId
  readonly signature: Signature
  readonly sigWords: Uint32Array
  readonly hash: number

  /** componentId → its ColumnSet. Hot archetypes only; tag/cold archetypes leave it empty. */
  readonly columnSets: Map<ComponentId, ColumnSet>

  /** Dense entity-row list column: rows[r] = the FULL EntityHandle occupying row r. */
  rowsColumn: Column | null
  rows: Uint32Array
  count: number

  /** Lazy edge cache keyed by single ComponentId. */
  readonly edges: Map<ComponentId, { add?: Archetype; remove?: Archetype }>

  /** Fragmentation policy state. */
  cold: boolean
  lastAccessTick: number
}

export interface ArchetypeColumnDeps {
  readonly buffers: Buffers
  readonly accessorWorld: AccessorWorld
  readonly initialCapacity: number
  defOf(c: ComponentId): ComponentDef<Schema> | undefined
}

/** Allocate the row-list column + one ColumnSet per column-bearing component (hot archetype only). */
export function attachHotColumns(arch: Archetype, deps: ArchetypeColumnDeps): void {
  const { buffers, accessorWorld, initialCapacity, defOf } = deps
  const rowsKey = columnKey(arch.id as number, ROWLIST_COMPONENT_ID, 0)
  const rowsColumn = buffers.column(rowsKey, ROW_LAYOUT, initialCapacity)
  arch.rowsColumn = rowsColumn
  arch.rows = rowsColumn.view as Uint32Array

  for (let i = 0; i < arch.signature.length; i++) {
    const c = arch.signature[i] as number as ComponentId
    const def = defOf(c)
    if (def === undefined) continue // pair/synthetic id with no registered def yet (relations)
    const rt = def as ComponentRuntime<Schema>
    // A pure tag (no columns AND no rich fields) gets no ColumnSet. A rich-only or mixed component DOES
    // get one — its accessor carries the sidecar getters/setters even with zero columns.
    if (rt.columnLayouts.length === 0 && !rt.hasRichFields) continue
    arch.columnSets.set(
      c,
      buildColumnSet({ buffers, archetypeId: arch.id as number, def, world: accessorWorld, initialCapacity }),
    )
  }
}

export function makeArchetype(id: ArchetypeId, sig: Signature, hash: number, stride: number, tick: number, cold: boolean): Archetype {
  return {
    id,
    signature: sig,
    sigWords: buildSigWords(sig, stride),
    hash,
    columnSets: new Map(),
    rowsColumn: null,
    rows: new Uint32Array(0),
    count: 0,
    edges: new Map(),
    cold,
    lastAccessTick: tick,
  }
}

export { ROWLIST_COMPONENT_ID }
