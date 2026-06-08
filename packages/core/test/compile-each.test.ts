import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, read, write, vec2 } from '@ecsia/core'
import type { ComponentDef, Schema } from '@ecsia/core'
import { analyzeEachBody } from '../src/internal.js'

const DT = 1 / 60

// Test element: the pooled element is dynamically shaped; these tests only ever touch position/velocity.
type El = { position: { x: number; y: number }; velocity: { dx: number; dy: number }; handle: unknown }
interface Compilable {
  compile<Ctx = void>(body: (e: El, ctx: Ctx) => void): (ctx: Ctx) => void
  each(fn: (e: El) => void): void
}

// Fresh component defs per world — a ComponentDef registers to exactly one world.
function makeWorld() {
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const world = createWorld({ components: [Position, Velocity], maxEntities: 1 << 16 })
  const spawn = (x: number, y: number, dx: number, dy: number) =>
    world.spawnWith([Position, { x, y }], [Velocity, { dx, dy }])
  return { world, Position, Velocity, spawn }
}

describe('compile() — correctness vs .each', () => {
  test('integrate body matches .each byte-for-byte', () => {
    const a = makeWorld()
    const b = makeWorld()
    for (let i = 0; i < 2000; i++) {
      const dx = (i % 7) - 3
      const dy = (i % 5) - 2
      a.spawn(i, -i, dx, dy)
      b.spawn(i, -i, dx, dy)
    }
    const qa = a.world.query(write(a.Position), read(a.Velocity)) as unknown as Compilable
    const qb = b.world.query(write(b.Position), read(b.Velocity)) as unknown as Compilable

    const run = qa.compile<{ dt: number }>((e, ctx) => {
      e.position.x += e.velocity.dx * ctx.dt
      e.position.y += e.velocity.dy * ctx.dt
    })
    for (let f = 0; f < 10; f++) {
      run({ dt: DT })
      qb.each((e) => {
        e.position.x += e.velocity.dx * DT
        e.position.y += e.velocity.dy * DT
      })
    }

    const dump = (q: Compilable): number[] => {
      const out: number[] = []
      q.each((e) => out.push(e.position.x as number, e.position.y as number))
      return out
    }
    const da = dump(qa)
    expect(da.length).toBe(4000)
    expect(da).toEqual(dump(qb))
  })

  test('stays correct across column growth (crosses the 1024-row reservation)', () => {
    const { world, Position, Velocity, spawn } = makeWorld()
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    const run = q.compile<{ dt: number }>((e, ctx) => {
      e.position.x += e.velocity.dx * ctx.dt
    })
    for (let i = 0; i < 1500; i++) spawn(0, 0, 2, 0)
    void Velocity
    for (let f = 0; f < 5; f++) run({ dt: 1 })
    let bad = 0
    let seen = 0
    q.each((e) => {
      seen++
      if ((e.position.x as number) !== 10) bad++
    })
    expect(seen).toBe(1500)
    expect(bad).toBe(0)
  })

  test('compound and assign forms both compile correctly', () => {
    const { world, Position, Velocity, spawn } = makeWorld()
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    spawn(1, 1, 3, 4)
    void Velocity
    const run = q.compile((e) => {
      e.position.x = e.velocity.dx
      e.position.y *= 2
    })
    run()
    q.each((e) => {
      expect(e.position.x).toBe(3)
      expect(e.position.y).toBe(2)
    })
  })

  test('local const inside a straight-line body still compiles', () => {
    const { world, Position, Velocity, spawn } = makeWorld()
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    spawn(0, 0, 4, 5)
    void Velocity
    const run = q.compile<{ dt: number }>((e, ctx) => {
      const sx = e.velocity.dx * ctx.dt
      e.position.x += sx
    })
    run({ dt: 2 })
    q.each((e) => expect(e.position.x).toBe(8))
  })

  test('multiple archetypes (some entities lack a 3rd component) all integrate', () => {
    const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
    const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
    const Tag = defineComponent({ t: 'u8' }, { name: 'tag' })
    const world = createWorld({ components: [Position, Velocity, Tag], maxEntities: 1 << 14 })
    for (let i = 0; i < 300; i++) world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 1, dy: 0 }])
    for (let i = 0; i < 300; i++)
      world.spawnWith([Position, { x: 0, y: 0 }], [Velocity, { dx: 1, dy: 0 }], [Tag, { t: 1 }])
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    const run = q.compile((e) => {
      e.position.x += e.velocity.dx
    })
    run()
    run()
    let seen = 0
    q.each((e) => {
      seen++
      expect(e.position.x).toBe(2)
    })
    expect(seen).toBe(600)
  })
})

