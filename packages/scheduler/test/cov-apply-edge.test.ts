// Coverage: commands/apply.ts — the deterministic merge + validate-then-apply edge cases
// Hand-built command buffers drive each branch precisely: drop-if-dead,
// the NO_ENTITY OP_CREATE guard, drain removes-before-adds, SET_PAYLOAD fold-vs-drain-vs-absent,
// ADD_PAIR wired-vs-unwired, and the corrupt-opcode throw.

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent, handleIndex } from '@ecsia/core'
import type { EntityHandle, World } from '@ecsia/core'
import { flushAll, makeCommandBuffer, buildFieldCodec, Op } from '../src/internal.js'
import type { CommandBuffer, ComponentFieldCodec, WorldApply } from '../src/internal.js'
import type { ComponentDef, RelationId, Schema } from '@ecsia/schema'

function kit() {
  const Health = defineComponent({ hp: 'i32' }, { name: 'apply_health' })
  const Armor = defineComponent({ ac: 'i32' }, { name: 'apply_armor' })
  const world = createWorld({ components: [Health, Armor], maxEntities: 1 << 12 })
  const codecById = new Map<number, ComponentFieldCodec>([
    [(Health as unknown as { id: number }).id, buildFieldCodec(Health)],
    [(Armor as unknown as { id: number }).id, buildFieldCodec(Armor)],
  ])
  return { world, Health, Armor, codecById }
}

interface ApplyOpts {
  withAddPair?: boolean
  withRemovePair?: boolean
  addPairCalls?: Array<{ s: number; rid: number; t: number; payload: unknown }>
  removePairCalls?: Array<{ s: number; rid: number; t: number }>
}

function worldApplyOf(
  world: World,
  codecById: ReadonlyMap<number, ComponentFieldCodec>,
  warns: string[],
  opts: ApplyOpts = {},
): WorldApply {
  const layout = world.handleLayout
  const apply = world.__apply
  const base: WorldApply = {
    isAlive: (h) => world.isAlive(h),
    handleIndex: (h) => handleIndex(h, layout) as number,
    spawnReserved: (h) => world.__spawnReserved(h),
    despawn: (h) => world.despawn(h),
    defOf: (id) => apply.defOf(id),
    codecOf: (id) => codecById.get(id as unknown as number),
    addMany: (h, defs) => apply.addMany(h, defs),
    removeMany: (h, defs) => apply.removeMany(h, defs),
    has: (h, def) => world.has(h, def),
    writePayload: (h, def, values) => apply.writePayload(h, def, values),
    returnUnused: () => {},
    warn: (m) => warns.push(m),
  }
  if (opts.withAddPair) {
    base.addPair = (s, rid, t, payload) =>
      opts.addPairCalls?.push({ s: s as number, rid: rid as number, t: t as number, payload })
  }
  if (opts.withRemovePair) {
    base.removePair = (s, rid, t) =>
      opts.removePairCalls?.push({ s: s as number, rid: rid as number, t: t as number })
  }
  return base
}

/** A tiny record writer for hand-built buffers (mirrors encode.ts but lets us forge edge records). */
class Rec {
  words = new Uint32Array(256)
  head = 0
  private push(...w: number[]): void {
    for (const x of w) this.words[this.head++] = x >>> 0
  }
  create(h: number): this {
    this.push(Op.CREATE, h)
    return this
  }
  destroy(h: number): this {
    this.push(Op.DESTROY, h)
    return this
  }
  add(h: number, cid: number, payload?: ComponentFieldCodec, values?: Record<string, unknown>): this {
    const f = payload && values ? payload.totalWords : 0
    this.push(Op.ADD, h, cid, f)
    if (f > 0) {
      payload!.encode(values!, this.words, this.head)
      this.head += f
    }
    return this
  }
  remove(h: number, cid: number): this {
    this.push(Op.REMOVE, h, cid)
    return this
  }
  setPayload(h: number, cid: number, payload: ComponentFieldCodec, values: Record<string, unknown>): this {
    this.push(Op.SET_PAYLOAD, h, cid, payload.totalWords)
    payload.encode(values, this.words, this.head)
    this.head += payload.totalWords
    return this
  }
  addPair(s: number, rid: number, t: number): this {
    this.push(Op.ADD_PAIR, s, rid, t, 0)
    return this
  }
  removePair(s: number, rid: number, t: number): this {
    this.push(Op.REMOVE_PAIR, s, rid, t)
    return this
  }
  raw(...w: number[]): this {
    this.push(...w)
    return this
  }
  buffer(workerIndex = 0): CommandBuffer {
    const cb = makeCommandBuffer(workerIndex, Math.max(this.head, 16), false)
    cb.words.set(this.words.subarray(0, this.head))
    cb.head = this.head
    cb.recordCount = 1
    return cb
  }
}

