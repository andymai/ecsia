import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

const alias = {
  '@ecsia/schema': pkg('schema'),
  '@ecsia/core': pkg('core'),
  '@ecsia/relations': pkg('relations'),
  '@ecsia/scheduler': pkg('scheduler'),
  '@ecsia/serialization': pkg('serialization'),
  '@ecsia/ecsia': pkg('ecsia'),
}

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
      environment: 'node',
      alias,
    },
  },
  {
    // The "examples run green in CI" gate (build-plan.md M12): each example's main() is driven by a
    // smoke test that imports @ecsia/ecsia and asserts the observable end state.
    test: {
      name: 'examples',
      include: ['examples/test/**/*.test.ts'],
      environment: 'node',
      alias,
    },
  },
  {
    // Bench self-check: the full suite runs on demand (pnpm bench:macro), but a tiny smoke test keeps
    // the harness compiling + runnable in CI without paying the measurement cost.
    test: {
      name: 'bench',
      include: ['bench/test/**/*.test.ts'],
      environment: 'node',
      alias,
    },
  },
])
