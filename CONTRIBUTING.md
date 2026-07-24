# Contributing

Issues and PRs welcome.

## Setup

- Node ≥ 20, pnpm ≥ 10, Bun (for `build:binary`), Rust stable (only for the menu-bar app).
- `pnpm install`, then `pnpm test`.

## Before opening a PR

```bash
pnpm lint && pnpm typecheck && pnpm format && pnpm test
```

CI runs the same checks on macOS.

## Guidelines

- No barrel files; import from the specific module.
- Prefer `unknown` + schema validation (zod) over type assertions.
- Tests accompany behavior changes — the stream parser, stall detector, queue, and HTTP API all have focused suites under `tests/`.
- The daemon must keep working without the menu-bar app; the app is a read-only-plus-cancel client of the HTTP API.
