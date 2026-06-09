// A scene graph: a tree of objects where each child's position is relative to its parent. A
// ChildOf exclusive relation (each entity can have at most one — i.e. one parent) wires the tree;
// a propagation pass walks nodes shallowest-first so each child's world position = its parent's
// world position + its own local offset. Demonstrates createRelations, depthOf, and targetsOf,
// all through the ecsia umbrella. The thing to notice: re-parenting is a cheap in-place write —
// entities never move between archetypes (the groups of entities sharing the same component set).

import { createWorld, defineComponent, createRelations } from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'

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

  // Component definitions get their id when registered with a world, so a fresh main() makes
  // fresh ones — that lets the example run repeatedly.
  const LocalTransform = defineComponent({ x: 'f32', y: 'f32' }, { name: 'local' })
  const WorldTransform = defineComponent({ x: 'f32', y: 'f32' }, { name: 'world' })

  const world = createWorld({ components: [LocalTransform, WorldTransform], maxEntities: 1 << 16 })
  const rel = createRelations(world)
  // Exclusive: a node has at most one parent. Re-parenting overwrites the link in place — no
  // storage migration.
  const ChildOf = rel.defineRelation(null, { exclusive: true })

  const handles: EntityHandle[] = []
  for (const spec of specs) {
    // spawnWith both creates the entity and fills in LocalTransform; WorldTransform is attached
    // empty — the propagation pass below computes it.
    handles.push(world.spawnWith([LocalTransform, { x: spec.local.x, y: spec.local.y }], WorldTransform))
  }
  for (let i = 0; i < specs.length; i++) {
    const parent = specs[i]!.parent
    if (parent !== null) rel.addPair(handles[i]!, ChildOf, handles[parent]!)
  }

  // A node's world transform needs its parent's already computed, so sort by depthOf (root =
  // depth 0) before composing. depthOf walks the exclusive parent chain.
  const order = handles
    .map((h, i) => ({ h, i, depth: rel.depthOf(h, ChildOf) }))
    .sort((a, b) => a.depth - b.depth)

  let maxDepth = 0
  for (const { h, depth } of order) {
    if (depth > maxDepth) maxDepth = depth

    // world.entity() reuses ONE pooled reference per world: the next call re-points it, and
    // reading a stale reference throws. So copy every input out to plain numbers before binding
    // the next view — never hold two live accessors across a world.entity() call.
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
