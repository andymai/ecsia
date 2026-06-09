// Coverage: graph/edges.ts (offer self-edge guard, resolveOrdering unregistered throw, class-hint
// resolution + missing-writer/reader continues, deny suppression) and graph/dag.ts (cycle reporting:
// edgeOf empty-cause fallback, name fallback, cause-less edge formatting).

import { describe, expect, test } from 'vitest'
import { createWorld, defineComponent } from '@ecsia/core'
import { beforeWritersOf, afterReadersOf, defineSystem, inAnyOrderWith } from '@ecsia/scheduler'
import { CycleError, EdgeWeight, aggregateAccess, buildDAG, buildEdges, lowerSystems, resolveOrdering } from '../src/internal.js'
import type { Edge, SystemBox } from '../src/internal.js'
import type { ComponentDef, Schema, SystemId } from '@ecsia/schema'

/** Lower + resolve ordering the way createScheduler does, ready for buildEdges/buildDAG. */
function boxesOf(defs: ReturnType<typeof defineSystem>[], stride = 4): SystemBox[] {
  return resolveOrdering(lowerSystems(defs, stride), defs)
}

describe('edges.ts: resolveOrdering unregistered before/after (lines 62-63, branch 61)', () => {
  test('before referencing a def absent from the registered set throws and names the OWNER', () => {
    const A = defineSystem({ name: 'A', run() {} })
    const Stranger = defineSystem({ name: 'Stranger', run() {} })
    // A declares `before: [Stranger]` but only A is registered → Stranger has no id.
    const B = defineSystem({ name: 'A', before: [Stranger], run() {} })
    expect(() => resolveOrdering(lowerSystems([B], 4), [B])).toThrow(
      /system 'A' lists a system in its before\/after that isn't in this scheduler/,
    )
    // Sanity: the same set WITH the referenced def registered does not throw.
    expect(() => resolveOrdering(lowerSystems([A, Stranger], 4), [A, Stranger])).not.toThrow()
  })

  test('after referencing an unregistered def throws too', () => {
    const Ghost = defineSystem({ name: 'Ghost', run() {} })
    const Real = defineSystem({ name: 'Real', after: [Ghost], run() {} })
    expect(() => resolveOrdering(lowerSystems([Real], 4), [Real])).toThrow(
      /system 'Real' lists a system in its before\/after that isn't in this scheduler/,
    )
  })

  test('an undefined before/after list resolves to an empty array (branch 58, no throw)', () => {
    const Plain = defineSystem({ name: 'Plain', run() {} })
    const [box] = resolveOrdering(lowerSystems([Plain], 4), [Plain])
    expect([...box!.before]).toEqual([])
    expect([...box!.after]).toEqual([])
  })
})

describe('edges.ts: offer() self-edge guard (branch 37)', () => {
  test('beforeWritersOf(C) on a system that itself writes C yields NO self-loop edge', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_selfedge' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    // W writes C and also declares beforeWritersOf(C). Resolving the hint enumerates the writers of C,
    // which includes W itself → an offered W→W edge that offer() must drop (edge.from === edge.to).
    const W = defineSystem({ name: 'W', write: [C], order: [beforeWritersOf(C)], run() {} })
    const boxes = boxesOf([W])
    const edges = buildEdges(boxes, [W], aggregateAccess(boxes))
    // No edge may have from === to.
    expect(edges.every((e) => (e.from as unknown as number) !== (e.to as unknown as number))).toBe(true)
    // And since W is the sole writer, the only candidate edge was the self-loop → no edges at all.
    expect(edges).toEqual([])
  })
})

describe('edges.ts: applyClassHints resolution + missing-set continues (lines 158-181, branches 157)', () => {
  test('beforeWritersOf adds a weight-3 hint edge from the hinter to each writer of C', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_bwo_edge' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const Writer = defineSystem({ name: 'Writer', write: [C], run() {} })
    const Hinter = defineSystem({ name: 'Hinter', read: [C], order: [beforeWritersOf(C)], run() {} })
    const boxes = boxesOf([Writer, Hinter])
    const edges = buildEdges(boxes, [Writer, Hinter], aggregateAccess(boxes))
    const hintEdge = edges.find(
      (e) => (e.from as unknown as number) === 1 && (e.to as unknown as number) === 0,
    )
    expect(hintEdge).toBeDefined()
    expect(hintEdge!.weight).toBe(EdgeWeight.CLASS_HINT)
    expect(hintEdge!.cause).toContain('Hinter.beforeWritersOf(cov_bwo_edge)')
  })

  test('afterReadersOf adds a weight-3 edge from each reader of C to the hinter', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_aro_edge' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const Reader = defineSystem({ name: 'Reader', read: [C], run() {} })
    const Hinter = defineSystem({ name: 'Hinter', write: [C], order: [afterReadersOf(C)], run() {} })
    const boxes = boxesOf([Reader, Hinter])
    const edges = buildEdges(boxes, [Reader, Hinter], aggregateAccess(boxes))
    // reader(0) → hinter(1)
    const hintEdge = edges.find(
      (e) =>
        (e.from as unknown as number) === 0 &&
        (e.to as unknown as number) === 1 &&
        e.weight === EdgeWeight.CLASS_HINT,
    )
    expect(hintEdge).toBeDefined()
    expect(hintEdge!.cause).toContain('Hinter.afterReadersOf(cov_aro_edge)')
  })

  test('beforeWritersOf(C) with NO writers of C registered adds no hint edge (branch: writers undefined)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_bwo_nowriter' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    // No system writes C, so access.writers.get(C) is undefined → the hint contributes nothing.
    const Hinter = defineSystem({ name: 'Hinter', read: [C], order: [beforeWritersOf(C)], run() {} })
    const boxes = boxesOf([Hinter])
    const edges = buildEdges(boxes, [Hinter], aggregateAccess(boxes))
    expect(edges).toEqual([])
  })

  test('afterReadersOf(C) with NO readers of C registered adds no hint edge (branch: readers undefined)', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_aro_noreader' }) as ComponentDef<Schema>
    createWorld({ components: [C] })
    const Hinter = defineSystem({ name: 'Hinter', write: [C], order: [afterReadersOf(C)], run() {} })
    const boxes = boxesOf([Hinter])
    const edges = buildEdges(boxes, [Hinter], aggregateAccess(boxes))
    expect(edges).toEqual([])
  })

})

