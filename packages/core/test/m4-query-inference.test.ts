import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(here, 'm4-query-inference.test-d.ts')

// Gate the query DSL inference obligations: the fixture must
// type-check under the project's strict flags. Type-only — drive tsc on it directly. Every
// @ts-expect-error is a real error (the read/write split, has/optional contributions, the arity cap).
describe('query DSL inference contracts', () => {
  test('the query inference fixture type-checks clean', () => {
    let ok = true
    let out = ''
    try {
      execFileSync(
        'npx',
        [
          'tsc',
          '--noEmit',
          '--strict',
          '--exactOptionalPropertyTypes',
          '--noUncheckedIndexedAccess',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--lib',
          'ES2023',
          '--target',
          'ES2022',
          '--skipLibCheck',
          fixture,
        ],
        { cwd: resolve(here, '../../..'), stdio: 'pipe' },
      )
    } catch (e) {
      ok = false
      out = String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '')
    }
    expect(ok, out).toBe(true)
  })
})
