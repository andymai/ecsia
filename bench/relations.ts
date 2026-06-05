// Relation-query micro-bench (ecsia-only — first-class integer pairs are an ecsia differentiator;
// miniplex/bitECS have no native relation primitive). Builds a star topology: N subjects each related
// to one of K targets via a non-exclusive `LinkedTo` relation, then times a wildcard subjectsOf walk
// (the O(1)-presence-bit wildcard path, relations.md P6) across all targets.

import { createWorld, defineComponent, createRelations } from '@ecsia/ecsia'
import type { EntityHandle } from '@ecsia/ecsia'

export interface RelCase {
  readonly name: string
  step(): void
  /** Total subjects visited in the last step (smoke-test observable). */
  visited(): number
}

export function makeEcsiaRelations(subjects: number, targets: number): RelCase {
  const Tag = defineComponent({ v: 'u32' }, { name: 'tag' })
  const world = createWorld({ components: [Tag], maxEntities: nextPow2(subjects + targets) })
  const rel = createRelations(world)
  const LinkedTo = rel.defineRelation(null, { exclusive: false })

  const targetHandles: EntityHandle[] = []
  for (let t = 0; t < targets; t++) targetHandles.push(world.spawnWith(Tag))
  for (let s = 0; s < subjects; s++) {
    const subj = world.spawnWith(Tag)
    rel.addPair(subj, LinkedTo, targetHandles[s % targets]!)
  }

  let lastVisited = 0
  return {
    name: 'ecsia-relations',
    step() {
      let count = 0
      for (const t of targetHandles) {
        for (const _ of rel.subjectsOf(LinkedTo, t)) count++
      }
      lastVisited = count
    },
    visited() {
      return lastVisited
    },
  }
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return Math.max(p, 1024)
}
