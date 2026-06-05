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
import { createWorld, defineComponent, defineTag, has, object, onAdd, onRemove, read, staticString, vec2, without } from '@ecsia/core'
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

  it('re-parenting: addPair(B, IsA, A) after instances exist affects FUTURE spawns only', () => {
    const { world, rel, Health } = makeKit()
    const a = rel.definePrefab([Health, { hp: 1 }])
    const b = rel.definePrefab([Health, { hp: 2 }])
    const before = rel.spawnFrom(b)
    rel.addPair(b, rel.IsA, a)
    const after = rel.spawnFrom(b)

    expect(rel.hasPair(before, rel.IsA, a)).toBe(false) // the stamp is immutable
    expect(rel.hasPair(before, rel.IsA, b)).toBe(true)
    expect(rel.hasPair(after, rel.IsA, a)).toBe(true) // the new ancestor records going forward
    expect(rel.hasPair(after, rel.IsA, b)).toBe(true)

    const ofA: number[] = []
    world.query(rel.Pair(rel.IsA, a)).each((m) => ofA.push(m.handle as number))
    expect(ofA).toEqual([after as number])
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
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('live subject'))
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

  it('spawnFrom on a live NON-prefab entity throws in dev (same discipline as definePrefab extends)', () => {
    const { world, rel, Health } = makeKit()
    const plain = world.spawnWith([Health, { hp: 5 }])
    expect(() => rel.spawnFrom(plain)).toThrow(/not a Prefab-tagged/)
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

describe('prefabs — cold archetypes (the copy path must resolve cold rows)', () => {
  it('maxHotArchetypes: 1 — definePrefab + spawnFrom copy values through cold blocks, not zeros', () => {
    const Health = defineComponent({ hp: 'i32', regen: 'f32' }, { name: 'health' })
    const world = createWorld({ prefabs: true, components: [Health], maxHotArchetypes: 1 })
    const rel = createRelations(world)
    // Only EMPTY is hot: the template's archetype AND the instance's archetype are both cold.
    const goblin = rel.definePrefab([Health, { hp: 35, regen: 0.5 }])
    const e = rel.spawnFrom(goblin)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(35)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0.5)
  })

  it('maxHotArchetypes: 1 — definePrefab({ extends }) flattens a COLD base template correctly', () => {
    const Health = defineComponent({ hp: 'i32', regen: 'f32' }, { name: 'health' })
    const Attack = defineComponent({ dmg: 'i32' }, { name: 'attack' })
    const world = createWorld({ prefabs: true, components: [Health, Attack], maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const goblin = rel.definePrefab([Health, { hp: 35, regen: 0.5 }], [Attack, { dmg: 10 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }])
    const e = rel.spawnFrom(boss)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(200) // child wins
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0.5) // base survives the cold flatten
    expect((world.entity(e).read(Attack) as { dmg: number }).dmg).toBe(10)
  })

  it('maxHotArchetypes: 2 — a HOT template copies into a COLD instance archetype (mixed chain)', () => {
    const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
    const world = createWorld({ prefabs: true, components: [Health], maxHotArchetypes: 2 })
    const rel = createRelations(world)
    // Creation order: EMPTY (hot) → [Health, Prefab] for goblin (hot) → everything after is cold.
    const goblin = rel.definePrefab([Health, { hp: 35 }])
    const boss = rel.definePrefab({ extends: goblin }, [Health, { hp: 200 }]) // cold, flattened from hot
    const i1 = rel.spawnFrom(goblin) // cold instance, hot source
    const i2 = rel.spawnFrom(boss) // cold instance, cold source
    expect((world.entity(i1).read(Health) as { hp: number }).hp).toBe(35)
    expect((world.entity(i2).read(Health) as { hp: number }).hp).toBe(200)
  })

  it('a rich+numeric mixed component on a cold archetype copies both legs', () => {
    const Mixed = defineComponent({ hp: 'i32', label: 'string' }, { name: 'mixed' })
    const world = createWorld({ prefabs: true, components: [Mixed], maxHotArchetypes: 1 })
    const rel = createRelations(world)
    const p = rel.definePrefab([Mixed, { hp: 7, label: 'goblin' }])
    const e = rel.spawnFrom(p)
    expect((world.entity(e).read(Mixed) as { hp: number; label: string }).hp).toBe(7) // numeric leg (cold column)
    expect((world.entity(e).read(Mixed) as { hp: number; label: string }).label).toBe('goblin') // rich leg (sidecar)
  })
})

describe('prefabs — spawnFrom inside an observer handler stages to the deferred buffer', () => {
  it('inside onAdd: the handle is reserved-alive immediately; the build applies at the next flush and matches a direct spawnFrom', () => {
    const { world, rel, Health, Hostile } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35, regen: 0.5 }])

    let staged: EntityHandle | null = null
    let aliveInHandler = false
    let placedInHandler = true
    world.observe(onAdd(Hostile), () => {
      staged = rel.spawnFrom(goblin, [Health, { hp: 50 }])
      aliveInHandler = world.isAlive(staged)
      placedInHandler = world.has(staged, Health)
    })

    world.spawnWith(Hostile)
    world.observerDrain() // the handler fires; its spawnFrom stages
    expect(aliveInHandler).toBe(true) // usable handle returned mid-drain
    expect(placedInHandler).toBe(false) // …but NOT placed mid-drain
    expect(world.has(staged as unknown as EntityHandle, Health)).toBe(false) // still staged after the drain

    world.frameReset()
    world.observerDrain() // the next serial flush applies the staged build
    const e = staged as unknown as EntityHandle
    expect(world.has(e, Health)).toBe(true)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(50)
    expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0.5)
    expect(rel.hasPair(e, rel.IsA, goblin)).toBe(true)

    // Post-drain state matches an equivalent direct spawnFrom: same archetype, same field state.
    const direct = rel.spawnFrom(goblin, [Health, { hp: 50 }])
    expect(archOf(world, e as number)).toBe(archOf(world, direct as number))
    expect((world.entity(direct).read(Health) as { hp: number; regen: number }).hp).toBe(50)
  })

  it('inside onRemove: likewise staged; the instance materializes at the next flush', () => {
    const { world, rel, Health, Hostile } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])

    let staged: EntityHandle | null = null
    world.observe(onRemove(Hostile), () => {
      staged = rel.spawnFrom(goblin)
    })

    const victim = world.spawnWith(Hostile)
    world.observerDrain() // flush the spawn's add events; nothing staged yet
    world.frameReset()
    world.despawn(victim)
    world.observerDrain() // onRemove fires; its spawnFrom stages
    expect(staged).not.toBeNull()
    expect(world.has(staged as unknown as EntityHandle, Health)).toBe(false)

    world.frameReset()
    world.observerDrain()
    const e = staged as unknown as EntityHandle
    expect((world.entity(e).read(Health) as { hp: number }).hp).toBe(35)
    expect(rel.hasPair(e, rel.IsA, goblin)).toBe(true)
  })

  it('staged despawn(prefab) before a staged spawnFrom in ONE drain: defaulted values, NO IsA edge, dev warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { world, rel, Health, Hostile } = makeKit()
      const goblin = rel.definePrefab([Health, { hp: 35, regen: 0.5 }])

      let staged: EntityHandle | null = null
      world.observe(onAdd(Hostile), () => {
        world.despawn(goblin) // stages; goblin is still alive for the rest of the handler
        staged = rel.spawnFrom(goblin) // passes the liveness check, stages the build
      })

      world.spawnWith(Hostile)
      world.observerDrain()
      world.frameReset()
      world.observerDrain() // flush FIFO: the despawn applies first, the build sees a dead source

      const e = staged as unknown as EntityHandle
      expect(world.isAlive(e)).toBe(true)
      expect(world.has(e, Health)).toBe(true) // the component set still attaches…
      expect((world.entity(e).read(Health) as { hp: number; regen: number }).hp).toBe(0) // …with defaulted values
      expect((world.entity(e).read(Health) as { hp: number; regen: number }).regen).toBe(0)
      expect(rel.hasRelation(e, rel.IsA)).toBe(false) // the dead ancestor's pair is dropped
      expect(world.query(rel.Pair(rel.IsA, Wildcard)).count).toBe(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`prefab ${goblin as number}`))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEFAULTED'))
    } finally {
      warn.mockRestore()
    }
  })

  it('staged despawn of an ANCESTOR (source survives): values copy, only the dead Pair(IsA, …) drops, dev warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { world, rel, Health, Hostile } = makeKit()
      const monster = rel.definePrefab([Health, { hp: 10 }])
      const goblin = rel.definePrefab({ extends: monster }, [Health, { hp: 35 }])

      let staged: EntityHandle | null = null
      world.observe(onAdd(Hostile), () => {
        world.despawn(monster)
        staged = rel.spawnFrom(goblin)
      })

      world.spawnWith(Hostile)
      world.observerDrain()
      world.frameReset()
      world.observerDrain()

      const e = staged as unknown as EntityHandle
      expect((world.entity(e).read(Health) as { hp: number }).hp).toBe(35) // the live source still copies
      expect(rel.hasPair(e, rel.IsA, goblin)).toBe(true)
      expect(rel.hasRelation(e, rel.IsA)).toBe(true)
      expect([...rel.targetsOf(e, rel.IsA)]).toEqual([goblin]) // the dead ancestor's pair is dropped
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`ancestor prefab ${monster as number}`))
    } finally {
      warn.mockRestore()
    }
  })

  it('staged spawnFrom then staged despawn of the SAME reserved handle in one drain: clean pair bookkeeping', () => {
    const { world, rel, Health, Hostile } = makeKit()
    const goblin = rel.definePrefab([Health, { hp: 35 }])

    world.observe(onAdd(Hostile), () => {
      const e = rel.spawnFrom(goblin)
      world.despawn(e) // stages AFTER the build — the instance lives for exactly one flush step
    })

    world.spawnWith(Hostile)
    world.observerDrain()
    world.frameReset()
    world.observerDrain() // flush: the build materializes the instance, the despawn tears it down

    expect(world.query(rel.Pair(rel.IsA, Wildcard)).count).toBe(0)
    expect([...rel.subjectsOf(rel.IsA, goblin)]).toEqual([]) // back-ref bucket reclaimed
    // The pair id was refcounted down: a later query sees ONLY fresh instances.
    const fresh = rel.spawnFrom(goblin)
    const matched: number[] = []
    world.query(rel.Pair(rel.IsA, goblin)).each((m) => matched.push(m.handle as number))
    expect(matched).toEqual([fresh as number])
  })
})

