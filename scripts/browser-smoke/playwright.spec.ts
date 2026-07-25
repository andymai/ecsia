// Playwright driver for the ecsia browser smoke. CI-ONLY: browsers are NOT installed locally (the
// user's machine stays clean). CI runs `npx playwright install --with-deps chromium` first.
//
// It stands up BOTH server variants against the SAME bundle and asserts the browser-scoped smoke
// (entry.ts) passes in each:
// • isolated (COOP/COEP) → crossOriginIsolated===true, SAB path selected, SAB alloc+grow succeed,
//   AND the browser Web-Worker pool ENGAGES (threading.createWorker → dist/worker.js) with the
//   threaded run's snapshot bytes IDENTICAL to a serial run — parallel equals serial in a real tab.
// • non-isolated (no headers) → crossOriginIsolated===false, probe falls back LOUDLY (no SAB path),
//   the scheduler warns ONCE and runs single-threaded with identical bytes (loud, never silent).

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
interface ThreadedSmoke {
  ok: boolean
  engaged: boolean
  fallbackWarned: boolean
  bytesEqual: boolean
  workers: number
  frames: number
  detail?: string
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
): Promise<{ smoke: SmokeResult; threaded: ThreadedSmoke }> {
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
    // The threaded smoke is async (real Web Workers); #smoke-result appears only after BOTH smokes settle.
    await page.waitForSelector('#smoke-result', { state: 'attached', timeout: 20_000 }).catch((e) => {
      throw new Error(`#smoke-result never appeared. In-page diagnostics:\n${diagnostics.join('\n') || '(none captured)'}\n${e}`)
    })
    return (await page.evaluate(() => ({
      smoke: (window as unknown as { __ecsiaSmokeResult: SmokeResult }).__ecsiaSmokeResult,
      threaded: (window as unknown as { __ecsiaThreadedResult: ThreadedSmoke }).__ecsiaThreadedResult,
    }))) as { smoke: SmokeResult; threaded: ThreadedSmoke }
  } finally {
    await close(server)
  }
}

test.describe('ecsia browser smoke', () => {
  test('isolated (COOP/COEP): crossOriginIsolated true + SAB path + threaded pool engages byte-identically', async ({ page }) => {
    const { smoke: r, threaded: t } = await runVariant(page, { isolation: true })
    for (const s of r.sections) expect(s.ok, `${s.name}: ${s.detail ?? ''}`).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.isolated).toBe(true)
    expect(r.sabAvailable).toBe(true)
    expect(r.sabPathSelected).toBe(true)
    expect(r.sabAllocated).toBe(true)
    // The headline: a REAL browser Web-Worker pool ran the schedule and reproduced the serial bytes.
    expect(t.engaged, `threaded pool did not engage: ${t.detail ?? ''}`).toBe(true)
    expect(t.fallbackWarned).toBe(false)
    expect(t.bytesEqual).toBe(true)
    expect(t.ok).toBe(true)
  })

  test('non-isolated (no headers): crossOriginIsolated false + probe and scheduler fall back loudly', async ({ page }) => {
    const { smoke: r, threaded: t } = await runVariant(page, { isolation: false })
    for (const s of r.sections) expect(s.ok, `${s.name}: ${s.detail ?? ''}`).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.isolated).toBe(false)
    // The load-bearing fallback assertion: with no isolation the probe must NOT select the SAB path.
    expect(r.sabAvailable).toBe(false)
    expect(r.sabPathSelected).toBe(false)
    // Scheduler-level fallback: LOUD (one-time warning), never silent — and output still identical.
    expect(t.engaged).toBe(false)
    expect(t.fallbackWarned, 'expected the one-time threaded-fallback warning').toBe(true)
    expect(t.bytesEqual).toBe(true)
    expect(t.ok).toBe(true)
  })
})