describe('compile() — reactivity preserved', () => {
  test('.changed() sees compiled writes (and matches the proxy path)', () => {
    const count = (useCompiled: boolean): number => {
      const { world, Position, Velocity, spawn } = makeWorld()
      spawn(0, 0, 1, 1)
      spawn(0, 0, 2, 2)
      const writer = world.query(write(Position), read(Velocity))
      const changed = writer.changed(Position) as unknown as {
        eachChanged(fn: (e: El) => void): void
      }
      const w = writer as unknown as Compilable
      world.frameReset() // separate the spawn-time writes from the run's writes

      if (useCompiled) {
        w.compile<{ dt: number }>((e, ctx) => {
          e.position.x += e.velocity.dx * ctx.dt
        })({ dt: 1 })
      } else {
        w.each((e) => {
          e.position.x += e.velocity.dx * 1
        })
      }
      let n = 0
      changed.eachChanged(() => n++)
      return n
    }
    expect(count(false)).toBe(2) // proxy reference
    expect(count(true)).toBe(2) // compiled path
  })

  test('no .changed consumer ⇒ writes still land (gate is transparent)', () => {
    const { world, Position, Velocity, spawn } = makeWorld()
    spawn(5, 0, 10, 0)
    void Velocity
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    const run = q.compile((e) => {
      e.position.x += e.velocity.dx
    })
    run()
    q.each((e) => expect(e.position.x).toBe(15))
  })
})

describe('compile() — fallback to proxy stays correct', () => {
  test('control-flow body falls back yet matches an explicit-if proxy', () => {
    const a = makeWorld()
    const b = makeWorld()
    for (let i = 0; i < 500; i++) {
      const dx = (i % 9) - 4
      a.spawn(i, 0, dx, 0)
      b.spawn(i, 0, dx, 0)
    }
    const qa = a.world.query(write(a.Position), read(a.Velocity)) as unknown as Compilable
    const qb = b.world.query(write(b.Position), read(b.Velocity)) as unknown as Compilable
    const run = qa.compile<{ dt: number }>((e, ctx) => {
      if ((e.velocity.dx as number) > 0) e.position.x += e.velocity.dx * ctx.dt
    })
    for (let f = 0; f < 4; f++) {
      run({ dt: DT })
      qb.each((e) => {
        if ((e.velocity.dx as number) > 0) e.position.x += e.velocity.dx * DT
      })
    }
    const dumpA: number[] = []
    const dumpB: number[] = []
    qa.each((e) => dumpA.push(e.position.x as number))
    qb.each((e) => dumpB.push(e.position.x as number))
    expect(dumpA.length).toBe(500)
    expect(dumpA).toEqual(dumpB)
  })

  test('body closing over an outer variable falls back (not self-contained) without crashing', () => {
    const { world, Position, Velocity, spawn } = makeWorld()
    spawn(0, 0, 3, 0)
    void Velocity
    const GRAVITY = 7 // captured from outer scope — the codegen copy cannot see it
    const q = world.query(write(Position), read(Velocity)) as unknown as Compilable
    // Must NOT throw at compile or at run — the scratch pre-flight demotes it to the proxy, which closes
    // over GRAVITY correctly.
    const run = q.compile((e) => {
      e.position.x += e.velocity.dx + GRAVITY
    })
    run()
    q.each((e) => expect(e.position.x).toBe(10))
  })

  test('vec field → proxy (non-scalar), correct result', () => {
    const Pos = defineComponent({ p: vec2() }, { name: 'vpos' })
    const Vel = defineComponent({ v: vec2() }, { name: 'vvel' })
    const world = createWorld({ components: [Pos, Vel], maxEntities: 1 << 12 })
    world.spawnWith([Pos, { p: [1, 2] as never }], [Vel, { v: [3, 4] as never }])
    const q = world.query(write(Pos), read(Vel)) as unknown as {
      compile(body: (e: { vpos: { p: number[] }; vvel: { v: number[] } }) => void): () => void
      each(fn: (e: { vpos: { p: number[] } }) => void): void
    }
    const run = q.compile((e) => {
      const p = e.vpos.p
      const v = e.vvel.v
      p[0] = p[0]! + v[0]!
      p[1] = p[1]! + v[1]!
    })
    run()
    q.each((e) => {
      const p = e.vpos.p
      expect([p[0], p[1]]).toEqual([4, 6])
    })
  })
})

