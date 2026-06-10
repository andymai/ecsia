## What does this PR do?

## How to test

## Checklist

- [ ] Tests pass (`pnpm test`) — and a behavior change adds a test that fails without it
- [ ] Type checks pass (`pnpm typecheck:extras` + `pnpm typecheck:tests`)
- [ ] Doc snippets compile (`pnpm docs:check`) — required if a public API changed
- [ ] Layering preserved (no upward imports; umbrella stays pure re-exports)
- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/)
