// Builds the Echo Survivors demo into website/public/demo/ so VitePress ships it at
// andymai.github.io/ecsia/demo/. Two esbuild bundles (page + Web Worker) over the BUILT dist
// packages (run `pnpm build` first — same posture as scripts/browser-smoke), plus the static shell
// (index.html, coi-sw.js). The same node-builtin guard as the smoke: no live node:* import may
// survive into either browser bundle.
//
// Run: node demo/build.mjs (wired as `pnpm demo:build`; `pnpm docs:build` runs it before vitepress)

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, copyFile, readFile } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const outdir = join(ROOT, 'website', 'public', 'demo')

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
    throw new Error(`demo bundle ${file} references a node: builtin — it would fail to load in a browser`)
  }
}

await copyFile(join(HERE, 'index.html'), join(outdir, 'index.html'))
await copyFile(join(HERE, 'coi-sw.js'), join(outdir, 'coi-sw.js'))

console.log(`demo built: ${outdir}`)
