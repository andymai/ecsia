# ecsia browser smoke lane

A CI-only browser smoke that proves the **shipped** `ecsia` dist runs in a real Chromium tab, that its
SharedArrayBuffer capability probe behaves correctly under and without cross-origin isolation, and that
the **browser Web-Worker pool** reproduces the serial result **byte-identically** in a real tab.

## Pieces

- `server.mjs` — zero-dep static server. **Default** mode sends `Cross-Origin-Opener-Policy:
  same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (the page becomes `crossOriginIsolated`).
  `--no-isolation` **omits** them (the page is not isolated). The Playwright spec stands up both variants
  against the same bundle.
- `entry.ts` — the browser-scoped smoke. esbuild bundles it (`build.mjs`) into `dist/entry.js`, inlining
  the `ecsia` dist umbrella. Exercises kernel ops (world/components/spawnWith/query/scheduler),
  an in-tab snapshot round-trip, the **capability probe** (`bootstrapForWorker(world).capabilities`), a
  `crossOriginIsolated` assertion, raw resizable-`SharedArrayBuffer` alloc + grow (isolated only), and
  the **threaded pool smoke**: `threading.createWorker` spawns real Web Workers (dist/worker.js) and the
  threaded run's snapshot bytes must equal a serial run's.
- `worker.ts` + `threaded-fixture.ts` — the Web Worker file (`ecsiaWorker` from the scheduler's shipped
  browser entry + statically bundled kernels) and the defs/kernels shared with the page entry.
- `index.html` — sets `window.__ECSIA_EXPECT_ISOLATED` from `?isolated=1|0` before importing the bundle,
  so one bundle covers both server variants.
- `build.mjs` — esbuild bundle step (`pnpm smoke:browser:bundle`). Requires `pnpm build` first.
- `playwright.spec.ts` + `playwright.config.ts` — the CI driver. **Browsers are not installed locally**;
  CI runs `npx playwright install --with-deps chromium` first.

## Build + run

```sh
pnpm build                     # build the dist the bundle inlines
pnpm smoke:browser:bundle      # esbuild -> scripts/browser-smoke/dist/entry.js
pnpm smoke:browser             # playwright test (CI only — needs an installed Chromium)
```

## What this lane claims

- the kernel + serialization run in-tab (shipped dist, no import maps);
- the SAB **capability probe** is correct — it selects the SAB path under isolation and **falls back
  loudly** (no SAB path) without it;
- the **browser Web-Worker pool** (transport seam + `ecsiaWorker` browser entry, SAB-shared columns,
  `Atomics.waitAsync` main-thread wave fence) engages under COOP/COEP and reproduces the serial run's
  snapshot **byte-for-byte** — and without isolation, the scheduler's fallback is a one-time warning
  plus a single-threaded run with the SAME bytes (loud, never silent).

The post-build check still asserts no live `node:` import survives in either bundle — the pool's Node
transport loads lazily and only on Node.
