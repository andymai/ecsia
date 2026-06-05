// Guard for the type-arity stress + inference-budget fixtures (). The fixtures are type-only; vitest does not type-check them by default, so we
// drive tsc on them directly under the project's strict flags.
//
// Three obligations:
// (1) the stress fixture type-checks clean — every @ts-expect-error is a REAL error (the
// read/write/has/without/optional/pair fold, the arity cap, the Has/HasWrite escape hatch).
// (2) DISCRIMINATION (not-any): an @ts-expect-error passes for ANY error, so a clean compile alone
// would not prove the elements are PRECISE rather than `any`. We compile a MUTATED fixture in
// which every iteration element is rebound to `any`. has `any`, the bogus-method calls guarded
// by `@ts-expect-error` (el.zzz() / el.nonexistentMethod()) no longer error → those directives
// become UNUSED → tsc fails with TS2578. The pair (clean passes, mutated fails-with-2578) proves
// the fixture discriminates `any` from a precise/typed element.
// (3) BUDGET: the budget fixture compiles within a bounded type-instantiation count. A
// regression that replaces the fixed-arity overload family with a recursive variadic
// QueryElement would balloon instantiations and blow the budget.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const stressFixture = resolve(here, 'm11-arity-stress.test-d.ts')
const budgetFixture = resolve(here, 'm11-arity-budget.fixture.ts')

const STRICT_FLAGS = [
  '--noEmit',
  '--strict',
  '--exactOptionalPropertyTypes',
  '--noUncheckedIndexedAccess',
  '--verbatimModuleSyntax',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--lib',
  'ES2023',
  '--target',
  'ES2022',
  '--types',
  'node',
  '--skipLibCheck',
]

// A regression that drops the fixed-arity overloads for a recursive variadic QueryElement would push
// this far higher; baseline at authoring is ~3.3k. Generous headroom catches the explosion without
// flaking on minor type-machinery additions.
const INSTANTIATION_BUDGET = 8000

// Wall-clock budget ("measure tsc wall-clock … assert under a GENEROUS budget").
// The instantiation count above is the PRIMARY, non-flaky tripwire (deterministic). Wall-clock is a
// secondary, deliberately-loose guard: it is sensitive to CI machine load, cold tsc start, npx
// resolution, and disk, so the threshold carries large headroom (baseline ~0.6s for one fixture; a
// recursive-variadic regression would push it to multiple seconds). The point is a regression
// tripwire, not a tight bound — we record the measured time and assert only a generous ceiling.
const WALLCLOCK_BUDGET_MS = 20_000

function typecheck(file: string, extra: readonly string[] = []): { ok: boolean; out: string } {
  try {
    const out = execFileSync('npx', ['tsc', ...STRICT_FLAGS, ...extra, file], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    return { ok: true, out: String(out) }
  } catch (e) {
    const out =
      String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '')
    return { ok: false, out }
  }
}

