# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
pnpm build                                       # tsc -b, needed only for dist-consuming smokes
pnpm test                                        # all vitest projects
pnpm vitest run <path>                           # single test file
pnpm docs:check                                  # compile-check doc snippets — run after public API changes
```

Tests run against `packages/*/src` via vitest aliases — no build needed. No linter or formatter is configured.

## Invariants

- **Layering is acyclic; nothing imports upward.** `@ecsia/schema` → `@ecsia/core` → everything else. Sibling packages (relations, scheduler, serialization) attach to core through `__`-prefixed seams on `World`, never by core importing them.
- **The `ecsia` umbrella is pure static re-exports.** It `Omit`s the `__` seams from public types and must stay free of module-scope side effects (tree-shaking depends on it). Don't expose seams publicly or add glue there.
- **`src/internal.ts` is for that package's own tests only** (relative import, not in `exports`). Symbols that sibling packages need live on core's public `index.ts` under the "INTERNAL (cross-package)" banner — don't move them.
- **`docs/spec/` is normative; `world.md` is the keystone.** Check the relevant spec before changing semantics. Published docs live in `website/`.
- **Parallel must equal serial** — the threaded scheduler's output is property-tested byte-identical to single-threaded. Changes to storage, scheduling, or command buffers must preserve this.
