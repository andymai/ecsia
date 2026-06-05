// Smoke + regression test for the @ecsia/devtools tour. Locks in the report facts the example
// renders: entity counts, the wave shape (a wave is a batch of systems that can safely run at
// the same time), a known write-write conflict, and the system kept on the main thread by its
// rich field (a field holding a real JS object rather than a number). Every assertion reads the
// plain report objects, not the rendered strings.

import { describe, expect, test } from 'vitest'
import { main as devtoolsTour } from '../devtools-tour.js'

describe('example: devtools-tour (inspect + explain over the damage-over-time world)', () => {
  const { report, plan, reportText, planText } = devtoolsTour()

  test('inspectWorld reports the live entity census', () => {
    // 4 mobs spawned; none despawn in the tour (Burn only decrements, never kills here).
    expect(report.entities.alive).toBe(4)
    expect(report.entities.capacity).toBe(1 << 14)

    // The four registered components surface by name with stable ids.
    const names = report.components.map((c) => c.name)
    expect(names).toEqual(['health', 'burning', 'position', 'label'])

    // label carries an object<T> rich field; the others store plain numbers in typed arrays.
    const label = report.components.find((c) => c.name === 'label')!
    expect(label.richFields).toEqual(['tag'])
    expect(label.bytesPerRow).toBe(0) // the object field lives in a side store, not a typed array

    const position = report.components.find((c) => c.name === 'position')!
    expect(position.bytesPerRow).toBe(8) // 2 × f32
    expect(position.totalBytes).toBe(8 * 4) // 4 entities hold Position

    expect(report.memory.sidecarEntries).toBe(1) // exactly the label.tag rich column
  })

  test('inspectWorld surfaces archetypes, queries and relations', () => {
    // Several archetypes (groups of entities sharing the same component set) exist — the
    // spawnWith targets plus the empty one. Every archetype carries a hot/cold temperature flag.
    expect(report.archetypes.length).toBeGreaterThan(0)
    for (const a of report.archetypes) expect(['hot', 'cold']).toContain(a.temperature)

    // The systems' queries were compiled by the scheduler; the inspector enumerates them.
    expect(report.queries.length).toBeGreaterThan(0)
    const allTerms = report.queries.flatMap((q) => q.terms)
    expect(allTerms.some((t) => t.includes('health'))).toBe(true)

    // The ChildOf relation has three live pairs (a, b, c → root).
    const childOf = report.relations.find((r) => r.pairCount > 0)
    expect(childOf?.pairCount).toBe(3)
  })

  test('explainPlan lays the systems into waves and explains the WHY', () => {
    // Burn writes health+burning; Move reads burning, writes position; Tagger reads label, writes
    // health. Burn↔Tagger both write health and Burn↔Move collide on burning, so the systems
    // can't all share one wave — the plan needs at least 2.
    expect(plan.waves.length).toBeGreaterThanOrEqual(2)

    // Each wave carries at least one batch with at least one system.
    const totalSystems = plan.waves.flatMap((w) => w.batches).flatMap((b) => b.systems).length
    expect(totalSystems).toBe(3)

    // A known write-write conflict: Burn and Tagger both write health (plan SystemId order → a=Burn).
    const ww = plan.conflicts.find((c) => c.kind === 'write-write' && c.on === 'health')
    expect(ww).toBeDefined()
    expect(ww!.a).toBe('Burn')
    expect(ww!.b).toBe('Tagger')

    // A read-write conflict on burning between Burn (writes) and Move (reads).
    const rw = plan.conflicts.find((c) => c.kind === 'read-write' && c.on === 'burning')
    expect(rw).toBeDefined()

    // Tagger reads Label's object field, so it can't run on a worker thread — it's kept on the
    // main thread, and the plan gives the reason as 'rich-fields'.
    const pin = plan.pinned.find((p) => p.system === 'Tagger')
    expect(pin).toBeDefined()
    expect(pin!.reason).toBe('rich-fields')
  })

  test('renderers produce non-empty strings over the data layer', () => {
    expect(reportText).toContain('Components')
    expect(reportText).toContain('health')
    expect(planText).toContain('wave 0')
    expect(planText).toContain('Conflicts')
  })
})
