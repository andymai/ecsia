# EMBER WORKS — the ecsia falling-sand showcase

**Direct link only (unlisted): `andymai.github.io/ecsia/embers`**

A juiced falling-sand playground: 18 reacting elements over a 640×360 grid, a threaded air/heat
field, and byte-identical replay URLs. Draw something, hit **share**, and the link re-simulates
your exact scene on any machine — the demo is a continuously running proof of ecsia's determinism
guarantee, in a genre where a single divergent grain is instantly visible on screen.

Sand piles and slides, water and oil flow and float by density, fire climbs and eats oil/wood,
lava melts sand to glass and flashes water to steam, gunpowder and nitro chain-detonate through
fuses, salt brines water (and drops its freezing point), plants creep across ponds, acid eats
through everything but glass. A quarter-res temperature/pressure field couples back into all of it.

## How it uses ecsia

| Feature | Where |
|---|---|
| One hot `Particle` component on a single archetype; element is a **field, not composition** | `src/sim/components.ts`, `src/sim/particles.ts` |
| **Pre-spawned pool + freelist** (`elem === NONE` is dead) — zero structural churn after world build | `src/sim/particles.ts` (`spawnAt`/`kill`) |
| Threaded air/heat field: `BANDS` double-buffered component pairs, disjoint write-sets share one wave across the Web-Worker pool | `src/sim/components.ts`, `src/sim/kernels.ts` |
| Determinism (parallel == serial == replayed) — one FNV state hash over every grain + the whole field | `src/sim/world.ts` |
| Raw-column fast paths (`eachChunk` / worker `columnView`) | `src/sim/systems.ts`, `src/sim/kernels.ts` |
| Main-thread pinning (`object<T>` on `MainPin`) keeps the CA kernel + paint serial by construction | `src/sim/components.ts` |
| Share/replay URLs — brush strokes recorded as inputs → RLE-ish delta → deflate-raw → base64url | `src/game/codec.ts` |

The simulation is fully deterministic: a seeded PRNG consumed only in the serial CA kernel, no
`Math.sin/cos` in sim math (portable polynomial-free arithmetic in `src/sim/shared.ts`), fixed
60 Hz ticks. A session is completely described by `(seed, brush-event stream)` — exactly what the
share URL encodes. Scripted presets and the idle attract scene are the *same* event stream that
live painting records, so scripted, hand-drawn, and replayed input flow through one code path.

## Layout

- `src/sim/` — elements table, components, the serial CA kernel, the threaded field math, world + hash
- `src/game/` — the share-URL codec, scripted presets, and the attract program
- `src/render/` — WebGL2: palette/emissive scene → HDR bloom → composite with heat-haze refraction,
  liquid sheen, and emissive light spill (procedural, zero assets)
- `src/main.ts` — orchestrator: input recorder, script/replay playback, stats HUD, share flow, frame pump
- `worker.ts` — the Web Worker file (`ecsiaWorker` + statically bundled field kernels)
- `coi-sw.js` — service worker adding COOP/COEP on GitHub Pages so `SharedArrayBuffer` exists

## Build & run

```sh
pnpm build          # library dist first (the demo bundles shipped artifacts)
pnpm embers:build   # esbuild → website/public/embers/ (deployed with the docs site)
pnpm embers:serve   # serve locally WITH cross-origin isolation → http://localhost:8898
```

Headless verification (also used by the E2E harness): open `/#bench=serial&seed=N&ticks=T` and
`/#bench=threaded&...` — each runs the attract program without rendering and exposes
`{ hash, msPerTick, live }`; the two hashes must match exactly.