describe('edges.ts: DENY suppresses the IMPLICIT edge (collectDenials + branch 157 deny-skip)', () => {
  test('inAnyOrderWith(A,B) removes the implicit write/write edge between A and B in both directions', () => {
    const C = defineComponent({ x: 'f32' }, { name: 'cov_deny_suppress' }) as ComponentDef<Schema>
    createWorld({ components: [C] })

    // Baseline: A and B both writing C produce an implicit A→B edge with no deny.
    const A = defineSystem({ name: 'A', write: [C], run() {} })
    const B = defineSystem({ name: 'B', write: [C], run() {} })
    const without = boxesOf([A, B])
    const baselineEdges = buildEdges(without, [A, B], aggregateAccess(without))
    expect(
      baselineEdges.some((e) => (e.from as unknown as number) === 0 && (e.to as unknown as number) === 1),
    ).toBe(true)

    // With a deny between the two registered defs, the implicit edge is suppressed in BOTH directions.
    // The deny hint also forces applyClassHints to take its `hint.kind === 'deny'` continue (branch 157).
    const A2 = defineSystem({ name: 'A2', write: [C], run() {} })
    const B2 = defineSystem({ name: 'B2', write: [C], run() {} })
    const B2WithDeny = defineSystem({ ...B2, order: [inAnyOrderWith(A2, B2)] })
    const denied = boxesOf([A2, B2WithDeny])
    const deniedEdges = buildEdges(denied, [A2, B2WithDeny], aggregateAccess(denied))
    expect(
      deniedEdges.some((e) => (e.from as unknown as number) === 0 && (e.to as unknown as number) === 1),
    ).toBe(false)
    expect(
      deniedEdges.some((e) => (e.from as unknown as number) === 1 && (e.to as unknown as number) === 0),
    ).toBe(false)
  })
})

describe('dag.ts: cycle reporting — edgeOf/cause formatting (lines 39-40, branches 38/82/86)', () => {
  const two = (): SystemBox[] =>
    boxesOf([defineSystem({ name: 'P', run() {} }), defineSystem({ name: 'Q', run() {} })])

  function cycleErrorFrom(boxes: SystemBox[], edges: Edge[]): CycleError {
    try {
      buildDAG(boxes, edges)
    } catch (e) {
      return e as CycleError
    }
    throw new Error('expected buildDAG to throw a CycleError')
  }

  test('a 2-cycle with CAUSES reports the named chain, parenthesised causes, and a break suggestion', () => {
    const boxes = two()
    const edges: Edge[] = [
      { from: 0 as unknown as SystemId, to: 1 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: 'pq' },
      { from: 1 as unknown as SystemId, to: 0 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: 'qp' },
    ]
    const err = cycleErrorFrom(boxes, edges)
    expect(err.message).toContain('System cycle detected:')
    // Real names (branch 76 takes the name, not #id) and both causes parenthesised (branch 82 truthy).
    expect(err.message).toContain('P')
    expect(err.message).toContain('Q')
    expect(err.message).toContain('(pq)')
    expect(err.message).toContain('(qp)')
    expect(err.message).toContain('inAnyOrderWith(P, Q)') // break suggestion (branch 86 cycle[1] present)
    // Chain is closed: [start, ..., start].
    expect(err.chain[0]).toBe(err.chain[err.chain.length - 1])
  })

  test('an edge with an EMPTY cause prints no parentheses (branch 82 falsy side)', () => {
    const boxes = two()
    const edges: Edge[] = [
      { from: 0 as unknown as SystemId, to: 1 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: '' },
      { from: 1 as unknown as SystemId, to: 0 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: '' },
    ]
    const err = cycleErrorFrom(boxes, edges)
    const arrowLines = err.message.split('\n').filter((l) => l.includes('→'))
    expect(arrowLines.length).toBeGreaterThan(0)
    for (const line of arrowLines) expect(line).not.toMatch(/\(/)
  })

  test('edgeOf loop skips a non-matching edge before returning the matching cause (branch 38)', () => {
    // Cycle is 0→1→0; node 2 is a sink reachable from 0 (a non-cyclic noise edge). edgeOf(0,1)
    // must iterate past the 0→2 entry (branch 38 false side) before matching 0→1.
    const boxes = boxesOf([
      defineSystem({ name: 'P', run() {} }),
      defineSystem({ name: 'Q', run() {} }),
      defineSystem({ name: 'R', run() {} }),
    ])
    const edges: Edge[] = [
      { from: 0 as unknown as SystemId, to: 2 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: 'noise' },
      { from: 0 as unknown as SystemId, to: 1 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: 'forward' },
      { from: 1 as unknown as SystemId, to: 0 as unknown as SystemId, weight: EdgeWeight.IMPLICIT, cause: 'backward' },
    ]
    const err = cycleErrorFrom(boxes, edges)
    // The matching causes win despite the leading non-matching entry.
    expect(err.message).toContain('(forward)')
    expect(err.message).toContain('(backward)')
  })
})
