// rich-fields INVARIANT suite — the discriminating leg.
//
// This file complements the example-based rich-fields.test.ts with the property/parity tests the spec
// The RF-HYGIENE fast-check recycle+wrap property (T-HYGIENE-RECYCLE), the
// RF-MIGRATE multi-migration survival, full RF-CHANGED parity against the numeric .changed filter +
// changedSince + onChange (T-CHANGED-PARITY), the RF-REMOVE-READ window AND its gone-next-frame
// counterpart (T-REMOVE-READ), the createStableIndex maintenance/duplicate-id policy (T-STABLE-INDEX),
// and the miniplex `{ title, meta }` parity smoke. Each test is built to FAIL if its invariant breaks.

import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import {
  createWorld,
  defineComponent,
  object,
  field,
  read,
  write,
  onAdd,
  onChange,
  onRemove,
  createStableIndex,
} from '@ecsia/core'
import type { ComponentDef, EntityHandle, Schema } from '@ecsia/core'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]
const rd = (world: ReturnType<typeof createWorld>, e: EntityHandle, C: ComponentDef<Schema>) =>
  world.entity(e).read(C) as Record<string, unknown>
const wr = (world: ReturnType<typeof createWorld>, e: EntityHandle, C: ComponentDef<Schema>) =>
  world.entity(e).write(C) as Record<string, unknown>

