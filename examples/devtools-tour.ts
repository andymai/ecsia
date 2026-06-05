// A tour of @ecsia/devtools. Builds a small world — the damage-over-time setup of Health, Burning,
// and a ChildOf relation, plus a Label component holding a rich field (a real JS object rather
// than a number — these pin a system to the main thread) — then inspects it with inspectWorld and
// explainPlan and prints both as text. The thing to notice: every fact the text renderers print
// is also a plain, assertable field on the report objects, which is what the smoke test checks.

// devtools is an opt-in diagnostic: inspectWorld reads internal inspection hooks
// (`__serialize`/`__inspect`) that the ecsia umbrella deliberately leaves off its facade. So this
// example takes its world from @ecsia/core — the version that carries those hooks — and wires in
// the scheduler and relations packages directly, the same way a real devtools consumer would.
import { createWorld, defineComponent, read, write, object } from '@ecsia/core'
import { createScheduler, defineSystem } from '@ecsia/scheduler'
import type { SchedulerHandle } from '@ecsia/scheduler'
import { createRelations } from '@ecsia/relations'
import {
  inspectWorld,
  explainPlan,
  renderText,
  componentNameMap,
  type WorldReport,
  type PlanExplain,
} from '@ecsia/devtools'

export interface DevtoolsTourResult {
  readonly report: WorldReport
  readonly plan: PlanExplain
  readonly reportText: string
  readonly planText: string
}

export function main(): DevtoolsTourResult {
  // Position drives a system that can run on a worker thread. Label carries an object<string>
  // field, so any system touching it can't run on a worker — the plan keeps it on the main
  // thread and reports the reason as 'rich-fields'.
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Burning = defineComponent({ stacks: 'i32' }, { name: 'burning' })
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Label = defineComponent({ tag: object<string>() }, { name: 'label' })

  const world = createWorld({ components: [Health, Burning, Position, Label], maxEntities: 1 << 14 })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

  // A small mob graph: one root with three children, two of them burning.
  const root = world.spawnWith([Health, { hp: 100 }], [Position, { x: 0, y: 0 }], [Label, { tag: 'root' }])
  const a = world.spawnWith([Health, { hp: 6 }], [Burning, { stacks: 3 }], [Position, { x: 1, y: 0 }])
  const b = world.spawnWith([Health, { hp: 4 }], [Burning, { stacks: 2 }], [Position, { x: 2, y: 0 }])
  const c = world.spawnWith([Health, { hp: 50 }], [Position, { x: 3, y: 0 }])
  rel.addPair(a, ChildOf, root)
  rel.addPair(b, ChildOf, root)
  rel.addPair(c, ChildOf, root)

  // Burn writes Health and Burning. Move reads Burning and writes Position, so it must wait for
  // Burn. Tagger reads Label (the rich field — so it can't run on a worker thread) and writes
  // Health, colliding with Burn's Health write; that forces them into different waves (a wave is
  // a batch of systems that can safely run at the same time). explainPlan reports all of this.
  const Burn = defineSystem({
    name: 'Burn',
    read: [],
    write: [Health, Burning],
    run({ query }) {
      for (const e of query(write(Health), write(Burning))) {
        e.health.hp -= e.burning.stacks
        e.burning.stacks -= 1
      }
    },
  })
  const Move = defineSystem({
    name: 'Move',
    read: [Burning],
    write: [Position],
    run({ query }) {
      for (const e of query(write(Position), read(Burning))) {
        e.position.x += 1
      }
    },
  })
  const Tagger = defineSystem({
    name: 'Tagger',
    read: [Label],
    write: [Health],
    run({ query }) {
      for (const e of query(read(Label), write(Health))) {
        if (e.health.hp < 0) e.health.hp = 0
      }
    },
  })

  const scheduler: SchedulerHandle = createScheduler(world, [Burn, Move, Tagger])

  // Run a couple of frames so the world has live state and matched queries to inspect.
  scheduler.update(1)
  scheduler.update(1)

  const report = inspectWorld(world)
  const plan = explainPlan(scheduler, componentNameMap(world))

  const reportText = renderText(report)
  const planText = renderText(plan)

  return { report, plan, reportText, planText }
}

// Run directly: `node --experimental-strip-types examples/devtools-tour.ts` (or via the smoke test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { reportText, planText } = main()
  // eslint-disable-next-line no-console
  console.log(reportText)
  // eslint-disable-next-line no-console
  console.log('\n' + planText)
}
