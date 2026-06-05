import { defineConfig } from 'vitest/config'

// Coverage is configured at the root (the projects live in vitest.workspace.ts). We measure the
// published source only — packages/*/src — excluding tests, type-only fixtures, barrels, and the
// non-published examples/bench.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
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
    },
  },
})
