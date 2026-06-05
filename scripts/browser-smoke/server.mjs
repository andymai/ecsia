// Tiny zero-dependency static server for the ecsia browser smoke lane.
//
// DEFAULT mode sends the cross-origin-isolation headers a SharedArrayBuffer page needs:
// Cross-Origin-Opener-Policy: same-origin
// Cross-Origin-Embedder-Policy: require-corp
// Under these headers a Chromium tab reports `crossOriginIsolated === true`, so the capability probe
// selects the SAB path and `new SharedArrayBuffer(...)` is allowed.
//
// --no-isolation mode OMITS those headers. The page then reports `crossOriginIsolated === false`; the
// smoke asserts the capability probe FALLS BACK LOUDLY (no SAB path) instead of silently pretending. CI
// runs BOTH server variants against the SAME bundle to prove both branches.
//
// Usage:
// node server.mjs [--port 8080] [--no-isolation] [--root <dir>]
// The server serves this directory (scripts/browser-smoke) plus the built bundle at /dist/.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, extname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { port: 8080, isolation: true, root: HERE }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-isolation') args.isolation = false
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--root') args.root = argv[++i]
  }
  return args
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function createSmokeServer({ isolation = true, root = HERE } = {}) {
  return createServer(async (req, res) => {
    // Cross-origin isolation headers — present iff isolation mode is on. They are what flips
    // `crossOriginIsolated` to true in the browser and unlocks SharedArrayBuffer.
    if (isolation) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    }
    // CORP on every asset so the isolated page may load its own same-origin resources under require-corp.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '/') pathname = '/index.html'

      // Resolve within root; reject path traversal.
      const filePath = normalize(join(root, pathname))
      if (!filePath.startsWith(normalize(root))) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }

      const info = await stat(filePath).catch(() => null)
      if (!info || !info.isFile()) {
        res.statusCode = 404
        res.end('not found')
        return
      }

      const body = await readFile(filePath)
      res.statusCode = 200
      res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-store')
      res.end(body)
    } catch (err) {
      res.statusCode = 500
      res.end(`error: ${err && err.message ? err.message : err}`)
    }
  })
}

// Run directly: node server.mjs [...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const server = createSmokeServer({ isolation: args.isolation, root: args.root })
  server.listen(args.port, () => {
    console.log(
      `browser-smoke server: http://localhost:${args.port}  ` +
        `isolation=${args.isolation ? 'on (COOP/COEP)' : 'off (no isolation)'}`,
    )
  })
}