const cidOf = (def: ComponentDef<Schema>): number => (def as unknown as { id: number }).id
const readHp = (world: World, e: number | EntityHandle, def: ComponentDef<Schema>): number =>
  (world.entity(e as unknown as EntityHandle).read(def) as { hp?: number; ac?: number }).hp ??
  (world.entity(e as unknown as EntityHandle).read(def) as { ac: number }).ac

describe('apply.ts: OP_CREATE NO_ENTITY guard (lines 144-147)', () => {
  test('a forged OP_CREATE naming NO_ENTITY (0xffffffff) is dropped with a warn, never spawned', () => {
    const { world, codecById } = kit()
    const warns: string[] = []
    const cb = new Rec().create(0xffffffff).buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(cb.appliedCreateCount).toBe(0) // not counted toward applied creates
    expect(warns.some((m) => /NO_ENTITY|reservation exhausted/i.test(m))).toBe(true)
  })
})

describe('apply.ts: drop-if-dead gate (validateSubject warns) across ops', () => {
  test('OP_REMOVE on a never-alive handle is dropped with a dead-entity warn (lines 177-187, branch 177)', () => {
    const { world, Health, codecById } = kit()
    const warns: string[] = []
    // Handle 5 was never reserved/created → dead.
    const cb = new Rec().remove(5, cidOf(Health)).buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(warns.some((m) => /dead entity/i.test(m))).toBe(true)
  })

  test('OP_REMOVE on a live entity coalesces into a removeMany migration (lines 119-121, 178-185)', () => {
    const { world, Health, Armor, codecById } = kit()
    const e = world.spawn()
    world.add(e, Health, { hp: 10 })
    world.add(e, Armor, { ac: 3 })
    expect(world.has(e, Health)).toBe(true)
    const warns: string[] = []
    const cb = new Rec().remove(e as number, cidOf(Health)).buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.has(e, Health)).toBe(false) // removeMany ran (the removes-branch in drain)
    expect(world.has(e, Armor)).toBe(true) // unrelated component untouched
  })

  test('a remove-then-add of distinct ids on one entity lands both (removes-before-adds)', () => {
    const { world, Health, Armor, codecById } = kit()
    const e = world.spawn()
    world.add(e, Health, { hp: 7 })
    const warns: string[] = []
    // Same wave: REMOVE Health then ADD Armor. drain() must apply removeMany THEN addMany.
    const cb = new Rec()
      .remove(e as number, cidOf(Health))
      .add(e as number, cidOf(Armor), codecById.get(cidOf(Armor)), { ac: 9 })
      .buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.has(e, Health)).toBe(false)
    expect(world.has(e, Armor)).toBe(true)
    expect(readHp(world, e, Armor)).toBe(9)
  })

  test('REMOVE cancels a same-wave ADD of the same id (removeFrom adds, line 182-184)', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn()
    const warns: string[] = []
    // ADD Health then REMOVE Health in the same wave → net no-op; Health absent afterwards.
    const cb = new Rec()
      .add(e as number, cidOf(Health), codecById.get(cidOf(Health)), { hp: 5 })
      .remove(e as number, cidOf(Health))
      .buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.has(e, Health)).toBe(false) // the add was cancelled before the migration
  })
})