describe('analyzeEachBody — transform unit', () => {
  // Unregistered defs: the analyzer reads only schema metadata, never a world.
  const Position = defineComponent({ x: 'f32', y: 'f32' }, { name: 'position' })
  const Velocity = defineComponent({ dx: 'f32', dy: 'f32' }, { name: 'velocity' })
  const deps = {
    defByName: (n: string): ComponentDef<Schema> | undefined =>
      n === 'position' ? Position : n === 'velocity' ? Velocity : undefined,
    idOf: (d: ComponentDef<Schema>) => (d === Position ? 0 : d === Velocity ? 1 : undefined),
    isRequired: () => true,
  }

  test('rewrites e.comp.field to column indexing and finds the write set', () => {
    const plan = analyzeEachBody(
      ((e: El, ctx: { dt: number }) => {
        e.position.x += e.velocity.dx * ctx.dt
      }) as never,
      deps as never,
    )
    expect(plan).not.toBeNull()
    expect(plan!.specs.map((s) => `${s.def.name}.${s.field}`)).toEqual(['position.x', 'velocity.dx'])
    expect(plan!.writtenIds).toEqual([0])
    expect(plan!.factorySource).toContain('__v0[__i]')
    expect(plan!.factorySource).toContain('const __c_dt = __ctx.dt')
  })

  test('bails on control flow, strings, nested fn, bare e', () => {
    const bail = (f: unknown) => expect(analyzeEachBody(f as never, deps as never)).toBeNull()
    bail((e: El) => {
      if (true) e.position.x = 1
    })
    bail((e: El) => {
      const s = 'e.position.x'
      e.position.x = s.length
    })
    bail((e: El) => [1].forEach(() => (e.position.x = 1)))
    bail((e: El) => {
      e.position.x = e.handle as unknown as number
    })
  })

  test('bails when a body local could collide with a generated name (silent-shadow guard)', () => {
    const bail = (f: unknown) => expect(analyzeEachBody(f as never, deps as never)).toBeNull()
    // A local named like a generated column/seam ident must NOT silently shadow it — any `__` bails.
    bail((e: El, ctx: { scale: number }) => {
      const __v0 = ctx.scale
      e.position.x += e.velocity.dx * __v0
    })
    bail((e: El) => {
      const __trackWrite = e.velocity.dx
      e.position.x += __trackWrite
    })
  })

  test('bails on destructuring-assignment and regex literals (write-miss / rewrite hazards)', () => {
    const bail = (f: unknown) => expect(analyzeEachBody(f as never, deps as never)).toBeNull()
    bail((e: El) => {
      ;[e.position.x] = [5] as [number]
    })
    bail((e: El) => {
      e.position.x = /e.position.x/.test('') ? 1 : 0
    })
  })

  test('division survives (not mistaken for a regex literal)', () => {
    const plan = analyzeEachBody(
      ((e: El, ctx: { mass: number }) => {
        e.position.x += e.velocity.dx / ctx.mass
      }) as never,
      deps as never,
    )
    expect(plan).not.toBeNull()
    expect(plan!.factorySource).toContain('/')
  })
})
