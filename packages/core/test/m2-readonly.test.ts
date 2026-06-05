// Guard for the readonly type-level fixture (m2-readonly.test-d.ts). The fixture is type-only;
// vitest does not type-check it by default, so we drive tsc on it directly under the strict flags.
//
// DISCRIMINATION (the load-bearing requirement): a positive compile is not enough — an
// @ts-expect-error passes for ANY error, so a clean compile alone would not prove the *readonly*
// modifier is what fails. We therefore also compile a MUTATED fixture in which ReadView is rebound to
// a NON-readonly mapped type. With readonly stripped, `r.x = 5` no longer errors, so its
// @ts-expect-error becomes UNUSED and tsc fails with TS2578. The pair (clean passes, mutated fails)
// is what proves the test discriminates the modifier.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const fixture = resolve(here, 'm2-readonly.test-d.ts')

function typecheck(file: string): { ok: boolean; out: string } {
  try {
    execFileSync(
      'npx',
      [
        'tsc',
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
        file,
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    )
    return { ok: true, out: '' }
  } catch (e) {
    const out =
      String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '')
    return { ok: false, out }
  }
}

describe(' readonly shorthand/read is a compile error ', () => {
  test('the fixture type-checks clean: every @ts-expect-error is a real error, write paths compile', () => {
    const { ok, out } = typecheck(fixture)
    expect(ok, out).toBe(true)
  })

  test('DISCRIMINATION: stripping readonly from ReadView makes the fixture FAIL to compile', () => {
    // Rebuild the fixture against a NON-readonly ReadView. The `@ts-expect-error` on `r.x = 5` then
    // guards a line that no longer errors → tsc reports it as unused (TS2578) → compile fails.
    const src = readFileSync(fixture, 'utf8')
    const mutated = src
      // Drop the readonly imports; supply local mutable ReadOf/WriteOf instead.
      .replace(
        "import type { ReadOf, WriteOf } from '@ecsia/core'",
        [
          "import type { ComponentDef } from '@ecsia/core'",
          '// MUTATION: ReadOf is rebound to a NON-readonly mapped type (readonly stripped).',
          "type SchemaOfX<C> = C extends ComponentDef<infer S> ? S : never",
          'type ReadOf<C> = { -readonly [K in keyof SchemaOfX<C>]: number }',
          'type WriteOf<C> = { -readonly [K in keyof SchemaOfX<C>]: number }',
        ].join('\n'),
      )
      // The vec @ts-expect-error lines reference ReadonlyVecView semantics our crude mutant doesn't
      // model; drop the vec block so the mutation isolates the scalar readonly check cleanly.
      .replace(/\/\/ A vec field's read view[\s\S]*?wb\.v\[0\] = 1\n/, '')
      .replace(/import \{ defineComponent, vec \} from '@ecsia\/core'/, "import { defineComponent } from '@ecsia/core'")
      .replace(/const Body = defineComponent[\s\S]*$/, 'export {}\n')

    // Write the mutant NEXT TO the real fixture so `@ecsia/core` resolves identically (a /tmp copy
    // would fail module resolution for the wrong reason, TS2307). Name it `.mutant.ts` (not
    // `.test.ts`) so vitest never collects it.
    const mutFile = resolve(here, 'm2-readonly.mutant.generated.ts')
    try {
      writeFileSync(mutFile, mutated, 'utf8')
      const { ok, out } = typecheck(mutFile)
      // Must fail — and specifically because the expect-error is now unused (TS2578), NOT because of
      // unrelated module-resolution noise.
      expect(ok, `mutant unexpectedly compiled:\n${out}`).toBe(false)
      expect(out).toMatch(/2578/)
      expect(out).not.toMatch(/2307/)
    } finally {
      rmSync(mutFile, { force: true })
    }
  })
})