describe('apply.ts: SET_PAYLOAD edge cases (lines 197-202, branches 197/201)', () => {
  test('SET_PAYLOAD on a same-wave pending ADD folds into the add payload (line 197-198)', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn()
    const warns: string[] = []
    const hc = codecById.get(cidOf(Health))!
    // ADD Health{hp:1} then SET_PAYLOAD Health{hp:42}: the set must overwrite the pending add's payload,
    // so the single migration lands hp=42 (NOT a separate write, since the component is not yet present).
    const cb = new Rec()
      .add(e as number, cidOf(Health), hc, { hp: 1 })
      .setPayload(e as number, cidOf(Health), hc, { hp: 42 })
      .buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.has(e, Health)).toBe(true)
    expect(readHp(world, e, Health)).toBe(42) // folded value, not 1
    expect(warns.some((m) => /absent component/i.test(m))).toBe(false)
  })

  test('SET_PAYLOAD on an already-present component drains then writes (line 200-201)', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn()
    world.add(e, Health, { hp: 3 })
    const warns: string[] = []
    const hc = codecById.get(cidOf(Health))!
    const cb = new Rec().setPayload(e as number, cidOf(Health), hc, { hp: 77 }).buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(readHp(world, e, Health)).toBe(77)
    expect(warns.length).toBe(0)
  })

  test('SET_PAYLOAD on an ABSENT component (no add pending, not present) warns and writes nothing (line 202)', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn() // Health NOT added
    const warns: string[] = []
    const hc = codecById.get(cidOf(Health))!
    const cb = new Rec().setPayload(e as number, cidOf(Health), hc, { hp: 5 }).buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.has(e, Health)).toBe(false) // nothing written
    expect(warns.some((m) => /absent component/i.test(m))).toBe(true)
  })
})

describe('apply.ts: CREATE then ADD/SET in same flush treats the reserved handle as alive', () => {
  test('OP_CREATE makes a reserved handle alive so a following OP_ADD applies (newlyCreated whitelist)', () => {
    const { world, Health, codecById } = kit()
    const block = world.reserveEntityBlock(0, 1)
    const h = block.handles[0]! as number
    const warns: string[] = []
    const cb = new Rec()
      .create(h)
      .add(h, cidOf(Health), codecById.get(cidOf(Health)), { hp: 11 })
      .buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(cb.appliedCreateCount).toBe(1)
    expect(world.isAlive(h as unknown as EntityHandle)).toBe(true)
    expect(world.has(h as unknown as EntityHandle, Health)).toBe(true)
    expect(readHp(world, h, Health)).toBe(11)
  })

  test('OP_DESTROY tombstones an entity so a LATER op on it this flush is dropped (lines 97-100)', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn() as number
    const warns: string[] = []
    // DESTROY e, then ADD Health to e in the SAME flush → second op references a tombstoned index.
    const cb = new Rec()
      .destroy(e)
      .add(e, cidOf(Health), codecById.get(cidOf(Health)), { hp: 1 })
      .buffer()
    flushAll(worldApplyOf(world, codecById, warns), [cb])
    expect(world.isAlive(e as unknown as EntityHandle)).toBe(false)
    expect(warns.some((m) => /destroyed earlier this flush/i.test(m))).toBe(true)
  })
})

