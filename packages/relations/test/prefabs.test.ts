// IsA inheritance + prefabs unit suite (isa-prefabs.md). Exercises the full
// createWorld({ prefabs: true }) + createRelations(world) surface end to end:
//
// copy semantics: spawnFrom value equality vs the prefab (numeric / vec / staticString /
// eid-verbatim / rich), prefab edits affect FUTURE spawns only.
// override precedence: chain flatten (leaf wins) < spawnFrom overrides; component-adding
// overrides change shape.
// transitive IsA: the full ancestor pair set on every instance; Pair(IsA, Wildcard); visited-set
// termination (+ dev warn) on a manually-created IsA cycle.
// default query exclusion: query(Position) never yields a template; has(Prefab) yields only
// templates; { matchPrefabs: true } yields both; the canonical hash distinguishes the three.
// lifecycle: despawning a prefab leaves instances intact minus the IsA edge (P4), with a dev
// warn; spawnFrom on a dead handle throws in dev.
// archetype accounting: N same-shape instances share ONE archetype; subtypes get their own.

import { describe, it, expect, vi } from 'vitest'
import { createWorld, defineComponent, defineTag, has, object, read, staticString, vec2, without } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations, Wildcard } from '../src/index.js'

function makeKit() {
  const Health = defineComponent({ hp: 'i32', regen: 'f32' }, { name: 'health' })
  const Attack = defineComponent({ dmg: 'i32' }, { name: 'attack' })
  const Position = defineComponent({ v: vec2() }, { name: 'position' })
  const Faction = defineComponent({ side: staticString('friend', 'foe') }, { name: 'faction' })
  const Leader = defineComponent({ target: 'eid' }, { name: 'leader' })
  const BossAura = defineComponent({ radius: 'f32' }, { name: 'bossAura' })
  const Hostile = defineTag('hostile')
  const components = [Health, Attack, Position, Faction, Leader, BossAura, Hostile] as readonly ComponentDef<Schema>[]
  const world = createWorld({ prefabs: true, components })
  const rel = createRelations(world)
  return { world, rel, Health, Attack, Position, Faction, Leader, BossAura, Hostile }
}

function archOf(world: ReturnType<typeof createWorld>, handle: number): number {
  return (world.entity(handle as never) as unknown as { __archetypeId: number }).__archetypeId
}

describe('prefabs — copy semantics', () => {
  it('spawnFrom copies the prefab values: numeric, vec, staticString, and eid verbatim', () => {
    const { world, rel, Health, Position, Faction, Leader } = makeKit()
    const captain = world.spawn()
    const goblin = rel.definePrefab(
      [Health, { hp: 35, regen: 0.5 }],
      [Faction, { side: 'foe' }],
      [Leader, { target: captain }],
      Position,
    )
    ;(world.entity(goblin).write(Position) as { v: { x: number; y: number } }).v.x = 3
    ;(world.entity(goblin).write(Position) as { v: { x: number; y: number } }).v.y = 4

    const e = rel.spawnFrom(goblin)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(35)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0.5)
    expect((world.entity(e).read(Faction) as { side: string }).side).toBe('foe')
    expect((world.entity(e).read(Position) as { v: { x: number; y: number } }).v.x).toBe(3)
    expect((world.entity(e).read(Position) as { v: { x: number; y: number } }).v.y).toBe(4)
    // eid copies VERBATIM: every instance aliases the SAME target the prefab pointed at.
    expect((world.entity(e).read(Leader) as { target: EntityHandle }).target as number).toBe(captain as number)
  })

  it('editing a prefab after spawning affects FUTURE spawns only (copy, not fall-through)', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const before = rel.spawnFrom(goblin)
    ;(world.entity(goblin).write(Health) as { hp: number }).hp = 99
    const after = rel.spawnFrom(goblin)
    expect((world.entity(before).read(Health) as { hp: number }).hp).toBe(35)
    expect((world.entity(after).read(Health) as { hp: number }).hp).toBe(99)
  })

  it("rich fields: 'string' copies the value; object<T> copies the REFERENCE with a dev warn", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const Named = defineComponent({ label: 'string' }, { name: 'named' })
      const Bag = defineComponent({ data: object<{ n: number }>() }, { name: 'bag' })
      const world = createWorld({ prefabs: true, components: [Named, Bag] })
      const rel = createRelations(world)
      const shared = { n: 7 }
      const p = rel.definePrefab([Named, { label: 'goblin' }], [Bag, { data: shared }])
      const e = rel.spawnFrom(p)
      expect((world.entity(e).read(Named) as { label: string }).label).toBe('goblin')
      expect((world.entity(e).read(Bag) as { data: { n: number } }).data).toBe(shared)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('by REFERENCE'))
    } finally {
      warn.mockRestore()
    }
  })

  it("the prefab's own non-IsA relation pairs are NOT copied onto instances", () => {
    const { world, rel, Health } = makeKit()
    const Guards = rel.defineRelation(null)
    const castle = world.spawn()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    rel.addPair(goblin, Guards, castle)
    const e = rel.spawnFrom(goblin)
    expect(rel.hasPair(goblin, Guards, castle)).toBe(true)
    expect(rel.hasPair(e, Guards, castle)).toBe(false)
    expect(rel.hasRelation(e, Guards)).toBe(false)
  })
})