// ===========================================================================
// RF-HYGIENE — randomized spawn/write/despawn with index recycling AND generation wrap
// (T-HYGIENE-RECYCLE). A new tenant at a recycled index must NEVER observe a prior tenant's value. The model is an
// oracle: track the value each LIVE handle should read; assert the sidecar agrees on every read.
// ===========================================================================
describe('RF-HYGIENE — recycle + generation wrap never leak a prior tenant (property, T-HYGIENE-RECYCLE)', () => {
  test('random spawn/write/despawn over a tiny index space: every live read matches the oracle', () => {
    fc.assert(
      fc.property(
        // A small index space + small generationBits so BOTH index recycling and generation WRAP are
        // forced within the op budget — this is the discriminating configuration.
        fc.array(fc.constantFrom<'spawn' | 'write' | 'despawn'>('spawn', 'write', 'despawn', 'write', 'spawn'), {
          minLength: 20,
          maxLength: 120,
        }),
        fc.array(fc.string({ maxLength: 6 }), { minLength: 1, maxLength: 8 }),
        (ops, words) => {
          const Label = defineComponent({ text: 'string' }, { name: 'Label' })
          const world = createWorld({ components: asComps(Label), maxEntities: 4, generationBits: 3 })
          // oracle: live handle → the string it must read ('' until written).
          const live = new Map<EntityHandle, string>()
          let wi = 0
          const nextWord = (): string => words[wi++ % words.length] ?? ''

          const handles = (): EntityHandle[] => [...live.keys()]

          for (const op of ops) {
            if (op === 'spawn') {
              // maxEntities=4 → spawn may fail (capacity); guard.
              let h: EntityHandle
              try {
                h = world.spawn()
              } catch {
                continue
              }
              world.add(h, Label)
              // A FRESH tenant must read the default immediately — the load-bearing leak check.
              expect((rd(world, h, Label).text as string)).toBe('')
              live.set(h, '')
            } else if (op === 'write') {
              const hs = handles()
              if (hs.length === 0) continue
              const h = hs[wi % hs.length]!
              const v = nextWord()
              wr(world, h, Label).text = v
              live.set(h, v)
            } else {
              const hs = handles()
              if (hs.length === 0) continue
              const h = hs[wi % hs.length]!
              world.despawn(h)
              live.delete(h)
            }
            // Invariant: EVERY currently-live handle reads exactly its oracle value. A recycle/wrap leak
            // would surface here as a fresh tenant reading a stale word.
            for (const [h, want] of live) {
              expect(world.isAlive(h)).toBe(true)
              expect(rd(world, h, Label).text as string).toBe(want)
            }
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  test('object<T> recycle: a fresh tenant never aliases the prior tenant object reference', () => {
    const Node = defineComponent({ meta: object<{ v: number }>() }, { name: 'Node' })
    const world = createWorld({ components: asComps(Node), maxEntities: 2, generationBits: 2 })
    const seen: Array<{ v: number }> = []
    for (let i = 0; i < 16; i++) {
      const e = world.spawn()
      world.add(e, Node)
      // fresh tenant reads the undefined default, NOT a prior object.
      expect(rd(world, e, Node).meta).toBeUndefined()
      const ref = { v: i }
      seen.push(ref)
      wr(world, e, Node).meta = ref
      expect(rd(world, e, Node).meta).toBe(ref)
      world.despawn(e)
    }
    // distinct references were never confused.
    expect(new Set(seen).size).toBe(16)
  })
})

// ===========================================================================
// RF-MIGRATE — index-keyed survival across MULTIPLE add/remove migrations. The value
// is set ONCE; a chain of sibling add/removes (each a real archetype relocation) must not perturb it.
// ===========================================================================
describe('RF-MIGRATE — rich value survives a chain of migrations untouched', () => {
  test('write once, then 6 add/remove migrations: string + object both intact each step', () => {
    const Doc = defineComponent({ title: 'string', meta: object<{ tags: string[] }>() }, { name: 'Doc' })
    const A = defineComponent({ a: 'i32' }, { name: 'A' })
    const B = defineComponent({ b: 'f32' }, { name: 'B' })
    const C = defineComponent({ c: 'u8' }, { name: 'C' })
    const world = createWorld({ components: asComps(Doc, A, B, C) })

    const e = world.spawnWith(Doc)
    const tags = ['x', 'y']
    wr(world, e, Doc).title = 'the-title'
    wr(world, e, Doc).meta = { tags }

    const steps: Array<() => void> = [
      () => world.add(e, A),
      () => world.add(e, B),
      () => world.remove(e, A),
      () => world.add(e, C),
      () => world.remove(e, B),
      () => world.remove(e, C),
    ]
    for (const step of steps) {
      step()
      const got = rd(world, e, Doc)
      expect(got.title).toBe('the-title')
      // The SAME object reference survives — index-keyed sidecar performs zero migration carry/copy.
      expect(got.meta).toBe(tags === undefined ? undefined : (got.meta as { tags: string[] }))
      expect((got.meta as { tags: string[] }).tags).toBe(tags)
    }
  })

  test('a rich value written AFTER several migrations is keyed by the same invariant index', () => {
    const Doc = defineComponent({ title: 'string' }, { name: 'Doc2' })
    const A = defineComponent({ a: 'i32' }, { name: 'A2' })
    const world = createWorld({ components: asComps(Doc, A) })
    const e = world.spawnWith(Doc)
    world.add(e, A)
    world.remove(e, A)
    world.add(e, A)
    wr(world, e, Doc).title = 'late-after-migrate'
    world.remove(e, A)
    expect(rd(world, e, Doc).title).toBe('late-after-migrate')
  })
})

// ===========================================================================
// RF-CHANGED — FULL parity with numeric fields: the .changed() query filter, world.changedSince, and
// onChange observers all fire for a rich write exactly as for a numeric write.
// ===========================================================================
describe('RF-CHANGED — parity with numeric fields across all three change surfaces', () => {
  test('.changed() query filter: a rich write surfaces the entity exactly like a numeric write', () => {
    const Mix = defineComponent({ hp: 'i32', title: 'string' }, { name: 'Mix' })
    const world = createWorld({ components: asComps(Mix) })
    const q = world.query(read(Mix)).changed()
    const e = world.spawnWith(Mix)
    world.frameReset()

    // baseline: no write this frame → not in changed set.
    let n = 0
    q.eachChanged(() => n++)
    expect(n).toBe(0)

    // rich write surfaces the row.
    wr(world, e, Mix).title = 'hi'
    n = 0
    q.eachChanged(() => n++)
    expect(n).toBe(1)
  })

  test('numeric-vs-rich parity: writing the rich field marks changed identically to the numeric field', () => {
    const Mix = defineComponent({ hp: 'i32', title: 'string' }, { name: 'MixP' })
    const world = createWorld({ components: asComps(Mix) })
    const q = world.query(write(Mix)).changed()
    const numeric = world.spawnWith(Mix)
    const rich = world.spawnWith(Mix)
    world.frameReset()
    wr(world, numeric, Mix).hp = 5
    wr(world, rich, Mix).title = 'r'
    const idx = new Set<number>()
    q.eachChanged((el) => idx.add((el as { handle: EntityHandle }).handle as unknown as number))
    expect(idx.size).toBe(2) // BOTH the numeric-only and rich-only writers are reported
  })

  test('changedSince predicate is true after a rich write, false again at the current tick', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'LabelCS' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawnWith(Label)
    // touch changedSince once so per-row stamping is enabled (matches the numeric m5 test pattern).
    expect(world.changedSince(e, 0)).toBe(false)
    world.frameReset()
    wr(world, e, Label).text = 'changed'
    expect(world.changedSince(e, 0)).toBe(true)
    expect(world.changedSince(e, world.currentTick())).toBe(false)
  })

  test('onChange observer fires once per frame for a rich write; a read fires nothing', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'LabelOC' })
    const world = createWorld({ components: asComps(Label) })
    let changes = 0
    world.observe(onChange(Label), () => changes++)
    const e = world.spawnWith(Label)
    world.frameReset()
    world.observerDrain()
    changes = 0

    world.frameReset()
    wr(world, e, Label).text = 'a'
    wr(world, e, Label).text = 'b' // dedup → still one change
    world.observerDrain()
    expect(changes).toBe(1)

    // pure read → no change.
    world.frameReset()
    void rd(world, e, Label).text
    world.observerDrain()
    expect(changes).toBe(1)
  })

  test('deep in-place object mutation does NOT track; re-assignment DOES', () => {
    const Node = defineComponent({ meta: object<{ tags: string[] }>() }, { name: 'NodeDM' })
    const world = createWorld({ components: asComps(Node) })
    let changes = 0
    world.observe(onChange(Node), () => changes++)
    const e = world.spawnWith([Node, { meta: { tags: [] } }])
    world.frameReset()
    world.observerDrain()
    changes = 0

    world.frameReset()
    ;(wr(world, e, Node).meta as { tags: string[] }).tags.push('x') // mutate live ref → NOT tracked
    world.observerDrain()
    expect(changes).toBe(0)

    world.frameReset()
    wr(world, e, Node).meta = { tags: ['y'] } // re-assign → tracked
    world.observerDrain()
    expect(changes).toBe(1)
  })
})

// ===========================================================================
// RF-REMOVE-READ — the window: an onRemove observer reads the DYING entity's last rich value; and
// the value is GONE next frame. Both legs are discriminating: the positive leg
// fails against a naive eager-clear, the gone-next-frame leg fails if the deferred entry never flushes.
// ===========================================================================
describe('RF-REMOVE-READ — onRemove reads the dying value; gone next frame', () => {
  test('onRemove observer reads the LAST written rich value (string + object)', () => {
    const Doc = defineComponent({ title: 'string', meta: object<{ k: number }>() }, { name: 'DocRR' })
    const world = createWorld({ components: asComps(Doc) })
    let seenTitle: string | null = null
    let seenMeta: { k: number } | null = null
    world.observe(onRemove(Doc), (ref) => {
      const v = ref.read(Doc) as { title: string; meta: { k: number } }
      seenTitle = v.title
      seenMeta = v.meta
    })
    const e = world.spawnWith(Doc)
    wr(world, e, Doc).title = 'dying'
    wr(world, e, Doc).meta = { k: 99 }
    world.frameReset()
    world.despawn(e)
    world.observerDrain()
    expect(seenTitle).toBe('dying')
    expect(seenMeta).toEqual({ k: 99 })
  })

  test('the dying value is GONE the next frame: a recycled index reads the default', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'LabelRR' })
    const world = createWorld({ components: asComps(Label), maxEntities: 2 })
    let observed = ''
    world.observe(onRemove(Label), (ref) => {
      observed = (ref.read(Label) as { text: string }).text
    })
    const a = world.spawnWith(Label)
    wr(world, a, Label).text = 'tenant-A'
    world.frameReset()
    world.despawn(a)
    world.observerDrain() // observer read window — then pending-clear flushes
    expect(observed).toBe('tenant-A')

    // Next frame a fresh entity reuses the index: it must read the default, never 'tenant-A'.
    const b = world.spawn()
    world.add(b, Label)
    expect(rd(world, b, Label).text).toBe('')
  })

  test('NEGATIVE: with NO remove-observer, the rich value is reclaimed eagerly (no leak)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'LabelNeg' })
    const world = createWorld({ components: asComps(Label), maxEntities: 2 })
    const a = world.spawnWith(Label)
    wr(world, a, Label).text = 'A'
    world.frameReset()
    world.despawn(a)
    world.observerDrain()
    const b = world.spawn()
    world.add(b, Label)
    expect(rd(world, b, Label).text).toBe('')
  })
})

