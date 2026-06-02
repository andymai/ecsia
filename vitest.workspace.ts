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
])
