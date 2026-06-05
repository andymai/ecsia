// Direct coverage for compileQuery's term classification + signature-bit placement corners using a
// hand-rolled CompileContext so fixedBitCount (the dense/residual split) and resolvePair can be
// controlled in isolation. Targets: every classifyTerm switch arm, the residual (large-id) with/not
// placement, the bare-ComponentDef default arm, and the pair-term resolution outcomes.

import { describe, expect, test } from 'vitest'
import { read, write, has, without, optional } from '@ecsia/core'
import { compileQuery } from '../src/internal.js'
import type { ComponentDef, QueryTerm, Schema } from '@ecsia/core'
import type { ResolvedPair } from '@ecsia/core'
import type { CompileContext } from '../src/internal.js'

interface FakeDef {
  id: number
  name: string
}
const def = (id: number, name: string): ComponentDef<Schema> => ({ id, name }) as unknown as ComponentDef<Schema>

function ctx(fixedBitCount = 64, resolvePair?: CompileContext['resolvePair']): CompileContext {
  return {
    idOf: (d: ComponentDef<Schema>) => (d as unknown as FakeDef).id as never,
    fixedBitCount,
    ...(resolvePair !== undefined ? { resolvePair } : {}),
  }
}

const pair = (relationId: number, target: number | symbol, id = 999): QueryTerm =>
  ({ relation: { name: 'rel', id: relationId }, target, id }) as unknown as QueryTerm

describe('compileQuery term classification', () => {
  test('read / write produce value terms with the right role; with/without/optional too', () => {
    const A = def(1, 'a')
    const B = def(2, 'b')
    const C = def(3, 'c')
    const D = def(4, 'd')
    const E = def(5, 'e')
    const q = compileQuery(
      [read(A), write(B), has(C), without(D), optional(E)] as readonly QueryTerm[],
      ctx(),
    )
    const roles = new Map(q.valueTerms.map((vt) => [vt.componentId as number, vt.role]))
    // read -> read value term, write -> write value term, optional -> optional value term.
    expect(roles.get(1)).toBe('read')
    expect(roles.get(2)).toBe('write')
    expect(roles.get(5)).toBe('optional')
    // has contributes a membership bit but NO value term.
    expect(roles.has(3)).toBe(false)
    // without is a not-bit, no value term.
    expect(roles.has(4)).toBe(false)

    // withWords cover A,B,C; notWords cover D; optionalIds cover E.
    expect(q.optionalIds).toContain(5)
    expect(q.notWords.length).toBe(1)
    // referenced is the full set.
    expect([...q.referencedIds].sort((x, y) => (x as number) - (y as number))).toEqual([1, 2, 3, 4, 5])
    expect(q.unsatisfiable).toBe(false)
  })

  test('a bare ComponentDef (no __term wrapper) is treated as read', () => {
    const A = def(7, 'bare')
    const q = compileQuery([A as unknown as QueryTerm], ctx())
    expect(q.valueTerms).toHaveLength(1)
    expect(q.valueTerms[0]!.role).toBe('read')
    expect(q.valueTerms[0]!.componentId as number).toBe(7)
  })

  test('a with-bit id at/above fixedBitCount lands in residualWith (not the dense words)', () => {
    const Big = def(40, 'big') // fixedBitCount 32 -> 40 is residual
    const q = compileQuery([has(Big)] as readonly QueryTerm[], ctx(32))
    expect(q.withWords).toHaveLength(0)
    expect(q.residualWith).toHaveLength(1)
    expect(q.residualWith[0]!.componentId as number).toBe(40)
    expect(q.residualWith[0]!.negate).toBe(false)
  })

  test('a without-bit id at/above fixedBitCount lands in residualWith with negate=true', () => {
    const Big = def(50, 'big')
    const q = compileQuery([without(Big)] as readonly QueryTerm[], ctx(32))
    expect(q.notWords).toHaveLength(0)
    expect(q.residualWith).toHaveLength(1)
    expect(q.residualWith[0]!.componentId as number).toBe(50)
    expect(q.residualWith[0]!.negate).toBe(true)
  })

  test('low ids go into the dense words, high ids into residual, in the same query', () => {
    const Low = def(3, 'low')
    const High = def(40, 'high')
    const q = compileQuery([has(Low), has(High)] as readonly QueryTerm[], ctx(32))
    expect(q.withWords).toHaveLength(1) // only Low
    expect(q.residualWith).toHaveLength(1) // only High
    expect(q.residualWith[0]!.componentId as number).toBe(40)
  })
})

describe('compileQuery pair-term resolution', () => {
  test('without resolvePair (relation-free world) a pair term is unsatisfiable', () => {
    const q = compileQuery([pair(1, 2)], ctx()) // no resolvePair injected
    expect(q.unsatisfiable).toBe(true)
  })

  test('resolvePair returning unsatisfiable propagates unsatisfiable', () => {
    const resolve = (): ResolvedPair => ({ componentId: 0 as never, unsatisfiable: true })
    const q = compileQuery([pair(1, 2)], ctx(64, resolve))
    expect(q.unsatisfiable).toBe(true)
  })

  test('a resolved specific pair adds its presence bit and any row filter', () => {
    const resolve = (relationId: number, target: number | symbol): ResolvedPair => ({
      componentId: 8 as never,
      unsatisfiable: false,
      rowFilter: { presenceId: 8 as never, targetEid: target as number, targetFieldIndex: 0 },
    })
    const q = compileQuery([pair(1, 42)], ctx(64, resolve))
    expect(q.unsatisfiable).toBe(false)
    expect([...q.referencedIds]).toContain(8)
    expect(q.rowFilters).toHaveLength(1)
    expect(q.rowFilters[0]!.targetEid).toBe(42)
  })

  test('a resolved wildcard pair (symbol target) adds its presence bit with no row filter', () => {
    const wild = Symbol.for('ecsia.query.wildcard')
    const resolve = (): ResolvedPair => ({ componentId: 9 as never, unsatisfiable: false })
    const q = compileQuery([pair(1, wild)], ctx(64, resolve))
    expect(q.unsatisfiable).toBe(false)
    expect([...q.referencedIds]).toContain(9)
    expect(q.rowFilters).toHaveLength(0)
  })

  test('canonical hash distinguishes Pair(R,p1) from Pair(R,p2) and wildcard', () => {
    const resolve = (): ResolvedPair => ({ componentId: 8 as never, unsatisfiable: false })
    const wild = Symbol.for('ecsia.query.wildcard')
    const h1 = compileQuery([pair(1, 1)], ctx(64, resolve)).hash
    const h2 = compileQuery([pair(1, 2)], ctx(64, resolve)).hash
    const hw = compileQuery([pair(1, wild)], ctx(64, resolve)).hash
    expect(h1).not.toBe(h2)
    expect(h1).not.toBe(hw)
  })
})
