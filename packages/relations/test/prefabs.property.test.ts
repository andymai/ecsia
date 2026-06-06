// prefabs — PROPERTY suite (fast-check). The load-bearing equivalence from
// isa-prefabs.md: for random component sets, inheritance chains, and override subsets,
//
//   spawnFrom(P, overrides) ≡ spawnWith(flattenedInits ⊕ overrides) + the IsA pair set
//
// with the final per-field state identical (Object.is — both paths cross the same f32/i32
// columns, so byte-identical column state ⟺ identical reads). The ORACLE flattens the chain
// independently (a plain JS object fold, root → leaf, overrides last) — it would catch a copy
// that drops a field, applies overrides before the copy, or breaks chain precedence.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent } from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'
import { createRelations } from '../src/index.js'

interface LevelSpec {
  // Per component: undefined = not declared at this level; otherwise the partial field values.
  a?: { x?: number; y?: number }
  b?: { dmg?: number }
  c?: { t?: number } // index into the shared target pool (eid field)
}

const partialA = fc.record({ x: fc.float({ noNaN: true }), y: fc.integer() }, { requiredKeys: [] })
const partialB = fc.record({ dmg: fc.integer() }, { requiredKeys: [] })
const partialC = fc.record({ t: fc.integer({ min: 0, max: 2 }) }, { requiredKeys: [] })
const levelArb: fc.Arbitrary<LevelSpec> = fc.record({ a: partialA, b: partialB, c: partialC }, { requiredKeys: [] })

describe('PROP-PREFAB spawnFrom == spawnWith(flattened ⊕ overrides) + IsA pairs', { timeout: 60_000 }, () => {
  it('holds for random chains (depth 1..4) and random override subsets', () => {
    fc.assert(
      fc.property(
        fc.array(levelArb, { minLength: 1, maxLength: 4 }), // the chain, root first
        levelArb, // the spawn-time overrides
        (chain, overrides) => {
          const A = defineComponent({ x: 'f32', y: 'i32' }, { name: 'A' })
          const B = defineComponent({ dmg: 'i32' }, { name: 'B' })
          const C = defineComponent({ t: 'eid' }, { name: 'C' })
          const world = createWorld({ prefabs: true, components: [A, B, C], maxEntities: 1 << 12 })
          const rel = createRelations(world)
          const pool = [world.spawn(), world.spawn(), world.spawn()]

          const initsOf = (level: LevelSpec): (readonly [ComponentDef<Schema>, Record<string, unknown>])[] => {
            const out: (readonly [ComponentDef<Schema>, Record<string, unknown>])[] = []
            if (level.a !== undefined) out.push([A, level.a])
            if (level.b !== undefined) out.push([B, level.b])
            if (level.c !== undefined && level.c.t !== undefined) out.push([C, { t: pool[level.c.t] }])
            return out
          }

          // Build the chain through the API…
          const prefabs: EntityHandle[] = []
          for (let i = 0; i < chain.length; i++) {
            const inits = initsOf(chain[i] as LevelSpec)
            prefabs.push(
              i === 0
                ? rel.definePrefab(...(inits as never[]))
                : rel.definePrefab({ extends: prefabs[i - 1] as EntityHandle }, ...(inits as never[])),
            )
          }
          const leaf = prefabs[prefabs.length - 1] as EntityHandle

          // …and flatten it independently: a plain object fold, root → leaf, overrides last.
          const flat = new Map<ComponentDef<Schema>, Record<string, unknown>>()
          for (const level of [...chain, overrides]) {
            for (const [def, vals] of initsOf(level)) {
              flat.set(def, { ...(flat.get(def) ?? {}), ...vals })
            }
          }

          const instance = rel.spawnFrom(leaf, ...(initsOf(overrides) as never[]))
          const oracle = world.spawnWith(...([...flat.entries()] as never[]))

          // Field-state equivalence over every component either path declared.
          for (const [def] of flat) {
            expect(world.has(instance, def)).toBe(true)
            expect(world.has(oracle, def)).toBe(true)
            const got = world.entity(instance).read(def) as Record<string, unknown>
            const want = world.entity(oracle).read(def) as Record<string, unknown>
            for (const field of Object.keys(def.schema)) {
              expect(Object.is(got[field], want[field]), `${def.name}.${field}`).toBe(true)
            }
          }

          // …plus the IsA pair set: one pair per ancestor, nothing else distinguishes them.
          for (const p of prefabs) expect(rel.hasPair(instance, rel.IsA, p)).toBe(true)
          expect(rel.hasRelation(oracle, rel.IsA)).toBe(false)

          // EXACT-signature oracle: instance signature = oracle signature ∪ {one IsA pair per
          // ancestor + the IsA presence bit} and NOTHING else — no surplus state (no Prefab tag,
          // no extra pairs, no stray components).
          const sigOf = (h: EntityHandle): readonly number[] => {
            const archId = (world.entity(h) as unknown as { __archetypeId: number }).__archetypeId
            const arch = world.__inspect.archetypes().find((x) => x.id === archId)
            return (arch?.signature ?? []) as unknown as readonly number[]
          }
          const instSig = new Set<number>(sigOf(instance))
          const oracleSig = sigOf(oracle)
          for (const c of oracleSig) expect(instSig.has(c)).toBe(true)
          // |instance| − |oracle| = chain length (one pair per ancestor) + 1 (IsA presence): the
          // exact IsA pair count, with zero room for surplus bits.
          expect(instSig.size).toBe(oracleSig.length + prefabs.length + 1)
          expect(world.has(instance, rel.Prefab)).toBe(false)
        },
      ),
      { numRuns: 40 },
    )
  })
})
