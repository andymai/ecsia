// Regression: reverse relation lookups (subjectsOf) must resolve for pairs applied via a replication
// DELTA, not just a baseline. Exclusive pairs ride the eid column rather than a journaled PairAdd, so
// the receiver must rebuild the backref from that column on apply (reindexAfterApply). Covers fresh
// adds, new->new pairs, and re-targets (which send no removal signal).
import { describe, it, expect } from 'vitest'
import {
  createWorld,
  createRelations,
  createScheduler,
  createReplicationStream,
  createReplicationReceiver,
  encodeReplicationMessage,
  decodeReplicationMessage,
  defineComponent,
  read,
} from '@ecsia/kit'
import type { EntityHandle } from '@ecsia/kit'

const makeDefs = () => ({ Tag: defineComponent({ n: 'u32' }, { name: 'tag' }) })

describe('replication delta — exclusive-relation reverse index', () => {
  it('subjectsOf resolves for delta-applied pairs (fresh add, new->new, and re-target)', () => {
    const S = makeDefs()
    const server = createWorld({ components: Object.values(S), maxEntities: 1 << 12 })
    const sRel = createRelations(server)
    const R = sRel.defineRelation(null, { exclusive: true })
    const sSched = createScheduler(server, [])
    const stream = createReplicationStream(server)

    const C = makeDefs()
    const client = createWorld({ components: Object.values(C), maxEntities: 1 << 12 })
    const cRel = createRelations(client)
    const CR = cRel.defineRelation(null, { exclusive: true })
    const cSched = createScheduler(client, [])
    const receiver = createReplicationReceiver(client)

    const join = (): void => {
      sSched.update(1 / 60)
      stream.tick()
      receiver.apply(decodeReplicationMessage(encodeReplicationMessage(stream.baseline())))
      cSched.update(1 / 60)
    }
    const tick = (mutate: () => void): void => {
      sSched.update(1 / 60)
      mutate()
      receiver.apply(decodeReplicationMessage(encodeReplicationMessage(stream.tick())))
      cSched.update(1 / 60)
    }
    const byN = (n: number): EntityHandle | undefined => {
      for (const e of client.query(read(C.Tag))) if (e.tag.n === n) return e.handle
      return undefined
    }
    const subjectsOf = (target: EntityHandle): number[] => [...cRel.subjectsOf(CR, target)].sort((a, b) => a - b)

    // baseline: two anchors + one pre-existing subject
    const anchorA = server.spawnWith([S.Tag, { n: 10 }])
    const anchorB = server.spawnWith([S.Tag, { n: 20 }])
    const pre = server.spawnWith([S.Tag, { n: 4 }])
    join()

    // delta 1: a NEW subject and the PRE-EXISTING subject both pair to anchorA; plus a new->new pair
    let child!: EntityHandle
    let other!: EntityHandle
    tick(() => {
      child = server.spawnWith([S.Tag, { n: 2 }])
      other = server.spawnWith([S.Tag, { n: 3 }])
      sRel.addPair(child, R, anchorA) // new subject -> baseline target
      sRel.addPair(pre, R, anchorA) // pre-existing subject -> baseline target
      sRel.addPair(other, R, child) // new subject -> new target
    })

    const cA = byN(10)!
    const cChild = byN(2)!
    const cPre = byN(4)!
    const cOther = byN(3)!

    // forward still works
    expect(cRel.targetOf(cChild, CR)).toBe(cA)
    // reverse now works for ALL delta-applied pairs
    expect(subjectsOf(cA)).toEqual([cChild, cPre].sort((a, b) => a - b))
    expect(subjectsOf(cChild)).toEqual([cOther])

    // delta 2: re-target `child` from anchorA to anchorB (an in-place eid write, no removal op)
    tick(() => {
      sRel.addPair(child, R, anchorB)
    })
    const cB = byN(20)!
    expect(cRel.targetOf(cChild, CR)).toBe(cB)
    expect(subjectsOf(cB)).toEqual([cChild]) // moved here
    expect(subjectsOf(cA)).toEqual([cPre]) // child no longer here; pre remains
  })
})
