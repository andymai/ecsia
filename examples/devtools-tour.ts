// Example: the @ecsia/devtools tour. Builds the dot-cascade-style world (Health + Burning + a ChildOf
// relation + a Burn system, plus a rich-field 'label' component to force a worker-INELIGIBLE system),
// then prints inspectWorld + explainPlan as text. The smoke test asserts the report facts (entity
// counts, the wave shape, a known write-write conflict, and the pinned rich-field system).
//
// This is a DATA-LAYER demo: every fact the renderers print is also an assertable field on the plain
// report objects the inspect/explain functions return.

// devtools is an OPT-IN, core-level diagnostic: inspectWorld/watchWorld read the world's internal
// `__serialize`/`__inspect` seams, which the ecsia umbrella facade deliberately omits.
// So this example takes the world from @ecsia/core (the seam-carrying World) and drives it with the
// scheduler/relations packages directly — the same way a real devtools consumer would wire it.
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
  // Position drives the worker-eligible movement system; Label carries an object<T> RICH field, so any
  // system touching it is worker-INELIGIBLE (pinned to the main thread, reason 'rich-fields').
  const Health = defineComponent({ hp: 'i32' }, { name: 'health' })
  const Burning = defineComponent({ stacks: 'i32' }, { name: 'burning' })
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Label = defineComponent({ tag: object<string>() }, { name: 'label' })

  const world = createWorld({ components: [Health, Burning, Position, Label], maxEntities: 1 << 14 })
  const rel = createRelations(world)
  const ChildOf = rel.defineRelation(null, { exclusive: true, cascade: 'deleteSubject' })

  // A small mob graph: 1 root + 3 children, two of them burning.
  const root = world.spawnWith([Health, { hp: 100 }], [Position, { x: 0, y: 0 }], [Label, { tag: 'root' }])
  const a = world.spawnWith([Health, { hp: 6 }], [Burning, { stacks: 3 }], [Position, { x: 1, y: 0 }])
  const b = world.spawnWith([Health, { hp: 4 }], [Burning, { stacks: 2 }], [Position, { x: 2, y: 0 }])
  const c = world.spawnWith([Health, { hp: 50 }], [Position, { x: 3, y: 0 }])
  rel.addPair(a, ChildOf, root)
  rel.addPair(b, ChildOf, root)
  rel.addPair(c, ChildOf, root)

  // Burn writes Health + Burning (worker-eligible). Move reads Burning, writes Position (worker-eligible;
  // conflicts with Burn on Burning, read-write). Tagger reads Label (rich/object) → worker-INELIGIBLE,
  // and writes Health → a write-write conflict with Burn on Health forcing them apart.
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

  // Drive a couple of frames so the world has live state + matched queries to inspect.
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
