# Contributing to ecsia

Thanks for your interest in ecsia. This is a young project — bug reports, repros, and focused
pull requests are all welcome.

## Getting set up

ecsia is a pnpm monorepo. You need **Node 22.13+** and **pnpm** (the repo pins a version via
`packageManager`; [Corepack](https://nodejs.org/api/corepack.html) will use it automatically).

```sh
pnpm install
pnpm build        # tsc -b across all packages (only needed for dist-consuming smokes)
pnpm test         # all vitest projects: unit, property, worker, type-level
```

Tests run against `packages/*/src` through vitest aliases, so most of the time you don't need a
build — just `pnpm test` or a single file:

```sh
pnpm vitest run packages/core/test/m4-queries.property.test.ts
```

### The local gate

Before opening a PR, run what CI runs:

```sh
pnpm build
pnpm typecheck:extras   # type-checks examples/ and bench/
pnpm typecheck:tests    # strict type-check of packages/*/test (a CI gate, not part of `pnpm test`)
pnpm docs:check         # compile-checks the code snippets in README + website docs
pnpm test
```

If you changed a public API, `pnpm docs:check` is the one people forget — it compiles every
documentation snippet against the real types.

## Project shape & invariants

A few rules keep the architecture honest. Please don't break them in a PR:

- **Layering is acyclic; nothing imports upward.** `@ecsia/schema` → `@ecsia/core` → everything
  else. Sibling packages (relations, scheduler, serialization, …) attach to core through
  `__`-prefixed seams on `World`; core never imports them.
- **The `@ecsia/kit` umbrella is pure static re-exports** with no module-scope side effects —
  tree-shaking depends on it. Don't add glue or expose the `__` seams there.
- **Parallel must equal serial.** The threaded scheduler's output is property-tested
  byte-identical to single-threaded. Changes to storage, scheduling, or command buffers must
  preserve that.
- **`docs/spec/` is normative.** Check the relevant spec before changing semantics.

The repo's [`CLAUDE.md`](./CLAUDE.md) has the short version of these, plus the commands.

## Pull requests

- **Branch from `main`** — don't push to `main` directly (it bypasses required checks).
- **Conventional Commits.** The PR title (and squash-merge subject) must follow
  [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`, `docs:`,
  `test:`, `chore:`, `refactor:`, … with a lowercase subject. A CI check enforces this.
- **Keep it focused.** One concern per PR; separate refactors from behavior changes.
- **Tests with behavior changes.** A bug fix should come with a test that fails without it.
- **Green CI.** All checks (build/test across Node versions, the runtime smokes, the bundle-size
  budget, docs:check, and the automated review) must pass. PRs squash-merge.

New to the codebase? Issues labeled `good first issue` are a good place to start, and the
[architecture guides](https://andymai.github.io/ecsia/) explain how the pieces fit.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/andymai/ecsia/issues/new/choose). A minimal repro —
ideally a few lines against `@ecsia/kit` — is the single most helpful thing you can include.

For security issues, **do not open a public issue** — see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](./LICENSE).
