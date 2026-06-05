// Renderers: PURE functions over the data layer. renderText must contain the load-bearing FACTS
// (grep-able: counts, component/system names, conflict kinds, pin reasons). renderHTML must be
// SELF-CONTAINED (no external refs, no scripts) and contain the SAME facts.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTag, write, read, object } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import { createRelations } from '@ecsia/relations'
import { inspectWorld, explainPlan, renderText, renderHTML, componentNameMap } from '../src/index.js'

// A real world + plan with relations, rich fields, conflicts and a pin — so the renderers have every
// section to exercise.
function fixture() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Label = defineComponent({ tag: object<string>() }, { name: 'label' })
  const world = createWorld({ components: [Position, Label], maxEntities: 256 })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true })

  const root = world.spawnWith([Position, { x: 0, y: 0 }], [Label, { tag: 'root' }]) as number
  const child = world.spawnWith([Position, { x: 1, y: 2 }]) as number
  rel.addPair(child as never, ChildOf, root as never)

  const Mover = defineSystem({ name: 'Mover', read: [], write: [Position], run() {} })
  const Tagger = defineSystem({ name: 'Tagger', read: [Label], write: [Position], run() {} })
  const sched = createScheduler(world, [Mover, Tagger])
  void world.query(write(Position), read(Label)).count

  const report = inspectWorld(world)
  const plan = explainPlan(sched, componentNameMap(world))
  return { report, plan }
}

describe('renderText — load-bearing facts are grep-able', () => {
  test('world report text carries every section and the live counts', () => {
    const { report } = fixture()
    const txt = renderText(report)

    expect(txt).toContain('== Entities ==')
    expect(txt).toContain('== Components ==')
    expect(txt).toContain('== Archetypes ==')
    expect(txt).toContain('== Memory ==')

    // The entity census and component names appear verbatim.
    expect(txt).toContain(`alive ${report.entities.alive}`)
    expect(txt).toContain('position')
    expect(txt).toContain('label')

    // The rich field is named in the components table.
    expect(txt).toContain('tag')

    // The relation + its pair count appear.
    expect(txt).toContain('== Relations ==')
    expect(txt).toContain('Relation0')
  })

  test('plan text carries the wave layout, conflicts, and pin', () => {
    const { plan } = fixture()
    const txt = renderText(plan)

    expect(txt).toContain('== Waves ==')
    expect(txt).toContain('wave 0')
    expect(txt).toContain('Mover')
    expect(txt).toContain('Tagger')

    // Conflicts section names the offending component + kind.
    expect(txt).toContain('== Conflicts ==')
    expect(txt).toContain('write-write')
    expect(txt).toContain('position')

    // Pinned section names the rich-field system + reason.
    expect(txt).toContain('== Pinned')
    expect(txt).toContain('rich-fields')
    expect(txt).toContain('Tagger')
  })
})

describe('renderHTML — self-contained, no external refs, same facts', () => {
  test('world report HTML is a complete document with inline style and no scripts/external refs', () => {
    const { report } = fixture()
    const html = renderHTML(report)

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('<style>') // inline CSS

    // SELF-CONTAINED: no scripts, no external resource references.
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/src\s*=/)
    expect(html).not.toMatch(/href\s*=/)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import/)

    // SAME FACTS as the text render.
    expect(html).toContain('position')
    expect(html).toContain('label')
    expect(html).toContain('tag')
    expect(html).toContain('Relation0')
    expect(html).toContain(String(report.entities.alive))
  })

  test('plan HTML carries the waves, conflicts, and pin without scripts', () => {
    const { plan } = fixture()
    const html = renderHTML(plan)

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\//)

    expect(html).toContain('wave 0')
    expect(html).toContain('Mover')
    expect(html).toContain('Tagger')
    expect(html).toContain('write-write')
    expect(html).toContain('rich-fields')
  })

  test('renderHTML escapes angle brackets in names (no raw injection)', () => {
    const Evil = defineComponent({ v: 'i32' }, { name: '<x>&"' })
    const world = createWorld({ components: [Evil] })
    world.spawnWith(Evil)
    const html = renderHTML(inspectWorld(world))
    // The raw name must not appear unescaped; the escaped form must.
    expect(html).not.toContain('<x>&"')
    expect(html).toContain('&lt;x&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
  })

  // A tag's name flows through inspectWorld into ComponentReport.name; the contract is that it is
  // ALWAYS a string, so renderHTML's esc() (String.prototype.replace) and renderText never choke. Lock
  // both the string-typed report field and that the rendered output names the tag verbatim.
  test('a tag-bearing world renders with a string name in every component report', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const Frozen = defineTag('frozen')
    const world = createWorld({ components: [Health, Frozen], maxEntities: 64 })
    world.spawnWith(Health, Frozen)

    const report = inspectWorld(world)
    for (const c of report.components) expect(typeof c.name).toBe('string')
    const tag = report.components.find((c) => c.name === 'frozen')!
    expect(tag).toBeDefined()

    expect(renderText(report)).toContain('frozen')
    const html = renderHTML(report)
    expect(html).toContain('frozen')
    expect(html).not.toContain('[object Object]')
  })

  test('renderText and renderHTML are pure — repeated calls are identical and do not mutate the report', () => {
    const { report } = fixture()
    const snapshot = JSON.stringify(report)
    const t1 = renderText(report)
    const t2 = renderText(report)
    const h1 = renderHTML(report)
    const h2 = renderHTML(report)
    expect(t1).toBe(t2)
    expect(h1).toBe(h2)
    expect(JSON.stringify(report)).toBe(snapshot) // unchanged
  })
})
