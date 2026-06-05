// Example: a scene-graph hierarchy. A `ChildOf` EXCLUSIVE relation (one parent per node) wires the
// tree; a transform-propagation pass walks nodes in depth order so a child's
// world transform = parent world transform ∘ local transform. Demonstrates the first-class relations
// runtime (createRelations), exclusive-relation re-target without archetype churn, depthOf, and
// targetsOf for parent resolution — all through the ecsia umbrella.

import { createWorld, defineComponent, createRelations } from 'ecsia'
import type { EntityHandle } from 'ecsia'

export interface SceneNodeSpec {
  readonly local: { x: number; y: number }
  /** Index (into the spec array) of this node's parent, or null for a root. Must be < own index. */
  readonly parent: number | null
}

export interface SceneGraphOptions {
  /** The node specs, in an order where every parent precedes its children. */
  readonly nodes?: readonly SceneNodeSpec[]
}

export interface SceneNodeResult {
  readonly handle: number
  readonly depth: number
  readonly world: { x: number; y: number }
}

export interface SceneGraphResult {
  readonly nodes: ReadonlyArray<SceneNodeResult>
  /** Max depth observed (root = 0). */
  readonly maxDepth: number
}

const DEFAULT_NODES: readonly SceneNodeSpec[] = [
  { local: { x: 10, y: 0 }, parent: null }, // 0 root
  { local: { x: 5, y: 0 }, parent: 0 }, //    1 child of root
  { local: { x: 0, y: 3 }, parent: 1 }, //    2 grandchild
  { local: { x: -2, y: 0 }, parent: 0 }, //   3 second child of root
  { local: { x: 1, y: 1 }, parent: 2 }, //    4 great-grandchild
]

export function main(opts: SceneGraphOptions = {}): SceneGraphResult {
  const specs = opts.nodes ?? DEFAULT_NODES

  // Per-call defs: component ids are world-scoped, so a fresh main() gets fresh registrations.
  const LocalTransform = defineComponent({ x: 'f32', y: 'f32' }, { name: 'local' })
  const WorldTransform = defineComponent({ x: 'f32', y: 'f32' }, { name: 'world' })

  const world = createWorld({ components: [LocalTransform, WorldTransform], maxEntities: 1 << 16 })
  const rel = createRelations(world)
  // Exclusive: a node has at most one parent; re-parenting is an in-place eid write, no migration.
  const ChildOf = rel.defineRelation(null, { exclusive: true })

  const handles: EntityHandle[] = []
  for (const spec of specs) {
    // Value-carrying spawn: initialize LocalTransform inline; WorldTransform stays membership-only (it
    // is computed by the propagation pass below).
    handles.push(world.spawnWith([LocalTransform, { x: spec.local.x, y: spec.local.y }], WorldTransform))
  }
  for (let i = 0; i < specs.length; i++) {
    const parent = specs[i]!.parent
    if (parent !== null) rel.addPair(handles[i]!, ChildOf, handles[parent]!)
  }

  // Propagate transforms in depth order: a node's world transform needs its parent's already computed,
  // so we sort by depthOf (root depth 0) before composing. depthOf walks the exclusive parent chain.
  const order = handles
    .map((h, i) => ({ h, i, depth: rel.depthOf(h, ChildOf) }))
    .sort((a, b) => a.depth - b.depth)

  let maxDepth = 0
  for (const { h, depth } of order) {
    if (depth > maxDepth) maxDepth = depth

    // The EntityRef + its accessors are pooled per-world: a later world.entity()
    // call rebinds the SAME singleton to a new row, and the stale-ref guard now THROWS if you read a
    // ref after it rebound. So resolve every input to PLAIN NUMBERS before binding the next view —
    // never hold two live accessors across a world.entity() call.
    const lt = world.entity(h).read(LocalTransform)
    const lx = lt.x
    const ly = lt.y

    let parentHandle: EntityHandle | undefined
    for (const t of rel.targetsOf(h, ChildOf)) {
      parentHandle = t
      break
    }
    let baseX = 0
    let baseY = 0
    if (parentHandle !== undefined) {
      const pw = world.entity(parentHandle).read(WorldTransform)
      baseX = pw.x
      baseY = pw.y
    }

    const wt = world.entity(h).write(WorldTransform)
    wt.x = baseX + lx
    wt.y = baseY + ly
  }

  const nodes: SceneNodeResult[] = handles.map((h) => {
    const wt = world.entity(h).read(WorldTransform)
    return { handle: h as number, depth: rel.depthOf(h, ChildOf), world: { x: wt.x, y: wt.y } }
  })

  return { nodes, maxDepth }
}
