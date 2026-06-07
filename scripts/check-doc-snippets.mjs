#!/usr/bin/env node
// Doc-snippet truthfulness gate. Extracts every ```ts / ```typescript / ```tsx code fence from
// website/**/*.md, the root README, and packages/*/README.md into a per-page scratch module under
// website/.snippet-check/, then type-checks the
// whole batch with `tsc` against the workspace SOURCE (via tsconfig paths, same mapping examples/ use).
// A snippet whose fence is marked `ts no-check` (or `twoslash`, or carries a `no-check` meta word) is
// copied verbatim but excluded from compilation — reserve that for non-code blocks like install lines.
//
// WHY this exists: the guide writes code against the real public surface; this makes "the docs compile"
// a CI-checkable fact instead of a promise. If you change an API and a snippet goes stale, this fails.

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WEBSITE = join(ROOT, 'website')
const SCRATCH = join(WEBSITE, '.snippet-check')

// The reference/ tree is typedoc-generated API docs — never authored snippets, skip it.
const SKIP_DIRS = new Set(['.vitepress', 'reference', 'node_modules', '.snippet-check'])

async function walkMarkdown(dir) {
  const out = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      out.push(...(await walkMarkdown(join(dir, ent.name))))
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      out.push(join(dir, ent.name))
    }
  }
  return out
}

// Pull every fenced block; return { lang, meta, code, line } for each. `meta` is whatever trails the
// language token on the opening fence (e.g. "no-check").
function extractFences(src) {
  const fences = []
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const open = /^```(\w+)?([^\n`]*)$/.exec(lines[i])
    if (open) {
      const lang = (open[1] ?? '').toLowerCase()
      const meta = (open[2] ?? '').trim()
      const start = i + 1
      let j = start
      while (j < lines.length && !/^```\s*$/.test(lines[j])) j++
      fences.push({ lang, meta, code: lines.slice(start, j).join('\n'), line: start + 1 })
      i = j + 1
      continue
    }
    i++
  }
  return fences
}

function isTs(lang) {
  return lang === 'ts' || lang === 'typescript' || lang === 'tsx'
}

function isCheckable(meta) {
  // Skip blocks the author opted out of, plus twoslash (different toolchain).
  const words = meta.split(/\s+/).filter(Boolean)
  return !words.includes('no-check') && !words.includes('twoslash')
}

async function main() {
  if (existsSync(SCRATCH)) await rm(SCRATCH, { recursive: true, force: true })
  await mkdir(SCRATCH, { recursive: true })

  const mdFiles = await walkMarkdown(WEBSITE)
  // READMEs are the npm landing pages — their snippets must compile for the same reason the guide's do.
  const rootReadme = join(ROOT, 'README.md')
  if (existsSync(rootReadme)) mdFiles.push(rootReadme)
  for (const ent of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const readme = join(ROOT, 'packages', ent.name, 'README.md')
    if (existsSync(readme)) mdFiles.push(readme)
  }
  const generated = []
  let totalBlocks = 0
  let skipped = 0

  for (const md of mdFiles) {
    const src = await readFile(md, 'utf8')
    const fences = extractFences(src).filter((f) => isTs(f.lang))
    let blockIndex = 0
    for (const f of fences) {
      totalBlocks++
      if (!isCheckable(f.meta)) {
        skipped++
        continue
      }
      blockIndex++
      const relPath = relative(ROOT, md).replace(/[\\/]/g, '__').replace(/\.md$/, '')
      const ext = f.lang === 'tsx'? 'tsx': 'ts'
      const outFile = join(SCRATCH, `${relPath}__${blockIndex}.${ext}`)
      // Each snippet becomes its OWN module so top-level `import`/`const` across blocks never collide.
      const header =
        `// AUTO-GENERATED from ${relative(ROOT, md)} (block #${blockIndex}, src line ${f.line}). DO NOT EDIT.\n` +
        `// Marked-as-shown snippet — typechecked against workspace source via tsconfig paths.\n` +
        `export {}\n`
      await writeFile(outFile, header + f.code + '\n', 'utf8')
      generated.push({ outFile, md, line: f.line })
    }
  }

  if (generated.length === 0) {
    console.log(`doc-snippets: no checkable ts blocks found (scanned ${mdFiles.length} md files).`)
    return
  }

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      noEmit: true,
      composite: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      // Snippets show illustrative fragments; isolatedModules' single-statement rule is too strict here.
      isolatedModules: false,
      verbatimModuleSyntax: false,
      jsx: 'react-jsx',
      types: ['node', 'three'],
      paths: {
        'ecsia': ['../../packages/ecsia/src/index.ts'],
        '@ecsia/core': ['../../packages/core/src/index.ts'],
        '@ecsia/schema': ['../../packages/schema/src/index.ts'],
        '@ecsia/relations': ['../../packages/relations/src/index.ts'],
        '@ecsia/scheduler': ['../../packages/scheduler/src/index.ts'],
        '@ecsia/serialization': ['../../packages/serialization/src/index.ts'],
        '@ecsia/three': ['../../packages/three/src/index.ts'],
        '@ecsia/devtools': ['../../packages/devtools/src/index.ts'],
        '@ecsia/react': ['../../packages/react/src/index.ts'],
      },
    },
    include: ['**/*.ts', '**/*.tsx'],
  }
  await writeFile(join(SCRATCH, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8')

  console.log(
    `doc-snippets: typechecking ${generated.length} snippet(s) from ${mdFiles.length} md files ` +
      `(${skipped} block(s) skipped via no-check)…`,
  )

  const tsc = process.platform === 'win32'? 'tsc.cmd': 'tsc'
  const res = spawnSync(join(ROOT, 'node_modules', '.bin', tsc), ['-p', join(SCRATCH, 'tsconfig.json')], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  const out = (res.stdout ?? '') + (res.stderr ?? '')
  if (res.status !== 0) {
    // Rewrite scratch paths back to the source .md so the failure points at the doc, not the temp file.
    const remapped = out.replace(
      new RegExp(`website\\${sep}\\.snippet-check\\${sep}([^\\s(]+)\\.(tsx?)`, 'g'),
      (m, name, ext) => {
        const g = generated.find((x) => x.outFile.endsWith(`${name}.${ext}`))
        return g? `${relative(ROOT, g.md)} (snippet near line ${g.line})`: m
      },
    )
    console.error(remapped.trim() || 'tsc failed with no output')
    console.error('\ndoc-snippets: FAILED — a documentation code block does not typecheck.')
    process.exit(1)
  }

  console.log(`doc-snippets: OK — all ${generated.length} snippet(s) typecheck.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
