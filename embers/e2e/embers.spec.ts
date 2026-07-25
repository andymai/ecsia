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

async function bench(
  page: import('@playwright/test').Page,
  port: number,
  kind: 'serial' | 'threaded',
  seed: number,
  ticks: number,
): Promise<BenchResult> {
  const diagnostics: string[] = []
  page.on('pageerror', (err) => diagnostics.push(`pageerror: ${err.stack ?? err.message}`))
  await page.goto(`http://localhost:${port}/index.html#bench=${kind}&seed=${seed}&ticks=${ticks}`, {
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
      expect(serial.live, 'the scripted scene should populate the pool').toBeGreaterThan(200)
      expect(threaded.threaded, 'the worker pool must actually engage under isolation').toBe(true)
      expect(threaded.hash, 'threaded hash must equal serial hash').toBe(serial.hash)
    } finally {
      await close(server)
    }
  })
})
