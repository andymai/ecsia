// Builds the EMBER WORKS demo into website/public/embers/ so VitePress ships it at
// andymai.github.io/ecsia/embers/. Two esbuild bundles (page + Web Worker) over the BUILT dist
// packages (run `pnpm build` first — same posture as demo/build.mjs), plus the static shell.
// Same node-builtin guard as the demo: no live node:* import may survive into a browser bundle.
//
// Run: node embers/build.mjs (wired as `pnpm embers:build`; `pnpm docs:build` runs it before vitepress)

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, copyFile, readFile } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const outdir = join(ROOT, 'website', 'public', 'embers')

await mkdir(outdir, { recursive: true })

await build({
  entryPoints: { main: join(HERE, 'src', 'main.ts'), worker: join(HERE, 'worker.ts') },
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2023'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
})

for (const file of ['main.js', 'worker.js']) {
  const code = await readFile(join(outdir, file), 'utf8')
  if (/from\s*["']node:(worker_threads|url|os)["']/.test(code) || /require\(["']node:/.test(code)) {
    throw new Error(`embers bundle ${file} references a node: builtin — it would fail to load in a browser`)
  }
}

await copyFile(join(HERE, 'index.html'), join(outdir, 'index.html'))
await copyFile(join(HERE, 'coi-sw.js'), join(outdir, 'coi-sw.js'))

console.log(`embers built: ${outdir}`)
