# Contributing to pfl

Thanks for helping. This project is small and its rules are few; the ones below
are the ones a pull request is expected to follow.

## Setup

Node.js `>=22` and pnpm `11.6.0`. This repository pins both with
[mise](https://mise.jdx.dev/):

```sh
mise install
pnpm install
```

`pnpm install` also installs the git hooks (lefthook).

## Before you open a pull request

Run every gate locally; CI runs the same set on Linux and macOS.

```sh
pnpm test               # vitest run
pnpm run check          # oxlint --deny-warnings
pnpm run format         # oxfmt --check
pnpm run build          # tsc --build (type check)
pnpm run typecheck:test # tsc -p tsconfig.test.json
pnpm run knip           # unused exports
```

Prefer a targeted test file while iterating (`pnpm test <path>`).

## Design rules the code holds to

`CLAUDE.md` lists the invariants (read-only, no execution, no symlink
traversal, deny-by-default persistence, best-effort never silent). A change
that breaks one is a defect, not a tradeoff. When a summary and
`docs/design/pfl-design-v0.1.md` disagree, the design document is right.

If a change touches a trust-boundary path (`src/discovery/**`, `src/util/fs.ts`,
`src/limits.ts`, `src/redact/**`, `src/snapshot/store.ts`, or a runtime
adapter's `paths`/`consent`/`detect`), add a review under
`docs/security/reviews/` as part of the pull request.

## Commits and pull requests

- Commit messages follow the conventional-commit prefixes already in the
  history (`feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `chore`) and name
  the milestone and issue where there is one, e.g.
  `feat(runtime): add the OpenCode adapter (M9, #93)`.
- Keep the diff focused. The repository squash-merges, so the pull-request title
  becomes the commit subject; the body is what a reviewer reads.
- State what you verified, not only what you changed. A test that would fail on
  the regression is worth more than a description of the fix.
- A change to a persisted shape or the `--json` document is a compatibility
  event; see [`docs/design/stability.md`](docs/design/stability.md).

## Reporting a security issue

Do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).