describe('prefabs — inheritance chains & override precedence', () => {
  it('flatten at define time: the child wins per overlapping component, base fields survive', () => {
    const { world, rel, Health, Attack, BossAura } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35, regen: 0.5 }], [Attack, { dmg: 10 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }], [BossAura, { radius: 8 }])

    const e = rel.spawnFrom(boss)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(200) // child wins
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0.5) // base survives
    expect((world.entity(e).read(Attack) as { dmg: number }).dmg).toBe(10) // inherited
    expect((world.entity(e).read(BossAura) as { radius: number }).radius).toBe(8) // addition
  })

  it('spawnFrom overrides beat the whole chain; component-adding overrides change shape', () => {
    const { world, rel, Health, Attack, Hostile } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }])

    const plain = rel.spawnFrom(boss)
    const overridden = rel.spawnFrom(boss, [Health, { hp: 250 }])
    const reshaped = rel.spawnFrom(boss, [Attack, { dmg: 99 }], Hostile)

    expect((world.entity(overridden).read(Health) as { hp: number }).hp).toBe(250)
    // Value-only overrides keep the shape: one archetype for both.
    expect(archOf(world, overridden as number)).toBe(archOf(world, plain as number))
    // Component-adding overrides change the shape.
    expect(archOf(world, reshaped as number)).not.toBe(archOf(world, plain as number))
    expect((world.entity(reshaped).read(Health) as { hp: number }).hp).toBe(200)
    expect((world.entity(reshaped).read(Attack) as { dmg: number }).dmg).toBe(99)
    expect(world.has(reshaped, Hostile)).toBe(true)
  })

  it('transitive IsA recording: an instance carries one pair per ANCESTOR, queryable per level', () => {
    const { world, rel, Health } = makeKit()
    const monster = rel.definePrefab([Health, { hp: 10 }])
    const goblin = rel.definePrefab({ extends: monster }, [Health, { hp: 35 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }])

    const e = rel.spawnFrom(boss)
    expect(rel.hasPair(e, rel.IsA, boss)).toBe(true)
    expect(rel.hasPair(e, rel.IsA, goblin)).toBe(true)
    expect(rel.hasPair(e, rel.IsA, monster)).toBe(true)

    const g = rel.spawnFrom(goblin)
    const monsters: number[] = []
    world.query(rel.Pair(rel.IsA, monster)).each((m) => monsters.push(m.handle as number))
    expect(monsters.sort()).toEqual([e as number, g as number].sort())
    const goblins: number[] = []
    world.query(rel.Pair(rel.IsA, goblin)).each((m) => goblins.push(m.handle as number))
    expect(goblins.sort()).toEqual([e as number, g as number].sort())
    const bosses: number[] = []
    world.query(rel.Pair(rel.IsA, boss)).each((m) => bosses.push(m.handle as number))
    expect(bosses).toEqual([e as number])
  })

  it('Pair(IsA, Wildcard) matches every instance — and never a template (default exclusion)', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }])
    const i1 = rel.spawnFrom(goblin)
    const i2 = rel.spawnFrom(boss)

    const matched: number[] = []
    world.query(rel.Pair(rel.IsA, Wildcard)).each((m) => matched.push(m.handle as number))
    // The boss TEMPLATE also carries an IsA pair, but it is Prefab-tagged → excluded.
    expect(matched.sort()).toEqual([i1 as number, i2 as number].sort())
  })

  it('a manually-created IsA cycle terminates the ancestor walk (visited set) with a dev warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { rel, Health } = makeKit()
      const a = rel.definePrefab([Health, { hp: 1 }])
      const b = rel.definePrefab([Health, { hp: 2 }])
      rel.addPair(a, rel.IsA, b) // raw tag pairs carry no copy semantics…
      rel.addPair(b, rel.IsA, a) // …and can form a malformed cycle
      const e = rel.spawnFrom(a)
      expect(rel.hasPair(e, rel.IsA, a)).toBe(true)
      expect(rel.hasPair(e, rel.IsA, b)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('IsA cycle'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('prefabs — default query exclusion', () => {
  it('query(Position) never yields a template; has(Prefab) yields only templates; matchPrefabs yields both', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const instance = rel.spawnFrom(goblin)
    const plain = world.spawnWith([Health, { hp: 1 }])

    const normal: number[] = []
    world.query(read(Health)).each((m) => normal.push(m.handle as number))
    expect(normal.sort()).toEqual([instance as number, plain as number].sort())

    const templates: number[] = []
    world.query(has(rel.Prefab)).each((m) => templates.push(m.handle as number))
    expect(templates).toEqual([goblin as number])

    const both: number[] = []
    world.query(read(Health), { matchPrefabs: true }).each((m) => both.push(m.handle as number))
    expect(both.sort()).toEqual([goblin as number, instance as number, plain as number].sort())
  })

  it('the canonical hash distinguishes the trio (and dedups an explicit without(Prefab))', () => {
    const { world, rel, Health } = makeKit()
    const normal = world.query(read(Health))
    const matchAll = world.query(read(Health), { matchPrefabs: true })
    const templated = world.query(read(Health), has(rel.Prefab))
    expect(normal).not.toBe(matchAll)
    expect(normal).not.toBe(templated)
    expect(matchAll).not.toBe(templated)
    // Cache hits: same forms share one LiveQuery; an explicit without(Prefab) IS the default form.
    expect(world.query(read(Health))).toBe(normal)
    expect(world.query(read(Health), { matchPrefabs: true })).toBe(matchAll)
    expect(world.query(read(Health), without(rel.Prefab))).toBe(normal)
  })

  it('exclusion is incremental: tagging a live entity Prefab evicts it from matching queries', () => {
    const { world, rel, Health } = makeKit()
    const q = world.query(read(Health))
    const e = world.spawnWith([Health, { hp: 5 }])
    expect(q.count).toBe(1)
    world.add(e, rel.Prefab)
    expect(q.count).toBe(0)
    world.remove(e, rel.Prefab)
    expect(q.count).toBe(1)
  })

  it('a world without prefabs ignores matchPrefabs and has no built-ins', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ components: [Health] })
    const rel = createRelations(world)
    expect(() => rel.IsA).toThrow(/prefabs: true/)
    expect(() => rel.Prefab).toThrow(/prefabs: true/)
    expect(() => rel.definePrefab([Health, { hp: 1 }])).toThrow(/prefabs: true/)
    const e = world.spawnWith([Health, { hp: 1 }])
    // matchPrefabs is a no-op: same constraint, same LiveQuery.
    expect(world.query(read(Health), { matchPrefabs: true })).toBe(world.query(read(Health)))
    expect(world.query(read(Health)).count).toBe(1)
    expect(world.isAlive(e)).toBe(true)
  })
})

