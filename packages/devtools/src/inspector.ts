// World inspector: a pure read over the world's `__serialize` (component/rich/relation metadata)
// + `__inspect` (the FULL archetype census + live-query enumeration) + `world.options` (capacity). The
// result is a plain WorldReport — everything assertable headless, nothing live.

import type { World, ComponentId } from '@ecsia/core'
import type {
  WorldReport,
  ComponentReport,
  ArchetypeReport,
  QueryReport,
  RelationReport,
} from './types.js'
import { renderTerm, componentNameMap } from './names.js'

/**
 * Inspect `world` and return a plain, serializable report. Reads ONLY the world's serialization +
 * introspection seams (`__serialize` / `__inspect`) and `options` — no structural mutation, no live
 * handles in the output. Safe to call at any serial point.
 */
export function inspectWorld(world: World): WorldReport {
  const ser = world.__serialize
  const ins = world.__inspect

  const names = componentNameMap(world)
  const nameOf = (id: number): string => names.get(id) ?? `#${id}`

  // --- components: id, fields, richFields, bytesPerRow, totalBytes ---
  // bytesPerRow is the per-row column footprint (rich/object fields are sidecar — 0 column bytes).
  // totalBytes multiplies it by the live row count across every hot archetype that holds the component.
  const liveRowsByComponent = new Map<number, number>()
  for (const arch of ins.archetypes()) {
    if (arch.cold || arch.count === 0) continue
    for (const c of arch.signature) liveRowsByComponent.set(c as number, (liveRowsByComponent.get(c as number) ?? 0) + arch.count)
  }

  const richByComponent = new Map<number, string[]>()
  for (const rf of ser.richFields()) {
    let list = richByComponent.get(rf.componentId as number)
    if (list === undefined) {
      list = []
      richByComponent.set(rf.componentId as number, list)
    }
    list.push(rf.name)
  }

  const components: ComponentReport[] = []
  let columnsBytes = 0
  for (const meta of ser.components()) {
    const fields = ser.fieldsOf(meta.id) ?? []
    let bytesPerRow = 0
    for (const f of fields) {
      // ctor === null ⟺ rich/object (sidecar-backed) — no column bytes (schema FieldDescriptor / RF-DESC).
      if (f.ctor === null) continue
      bytesPerRow += f.bytesPerElem * f.stride
    }
    const liveRows = liveRowsByComponent.get(meta.id as number) ?? 0
    const totalBytes = bytesPerRow * liveRows
    columnsBytes += totalBytes
    components.push({
      // Coerce: ComponentReport.name is contractually a string, but a tag's brand can be any value the
      // caller passed; renderers (esc → String.prototype.replace) assume a string, so normalize here.
      name: String(meta.name),
      id: meta.id as number,
      fields: meta.fieldCount,
      richFields: richByComponent.get(meta.id as number) ?? [],
      bytesPerRow,
      totalBytes,
    })
  }

  // --- archetypes: full census (hot + cold + empty) ---
  // a.signature may be a (branded) typed array; spread to a plain array so `.map` yields strings, not a
  // re-coerced typed array (Uint32Array.map would stringify→NaN→0).
  const archetypes: ArchetypeReport[] = ins.archetypes().map((a) => ({
    id: a.id,
    signature: Array.from(a.signature as Iterable<number>, (c) => nameOf(c)),
    count: a.count,
    temperature: a.cold ? 'cold' : 'hot',
  }))

  // --- queries: terms, matchedArchetypes, size ---
  const queries: QueryReport[] = ins.queries().map((q) => ({
    terms: q.terms.map(renderTerm),
    matchedArchetypes: q.matchedArchetypes,
    size: q.size,
  }))

  // --- relations: name + live pair count (via the serialization relation provider, when attached) ---
  const relations: RelationReport[] = []
  const provider = ser.relations()
  if (provider !== undefined) {
    const counts = new Map<number, number>()
    for (const pair of provider.livePairs()) counts.set(pair.relationId as number, (counts.get(pair.relationId as number) ?? 0) + 1)
    for (const r of provider.relations()) relations.push({ name: r.name, pairCount: counts.get(r.id as number) ?? 0 })
  }

  return {
    entities: { alive: ser.aliveCount(), capacity: world.options.maxEntities },
    archetypes,
    components,
    queries,
    memory: { columnsBytes, sidecarEntries: ser.richFields().length },
    relations,
  }
}

// re-exported so a consumer needn't reach for the seam's ComponentId brand
export type { ComponentId }
