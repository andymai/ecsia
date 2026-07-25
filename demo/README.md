# ECHO SURVIVORS — the ecsia showcase demo

**Play it: [andymai.github.io/ecsia/demo](https://andymai.github.io/ecsia/demo/)**

A retro-CRT, time-loop survivors game: survive the 90-second loop; every death rewinds time and
adds a ghost of your past self, replaying your exact recorded inputs. Eight lives. The horde
scales with your echoes. Finished runs share as URLs that any machine re-simulates and verifies
**byte-identically** — the demo is a continuously running proof of ecsia's determinism guarantee.

## How it uses ecsia

| Feature | Where |
|---|---|
| Browser Web-Worker pool (`threading.createWorker` + `ecsiaWorker`) | horde steering: 4 cohort systems with disjoint writes share one wave across up to 4 workers |
| Topics (worker-side `consume`) | player-position beacons published serially, consumed inside worker kernels |
| Raw-column fast paths (`eachChunk` / `columnView`) | steering twins, collision grid build, rendering, state hash |
| Determinism (parallel == serial) | one state hash across serial, threaded, and replayed runs; the replay verifier checks it |
| Main-thread pinning (`object<T>` field on `MainPin`) | every structural/gameplay system stays serial by construction |

The simulation is fully deterministic: seeded PRNG consumed only in serial systems, no
`Math.sin/cos` (portable polynomial approximations in `src/sim/shared.ts`), all progression
positional (no menus), fixed 60 Hz ticks. A run is completely described by
`(seed, overdrive, input streams)` — which is exactly what the share URL encodes
(RLE → deflate-raw → base64url).

## Layout

- `src/sim/` — components, systems, worker kernels, the deterministic step math, the run builder
- `src/game/` — the replay-URL codec
- `src/render/` — WebGL2 instanced sprite renderer + CRT post pass (procedural pixel atlas, zero assets)
- `src/main.ts` — orchestrator: run/echo state machine, input, HUD, share/replay flow
- `worker.ts` — the Web Worker file (`ecsiaWorker` + statically bundled kernels)
- `coi-sw.js` — service worker adding COOP/COEP on GitHub Pages so `SharedArrayBuffer` exists

## Build & run

```sh
pnpm build          # library dist first (the demo bundles shipped artifacts)
pnpm demo:build     # esbuild → website/public/demo/ (deployed with the docs site)
pnpm demo:serve     # serve locally WITH cross-origin isolation → http://localhost:8899
```

Headless verification (also used by the E2E harness): open
`/#bench=serial&seed=N&ticks=T` and `/#bench=threaded&...` — each runs a scripted deterministic
life without rendering and exposes `{ hash, msPerTick }`; the two hashes must match exactly.