describe('prefabs — lifecycle & archetype accounting', () => {
  it('despawning a prefab: instances keep data, IsA edges removed (P4), dev warn on live instances', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { world, rel, Health } = makeKit()
      const goblin = rel.definePrefab([Health, { hp: 35 }])
      const e = rel.spawnFrom(goblin)
      const isaQuery = world.query(rel.Pair(rel.IsA, Wildcard))
      expect(isaQuery.count).toBe(1)

      world.despawn(goblin)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('live instance'))
      expect(world.isAlive(e)).toBe(true)
      expect((world.entity(e).read(Health) as { hp: number }).hp).toBe(35) // data survives
      expect(rel.hasRelation(e, rel.IsA)).toBe(false) // the edge does not
      expect(isaQuery.count).toBe(0)
      // P8: the prefab's back-ref bucket was reclaimed — a fresh entity recycling the slot must
      // not alias the dead prefab's instances.
      const fresh = world.spawn()
      expect([...rel.subjectsOf(rel.IsA, fresh)]).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('despawning a prefab with NO instances does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { world, rel, Health } = makeKit()
      const goblin = rel.definePrefab([Health, { hp: 35 }])
      world.despawn(goblin)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('spawnFrom on a dead prefab handle throws in dev', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    world.despawn(goblin)
    expect(() => rel.spawnFrom(goblin)).toThrow(/dead/)
  })

  it('definePrefab({ extends }) with a dead base throws in dev', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    world.despawn(goblin)
    expect(() => rel.definePrefab({ extends: goblin }, [Health, { hp: 1 }])).toThrow(/despawned/)
  })

  it('definePrefab({ extends }) with a non-prefab entity throws in dev', () => {
    const { world, rel, Health } = makeKit()
    const plain = world.spawnWith([Health, { hp: 5 }])
    expect(() => rel.definePrefab({ extends: plain }, [Health, { hp: 1 }])).toThrow(/not a Prefab-tagged/)
  })

  it('N instances of one prefab land in ONE archetype; subtypes occupy a distinct one', () => {
    const { world, rel, Health } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }])

    const instances = Array.from({ length: 50 }, () => rel.spawnFrom(goblin))
    const overridden = rel.spawnFrom(goblin, [Health, { hp: 1 }]) // value-only: same shape
    const first = archOf(world, instances[0] as number)
    for (const i of instances) expect(archOf(world, i as number)).toBe(first)
    expect(archOf(world, overridden as number)).toBe(first)

    // Boss instances carry a different IsA pair set → a different archetype.
    const b = rel.spawnFrom(boss)
    expect(archOf(world, b as number)).not.toBe(first)
    // …and the templates never share an archetype with their instances (the Prefab bit).
    expect(archOf(world, goblin as number)).not.toBe(first)
  })
})
