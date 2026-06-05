# Performance

::: warning Placeholder — P7 will fill this in
This page is intentionally a stub. Measured numbers belong here, and they are not ready yet. P7 will
populate it with a reproducible benchmark methodology and **honest** results — including the cases where
ecsia is *slower* than the single-purpose libraries.
:::

## What we will (and won't) claim

ecsia ships a [tinybench](https://github.com/tinylibs/tinybench) macro-benchmark suite (`pnpm
bench:macro`) against miniplex and bitECS. The honest summary today:

- **Single-thread iteration.** bitECS's raw SoA loop and miniplex's array iteration still **out-iterate**
  ecsia's accessor-indirected `query` path. We will not pretend otherwise.
- **Parallelism.** ecsia's edge is the **auto-parallel worker path** — no JS reference library ships one.
  A near-linear-speedup demonstration wants a cross-origin-isolated host (see
  [Parallelism](/guide/parallelism)).
- **Cross-worker relations.** bitECS's JS-object pair identity can't cross a worker boundary; ecsia's
  integer-encoded pairs can.

## Why this page is empty for now

Publishing a number without a fixed machine, fixed inputs, warmup discipline, and a documented method is
worse than publishing nothing. P7 will land:

- the benchmark harness invocation and environment capture,
- the comparison tables (iteration, parallel speedup, relation queries),
- and the caveats for each measurement.

Until then, run it yourself:

```ts no-check
pnpm bench:macro        # cross-library macro-benchmarks (miniplex, bitECS)
```

## See also

- [Parallelism](/guide/parallelism) — where ecsia's performance story actually is.
- The [status banner](/#status) — the broader "0.x, unpublished, experimental" caveat this page lives
  under.