describe(' type-arity stress ', () => {
  test('the stress fixture type-checks clean: every @ts-expect-error is a real error', () => {
    const { ok, out } = typecheck(stressFixture)
    expect(ok, out).toBe(true)
  })

  test('DISCRIMINATION (not-any): collapsing every element to `any` makes the not-any guards UNUSED (TS2578)', () => {
    // Rebuild the fixture so EVERY iteration element is `any` (the bitECS `ComponentRef = any`
    // failure mode the typed degradation rejects). has `any`, the `@ts-expect-error el.zzz()` /
    // `el.nonexistentMethod()` lines no longer error → tsc reports them unused (TS2578).
    const src = readFileSync(stressFixture, 'utf8')
    const mutated = src
      // every `.each((el) => {` callback param becomes `any` — the loose/precise distinction is erased.
      .replace(/\.each\(\(el\)/g, '.each((el: any)')
      // the QueryElement-typed `e` element likewise → any.
      .replace(/declare const e: QueryElement<AllKinds> & \{ handle: EntityHandle \}/, 'declare const e: any')

    // Write the mutant NEXT TO the real fixture so `@ecsia/schema` resolves identically (a /tmp copy
    // would fail module resolution for the wrong reason, TS2307). `.mutant.generated.ts` is not a
    // `.test.ts`, so vitest never collects it.
    const mutFile = resolve(here, 'm11-arity-stress.mutant.generated.ts')
    try {
      writeFileSync(mutFile, mutated, 'utf8')
      const { ok, out } = typecheck(mutFile)
      expect(ok, `mutant unexpectedly compiled (any was NOT discriminated):\n${out}`).toBe(false)
      // It must fail specifically because the expect-errors are now unused (TS2578), NOT because of
      // unrelated module-resolution noise.
      expect(out).toMatch(/2578/)
      expect(out).not.toMatch(/2307/)
    } finally {
      rmSync(mutFile, { force: true })
    }
  })

  test('DISCRIMINATION (readonly carry): stripping readonly from Has makes the shorthand TS2540 guard UNUSED (TS2578)', () => {
    // The (4) READONLY-SHORTHAND carry pins that `Has<A>` shorthand assignment is TS2540. Prove the
    // readonly modifier — not an unrelated error — is what fails: rebind `Has` to a NON-readonly mapped
    // type. has readonly stripped, `shorthand.a.x = 5` no longer errors → its `@ts-expect-error` is
    // unused → TS2578. (The other not-any expect-errors still error, so the failure is specifically the
    // readonly guard.)
    const src = readFileSync(stressFixture, 'utf8')
    const mutated = src
      .replace("  Has,\n", "") // drop the imported Has
      .replace(
        "import { read, write, has, without, optional } from '@ecsia/schema'",
        [
          "import { read, write, has, without, optional } from '@ecsia/schema'",
          "import type { ReadOf as _ReadOf, CompKey as _CompKey } from '@ecsia/schema'",
          '// MUTATION: Has is rebound to a NON-readonly mapped type (readonly stripped from both the',
          '// component-key level and the field level), so shorthand field assignment no longer errors.',
          'type Has<C> = { -readonly [K in _CompKey<C>]: { -readonly [F in keyof _ReadOf<C>]: _ReadOf<C>[F] } }',
        ].join('\n'),
      )

    const mutFile = resolve(here, 'm11-readonly-carry.mutant.generated.ts')
    try {
      writeFileSync(mutFile, mutated, 'utf8')
      const { ok, out } = typecheck(mutFile)
      expect(ok, `readonly-carry mutant unexpectedly compiled:\n${out}`).toBe(false)
      expect(out).toMatch(/2578/)
      expect(out).not.toMatch(/2307/)
    } finally {
      rmSync(mutFile, { force: true })
    }
  })
})

describe(' inference budget ', () => {
  test('the max-arity budget fixture compiles within the instantiation budget', () => {
    const { ok, out } = typecheck(budgetFixture, ['--extendedDiagnostics'])
    expect(ok, out).toBe(true)
    const m = out.match(/Instantiations:\s*(\d+)/)
    expect(m, `no Instantiations line in tsc diagnostics:\n${out}`).toBeTruthy()
    const instantiations = Number(m![1])
    expect(instantiations, `instantiation count ${instantiations} exceeds budget ${INSTANTIATION_BUDGET}`).toBeLessThan(
      INSTANTIATION_BUDGET,
    )
  })

  test('DISCRIMINATION (budget bites): an absurdly low budget would fail', () => {
    // Sanity that the measurement is real (not a no-op match): the budget fixture instantiates a
    // nontrivial count, so a budget of 1 must be exceeded.
    const { ok, out } = typecheck(budgetFixture, ['--extendedDiagnostics'])
    expect(ok, out).toBe(true)
    const instantiations = Number(out.match(/Instantiations:\s*(\d+)/)![1])
    expect(instantiations).toBeGreaterThan(1)
  })

  test('WALL-CLOCK: the max-arity budget fixture type-checks within a generous wall-clock ceiling', () => {
    // Secondary, deliberately-loose regression tripwire. Wall-clock is environment-sensitive,
    // so the ceiling carries large headroom and the measured time is recorded for visibility. A
    // recursive-variadic regression (the thing the cap prevents) would blow past it.
    const start = performance.now()
    const { ok, out } = typecheck(budgetFixture)
    const elapsedMs = performance.now() - start
    expect(ok, out).toBe(true)
    // eslint-disable-next-line no-console
    console.info(`[arity budget] tsc wall-clock for max-arity fixture: ${elapsedMs.toFixed(0)}ms (ceiling ${WALLCLOCK_BUDGET_MS}ms)`)
    expect(
      elapsedMs,
      `tsc wall-clock ${elapsedMs.toFixed(0)}ms exceeded the generous ceiling ${WALLCLOCK_BUDGET_MS}ms — likely a type-machinery regression (recursive variadic fold?)`,
    ).toBeLessThan(WALLCLOCK_BUDGET_MS)
  })
})
