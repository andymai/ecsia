// A deterministic multi-archetype delta scenario, replayed frame by frame, used as the byte-identity
// golden for the epsilon row filter. Exercises every path the filter can take: multi-lane (vec3)
// columns, a non-persisted column, a column-less (rich) persisted field, an eid column, swap-pop tenant
// reuse, archetype migration, fresh rows, refreshEpsilonShadow, and an empty frame.

import { createWorld, defineComponent, field, object, vec3 } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createDeltaSerializer } from '../src/index.js'

const asComps = (...c: unknown[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

export function scenarioFrames(epsilon: number | undefined): Uint8Array[] {
  const Body = defineComponent({ p: vec3(), hp: 'i32', cache: field('f32', { persist: false }) }, { name: 'body' })
  const Tag = defineComponent({}, { name: 'tag' })
  const Label = defineComponent({ text: 'string', meta: object<{ k: number }>() }, { name: 'label' })
  const Link = defineComponent({ who: 'eid' }, { name: 'link' })

  const w = createWorld({ components: asComps(Body, Tag, Label, Link) })
  const ents: EntityHandle[] = []
  for (let i = 0; i < 6; i++) {
    const e = i % 3 === 0 ? w.spawnWith(Body, Tag) : w.spawnWith(Body)
    const b = w.entity(e).write(Body as ComponentDef<Schema>) as unknown as { p: number[]; hp: number; cache: number }
    b.p[0] = i
    b.p[1] = i * 2
    b.p[2] = i * 3
    b.hp = 100 + i
    b.cache = i
    ents.push(e)
  }
  const labelled = w.spawnWith(Label)
  const linker = w.spawnWith(Link)
  ;(w.entity(linker).write(Link as ComponentDef<Schema>) as unknown as { who: EntityHandle }).who = ents[0] as EntityHandle

  const ser = createDeltaSerializer(w, w.currentTick(), epsilon === undefined ? {} : { epsilon })
  const body = (e: EntityHandle) =>
    w.entity(e).write(Body as ComponentDef<Schema>) as unknown as { p: number[]; hp: number; cache: number }
  const frames: Uint8Array[] = []
  const step = (fn: () => void): void => {
    w.advanceTick()
    fn()
    frames.push(ser.deltaCopy())
  }

  // Warm every row: an unemitted row's shadow cells are zero, so nothing is epsilon-comparable
  // until it has been emitted once.
  step(() => {
    for (let i = 0; i < ents.length; i++) body(ents[i] as EntityHandle).hp = 1000 + i
    ;(w.entity(labelled).write(Label as ComponentDef<Schema>) as unknown as { text: string }).text = 'w0'
  })
  step(() => {
    body(ents[0] as EntityHandle).p[0] = 0.2 // drop at 0.5, emit at 0.05
    body(ents[1] as EntityHandle).p[2] = 100 // emit at both
    body(ents[3] as EntityHandle).p[2] = 9.02 // drop at both
    body(ents[4] as EntityHandle).cache = 42 // non-persisted only — stamps, must not defeat the drop
  })
  step(() => {
    body(ents[2] as EntityHandle).p[2] = 6.3 // last lane only
  })
  step(() => {
    w.despawn(ents[1] as EntityHandle) // swap-pop: a survivor inherits the row
  })
  step(() => {
    w.add(ents[2] as EntityHandle, Tag as ComponentDef<Schema>) // migration
    ;(w.entity(labelled).write(Label as ComponentDef<Schema>) as unknown as { text: string }).text = 'moved'
  })
  step(() => {
    const fresh = w.spawnWith(Body) // grows the archetype: the columns regrow FRESH
    body(fresh).hp = 3
    body(fresh).p[1] = 9.5
  })
  step(() => {
    ;(w.entity(labelled).write(Label as ComponentDef<Schema>) as unknown as { meta: { k: number } }).meta = { k: 4 }
  })
  step(() => {
    body(ents[0] as EntityHandle).p[0] = 0.22 // accumulates against the last EMITTED value
  })
  step(() => {
    ser.refreshEpsilonShadow()
    body(ents[0] as EntityHandle).p[1] = 0.04
  })
  step(() => {
    ;(w.entity(linker).write(Link as ComponentDef<Schema>) as unknown as { who: EntityHandle }).who =
      ents[2] as EntityHandle
  })
  step(() => {
    /* empty frame */
  })

  return frames
}