describe('prefabs — mid-drain chained definePrefab → spawnFrom dev errors', () => {
  it('inside ONE handler: the error says the staged prefab materializes at the next flush', () => {
    const { world, rel, Health, Hostile } = makeKit()
    let spawnMsg = ''
    let extendMsg = ''
    world.observe(onAdd(Hostile), () => {
      const p = rel.definePrefab([Health, { hp: 35 }])
      try {
        rel.spawnFrom(p)
      } catch (err) {
        spawnMsg = (err as Error).message
      }
      try {
        rel.definePrefab({ extends: p })
      } catch (err) {
        extendMsg = (err as Error).message
      }
    })
    world.spawnWith(Hostile)
    world.observerDrain()
    expect(spawnMsg).toMatch(/materializes at the next observer flush/)
    expect(spawnMsg).not.toMatch(/not a Prefab-tagged/)
    expect(extendMsg).toMatch(/materializes at the next observer flush/)
    expect(extendMsg).not.toMatch(/not a Prefab-tagged/)
  })

  it('after the drain but BEFORE the flush: same staged-prefab error; genuinely untagged keeps the old message', () => {
    const { world, rel, Health, Hostile } = makeKit()
    let p: EntityHandle | null = null
    world.observe(onAdd(Hostile), () => {
      p = rel.definePrefab([Health, { hp: 1 }])
    })
    world.spawnWith(Hostile)
    world.observerDrain() // the define is still staged — its flush is pending
    expect(() => rel.spawnFrom(p as unknown as EntityHandle)).toThrow(/materializes at the next observer flush/)
    // A live non-prefab entity keeps the untagged message even while a flush is pending.
    const plain = world.spawnWith([Health, { hp: 5 }])
    expect(() => rel.spawnFrom(plain)).toThrow(/not a Prefab-tagged/)
  })
})
