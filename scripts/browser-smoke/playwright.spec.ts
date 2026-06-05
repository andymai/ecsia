// Playwright driver for the ecsia browser smoke. CI-ONLY: browsers are NOT installed locally (the
// user's machine stays clean). CI runs `npx playwright install --with-deps chromium` first.
//
// It stands up BOTH server variants against the SAME bundle and asserts the browser-scoped smoke
// (entry.ts) passes in each:
//   • isolated (COOP/COEP)      → crossOriginIsolated===true, SAB path selected, SAB alloc+grow succeed
//   • non-isolated (no headers) → crossOriginIsolated===false, probe falls back LOUDLY (no SAB path)
//
// HONEST SCOPING: no threaded worker pool is exercised here — ecsia's WorkerPool is node:worker_threads
// based; a browser Web-Worker pool is future work (see README).

import { test, expect } from '@playwright/test'
import type { Server } from 'node:http'
import { createSmokeServer } from './server.mjs'

interface SmokeSection { name: string; ok: boolean; detail?: string }
interface SmokeResult {
  ok: boolean
  isolated: boolean
  expectedIsolated: boolean
  backing: string
  sabAvailable: boolean
  sabPathSelected: boolean
  sabAllocated: boolean
  sabGrew: boolean
  sections: SmokeSection[]
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function runVariant(
  page: import('@playwright/test').Page,
  { isolation }: { isolation: boolean },
): Promise<SmokeResult> {
  const server = createSmokeServer({ isolation })
  const port = await listen(server)
  const diagnostics: string[] = []
  page.on('pageerror', (err) => diagnostics.push(`pageerror: ${err.stack ?? err.message}`))
  page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') diagnostics.push(`console.${msg.type()}: ${msg.text()}`) })
  try {
    const expectIsolated = isolation ? '1' : '0'
    await page.goto(`http://localhost:${port}/index.html?isolated=${expectIsolated}`, {
      waitUntil: 'load',
    })
    await page.waitForSelector('#smoke-result', { timeout: 10_000 }).catch((e) => {
      throw new Error(`#smoke-result never appeared. In-page diagnostics:\n${diagnostics.join('\n') || '(none captured)'}\n${e}`)
    })
    return (await page.evaluate(() => (window as unknown as { __ecsiaBrowserSmoke: () => SmokeResult }).__ecsiaBrowserSmoke())) as SmokeResult
  } finally {
    await close(server)
  }
}

test.describe('ecsia browser smoke', () => {
  test('isolated (COOP/COEP): crossOriginIsolated true + SAB path + alloc/grow', async ({ page }) => {
    const r = await runVariant(page, { isolation: true })
    for (const s of r.sections) expect(s.ok, `${s.name}: ${s.detail ?? ''}`).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.isolated).toBe(true)
    expect(r.sabAvailable).toBe(true)
    expect(r.sabPathSelected).toBe(true)
    expect(r.sabAllocated).toBe(true)
  })

  test('non-isolated (no headers): crossOriginIsolated false + probe falls back loudly', async ({ page }) => {
    const r = await runVariant(page, { isolation: false })
    for (const s of r.sections) expect(s.ok, `${s.name}: ${s.detail ?? ''}`).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.isolated).toBe(false)
    // The load-bearing fallback assertion: with no isolation the probe must NOT select the SAB path.
    expect(r.sabAvailable).toBe(false)
    expect(r.sabPathSelected).toBe(false)
  })
})
