# Stability and compatibility (v1.0)

- Status: settled for v1.0
- Design references: `pfl-design-v0.1.md` §15; `pfl-roadmap-v1.0.md` M10
- Related: [`versions.md`](versions.md), [`pfl-json-contract.md`](pfl-json-contract.md),
  [`adr/0001-snapshot-serialization-and-ids.md`](adr/0001-snapshot-serialization-and-ids.md)

This document states what a user can rely on across releases: the versioning
policy, the command-line surface, and the on-disk schema.

## Platform support

`pfl` supports **POSIX only** — macOS and Linux. Windows is not supported, and
the package declares that in `package.json` `os` so an install on an
unsupported platform fails loudly rather than at first use. The published
contract is the CLI and the stored schema; the source modules are not a public
API (`package.json` `exports` exposes only `./package.json`).

## Semantic versioning

From v1.0 onward the package version is SemVer:

- **MAJOR** — a breaking change to the CLI contract (a removed or renamed
  command, flag, or exit code), to the `--json` document's field meanings, or to
  the on-disk schema in a way that is not additive.
- **MINOR** — a backwards-compatible addition: a new command, flag, runtime
  adapter, finding rule, or `--json` field.
- **PATCH** — a backwards-compatible fix.

A change to the **stored schema** is the strict case: any change to the
persisted shape, including an addition, bumps `SNAPSHOT_SCHEMA_VERSION` and is
therefore at least a MINOR package bump. The package version and the three
stored version values are independent; see [`versions.md`](versions.md). In
particular, the package version is **not** a compatibility signal for reading a
snapshot: a snapshot is read according to its own `schemaVersion`.

## Command-line stability

Within a MAJOR version these are stable:

- **Command and flag names.** A command or flag is not renamed or removed
  without a MAJOR bump. A new flag is additive.
- **Exit codes.** The codes and their stable names are frozen
  (`SUCCESS`, `CONFIG_ERROR`, `RUNTIME_UNSUPPORTED`, `INSPECTION_FAILED`,
  `CONSENT_REQUIRED`, `SNAPSHOT_STORE_FAILED`).
- **The `--json` envelope.** Every output command emits exactly one document on
  stdout with the common envelope; readers ignore unknown fields, so an added
  field is a MINOR change and a changed meaning is MAJOR.
  `docs/design/pfl-json-contract.md` is the contract.
- **Consent semantics.** A read outside the project requires the matching
  `<runtime>:<scope>` grant; a non-interactive run without it fails closed with
  exit 5. `--allow-scope` grants one run and is never persisted.

Human-readable output (the non-`--json` text) is **not** a stable contract: its
layout may change in a MINOR release. Scripts should use `--json`.

## Snapshot schema compatibility

- A stored artifact carries `schemaVersion`. An artifact whose version is not in
  `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS` is **refused, never guessed**: a scan
  skips it with a diagnostic (`unsupported-snapshot-schema`), and a direct read
  fails with exit 2 and the diagnostic. ADR 0001 defines the scheme.
- The on-disk schema is a stricter contract than the CLI document: any change to
  the persisted shape bumps the schema version, because a stored snapshot must
  be interpretable exactly or not at all.
- A newer binary reads an older supported snapshot; it does not read a snapshot
  written by a future schema. A snapshot's `schemaVersion` decides, not the
  package version.

## Deprecation

A deprecated command or flag is documented as deprecated for at least one MINOR
release before removal at the next MAJOR. Deprecations are recorded here and in
the `CHANGELOG`. None are outstanding.
