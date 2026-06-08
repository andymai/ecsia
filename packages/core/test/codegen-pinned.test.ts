// Pinned-loop codegen: the mechanism behind bindColumns beating bitECS. These tests pin the SAFETY
// contract — codegen is used only when it provably matches the interpreted path, and falls back
// (always correct) under CSP, on an illegal outer-scope closure, or on any divergence. The
// steady-state speed win + the no-post-growth-penalty property are bench territory (bench/iterate.ts
// + the CI bench lane); correctness under random churn is bind-columns.property.test.ts.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, write } from '@ecsia/core'
import type { ComponentDef, Schema } from '@ecsia/core'
import { CODEGEN_AVAILABLE, buildPinnedRunner } from '../src/query/codegen.js'
import type { BoundColumnsMeta } from '@ecsia/schema'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c

describe('pinned codegen — safety contract', () => {
  test('eval is available under Node (the codegen path is live, not the CSP fallback)', () => {
    expect(CODEGEN_AVAILABLE).toBe(true)
  })

  test('a self-contained factory codegens and integrates correctly through growth', () => {
    const Pos = defineComponent({ x: 'f32' }, { name: 'CgPos' })
    const Vel = defineComponent({ dx: 'f32' }, { name: 'CgVel' })
    const world = createWorld({ components: asComps(Pos, Vel), maxEntities: 1 << 14 })
    const seed = () => {
      const h = world.spawnWith(Pos, Vel)
      ;(world.entity(h).write(Vel) as { dx: number }).dx = 2
      return h
    }
    for (let i = 0; i < 4; i++) seed()
    const q = world.query(write(Pos), write(Vel))
    // Self-contained: closes over nothing; dt arrives via ctx, hoisted out of the loop.
    const run = q.bindColumns([Pos, 'x'], [Vel, 'dx'], (vs, meta) => {
      const px = vs[0] as Float32Array
      const dx = vs[1] as Float32Array
      return (ctx: { dt: number }) => {
        const dt = ctx.dt
        const c = meta.count
        for (let i = 0; i < c; i++) px[i] = px[i]! + dx[i]! * dt
      }
    })
    run({ dt: 0.5 })
    // Force growth past the initial capacity so the runner re-builds (fresh codegen, no penalty),
    // then run again — the new rows integrate too, the old ones keep their accumulated value.
    const grown: ReturnType<typeof seed>[] = []
    for (let i = 0; i < 5000; i++) grown.push(seed())
    run({ dt: 0.5 })
    // Original 4 ran twice (x = 2*0.5*2 = 2); the 5000 new ran once (x = 2*0.5 = 1).
    let twice = 0
    let once = 0
    q.each((e) => {
      const x = (e as unknown as { CgPos: { x: number } }).CgPos.x
      if (Math.abs(x - 2) < 1e-6) twice++
      else if (Math.abs(x - 1) < 1e-6) once++
    })
    expect(twice).toBe(4)
    expect(once).toBe(5000)
  })

  test('a factory that closes over OUTER scope falls back to interpreted (still correct)', () => {
    const Pos = defineComponent({ x: 'f32' }, { name: 'CgPos2' })
    const world = createWorld({ components: asComps(Pos), maxEntities: 64 })
    for (let i = 0; i < 3; i++) world.spawnWith(Pos)
    const q = world.query(write(Pos))
    const bump = 7 // an OUTER closure — recompile can't see it; the pre-flight catches the throw → fallback
    const run = q.bindColumns([Pos, 'x'], (vs, meta) => {
      const px = vs[0] as Float32Array
      return () => {
        const c = meta.count
        for (let i = 0; i < c; i++) px[i] = px[i]! + bump
      }
    })
    run()
    q.each((e) => {
      expect((e as unknown as { CgPos2: { x: number } }).CgPos2.x).toBe(7)
    })
  })

  test('buildPinnedRunner: codegen and interpreted produce identical output (the pre-flight invariant)', () => {
    // Drive the helper directly on scratch typed arrays — no world needed. Self-contained factory.
    const factory = (vs: readonly Float32Array[], meta: BoundColumnsMeta) => {
      const a = vs[0] as Float32Array
      const b = vs[1] as Float32Array
      return (ctx: { k: number }) => {
        const k = ctx.k
        const c = meta.count
        for (let i = 0; i < c; i++) a[i] = a[i]! + b[i]! * k
      }
    }
    const meta: BoundColumnsMeta = { count: 8, strides: [1, 1] }
    const codegen = [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), new Float32Array([1, 1, 1, 1, 1, 1, 1, 1])]
    const interp = [codegen[0]!.slice(), codegen[1]!.slice()]
    // buildPinnedRunner returns codegen when CODEGEN_AVAILABLE (Node) and the pre-flight matches.
    const cgRun = buildPinnedRunner(factory as never, codegen as never, meta, [1, 1])
    // A hand-built interpreted runner over the clone.
    const inRun = factory(interp as never, meta)
    cgRun({ k: 10 } as never)
    inRun({ k: 10 })
    expect([...(codegen[0] as Float32Array)]).toEqual([...(interp[0] as Float32Array)])
  })

  test('a recycled-index / multi-archetype query integrates correctly under codegen', () => {
    const Pos = defineComponent({ x: 'f32' }, { name: 'CgPos3' })
    const Vel = defineComponent({ dx: 'f32' }, { name: 'CgVel3' })
    const Tag = defineComponent({ t: 'u8' }, { name: 'CgTag3' })
    const world = createWorld({ components: asComps(Pos, Vel, Tag), maxEntities: 1 << 12 })
    const mk = (withTag: boolean) => {
      const h = withTag ? world.spawnWith(Pos, Vel, Tag) : world.spawnWith(Pos, Vel)
      ;(world.entity(h).write(Vel) as { dx: number }).dx = 3
    }
    for (let i = 0; i < 10; i++) mk(false)
    for (let i = 0; i < 10; i++) mk(true) // a SECOND matching archetype — two bindings, two codegen runners
    const q = world.query(write(Pos), write(Vel))
    const run = q.bindColumns([Pos, 'x'], [Vel, 'dx'], (vs, meta) => {
      const px = vs[0] as Float32Array
      const dx = vs[1] as Float32Array
      return () => {
        const c = meta.count
        for (let i = 0; i < c; i++) px[i] = px[i]! + dx[i]!
      }
    })
    run()
    let n = 0
    q.each((e) => {
      expect((e as unknown as { CgPos3: { x: number } }).CgPos3.x).toBe(3)
      n++
    })
    expect(n).toBe(20) // both archetypes integrated
  })
})
