# ecsia browser smoke lane

A CI-only browser smoke that proves the **shipped** `@ecsia/ecsia` dist runs in a real Chromium tab and
that its SharedArrayBuffer capability probe behaves correctly under and without cross-origin isolation.

## Pieces

- `server.mjs` — zero-dep static server. **Default** mode sends `Cross-Origin-Opener-Policy:
  same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (the page becomes `crossOriginIsolated`).
  `--no-isolation` **omits** them (the page is not isolated). The Playwright spec stands up both variants
  against the same bundle.
- `entry.ts` — the browser-scoped smoke. esbuild bundles it (`build.mjs`) into `dist/entry.js`, inlining
  the `@ecsia/ecsia` dist umbrella. Exercises kernel ops (world/components/spawnWith/query/scheduler),
  an in-tab snapshot round-trip, the **capability probe** (`bootstrapForWorker(world).capabilities`), a
  `crossOriginIsolated` assertion, and raw resizable-`SharedArrayBuffer` alloc + grow (isolated only).
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

## HONEST SCOPING — what this lane does NOT claim

ecsia's `WorkerPool` is **`node:worker_threads`-based**. This browser lane does **NOT** exercise or claim
a threaded worker pool in the browser. The bundle’s build step deliberately stubs `node:worker_threads`
/ `node:url` (the umbrella statically re-exports `WorkerPool`, but the browser entry never constructs
one, and `pool.js` has no module-scope side effects), and the post-build check asserts no live `node:`
import survives. So the browser claim is strictly:

- the kernel + serialization run in-tab, and
- the SAB **capability probe** is correct — it selects the SAB path under isolation and **falls back
  loudly** (no SAB path) without it.

### Roadmap

A browser **Web-Worker** parallel pool (postMessage / SAB-shared columns under cross-origin isolation, as
an alternative dispatcher behind the same `updateThreaded` seam) is **future work**. Until it exists, any
"runs threaded in the browser" claim would be untrue, and this lane does not make it.
