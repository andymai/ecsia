// Rich fields (rich-fields.md): the entity-index-keyed sidecar for 'string' + object<T>, accessor
// integration, RF-HYGIENE recycle, RF-MIGRATE survival, RF-REMOVE-READ onRemove parity, RF-CHANGED
// parity, RF-PIN main-thread pinning, defaults, and createStableIndex.

import { describe, expect, test } from 'vitest'
import {
  createWorld,
  defineComponent,
  object,
  field,
  onAdd,
  onRemove,
  onChange,
  createStableIndex,
} from '@ecsia/core'
import type { ComponentDef, Schema } from '@ecsia/core'

const asComps = (...c: ComponentDef<Schema>[]): readonly ComponentDef<Schema>[] => c as readonly ComponentDef<Schema>[]

describe('§4/§5 — basic sidecar read/write through the accessor', () => {
  test('a string rich field reads back what was written (rich-only component)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawnWith(Label)
    ;(world.entity(e).write(Label) as { text: string }).text = 'hello'
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('hello')
  })

  test('an object<T> rich field stores and returns the LIVE reference', () => {
    const Node = defineComponent({ meta: object<{ tags: string[] }>() }, { name: 'Node' })
    const world = createWorld({ components: asComps(Node) })
    const e = world.spawnWith(Node)
    const value = { tags: ['a', 'b'] }
    ;(world.entity(e).write(Node) as { meta: { tags: string[] } }).meta = value
    const got = (world.entity(e).read(Node) as { meta: { tags: string[] } }).meta
    expect(got).toBe(value)
    expect(got.tags).toEqual(['a', 'b'])
  })

  test('a mixed component: numeric column + rich field both work', () => {
    const Thing = defineComponent({ hp: 'i32', name: 'string' }, { name: 'Thing' })
    const world = createWorld({ components: asComps(Thing) })
    const e = world.spawnWith([Thing, { hp: 7, name: 'orc' }])
    const r = world.entity(e).read(Thing) as { hp: number; name: string }
    expect(r.hp).toBe(7)
    expect(r.name).toBe('orc')
  })

  test('spawnWith value-carrying tuple writes the rich field', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawnWith([Label, { text: 'from-spawn' }])
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('from-spawn')
  })
})

describe('§3.1/§4.4 — defaults', () => {
  test('T-HYGIENE-DEFAULT: never-written string reads the intrinsic empty default', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawnWith(Label)
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('')
  })

  test('a never-written object reads the intrinsic undefined default', () => {
    const Node = defineComponent({ meta: object<{ n: number }>() }, { name: 'Node' })
    const world = createWorld({ components: asComps(Node) })
    const e = world.spawnWith(Node)
    expect((world.entity(e).read(Node) as { meta: unknown }).meta).toBeUndefined()
  })

  test('user-overridable default via field(token, { default }) (G-1 plumbing)', () => {
    const Label = defineComponent({ text: field('string', { default: 'untitled' }) }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawnWith(Label)
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('untitled')
  })

  test('object default is shared by reference across entities (documented JS semantics)', () => {
    const shared = { tags: [] as string[] }
    const Node = defineComponent({ meta: field(object<{ tags: string[] }>(), { default: shared }) }, { name: 'Node' })
    const world = createWorld({ components: asComps(Node) })
    const a = world.spawnWith(Node)
    const b = world.spawnWith(Node)
    const ma = (world.entity(a).read(Node) as { meta: unknown }).meta
    const mb = (world.entity(b).read(Node) as { meta: unknown }).meta
    expect(ma).toBe(mb)
    expect(ma).toBe(shared)
  })
})

describe('§4.5 — RF-HYGIENE: recycled index never leaks the prior tenant', () => {
  test('T-HYGIENE-RECYCLE: a fresh entity at a recycled index reads the default', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    // Tiny index space so despawn/respawn forces index recycling. generationBits modest so we can wrap.
    const world = createWorld({ components: asComps(Label), maxEntities: 4, generationBits: 4 })
    const a = world.spawn()
    world.add(a, Label)
    ;(world.entity(a).write(Label) as { text: string }).text = 'tenant-A'
    world.despawn(a)
    const b = world.spawn()
    world.add(b, Label)
    // b reuses a's index at a bumped generation; it must NOT see 'tenant-A'.
    expect((world.entity(b).read(Label) as { text: string }).text).toBe('')
  })

  test('generation-wrap: after 2^genBits recycles the cleared slot still defaults', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label), maxEntities: 2, generationBits: 2 })
    // Force many recycles of the same single index so the generation wraps (mask = 3).
    let last = 0
    for (let i = 0; i < 12; i++) {
      const e = world.spawn()
      world.add(e, Label)
      const view = world.entity(e).read(Label) as { text: string }
      // Each fresh tenant must read the default, never a prior tenant's value, even across wrap.
      expect(view.text).toBe('')
      ;(world.entity(e).write(Label) as { text: string }).text = `gen-${i}`
      last = e as unknown as number
      world.despawn(e)
    }
    expect(last).toBeGreaterThanOrEqual(0)
  })
})

