// Cross-library iteration micro-benchmark (timing one tiny loop, rather than a realistic workload):
// integrate Position from Velocity over N entities, the classic ECS hot loop. ecsia vs miniplex vs
// bitECS. Each builder returns a `step()` that advances every entity one frame; tinybench times
// step() in the runner. Kept allocation-free in the loop so the measurement is the storage/iteration
// cost, not GC.

import { createWorld, defineComponent, write } from 'ecsia'
import type { QueryChunk } from 'ecsia'
import { World as MiniplexWorld } from 'miniplex'
import {
  createWorld as bitCreateWorld,
  addEntity as bitAddEntity,
  addComponent as bitAddComponent,
  query as bitQuery,
} from 'bitecs'

export interface IterCase {
  readonly name: string
  step(): void
  /** Read back one entity's x to keep the optimizer honest + let the smoke test assert progress. */
  sampleX(): number
}

const DT = 1 / 60

export function makeEcsiaIter(n: number): IterCase {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: nextPow2(n) })
  let first = 0 as unknown as ReturnType<typeof world.spawnWith>
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Position, Velocity)
    if (i === 0) first = h
    const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
    v.dx = 1
    v.dy = 0.5
  }
  const q = world.query(write(Position), write(Velocity))
  return {
    name: 'ecsia',
    step() {
      q.each((e) => {
        const el = e as unknown as { position: { x: number; y: number }; velocity: { dx: number; dy: number } }
        el.position.x += el.velocity.dx * DT
        el.position.y += el.velocity.dy * DT
      })
    },
    sampleX() {
      return (world.entity(first).read(Position) as { x: number }).x
    },
  }
}

// The opt-in column-cursor variant of the ecsia loop. ecsia stores each field in its own contiguous
// array (a column), a layout called Structure-of-Arrays (SoA); eachChunk hands per-archetype raw
// typed column views + a row span, so the inner loop indexes Float32Array directly — bypassing the
// per-row accessor objects AND the reactivity write-log push (close to the bitECS raw-SoA loop,
// still typed).
export function makeEcsiaCursorIter(n: number): IterCase {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: nextPow2(n) })
  let first = 0 as unknown as ReturnType<typeof world.spawnWith>
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Position, Velocity)
    if (i === 0) first = h
    const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
    v.dx = 1
    v.dy = 0.5
  }
  const q = world.query(write(Position), write(Velocity))
  return {
    name: 'ecsia-cursor',
    step() {
      q.eachChunk((c: QueryChunk) => {
        const px = c.column(Position, 'x')
        const py = c.column(Position, 'y')
        const dx = c.column(Velocity, 'dx')
        const dy = c.column(Velocity, 'dy')
        const count = c.count
        for (let i = 0; i < count; i++) {
          ;(px as { [k: number]: number })[i] = px[i]! + dx[i]! * DT
          ;(py as { [k: number]: number })[i] = py[i]! + dy[i]! * DT
        }
      })
    },
    sampleX() {
      return (world.entity(first).read(Position) as { x: number }).x
    },
  }
}

// The pinned-columns variant. Where eachChunk re-resolves its column views every call, bindColumns
// resolves them ONCE at setup and invokes the factory to mint a persistent runner closure — V8
// specializes the captured views into the optimized loop, which is the whole win. The two contract
// points the factory shape encodes: the runner takes zero arguments, and the live row count is read
// from the identity-stable `meta` inside the runner. All spawning happens before the bind, so column
// growth never invalidates the binding (the pre-sizing discipline the docs recommend).
export function makeEcsiaPinnedIter(n: number): IterCase {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: nextPow2(n) })
  let first = 0 as unknown as ReturnType<typeof world.spawnWith>
  for (let i = 0; i < n; i++) {
    const h = world.spawnWith(Position, Velocity)
    if (i === 0) first = h
    const v = world.entity(h).write(Velocity) as { dx: number; dy: number }
    v.dx = 1
    v.dy = 0.5
  }
  const q = world.query(write(Position), write(Velocity))
  // The factory is SELF-CONTAINED (closes over nothing): per-frame dt arrives via the runner's ctx,
  // hoisted to a local const before the loop. This is the shape the codegen path requires — each
  // archetype's runner is recompiled into a specialized singleton, no post-growth penalty.
  const run = q.bindColumns(
    [Position, 'x'],
    [Position, 'y'],
    [Velocity, 'dx'],
    [Velocity, 'dy'],
    ([px, py, dx, dy], meta) => (ctx: { dt: number }) => {
      const dt = ctx.dt
      const count = meta.count
      for (let i = 0; i < count; i++) {
        px[i] = px[i]! + dx[i]! * dt
        py[i] = py[i]! + dy[i]! * dt
      }
    },
  )
  const ctx = { dt: DT } // hoisted so step() allocates nothing
  return {
    name: 'ecsia-pinned',
    step() {
      run(ctx)
    },
    sampleX() {
      return (world.entity(first).read(Position) as { x: number }).x
    },
  }
}

interface MiniEntity {
  position: { x: number; y: number }
  velocity: { dx: number; dy: number }
}

export function makeMiniplexIter(n: number): IterCase {
  const world = new MiniplexWorld<MiniEntity>()
  for (let i = 0; i < n; i++) {
    world.add({ position: { x: 0, y: 0 }, velocity: { dx: 1, dy: 0.5 } })
  }
  const moving = world.with('position', 'velocity')
  let firstE: MiniEntity | undefined
  for (const e of moving.entities) {
    firstE = e
    break
  }
  return {
    name: 'miniplex',
    step() {
      for (const e of moving.entities) {
        e.position.x += e.velocity.dx * DT
        e.position.y += e.velocity.dy * DT
      }
    },
    sampleX() {
      return firstE?.position.x ?? 0
    },
  }
}

// bitECS 0.4: components are caller-owned SoA stores (the library tracks membership only), queries
// are the `query(world, terms)` function (cached per world after first use), and addComponent takes
// (world, eid, component). Pre-sized Float32Array columns keep this the raw-SoA loop the comparison
// has always measured.
export function makeBitEcsIter(n: number): IterCase {
  const world = bitCreateWorld()
  const cap = nextPow2(n + 1)
  const Position = { x: new Float32Array(cap), y: new Float32Array(cap) }
  const Velocity = { dx: new Float32Array(cap), dy: new Float32Array(cap) }
  let firstEid = 0
  for (let i = 0; i < n; i++) {
    const eid = bitAddEntity(world)
    if (i === 0) firstEid = eid
    bitAddComponent(world, eid, Position)
    bitAddComponent(world, eid, Velocity)
    Velocity.dx[eid] = 1
    Velocity.dy[eid] = 0.5
  }
  const px = Position.x
  const py = Position.y
  const vdx = Velocity.dx
  const vdy = Velocity.dy
  return {
    name: 'bitECS',
    step() {
      const ents = bitQuery(world, [Position, Velocity])
      for (let i = 0; i < ents.length; i++) {
        const eid = ents[i]!
        px[eid] = px[eid]! + vdx[eid]! * DT
        py[eid] = py[eid]! + vdy[eid]! * DT
      }
    },
    sampleX() {
      return px[firstEid]!
    },
  }
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return Math.max(p, 1024)
}
