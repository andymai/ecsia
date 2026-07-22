// Interest-management invariants (spec docs/spec/interest-management.md §7): IM-2 no-leakage,
// IM-6 unfiltered equivalence, IM-4 determinism, IM-5 compute-once.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { createWorld, defineComponent, defineTag, has } from '@ecsia/core'
import type { ComponentDef, ComponentId, EntityHandle, Schema, World } from '@ecsia/core'
import { createReplicationStream } from '../src/index.js'
import { FLAG_IS_FILTERED } from '../src/format.js'

const defP = () => defineComponent({ x: 'f32', y: 'f32' }, { name: 'p' }) as ComponentDef<Schema>

// A distinctive 8-byte sentinel written into the concealed column; if concealment leaks, these bytes
// appear verbatim (little-endian f64) in a view's wire image.
const SENTINEL_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])
const SENTINEL = new DataView(SENTINEL_BYTES.slice().buffer).getFloat64(0, true)

function containsSubsequence(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('interest — IM-2: a concealed component NEVER appears in a view image (no leakage)', () => {
  it('the concealed sentinel column is present unfiltered but absent from the concealing view', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 12 }), (n, xs) => {
        const P = defP()
        const Secret = defineComponent({ val: 'f64' }, { name: 'secret' }) as ComponentDef<Schema>
        const V = defineTag('vis') as unknown as ComponentDef<Schema>
        const src = createWorld({ components: [P, Secret, V] })
        const handles: EntityHandle[] = []
        for (let i = 0; i < n; i++) {
          const e = src.spawnWith(P, Secret, V)
          ;(src.entity(e).write(P) as { x: number }).x = xs[i % xs.length] as number
          ;(src.entity(e).write(Secret) as { val: number }).val = SENTINEL
          handles.push(e)
        }
        const stream = createReplicationStream(src)
        const concealing = stream.view({ visible: src.query(has(V)), hideComponents: [Secret.id as ComponentId] })
        const open = stream.view({ visible: src.query(has(V)) })

        const images: Uint8Array[] = []
        images.push(concealing.baseline().bytes)
        // The OPEN view proves the sentinel does reach the wire when NOT concealed (test is meaningful).
        expect(containsSubsequence(open.baseline().bytes, SENTINEL_BYTES)).toBe(true)

        for (let t = 0; t < 3; t++) {
          src.advanceTick()
          for (const e of handles) {
            ;(src.entity(e).write(P) as { x: number }).x = (xs[t % xs.length] as number) + t
            ;(src.entity(e).write(Secret) as { val: number }).val = SENTINEL
          }
          images.push(concealing.delta().bytes)
          open.delta() // keep the two views in lockstep on the shared cursor
        }

        for (const img of images) expect(containsSubsequence(img, SENTINEL_BYTES)).toBe(false)
      }),
      { numRuns: 40 },
    )
  })
})

describe('interest — IM-6: a view matching everything with no concealment equals the unfiltered delta', () => {
  it('view.delta() is byte-identical to stream.tick() (modulo the informational FLAG_IS_FILTERED bit)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 16 }), (xs) => {
        const P = defP()
        const src = createWorld({ components: [P] })
        const handles = xs.map((v) => {
          const e = src.spawnWith(P)
          ;(src.entity(e).write(P) as { x: number }).x = v
          return e
        })
        const stream = createReplicationStream(src)
        const view = stream.view({ visible: src.query(has(P)) })
        view.baseline() // sync prevVisible so no entity is "entered" on the compared tick

        src.advanceTick()
        handles.forEach((e, i) => {
          ;(src.entity(e).write(P) as { x: number }).x = (xs[i] as number) + 1
        })

        const unfiltered = stream.tick().bytes
        const filtered = view.delta().bytes.slice()
        // Clear the FLAG_IS_FILTERED bit (byte 7): it is the only intended difference.
        filtered[7] = (filtered[7] as number) & ~FLAG_IS_FILTERED
        expect(Array.from(filtered)).toEqual(Array.from(unfiltered))
      }),
      { numRuns: 50 },
    )
  })
})

describe('interest — IM-4: identical worlds + equal options ⇒ byte-identical filtered images', () => {
  it('two independently-built worlds emit the same baseline and delta bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.integer({ min: -100, max: 100 }), vis: fc.boolean(), hideHand: fc.boolean() }), { minLength: 1, maxLength: 10 }),
        (specs) => {
          const build = () => {
            const P = defP()
            const H = defineComponent({ secret: 'f32' }, { name: 'hand' }) as ComponentDef<Schema>
            const Vis = defineTag('vis') as unknown as ComponentDef<Schema>
            const w = createWorld({ components: [P, H, Vis] })
            const handles: EntityHandle[] = []
            for (const sp of specs) {
              const e = sp.vis ? w.spawnWith(P, H, Vis) : w.spawnWith(P, H)
              ;(w.entity(e).write(P) as { x: number }).x = sp.x
              ;(w.entity(e).write(H) as { secret: number }).secret = sp.x * 2
              handles.push(e)
            }
            const stream = createReplicationStream(w)
            const view = stream.view({
              visible: w.query(has(Vis)),
              conceal: (_e, c) => c === (H.id as ComponentId),
            })
            return { w, view, handles, P }
          }
          const a = build()
          const b = build()
          expect(Array.from(a.view.baseline().bytes)).toEqual(Array.from(b.view.baseline().bytes))

          a.w.advanceTick()
          b.w.advanceTick()
          a.handles.forEach((e, i) => ((a.w.entity(e).write(a.P) as { x: number }).x = (specs[i] as { x: number }).x + 1))
          b.handles.forEach((e, i) => ((b.w.entity(e).write(b.P) as { x: number }).x = (specs[i] as { x: number }).x + 1))
          expect(Array.from(a.view.delta().bytes)).toEqual(Array.from(b.view.delta().bytes))
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('interest — IM-5: the shared scan runs ONCE per tick regardless of view count', () => {
  it('the structural drain (and its co-located changedRows scan) runs once with N views attached', () => {
    const P = defP()
    const V = defineTag('vis') as unknown as ComponentDef<Schema>
    const world = createWorld({ components: [P, V] })
    for (let i = 0; i < 5; i++) world.spawnWith(P, V)

    // Only the top-level world is frozen; the __serialize surface object is a mutable literal, so its
    // drainStructuralSince method can be wrapped to count. gatherSharedChangeset calls it exactly once
    // and immediately runs the changedRows scan alongside — so drainCalls==1 witnesses one shared scan.
    const surf = world.__serialize as unknown as { drainStructuralSince: (since: number) => unknown }
    const origDrain = surf.drainStructuralSince.bind(surf)
    let drainCalls = 0
    surf.drainStructuralSince = (since: number) => {
      drainCalls++
      return origDrain(since)
    }

    const stream = createReplicationStream(world as unknown as World)
    const views = Array.from({ length: 4 }, () => stream.view({ visible: world.query(has(V)) }))
    for (const view of views) view.baseline()

    world.advanceTick()
    for (const e of world.query(has(P))) (world.entity(e.handle).write(P) as { x: number }).x = 1

    drainCalls = 0
    for (const view of views) view.delta()
    expect(drainCalls).toBe(1)
  })
})
