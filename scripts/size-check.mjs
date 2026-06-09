// Bundle-size budget. Bundles representative tree-shaken entry points against the BUILT dist,
// minifies (esbuild) + gzips (zlib), and asserts each stays under a committed budget. This is the
// honest "lean install" number — what a bundler ships for a real app, NOT the unminified source.
// Run after `pnpm build`. `--update` rewrites the budget to the measured sizes (the ratchet).
//
// Why per-import, not one number: ecsia is batteries-included but `sideEffects: false`, so a typed
// data + scheduler app pulls only the kernel; relations / serialization / topics drop unless used.
// The budgets pin that tree-shaking stays honest.

import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BUDGET_PATH = resolve(ROOT, 'bundle-budget.json')

// Each entry is the smallest realistic import for a use-case. Measured tree-shaken: the umbrella is
// pure static re-exports, so unused subsystems drop.
const ENTRIES = [
  {
    name: 'kernel',
    note: 'typed data + systems + scheduler (the typical app)',
    code: `import { createWorld, defineComponent, defineSystem, createScheduler, read, write } from '@ecsia/kit'
           console.log(createWorld, defineComponent, defineSystem, createScheduler, read, write)`,
  },
  {
    name: 'core-min',
    note: 'just a world + a component (@ecsia/core alone)',
    code: `import { createWorld, defineComponent } from '@ecsia/core'
           console.log(createWorld, defineComponent)`,
  },
  {
    name: 'full-umbrella',
    note: 'everything re-exported from the umbrella (the upper bound)',
    code: `import * as ecsia from '@ecsia/kit'
           console.log(ecsia)`,
  },
]

const alias = {
  '@ecsia/kit': resolve(ROOT, 'packages/ecsia/dist/index.js'),
  '@ecsia/core': resolve(ROOT, 'packages/core/dist/index.js'),
  '@ecsia/schema': resolve(ROOT, 'packages/schema/dist/index.js'),
  '@ecsia/scheduler': resolve(ROOT, 'packages/scheduler/dist/index.js'),
  '@ecsia/relations': resolve(ROOT, 'packages/relations/dist/index.js'),
  '@ecsia/serialization': resolve(ROOT, 'packages/serialization/dist/index.js'),
}

async function measure(entry) {
  const out = await build({
    stdin: { contents: entry.code, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    legalComments: 'none',
    alias,
    // node:worker_threads is only reached on the threaded path via dynamic import — never in a
    // browser bundle; mark it external so it doesn't inflate the measured size.
    external: ['node:worker_threads', 'node:url'],
  })
  const code = out.outputFiles[0].contents
  return { min: code.length, gzip: gzipSync(code).length }
}

async function main() {
  for (const a of Object.values(alias)) {
    if (!existsSync(a)) {
      console.error(`size-check: missing build artifact ${a} — run \`pnpm build\` first.`)
      process.exit(1)
    }
  }
  const update = process.argv.includes('--update')
  const budget = existsSync(BUDGET_PATH)
    ? JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
    : { _comment: '', budgets: {} }

  const results = {}
  let failed = false
  const TOLERANCE = 1.03 // 3% headroom so a trivial change doesn't trip the gate; ratchet with --update
  for (const entry of ENTRIES) {
    const { min, gzip } = await measure(entry)
    results[entry.name] = { gzip, min }
    const limit = budget.budgets?.[entry.name]?.gzip
    const status = limit === undefined ? 'NEW' : gzip <= Math.ceil(limit * TOLERANCE) ? 'ok' : 'OVER'
    if (status === 'OVER') failed = true
    console.log(
      `  ${entry.name.padEnd(16)} ${String(gzip).padStart(6)} B gz  (${String(min).padStart(6)} B min)  ` +
        `${limit === undefined ? '(no budget)' : `budget ${limit} B`}  ${status}` +
        `   — ${entry.note}`,
    )
  }

  if (update) {
    const next = {
      _comment:
        'Bundle-size budgets: max min+gzip BYTES per tree-shaken entry (scripts/size-check.mjs). The honest "lean install" number. Ratchet DOWN with `node scripts/size-check.mjs --update` when a build shrinks; CI fails if a build grows past budget*1.03.',
      budgets: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { gzip: v.gzip, min: v.min }])),
    }
    writeFileSync(BUDGET_PATH, JSON.stringify(next, null, 2) + '\n')
    console.log(`\nsize-check: budget written to ${BUDGET_PATH}`)
    return
  }

  if (failed) {
    console.error('\nsize-check: FAILED — a bundle grew past its budget. Investigate, or `--update` to ratchet if intended.')
    process.exit(1)
  }
  console.log('\nsize-check: OK — all bundles within budget.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
