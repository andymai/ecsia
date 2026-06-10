import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

const alias = {
  '@ecsia/schema': pkg('schema'),
  '@ecsia/core': pkg('core'),
  '@ecsia/relations': pkg('relations'),
  '@ecsia/scheduler': pkg('scheduler'),
  '@ecsia/serialization': pkg('serialization'),
  '@ecsia/kit': pkg('ecsia'),
  '@ecsia/three': pkg('three'),
  '@ecsia/react': pkg('react'),
  '@ecsia/devtools': pkg('devtools'),
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          environment: 'node',
          alias,
        },
      },
      {
        // @ecsia/react needs a DOM: jsdom environment + @testing-library/react. Tests are .tsx
        // (the unit project's *.test.ts glob never matches them).
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'react',
          include: ['packages/react/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/react/test/setup.ts'],
          alias,
        },
      },
      {
        // The "examples run green in CI" gate: each example's main() is driven by a
        // smoke test that imports ecsia and asserts the observable end state.
        test: {
          name: 'examples',
          include: ['examples/test/**/*.test.ts'],
          environment: 'node',
          alias,
        },
      },
      {
        // The @ecsia/react example renders into a DOM, so its smoke test is .tsx under jsdom —
        // same harness as the `react` project, reusing its act()/cleanup setup.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'examples-react',
          include: ['examples/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/react/test/setup.ts'],
          alias,
        },
      },
      {
        // Bench self-check: the full suite runs on demand (pnpm bench:macro), but a tiny smoke test
        // keeps the harness compiling + runnable in CI without paying the measurement cost.
        test: {
          name: 'bench',
          include: ['bench/test/**/*.test.ts'],
          environment: 'node',
          alias,
        },
      },
    ],
    // We measure the published source only — packages/*/src — excluding tests, type-only
    // fixtures, barrels, and the non-published examples/bench.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.test-d.ts',
        '**/index.ts',
        '**/dist/**',
        'examples/**',
        'bench/**',
        // Worker-thread entry: runs inside a worker_threads Worker, so main-process v8 coverage
        // cannot observe it. It IS execution-tested by the real WorkerPool serial-equivalence suite.
        'packages/scheduler/src/workers/worker-entry.ts',
      ],
      reporter: ['text', 'json-summary', 'json'],
      // A ratchet, not a target: floors sit a few points under measured reality
      // (2026-06: stmts 94.9 / branch 87.7 / fn 95.7 / lines 97.3) so only real
      // erosion fails CI, never run-to-run noise. Raise them when reality rises.
      thresholds: {
        statements: 92,
        branches: 84,
        functions: 92,
        lines: 95,
      },
    },
  },
})
