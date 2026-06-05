// inspectWorld (§1): the report must match a CONSTRUCTED world exactly. We spawn known entities with
// known components (incl. a rich-field component and a relation pair), then assert counts, signatures,
// byte math, the rich field listing, and the relation pairCount — all off the plain serializable report.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, defineTag, read, write, object } from '@ecsia/core'
import { createRelations } from '@ecsia/relations'
import { inspectWorld } from '../src/index.js'

describe('inspectWorld — report matches a constructed world exactly', () => {
  // Position: 2×f32 = 8 col bytes/row. Velocity: 2×f32 = 8. Frozen: tag (0 col bytes). Inventory: a
  // rich object<T> field 'items' (sidecar, 0 col bytes) + a plain i32 'gold' (4 col bytes).
  function build() {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const Frozen = defineTag('frozen')
    const Inventory = defineComponent({ gold: 'i32', items: object<string[]>() }, { name: 'inventory' })

    const world = createWorld({ components: [Position, Velocity, Frozen, Inventory], maxEntities: 2048 })
    const rel = createRelations(world)
    const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

    // 7 movers (Position+Velocity), 2 inventory holders (Position+Inventory), 1 frozen rock (Position+Frozen).
    const movers: number[] = []
    for (let i = 0; i < 7; i++) movers.push(world.spawnWith(Position, Velocity) as number)
    const holderA = world.spawnWith([Position, { x: 0, y: 0 }], [Inventory, { gold: 5 }]) as number
    const holderB = world.spawnWith([Position, { x: 1, y: 0 }], [Inventory, { gold: 9 }]) as number
    const rock = world.spawnWith(Position, Frozen) as number

    // One relation pair: holderB is a ChildOf holderA. Exactly one live pair.
    rel.addPair(holderB as never, ChildOf, holderA as never)

    // Compile a real query so the inspector enumerates it.
    const q = world.query(write(Position), read(Velocity))
    void q.count

    return { world, Position, Velocity, Inventory, movers, holderA, holderB, rock }
  }

  test('entity census reflects every spawn and the configured capacity', () => {
    const { world } = build()
    const r = inspectWorld(world)
    expect(r.entities.alive).toBe(10) // 7 movers + 2 holders + 1 rock
    expect(r.entities.capacity).toBe(2048)
  })

  test('component census: ids, field counts, byte math, and rich-field listing', () => {
    const { world } = build()
    const r = inspectWorld(world)

    // Every ComponentReport.name is a string, including the tag's (its brand is the string 'frozen').
    const byName = new Map(r.components.map((c) => [c.name, c]))
    expect([...byName.keys()].sort()).toEqual(['frozen', 'inventory', 'position', 'velocity'])
    const frozen = byName.get('frozen')!
    expect(frozen.name).toBe('frozen')

    const pos = byName.get('position')!
    expect(pos.fields).toBe(2)
    expect(pos.richFields).toEqual([]) // pure column component
    expect(pos.bytesPerRow).toBe(8) // 2 × f32
    // 10 live rows hold Position (7 movers + 2 holders + 1 rock).
    expect(pos.totalBytes).toBe(8 * 10)

    const vel = byName.get('velocity')!
    expect(vel.bytesPerRow).toBe(8)
    expect(vel.totalBytes).toBe(8 * 7) // only the 7 movers hold Velocity

    // Rich-field component: 'items' is sidecar (object<T>), 'gold' is a 4-byte column.
    const inv = byName.get('inventory')!
    expect(inv.fields).toBe(2)
    expect(inv.richFields).toEqual(['items']) // the rich field is listed by name
    expect(inv.bytesPerRow).toBe(4) // only the i32 gold contributes column bytes; items contributes 0
    expect(inv.totalBytes).toBe(4 * 2) // 2 holders

    // Tag carries no column bytes.
    const tag = byName.get('frozen')!
    expect(tag.bytesPerRow).toBe(0)
    expect(tag.totalBytes).toBe(0)
  })

  test('memory totals are positive and tie out to the per-component column bytes', () => {
    const { world } = build()
    const r = inspectWorld(world)

    expect(r.memory.columnsBytes).toBeGreaterThan(0)
    const summed = r.components.reduce((s, c) => s + c.totalBytes, 0)
    expect(r.memory.columnsBytes).toBe(summed)

    // Exactly one rich sidecar column registered: inventory.items.
    expect(r.memory.sidecarEntries).toBe(1)
  })

  test('archetype census carries readable signatures, exact counts, and hot/cold flags', () => {
    const { world } = build()
    const r = inspectWorld(world)

    for (const a of r.archetypes) expect(['hot', 'cold']).toContain(a.temperature)

    const movers = r.archetypes.find((a) => a.signature.includes('position') && a.signature.includes('velocity'))!
    expect(movers).toBeDefined()
    expect(movers.count).toBe(7)
    expect(movers.temperature).toBe('hot')

    // Both holders hold Inventory; adding the ChildOf pair attaches a synthetic presence id to holderB,
    // splitting the holders across two archetypes. Their counts sum to 2.
    const holderArches = r.archetypes.filter((a) => a.signature.includes('inventory'))
    expect(holderArches.reduce((s, a) => s + a.count, 0)).toBe(2)

    // Sum of live archetype counts equals the alive census.
    const liveRows = r.archetypes.reduce((s, a) => s + a.count, 0)
    expect(liveRows).toBe(r.entities.alive)
  })

  test('the compiled query is enumerated with rendered terms and an exact size', () => {
    const { world } = build()
    const r = inspectWorld(world)

    const q = r.queries.find((q) => q.terms.includes('write(position)') && q.terms.includes('read(velocity)'))!
    expect(q).toBeDefined()
    expect(q.size).toBe(7) // only the 7 movers hold both Position and Velocity
    expect(q.matchedArchetypes).toBeGreaterThanOrEqual(1)
  })

  test('the relation reports its live pair count', () => {
    const { world } = build()
    const r = inspectWorld(world)

    expect(r.relations.length).toBeGreaterThanOrEqual(1)
    const childOf = r.relations.find((rel) => rel.pairCount > 0)!
    expect(childOf).toBeDefined()
    expect(childOf.name).toBe('Relation0') // anonymous relations are named Relation<id>
    expect(childOf.pairCount).toBe(1) // exactly one ChildOf pair (holderB → holderA)
  })

  test('the report is plain + JSON-serializable (no live handles)', () => {
    const { world } = build()
    const r = inspectWorld(world)
    const round = JSON.parse(JSON.stringify(r))
    expect(round.entities.alive).toBe(10)
    expect(round.components.find((c: { name: string }) => c.name === 'inventory').richFields).toEqual(['items'])
  })

  test('relations report is empty when no relations runtime is attached', () => {
    const C = defineComponent({ v: 'i32' }, { name: 'c' })
    const world = createWorld({ components: [C] })
    expect(inspectWorld(world).relations).toEqual([])
  })
})