describe('apply.ts: relation ops (ADD_PAIR/REMOVE_PAIR, lines 218-227, 235-238)', () => {
  test('ADD_PAIR with addPair wired applies the pair with an undefined (deferred) payload', () => {
    const { world, codecById } = kit()
    const s = world.spawn() as number
    const t = world.spawn() as number
    const calls: Array<{ s: number; rid: number; t: number; payload: unknown }> = []
    const warns: string[] = []
    const cb = new Rec().addPair(s, 0, t).buffer()
    flushAll(worldApplyOf(world, codecById, warns, { withAddPair: true, addPairCalls: calls }), [cb])
    expect(calls).toEqual([{ s, rid: 0, t, payload: undefined }]) // payload deferred
  })

  test('ADD_PAIR drops if the TARGET is dead (both subject and target gated)', () => {
    const { world, codecById } = kit()
    const s = world.spawn() as number
    const warns: string[] = []
    const calls: Array<{ s: number; rid: number; t: number; payload: unknown }> = []
    // Target 999 never alive → the pair is dropped, addPair never called.
    const cb = new Rec().addPair(s, 0, 999).buffer()
    flushAll(worldApplyOf(world, codecById, warns, { withAddPair: true, addPairCalls: calls }), [cb])
    expect(calls.length).toBe(0)
    expect(warns.some((m) => /dead entity/i.test(m))).toBe(true)
  })

  test('ADD_PAIR with relations NOT wired warns (lines 225-227, branch 225)', () => {
    const { world, codecById } = kit()
    const s = world.spawn() as number
    const t = world.spawn() as number
    const warns: string[] = []
    const cb = new Rec().addPair(s, 0, t).buffer()
    flushAll(worldApplyOf(world, codecById, warns, { withAddPair: false }), [cb])
    expect(warns.some((m) => /relations are not wired/i.test(m))).toBe(true)
  })

  test('REMOVE_PAIR with removePair wired forwards the triple (lines 235-238)', () => {
    const { world, codecById } = kit()
    const s = world.spawn() as number
    const t = world.spawn() as number
    const removeCalls: Array<{ s: number; rid: number; t: number }> = []
    const cb = new Rec().removePair(s, 2, t).buffer()
    flushAll(
      worldApplyOf(world, codecById, [], { withRemovePair: true, removePairCalls: removeCalls }),
      [cb],
    )
    expect(removeCalls).toEqual([{ s, rid: 2, t }])
  })

  test('REMOVE_PAIR on a dead subject is dropped (validateSubject gate, branch 235)', () => {
    const { world, codecById } = kit()
    const warns: string[] = []
    const removeCalls: Array<{ s: number; rid: number; t: number }> = []
    const cb = new Rec().removePair(404, 2, 405).buffer()
    flushAll(
      worldApplyOf(world, codecById, warns, { withRemovePair: true, removePairCalls: removeCalls }),
      [cb],
    )
    expect(removeCalls.length).toBe(0)
    expect(warns.some((m) => /dead entity/i.test(m))).toBe(true)
  })
})

describe('apply.ts: corrupt opcode throws (lines 241-242, branch 241)', () => {
  test('an unknown opcode raises a corrupt-command-buffer error', () => {
    const { world, codecById } = kit()
    const rec = new Rec()
    rec.raw(99 /* bad opcode */, 0)
    const cb = rec.buffer()
    expect(() => flushAll(worldApplyOf(world, codecById, []), [cb])).toThrow(/corrupt command buffer|bad opcode/i)
  })
})

describe('apply.ts: deterministic merge order across workers', () => {
  test('buffers are applied in ascending workerIndex regardless of array order', () => {
    const { world, Health, codecById } = kit()
    const e = world.spawn() as number
    const hc = codecById.get(cidOf(Health))!
    // Worker 1 sets hp=1, worker 0 sets hp=0. Passed out of order [w1, w0]; ascending order means
    // w0 applies first then w1 LAST → final hp=1. (Deterministic regardless of array order.)
    const w1 = new Rec().add(e, cidOf(Health), hc, { hp: 1 }).buffer(1)
    const w0 = new Rec().setPayload(e, cidOf(Health), hc, { hp: 0 }).buffer(0)
    // w0 sets payload on an absent component first (warns, no-op), then w1 adds hp=1.
    const warns: string[] = []
    flushAll(worldApplyOf(world, codecById, warns), [w1, w0])
    expect(world.has(e, Health)).toBe(true)
    expect(readHp(world, e, Health)).toBe(1) // w1 (add) won because it applies after w0
  })
})
