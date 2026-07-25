// Playwright driver for EMBER WORKS determinism. CI-ONLY: browsers are NOT installed locally (the
// user's machine stays clean). CI runs `npx playwright install --with-deps chromium` first.
//
// It serves the BUILT embers bundle (website/public/embers) with cross-origin-isolation headers and
// drives the headless bench modes:
//   • #bench=serial   — single-threaded sim
//   • #bench=threaded — the Web-Worker field pool engages (SAB), same seed + same scripted strokes
// The two runs must produce a BYTE-IDENTICAL state hash: parallel equals serial in a real tab.

import { test, expect } from '@playwright/test'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createSmokeServer } from '../../scripts/browser-smoke/server.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EMBERS = join(ROOT, 'website', 'public', 'embers')

interface BenchResult {
  kind: string
  threaded: boolean
  seed: number
  ticks: number
  hash: string
  live: number
  msPerTick: number
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}
const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()))

const diagnostics: string[] = []

async function bench(
  page: import('@playwright/test').Page,
  port: number,
  kind: 'serial' | 'threaded',
  seed: number,
  ticks: number,
): Promise<BenchResult> {
  page.on('pageerror', (err) => diagnostics.push(`[${kind}] pageerror: ${err.stack ?? err.message}`))
  // The bench selector lives in the URL HASH, but two goto()s differing only in the fragment are a
  // same-document navigation in Chromium — the page never reloads and the second bench never runs.
  // A unique query per kind forces a full navigation so each bench executes from a fresh module.
  await page.goto(`http://localhost:${port}/index.html?run=${kind}#bench=${kind}&seed=${seed}&ticks=${ticks}`, {
    waitUntil: 'load',
  })
  await page.waitForSelector('#bench-done', { state: 'attached', timeout: 30_000 }).catch((e) => {
    throw new Error(`#bench-done never appeared (${kind}). Diagnostics:\n${diagnostics.join('\n') || '(none)'}\n${e}`)
  })
  return (await page.evaluate(() => (window as unknown as { __benchResult: BenchResult }).__benchResult)) as BenchResult
}

test.describe('EMBER WORKS determinism', () => {
  test('threaded field pool reproduces the serial hash byte-for-byte', async ({ page }) => {
    const server = createSmokeServer({ isolation: true, root: EMBERS })
    const port = await listen(server)
    try {
      const seed = 1234
      const ticks = 400
      const serial = await bench(page, port, 'serial', seed, ticks)
      const threaded = await bench(page, port, 'threaded', seed, ticks)
      const ctx = () => `\nserial=${JSON.stringify(serial)}\nthreaded=${JSON.stringify(threaded)}\ndiagnostics:\n${diagnostics.join('\n') || '(none)'}`
      expect(serial.live, `the scripted scene should populate the pool${ctx()}`).toBeGreaterThan(200)
      expect(threaded.threaded, `the worker pool must actually engage under isolation${ctx()}`).toBe(true)
      expect(threaded.hash, `threaded hash must equal serial hash${ctx()}`).toBe(serial.hash)
    } finally {
      await close(server)
    }
  })
})
