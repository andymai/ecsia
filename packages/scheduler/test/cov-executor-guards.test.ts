// Coverage: executor/guards.ts — the dev-mode scoped-query access guard. Exercises every term role
// (write/read/optional/with/without/bare/relation), the unregistered-id skip, and the two warning
// paths (undeclared write, undeclared read) plus production pass-through. scheduler.md §6.6, Must-Fix #2.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeScopedQuery } from '@ecsia/scheduler'
import type { SystemBox } from '@ecsia/scheduler'
import type { World } from '@ecsia/core'
import type { QueryTerm } from '@ecsia/schema'

/** A fake world whose query is an identity spy returning a sentinel result. */
function fakeWorld(): { world: World; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn((...terms: unknown[]) => ({ result: terms.length }))
  return { world: { query } as unknown as World, query }
}

/** A minimal SystemBox: only name + declared read/write ids are read by makeScopedQuery. */
function box(name: string, readIds: number[], writeIds: number[]): SystemBox {
  return { name, readIds, writeIds } as unknown as SystemBox
}

function comp(id: number, name: string): { id: number; name: string } {
  return { id, name }
}

afterEach(() => vi.restoreAllMocks())

describe('guards.ts: dev=false returns the world query verbatim (branch 37/38)', () => {
  test('production mode returns the SAME query reference — no wrapper, no guards', () => {
    const { world } = fakeWorld()
    const scoped = makeScopedQuery(world, box('s', [], []), false)
    expect(scoped).toBe(world.query)
  })
})

describe('guards.ts: term-role resolution (lines 14-26, branches 13/16/19-21)', () => {
  test('a write(C) term declared in the write set passes WITHOUT warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const C = comp(3, 'Pos')
    const scoped = makeScopedQuery(world, box('s', [], [3]), true)
    const out = scoped({ __term: 'write', c: C } as unknown as QueryTerm)
    expect(warnSpy).not.toHaveBeenCalled()
    // The wrapper forwards to the underlying query and returns its result unchanged.
    expect(out).toEqual({ result: 1 })
  })

  test('a write(C) term NOT in the declared write set warns (lines 49-51, branch 47)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const C = comp(7, 'Health')
    // C is in the READ set but not the WRITE set → a write() term is still flagged (Must-Fix #2).
    const scoped = makeScopedQuery(world, box('writer', [7], []), true)
    scoped({ __term: 'write', c: C } as unknown as QueryTerm)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toMatch(/issues a write\(Health\) term but 'Health' is not in its declared write set/)
  })

  test('a read term referencing an UNDECLARED component warns (lines 54-57, branch 53)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const C = comp(9, 'Velocity')
    // Velocity (id 9) is in neither read nor write set → undeclared read access is flagged.
    const scoped = makeScopedQuery(world, box('reader', [1], [2]), true)
    scoped({ __term: 'read', c: C } as unknown as QueryTerm)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toMatch(/references Velocity in a query but it is not in the system's declared read\/write set/)
  })

  test('a read term that IS declared (in read set) passes silently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const C = comp(4, 'Mass')
    const scoped = makeScopedQuery(world, box('s', [4], []), true)
    scoped({ __term: 'read', c: C } as unknown as QueryTerm)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('an optional term resolves to a READ role and is checked against read/write (case 17-18)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const C = comp(11, 'Shield')
    const scoped = makeScopedQuery(world, box('s', [], []), true) // declares nothing
    scoped({ __term: 'optional', c: C } as unknown as QueryTerm)
    expect(warnSpy).toHaveBeenCalledTimes(1) // undeclared read access
  })

  test("'with'/'without' presence FILTERS never warn even when their component is undeclared (line 22, role 'other')", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const Tag = comp(13, 'Tag')
    // A realistic system: declares read of Position(2), filters by With(Tag)/Without(Other) — Tag and
    // Other are NOT (and should not be) in the declared access set, because presence filters are not
    // data access. Regression guard for the false-positive warning fixed in guards.ts.
    const scoped = makeScopedQuery(world, box('s', [2], []), true)
    scoped(
      { __term: 'read', c: comp(2, 'Position') } as unknown as QueryTerm,
      { __term: 'with', c: Tag } as unknown as QueryTerm,
      { __term: 'without', c: comp(14, 'Other') } as unknown as QueryTerm,
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('a bare ComponentDef term defaults to a READ role (lines 24-25, default case)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    // No __term field → treated as a bare ComponentDef == read. Undeclared → warns.
    const bare = comp(15, 'Bare')
    const scoped = makeScopedQuery(world, box('s', [], []), true)
    scoped(bare as unknown as QueryTerm)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toMatch(/references Bare in a query/)
  })

  test('a relation/pair term is skipped (def===null, line 13 + branch 44)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world, query } = fakeWorld()
    const scoped = makeScopedQuery(world, box('s', [], []), true)
    // relation !== undefined → role 'other', def null → the per-term loop `continue`s (branch 44).
    scoped({ relation: { some: 'pair' } } as unknown as QueryTerm)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledOnce()
  })

  test('an unregistered component id (< 0) is skipped — the compiler reports it (line 46, branch 46)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const Unreg = comp(-1, 'Unregistered')
    const scoped = makeScopedQuery(world, box('s', [], []), true)
    scoped({ __term: 'read', c: Unreg } as unknown as QueryTerm)
    // id < 0 → continue before any warn, even though it is undeclared.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('a write term with no `c` (def null) is skipped (branch 44 via t.c undefined)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { world } = fakeWorld()
    const scoped = makeScopedQuery(world, box('s', [], []), true)
    scoped({ __term: 'write' } as unknown as QueryTerm) // t.c undefined → def null → continue
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