// ===========================================================================
// RF-REMOVE-READ × RF-HYGIENE — a despawn + SAME-WINDOW respawn at the recycled index. The
// pending-clear stash must serve the dying tenant's value ONLY to the dying generation's reads:
// the new tenant's onAdd reads its OWN value (or the default), and the dead tenant's onRemove
// still reads the OLD value — both directions, in one drain.
// ===========================================================================
describe('RF-REMOVE-READ × RF-HYGIENE — same-window respawn at a recycled index', () => {
  test('onAdd reads the NEW tenant value; onRemove reads the OLD tenant value (same drain)', () => {
    const Doc = defineComponent({ title: 'string' }, { name: 'DocRecycle' })
    const world = createWorld({ components: asComps(Doc) })
    let removedSaw: string | null = null
    let addedSaw: string | null = null
    world.observe(onRemove(Doc), (ref) => {
      removedSaw = (ref.read(Doc) as { title: string }).title
    })
    world.observe(onAdd(Doc), (ref) => {
      addedSaw = (ref.read(Doc) as { title: string }).title
    })

    const a = world.spawnWith([Doc, { title: 'old-tenant' }])
    world.frameReset()
    world.observerDrain() // settle a's add event
    addedSaw = null

    world.despawn(a)
    const b = world.spawnWith([Doc, { title: 'new-tenant' }])
    // The free list is LIFO: b reuses a's index inside the same observer window.
    expect(world.decodeHandle(b).index).toBe(world.decodeHandle(a).index)
    world.observerDrain()

    expect(removedSaw).toBe('old-tenant')
    expect(addedSaw).toBe('new-tenant')
  })

  test('respawn WITHOUT a write: onAdd reads the default, never the dead tenant value', () => {
    const Doc = defineComponent({ title: 'string' }, { name: 'DocRecycleDef' })
    const world = createWorld({ components: asComps(Doc) })
    let removedSaw: string | null = null
    let addedSaw: string | null = null
    world.observe(onRemove(Doc), (ref) => {
      removedSaw = (ref.read(Doc) as { title: string }).title
    })
    world.observe(onAdd(Doc), (ref) => {
      addedSaw = (ref.read(Doc) as { title: string }).title
    })

    const a = world.spawnWith([Doc, { title: 'old-tenant' }])
    world.frameReset()
    world.observerDrain()
    addedSaw = null

    world.despawn(a)
    const b = world.spawnWith(Doc)
    expect(world.decodeHandle(b).index).toBe(world.decodeHandle(a).index)
    world.observerDrain()

    expect(removedSaw).toBe('old-tenant')
    expect(addedSaw).toBe('')
  })

  test('TWO despawn/respawn cycles of one index in one window: each event reads its own tenant', () => {
    const Doc = defineComponent({ title: 'string' }, { name: 'DocRecycle2x' })
    const world = createWorld({ components: asComps(Doc) })
    const removed: string[] = []
    const added: string[] = []
    world.observe(onRemove(Doc), (ref) => {
      removed.push((ref.read(Doc) as { title: string }).title)
    })
    world.observe(onAdd(Doc), (ref) => {
      added.push((ref.read(Doc) as { title: string }).title)
    })

    const a = world.spawnWith([Doc, { title: 'tenant-1' }])
    world.frameReset()
    world.observerDrain()
    added.length = 0

    world.despawn(a)
    const b = world.spawnWith([Doc, { title: 'tenant-2' }])
    world.despawn(b)
    const c = world.spawnWith([Doc, { title: 'tenant-3' }])
    expect(world.decodeHandle(c).index).toBe(world.decodeHandle(a).index)
    world.observerDrain()

    expect(removed).toEqual(['tenant-1', 'tenant-2'])
    expect(added).toEqual(['tenant-2', 'tenant-3'])
  })

  test('a rich-free despawn before a rich despawn at the same index does not skew the window', () => {
    // The first tenant holds no rich fields (no stash) but still emits a Destroy entry; the pairing
    // of drain-side Destroys with stashed tenants must count it, or the second tenant's stash is
    // superseded one re-mint early and its events read the THIRD tenant's value.
    const Num = defineComponent({ v: 'i32' }, { name: 'NumMixed' })
    const Doc = defineComponent({ title: 'string' }, { name: 'DocMixed' })
    const world = createWorld({ components: asComps(Num, Doc) })
    const removed: string[] = []
    const added: string[] = []
    world.observe(onRemove(Num), () => {})
    world.observe(onRemove(Doc), (ref) => {
      removed.push((ref.read(Doc) as { title: string }).title)
    })
    world.observe(onAdd(Doc), (ref) => {
      added.push((ref.read(Doc) as { title: string }).title)
    })

    const t1 = world.spawnWith([Num, { v: 1 }])
    world.frameReset()
    world.observerDrain()

    world.despawn(t1)
    const t2 = world.spawnWith([Doc, { title: 'rich-2' }])
    expect(world.decodeHandle(t2).index).toBe(world.decodeHandle(t1).index)
    world.despawn(t2)
    const t3 = world.spawnWith([Doc, { title: 'rich-3' }])
    expect(world.decodeHandle(t3).index).toBe(world.decodeHandle(t1).index)
    world.observerDrain()

    expect(removed).toEqual(['rich-2'])
    expect(added).toEqual(['rich-2', 'rich-3'])
  })

  test('replace-load shape (despawn ALL + respawn all in one window): no cross-tenant reads', () => {
    // The core mechanics of load(bytes, 'replace'): every index is freed then re-minted before the
    // next drain. LIFO recycling re-mints the indices in REVERSE order, so respawning the same uids
    // in the same order swaps the uid↔index assignment — an onAdd read served from the dead
    // tenant's stash would record the OTHER entity's uid against this handle.
    const Id = defineComponent({ uid: 'string' }, { name: 'IdReplace' })
    const world = createWorld({ components: asComps(Id) })
    const removed: string[] = []
    const seenAtAdd = new Map<string, EntityHandle>()
    world.observe(onRemove(Id), (ref) => {
      removed.push((ref.read(Id) as { uid: string }).uid)
    })
    world.observe(onAdd(Id), (ref) => {
      seenAtAdd.set((ref.read(Id) as { uid: string }).uid, ref.handle)
    })

    const a = world.spawnWith([Id, { uid: 'u0' }])
    const b = world.spawnWith([Id, { uid: 'u1' }])
    world.frameReset()
    world.observerDrain()
    seenAtAdd.clear()

    world.despawn(a)
    world.despawn(b)
    world.spawnWith([Id, { uid: 'u0' }])
    world.spawnWith([Id, { uid: 'u1' }])
    world.observerDrain()

    expect(removed.sort()).toEqual(['u0', 'u1'])
    for (const uid of ['u0', 'u1']) {
      const h = seenAtAdd.get(uid)
      expect(h).toBeDefined()
      expect((world.entity(h as EntityHandle).read(Id) as { uid: string }).uid).toBe(uid)
    }
  })
})

