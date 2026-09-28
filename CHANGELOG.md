# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from v1.0
onward. The package version is not a compatibility signal for the on-disk
snapshot schema, the resolution semantics, or the classifier; see
[`docs/design/stability.md`](docs/design/stability.md).

## [Unreleased]

## [1.2.0] - 2026-09-28

### Added

- **`pfl inspect --cell-id <id>`** (#212) — record a caller-asserted isolation
  cell identifier as `provenance.cellId` on the observed snapshot, surfaced as
  `cellId` in `inspect` and `export` JSON (`null` when absent). The value is
  provenance, not verification: it does not change snapshot or element
  identity and does not certify which environment was observed.
- **Snapshot schema bumped (1 → 2).** Schema-1 artifacts remain readable; their
  absent `provenance` surfaces as `cellId: null`. See ADR 0004 and
  `docs/design/schema-bump-procedure.md`.
- **`pfl export --cell-id <id> --out <dir>`** (#213) — override cell provenance
  on the exported document; `--out` writes the full envelope JSON to
  `<dir>/<snapshot-id>.json` with mode `0o600`. Rejects destinations inside the
  inspected project.
- **Dead-path annotation** (ProjectIndex v2) — `markDeadPath` / `clearDeadPath` /
  `isDeadPath` idempotent functions; `deadPath: boolean` on export snapshots.
- **`credentialKeyNames()`** on `RuntimeAdapter` — returns sensitive env var
  names per adapter (claude-code, codex, opencode) for credential-stripped
  observer environments.

## [1.1.0] - 2026-09-27

### Added

- **`pfl export`** — emit a sanitized full IR in one JSON document.
- **Evidence bundle mode** (`--bundle <dir>`) — collect sanitized IR, manifest,
  and metadata into a self-contained directory for review.
- **`--runtime` flag** on read commands (`inspect`, `report`, `list`, `show`,
  `graph`, `diff`, `snapshots`) to scope `latest` to a single runtime.
- **`--kind` filter and `--limit`** on `list` to narrow element output.
- **Origin / facet / kind / status filters** on `graph` with deduped facet
  rendering.
- **Findings carry cited element path and kind** (`report`, `list`).
- **Partial snapshot cause explanation** in `report` and `snapshots`.
- **Cross-runtime compat scopes** surfaced in `report`, `list`, and `graph`.
- **Human-readable source path** shown on each element in `list`.
- **Store location** shown in human and JSON output (`inspect`).
- **Relation endpoints** rendered by source path in `show`.
- **Duplicate catalog name detection** in `claude-code` and `codex` adapters.
- **Distributable agent skill** shipped under `skills/pfl/`.

### Changed

- **Resolution semantics bumped (1 → 2).** The derivation and relation rules
  changed; stored resolved snapshots from v1.0 are incompatible with the new
  semantics.

### Fixed

- `claude-code`: encode dots in project directory names like Claude Code.
- `claude-code`: resolve marketplace catalogs as unresolved, not effective.
- Prune nested git checkouts from project instruction walks.
- Keep embedded paths readable in diagnostic messages (`redact`).

## [1.0.0] - 2026-09-18

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
