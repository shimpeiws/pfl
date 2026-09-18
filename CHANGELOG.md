# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from v1.0
onward. The package version is not a compatibility signal for the on-disk
snapshot schema, the resolution semantics, or the classifier; see
[`docs/design/stability.md`](docs/design/stability.md).

## [1.0.0-rc.1] - 2026-09-18

### Added

- **Three runtime adapters.** `claude-code`, `codex`, and `opencode` are
  inspected end to end: static discovery, four-dimension resolution, the
  deterministic facet classifier and descriptive findings, immutable snapshot
  storage, and rendering (`inspect`, `report`, `list`, `show`, `graph`, `diff`,
  `snapshots`, `gc`).
- **Consent as a choke point.** Reads outside the project are classified into
  scopes (`<runtime>:user`, `<runtime>:install`) and gated in one place, with a
  headless `--allow-scope` grant that never widens the stored grants.
- **A machine-readable contract.** Every output command accepts `--json` and
  emits one common envelope; the contract is frozen in
  `docs/design/pfl-json-contract.md`.
- **A frozen schema.** Stored artifacts and command documents are pinned by
  golden fixtures, and the version knobs are documented in
  `docs/design/versions.md`.
- **A read-path inventory and security review trail.** `docs/security/`
  records every read, its consent class, and the accepted risks.

### Changed

- OpenCode's verified range is a discrete set (1.18.0, 1.18.30, 1.18.31), not a
  continuous range; an unmeasured version inside the span is unverified.
- Shared adapter scaffolding (element builders, guarded file reads, the builtin
  layer) moved into `src/runtime/scaffold.ts`, and the facet/finding tables are
  now contributed by adapters over a core table.

## [0.1.1] - 2026-09-16

### Added

- Initial release: static inspection for `claude-code` and `codex`.