// ===========================================================================
// createStableIndex — add/remove/despawn maintenance, lookup correctness, duplicate-id policy
// (T-STABLE-INDEX). The util is observer-driven, so ids resolve at the drain.
// ===========================================================================
describe('createStableIndex — maintenance, lookup, duplicate-id policy', () => {
  test('resolves id→handle after add; drops on despawn', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'IdA' })
    const world = createWorld({ components: asComps(Id) })
    const idx = createStableIndex(world, Id, 'id')
    const a = world.spawnWith([Id, { id: 'alpha' }])
    world.frameReset()
    world.observerDrain()
    expect(idx.get('alpha')).toBe(a)
    expect(idx.has('alpha')).toBe(true)
    expect(idx.get('missing')).toBeUndefined()

    world.despawn(a)
    world.observerDrain()
    expect(idx.get('alpha')).toBeUndefined()
    expect(idx.has('alpha')).toBe(false)
    idx.dispose()
  })

  test('drops the mapping when the indexed component is REMOVED (not just despawn)', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'IdR' })
    const Other = defineComponent({ v: 'i32' }, { name: 'OtherR' })
    const world = createWorld({ components: asComps(Id, Other) })
    const idx = createStableIndex(world, Id, 'id')
    const e = world.spawnWith([Id, { id: 'k' }])
    world.add(e, Other)
    world.observerDrain()
    expect(idx.get('k')).toBe(e)
    world.remove(e, Id) // onRemove(Id) fires though the entity stays alive
    world.observerDrain()
    expect(idx.get('k')).toBeUndefined()
    expect(world.isAlive(e)).toBe(true)
    idx.dispose()
  })

  test('duplicate id: last writer wins', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'IdD' })
    const world = createWorld({ components: asComps(Id) })
    const idx = createStableIndex(world, Id, 'id')
    world.spawnWith([Id, { id: 'dup' }])
    const b = world.spawnWith([Id, { id: 'dup' }])
    world.observerDrain()
    expect(idx.get('dup')).toBe(b)
    idx.dispose()
  })

  test('dispose stops tracking: later spawns are not indexed', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'IdDisp' })
    const world = createWorld({ components: asComps(Id) })
    const idx = createStableIndex(world, Id, 'id')
    idx.dispose()
    world.spawnWith([Id, { id: 'after' }])
    world.observerDrain()
    expect(idx.get('after')).toBeUndefined()
  })
})

