// Bundles entry.ts -> dist/entry.js with esbuild (devDep). The bundle inlines the ecsia dist
// umbrella so the browser page runs the SHIPPED artifact with no import-map / node resolution in-tab.
//
// Run: node scripts/browser-smoke/build.mjs (also wired as `pnpm smoke:browser:bundle`)
// Requires `pnpm build` first (it bundles packages/ecsia/dist).

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const outdir = join(HERE, 'dist')

await mkdir(outdir, { recursive: true })

// No node-builtin stubs: the umbrella exposes the worker pool type-only + via loadWorkerPool(),
// so the static module graph is browser-clean. This build failing on a bare `node:*` import IS the
// regression signal that a node-only module leaked back into the barrel.
const result = await build({
  entryPoints: [join(HERE, 'entry.ts')],
  outfile: join(outdir, 'entry.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2023'],
  sourcemap: true,
  // No code splitting: a single self-contained module the <script type="module"> loads.
  metafile: true,
  logLevel: 'info',
})

// The shipped browser bundle must contain NO live node:* import (worker_threads / url): they were
// stubbed. A surviving reference would throw at <script type=module> load in a real browser.
const { readFile } = await import('node:fs/promises')
const code = await readFile(join(outdir, 'entry.js'), 'utf8')
if (/from\s*["']node:(worker_threads|url|os)["']/.test(code) || /require\(["']node:/.test(code)) {
  throw new Error('browser bundle still references a node: builtin — it would fail to load in a browser')
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`browser-smoke bundle built: ${outdir}/entry.js (${bytes} bytes)`)
