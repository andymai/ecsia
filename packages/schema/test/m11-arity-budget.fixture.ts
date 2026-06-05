// M11 — tsc compile-time BUDGET fixture (type-system.md §6.4, report §5.2/§7.5 mitigation 4).
//
// This file is NOT a vitest test (it is named `.fixture.ts`, not `.test.ts`, so the workspace glob
// never collects it). The guard test (m11-arity-budget.test.ts) compiles it with
// `--generateTrace`/`--extendedDiagnostics` and asserts the type-instantiation count stays under a
// budget — a regression in instantiation count (e.g. someone replacing the fixed-arity overload
// family with a recursive variadic QueryElement) blows the budget and fails CI.
//
// It exercises the MAXIMUM supported arity (MAX_QUERY_ARITY = 8) with a mix of every term kind, then
// the just-past-cap (9) degradation, so the budget covers both the full fold and the loose fallback.

import type { ComponentDef, EntityHandle, RelationDef, PairDef, WorldQuery } from '@ecsia/schema'
import { read, write, With, Without, optional } from '@ecsia/schema'

declare const A: ComponentDef<{ x: 'f32'; y: 'f32'; z: 'f32' }> & { name: 'a' }
declare const B: ComponentDef<{ x: 'f32'; y: 'f32' }> & { name: 'b' }
declare const C: ComponentDef<{ n: 'i32' }> & { name: 'c' }
declare const D: ComponentDef<{ flag: 'bool' }> & { name: 'd' }
declare const Ecmp: ComponentDef<{ id: 'eid' }> & { name: 'e' }
declare const Fcmp: ComponentDef<{ k: 'u32' }> & { name: 'f' }
declare const Gcmp: ComponentDef<{ v: 'f64' }> & { name: 'g' }
declare const Tag: ComponentDef<Record<never, never>> & { name: 'tag' }
declare const Owns: RelationDef<{ weight: 'f32' }> & { name: 'owns' }
declare const ownsPair: PairDef<typeof Owns>

declare const w: { query: WorldQuery }

// Max-arity (8) full fold: read · write · With · Without · optional · bare · pair · read.
const qMax = w.query(read(A), write(B), With(Tag), Without(C), optional(D), Ecmp, ownsPair, read(Fcmp))
qMax.each((el) => {
  const _h: EntityHandle = el.handle
  const _ax: number = el.a.x
  el.b.x = 1
  const _w: number = el.owns.weight
  void [_h, _ax, _w]
})

// Just past the cap (9): degraded, bounded — the loose fallback caps instantiation here.
const qOver = w.query(read(A), read(B), read(C), read(D), read(Ecmp), read(Fcmp), read(Gcmp), read(A), read(B))
qOver.each((el) => {
  const _h: EntityHandle = el.handle
  void _h
})

export {}
