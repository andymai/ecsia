// Example: damage-over-time + death + cascade. This is the exact program the newcomer-simulation
// could NOT write from the old docs — it exercises every gap that forced source-reading:
//
//   • in-system structural mutation via `ctx.world` (remove a component, despawn an entity)
//   • a `world.observe(onRemove(Health), ...)` death observer (registration, handler shape, fires on despawn)
//   • a `ChildOf` EXCLUSIVE relation with `cascade: 'deleteSubject'` — despawning a PARENT (target)
//     cascades to its CHILDREN (subjects)
//
// Burning entities take `stacks` damage per tick; each tick burns one stack down. At 0 stacks the
// Burning component is removed; at hp <= 0 the entity despawns (and any ChildOf children despawn with
// it). The onRemove(Health) observer records every death. Everything imports from ecsia.

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  createRelations,
  onRemove,
  read,
  write,
} from 'ecsia'
import type { EntityHandle } from 'ecsia'

export interface MobSpec {
  /** Starting hit points. */
  readonly hp: number
  /** Initial Burning stacks (damage/tick, decremented each tick). 0 = not burning. */
  readonly burning: number
  /** Index (into this spec array) of this mob's parent, or null for a root. Must be < own index. */
  readonly parent: number | null
}

export interface DotCascadeOptions {
  readonly mobs?: readonly MobSpec[]
  /** Max ticks to run (the sim also stops early once nothing is burning). Default 16. */
  readonly ticks?: number
}

export interface DotCascadeResult {
  /** Spec indices of mobs still alive at the end. */
  readonly survivors: readonly number[]
  /** Spec indices of mobs that died (the complement of `survivors`). */
  readonly deaths: readonly number[]
  /**
   * Number of onRemove(Health) handler fires — every death (direct burn-out AND cascaded child)
   * raises Health-removal exactly once, so this equals `deaths.length`. It is the observer's own
   * count, independent of the survivor scan, proving the death observer actually fired.
   */
  readonly observedDeathCount: number
  /** Spec indices of survivors that still carry the Burning component. */
  readonly stillBurning: readonly number[]
  /** Final hp of each survivor, keyed by spec index. */
  readonly hpById: Readonly<Record<number, number>>
  readonly ticksRun: number
}

const DEFAULT_MOBS: readonly MobSpec[] = [
  { hp: 10, burning: 0, parent: null }, // 0 root parent (never burns; dies only via... it doesn't)
  { hp: 6, burning: 3, parent: 0 }, //     1 child of 0 — burns out fast, despawns
  { hp: 100, burning: 0, parent: 1 }, //   2 child of 1 — healthy, but cascades when 1 dies
  { hp: 4, burning: 2, parent: null }, //  3 lone root — burns to death
  { hp: 50, burning: 1, parent: 3 }, //    4 child of 3 — cascades when 3 dies
]

export function main(opts: DotCascadeOptions = {}): DotCascadeResult {
  const specs = opts.mobs ?? DEFAULT_MOBS
  const ticks = opts.ticks ?? 16

  // Per-call defs: component ids are world-scoped, so a fresh main() gets fresh registrations.
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Burning = defineComponent({ stacks: 'i32' }, { name: 'burning' })

  const world = createWorld({ components: [Health, Burning], maxEntities: 1 << 16 })
  const rel = createRelations(world)
  // Exclusive parent link; deleteSubject ⇒ despawning a PARENT (the target) despawns its CHILDREN
  // (the subjects that point at it). The cascade is iterative, so deep chains unwind without recursion.
  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

  // Death observer. Registration is `world.observe(term, handler)` — the onRemove(Health) term alone
  // only describes WHAT to watch. onRemove(Health) fires both when the component is removed and when
  // the entity is despawned (despawn enqueues a remove for every held component), including the
  // children swept up by the deleteSubject cascade — so this counts every death exactly once.
  // Handlers run at a deferred serial slot, never mid-system.
  let observedDeathCount = 0
  const sub = world.observe(onRemove(Health), () => {
    observedDeathCount++
  })

  const handles: EntityHandle[] = []
  for (const spec of specs) {
    const h = spec.burning > 0 ? world.spawnWith(Health, Burning) : world.spawnWith(Health)
    world.entity(h).write(Health).hp = spec.hp
    if (spec.burning > 0) world.entity(h).write(Burning).stacks = spec.burning
    handles.push(h)
  }
  for (let i = 0; i < specs.length; i++) {
    const parent = specs[i]!.parent
    if (parent !== null) rel.addPair(handles[i]!, ChildOf, handles[parent]!)
  }

  // The DoT system mutates structure inside a serial system body via `ctx.world`. We collect the
  // targets DURING iteration and apply remove/despawn AFTER it, so we never restructure the archetype
  // we're walking. Despawning a parent here cascades its children (deleteSubject) at the same slot.
  const Burn = defineSystem({
    name: 'Burn',
    read: [],
    write: [Health, Burning],
    run({ world: w, query }) {
      const toExtinguish: EntityHandle[] = []
      const toDespawn: EntityHandle[] = []
      for (const e of query(write(Health), write(Burning))) {
        e.health.hp -= e.burning.stacks
        e.burning.stacks -= 1
        if (e.health.hp <= 0) toDespawn.push(e.handle)
        else if (e.burning.stacks <= 0) toExtinguish.push(e.handle)
      }
      for (const h of toExtinguish) w.remove(h, Burning) // stop the DoT, keep the entity
      for (const h of toDespawn) {
        if (w.isAlive(h)) w.despawn(h) // a parent despawn may have already cascaded this one
      }
    },
  })

  const scheduler = createScheduler(world, [Burn])

  let ticksRun = 0
  for (let t = 0; t < ticks; t++) {
    scheduler.update(1)
    ticksRun++
    // Stop early once nothing is burning (the observable end state is reached).
    let anyBurning = false
    for (const _ of world.query(read(Burning))) {
      anyBurning = true
      break
    }
    if (!anyBurning) break
  }

  sub.dispose()

  const survivors: number[] = []
  const deaths: number[] = []
  const stillBurning: number[] = []
  const hpById: Record<number, number> = {}
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i]!
    if (!world.isAlive(h)) {
      // Spawn handles stay valid keys for isAlive/entity() (lenient by index); a dead one is a death,
      // whether it burned out directly or was cascaded by its parent's despawn.
      deaths.push(i)
      continue
    }
    survivors.push(i)
    hpById[i] = world.entity(h).read(Health).hp
    if (world.has(h, Burning)) stillBurning.push(i)
  }

  return {
    survivors,
    deaths,
    observedDeathCount,
    stillBurning,
    hpById,
    ticksRun,
  }
}