// ===========================================================================
// Miniplex-parity smoke — defineComponent({ title: 'string', meta: object<{...}>() }) used end-to-end:
// spawn tuple values, query, mutate. (Snapshot round-trip is exercised in @ecsia/serialization.)
// ===========================================================================
describe('miniplex-parity smoke — { title, meta } end to end', () => {
  test('spawn tuple values → query → mutate', () => {
    interface Meta {
      author: string
      tags: string[]
    }
    const Node = defineComponent(
      { title: field('string', { default: 'untitled' }), meta: object<Meta>(), z: 'f32' },
      { name: 'NodeMP' },
    )
    const world = createWorld({ components: asComps(Node) })

    const a = world.spawnWith([Node, { title: 'A', meta: { author: 'ann', tags: ['t1'] }, z: 1 }])
    const b = world.spawnWith(Node) // defaults: title 'untitled', meta undefined, z 0

    // query the rich-bearing component and read tuple values back.
    const q = world.query(read(Node))
    const seen = new Map<number, { title: string; author: string | undefined; z: number }>()
    for (const el of q as Iterable<{ handle: EntityHandle }>) {
      const v = world.entity(el.handle).read(Node) as { title: string; meta: Meta | undefined; z: number }
      seen.set(el.handle as unknown as number, { title: v.title, author: v.meta?.author, z: v.z })
    }
    expect(seen.get(a as unknown as number)).toEqual({ title: 'A', author: 'ann', z: 1 })
    expect(seen.get(b as unknown as number)).toEqual({ title: 'untitled', author: undefined, z: 0 })

    // mutate: re-assign the object + bump the string + numeric, all on the same component.
    const wb = world.entity(b).write(Node) as { title: string; meta: Meta; z: number }
    wb.title = 'B'
    wb.meta = { author: 'bob', tags: ['t2', 't3'] }
    wb.z = 4
    const rb = world.entity(b).read(Node) as { title: string; meta: Meta; z: number }
    expect(rb.title).toBe('B')
    expect(rb.meta).toEqual({ author: 'bob', tags: ['t2', 't3'] })
    expect(rb.z).toBe(4)
  })
})