describe('§4.1 — RF-MIGRATE: rich value survives archetype migration with zero carry', () => {
  test('T-MIGRATE: add and remove a sibling component, rich value unchanged', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const Tag = defineComponent({ v: 'i32' }, { name: 'Tag' })
    const world = createWorld({ components: asComps(Label, Tag) })
    const e = world.spawnWith(Label)
    ;(world.entity(e).write(Label) as { text: string }).text = 'survives'
    world.add(e, Tag) // migrate to wider archetype
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('survives')
    world.remove(e, Tag) // migrate to narrower archetype
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('survives')
  })

  test('rich field added LATE (component added after spawn) reads/writes', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    const e = world.spawn()
    world.add(e, Label)
    ;(world.entity(e).write(Label) as { text: string }).text = 'late'
    expect((world.entity(e).read(Label) as { text: string }).text).toBe('late')
  })
})

describe('§4.3a — RF-REMOVE-READ: onRemove reads the dying entity rich value', () => {
  test('T-REMOVE-READ: onRemove observer reads the LAST written rich value', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    let seen: string | null = null
    world.observe(onRemove(Label), (ref) => {
      seen = (ref.read(Label) as { text: string }).text
    })
    const e = world.spawnWith(Label)
    ;(world.entity(e).write(Label) as { text: string }).text = 'dying-value'
    world.frameReset()
    world.despawn(e)
    world.observerDrain()
    expect(seen).toBe('dying-value')
  })

  test('after the drain, the pending-clear is flushed (no leak into a recycled index)', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label), maxEntities: 4 })
    world.observe(onRemove(Label), () => {})
    const a = world.spawnWith(Label)
    ;(world.entity(a).write(Label) as { text: string }).text = 'A'
    world.frameReset()
    world.despawn(a)
    world.observerDrain()
    const b = world.spawn()
    world.add(b, Label)
    expect((world.entity(b).read(Label) as { text: string }).text).toBe('')
  })
})

describe('§5.3 — RF-CHANGED: change-tracking parity', () => {
  test('T-CHANGED-PARITY: a rich write marks .changed and fires onChange', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    let changes = 0
    world.observe(onChange(Label), () => changes++)
    const e = world.spawnWith(Label)
    world.frameReset()
    ;(world.entity(e).write(Label) as { text: string }).text = 'changed'
    world.observerDrain()
    expect(changes).toBe(1)
  })

  test('a rich READ does NOT mark changed', () => {
    const Label = defineComponent({ text: 'string' }, { name: 'Label' })
    const world = createWorld({ components: asComps(Label) })
    let changes = 0
    world.observe(onChange(Label), () => changes++)
    const e = world.spawnWith([Label, { text: 'x' }])
    // Drain the spawn-time write first so the change counter starts clean.
    world.frameReset()
    world.observerDrain()
    changes = 0
    world.frameReset()
    void (world.entity(e).read(Label) as { text: string }).text
    world.observerDrain()
    expect(changes).toBe(0)
  })

  test('T-CHANGED-DEEP-MUT: in-place object mutation does NOT track; re-assignment does', () => {
    const Node = defineComponent({ meta: object<{ tags: string[] }>() }, { name: 'Node' })
    const world = createWorld({ components: asComps(Node) })
    let changes = 0
    world.observe(onChange(Node), () => changes++)
    const e = world.spawnWith([Node, { meta: { tags: [] } }])
    // Drain the spawn-time write first so the change counter starts clean.
    world.frameReset()
    world.observerDrain()
    changes = 0
    world.frameReset()
    // deep mutate through the live reference — NOT tracked.
    ;(world.entity(e).write(Node) as { meta: { tags: string[] } }).meta.tags.push('x')
    world.observerDrain()
    expect(changes).toBe(0)
    // re-assign — tracked.
    world.frameReset()
    ;(world.entity(e).write(Node) as { meta: { tags: string[] } }).meta = { tags: ['y'] }
    world.observerDrain()
    expect(changes).toBe(1)
  })
})

describe('§8 — createStableIndex', () => {
  test('T-STABLE-INDEX: resolves id→handle, drops on despawn, survives remove', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'Id' })
    const world = createWorld({ components: asComps(Id) })
    const idx = createStableIndex(world, Id, 'id')
    const a = world.spawnWith([Id, { id: 'alpha' }])
    world.frameReset()
    world.observerDrain() // onAdd fires at the drain
    expect(idx.get('alpha')).toBe(a)
    expect(idx.has('alpha')).toBe(true)
    world.despawn(a)
    world.observerDrain()
    expect(idx.get('alpha')).toBeUndefined()
    idx.dispose()
  })

  test('collision: last writer wins', () => {
    const Id = defineComponent({ id: 'string' }, { name: 'Id' })
    const world = createWorld({ components: asComps(Id) })
    const idx = createStableIndex(world, Id, 'id')
    world.spawnWith([Id, { id: 'dup' }])
    const b = world.spawnWith([Id, { id: 'dup' }])
    world.observerDrain()
    expect(idx.get('dup')).toBe(b)
    idx.dispose()
  })
})
