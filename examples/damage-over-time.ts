// A damage-over-time effect, with deaths and cascading cleanup. Burning entities lose hp each
// tick (one simulation step) equal to their stacks (how many instances of the effect are active);
// one stack burns off per tick, at 0 stacks the Burning component comes off, and at 0 hp the
// entity despawns (is removed from the world) — taking its children with it, via a ChildOf
// relation with cascade: 'deleteSubject'. Demonstrates structural changes from inside a system,
// relations with automatic cleanup, and an observer (a callback fired on component removal).

import {
  createWorld,
  defineComponent,
  defineSystem,
  createScheduler,
  createRelations,
  onRemove,
  read,
  write,
} from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'

export interface MobSpec {
  /** Starting hit points. */
  readonly hp: number
  /** Initial Burning stacks (damage per tick; one stack burns off each tick). 0 = not burning. */
  readonly burning: number
  /** Index (into this spec array) of this mob's parent, or null for a root. Must be < own index. */
  readonly parent: number | null
}

export interface DamageOverTimeOptions {
  readonly mobs?: readonly MobSpec[]
  /** Max ticks to run (the sim also stops early once nothing is burning). Default 16. */
  readonly ticks?: number
}

export interface DamageOverTimeResult {
  /** Spec indices of mobs still alive at the end. */
  readonly survivors: readonly number[]
  /** Spec indices of mobs that died (the complement of `survivors`). */
  readonly deaths: readonly number[]
  /**
   * How many times the onRemove(Health) observer fired. Every death — direct burn-out or
   * cascaded child — removes Health exactly once, so this equals `deaths.length`. It is the
   * observer's own count, independent of the survivor scan, proving the observer really ran.
   */
  readonly observedDeathCount: number
  /** Spec indices of survivors that still carry the Burning component. */
  readonly stillBurning: readonly number[]
  /** Final hp of each survivor, keyed by spec index. */
  readonly hpById: Readonly<Record<number, number>>
  readonly ticksRun: number
}

const DEFAULT_MOBS: readonly MobSpec[] = [
  { hp: 10, burning: 0, parent: null }, // 0 root — never burns, survives untouched
  { hp: 6, burning: 3, parent: 0 }, //     1 child of 0 — burns to death on tick 3
  { hp: 100, burning: 0, parent: 1 }, //   2 child of 1 — healthy, but dies in 1's cascade
  { hp: 4, burning: 2, parent: null }, //  3 lone root — singed down to 1 hp, survives
  { hp: 50, burning: 1, parent: 3 }, //    4 child of 3 — barely singed, survives
]

export function main(opts: DamageOverTimeOptions = {}): DamageOverTimeResult {
  const specs = opts.mobs ?? DEFAULT_MOBS
  const ticks = opts.ticks ?? 16

  // Component definitions get their id when registered with a world, so a fresh main() makes
  // fresh ones — that lets the example run repeatedly.
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Burning = defineComponent({ stacks: 'i32' }, { name: 'burning' })

  const world = createWorld({ components: [Health, Burning], maxEntities: 1 << 16 })
  const rel = createRelations(world)
  // ChildOf is an exclusive relation (each entity can have at most one — i.e. one parent).
  // cascade: 'deleteSubject' means despawning the parent also despawns everything pointing at it;
  // the cascade is iterative, so deep chains unwind without recursion.
  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

  // The death observer — a callback that fires when a component is removed. Register with
  // `world.observe(term, handler)`; the onRemove(Health) term describes WHAT to watch. It fires
  // both when Health is removed directly and when its entity despawns (despawning removes every
  // held component), including children swept up by the deleteSubject cascade — so this counts
  // every death exactly once. Handlers run at a deferred serial slot, never mid-system.
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

  // The damage system changes structure from inside a system body via `ctx.world`. We collect
  // targets DURING iteration and remove/despawn AFTER it, so we never restructure the archetype
  // (the group of entities sharing the same component set) we're walking. Despawning a parent
  // here cascades to its children (deleteSubject) at the same point.
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
      for (const h of toExtinguish) w.remove(h, Burning) // stop the effect, keep the entity
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
    // Stop early once nothing is burning — the end state is settled.
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
      // Spawn handles stay valid keys for isAlive/entity() even after death. A dead one counts as
      // a death whether it burned out directly or was cascaded by its parent's despawn.
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
