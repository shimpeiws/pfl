# Command cheat-sheet

Every command accepts `--json`. Human output is not a stable contract; scripts
must use `--json`. `--help` and `--version` are meta-options, outside the
document contract.

## `inspect`

```sh
pfl inspect --runtime <id> [--allow-scope <scope>] [--json]
```

| Flag                    | Required | Meaning                                                                      |
| ----------------------- | -------- | ---------------------------------------------------------------------------- |
| `--runtime <id>`        | yes      | `claude-code`, `codex`, or `opencode`                                        |
| `--allow-scope <scope>` | no       | Grant `<runtime>:user` or `<runtime>:install` for this run only (repeatable) |

Exits 5 when the user scope is required and not granted.

## `report`

```sh
pfl report [--snapshot <id>] [--runtime <id>] [--explain] [--json]
```

Interprets the latest (or named) snapshot. Summary: effective element count,
shadowed count, conditional count, opaque layers, semantic facets. Each finding
carries `elements` — the redacted source path and kind of every cited element —
so `--json` readers do not need a `show` call per id. When the snapshot is
`partial`, the report lists the elements (`status` + `reason`) and
warning/error diagnostics that made it so; `--explain` additionally dumps the
stored observed diagnostics in full (in `--json`, as `data.explanation`).

## `list`

```sh
pfl list [--snapshot <id>] [--runtime <id>] [--facet <f>] [--kind <k>] [--origin <o>] [--status <s>] [--limit <n>] [--json]
```

Valid facets: `instructions`, `knowledge`, `memory`, `actions`, `delegation`,
`controls`.

Valid kinds: every element kind a registered runtime adapter can record —
`instructions`, `rules`, `skills`, `commands`, `subagents`, `hooks`,
`permissions`, `memory`, `plugin`, `mcp-configuration`, and more. An unknown
kind fails and lists the valid set. `--kind` is repeatable and ORs:
`--kind subagents --kind commands` matches either.

Valid origins: `project`, `user`, `managed`, `plugin`, `builtin`, `unknown`.

Valid statuses: `effective`, `shadowed`, `conditional`, `unresolved`, `unknown`.

`--limit <n>` prints at most `n` elements; the JSON `total` still reports how
many elements matched before truncation.

Elements are ordered by `id`. Each row shows the source path (or `(none)` when
none), id, kind, origin, status, and facets.

## `show`

```sh
pfl show <element-id> [--snapshot <id>] [--runtime <id>] [--json]
```

Drills into one element: observed fact, resolved interpretation, relations,
findings, and provenance.

## `graph`

```sh
pfl graph [--snapshot <id>] [--runtime <id>] [--json]
```

Renders the provenance graph (observed sources → resolved elements) and
resolution graph (inter-layer relations: accumulates, shadows, conditionally
activates).

## `diff`

```sh
pfl diff <snapshot-a> [snapshot-b] [--runtime <id>] [--json]
```

Compares two snapshots structurally (added / removed / changed elements),
by effective state (newly effective / no longer effective / activation changed),
and by semantic facet delta. The second operand defaults to `latest`.

## `--runtime` on read commands

`report`, `list`, `show`, `graph`, and `diff` accept `--runtime <id>`. Without
it, `latest` means whichever runtime was inspected last; with it, `latest`
means the newest stored run for that runtime. A named `--snapshot` (or a `diff`
operand) from another runtime is refused with exit 2. The runtime is also in
every human header and JSON `data.runtime`, so a consumer can assert which
snapshot answered.

## `snapshots`

```sh
pfl snapshots [--json]
```

Lists stored snapshots for the current project, newest first. A `partial` run
carries its causes — `partialCauses` in `--json`, a parenthesized summary in
human output — so the listing answers why without opening the snapshot.

## `gc`

```sh
pfl gc [--dry-run] [--keep <n>] [--prune-orphans] [--json]
```

Reclaims old runs (20 kept by default) and orphaned histories. `--dry-run`
lists what would be reclaimed without deleting. Orphaned project directories
are removed only with `--prune-orphans`. Run with `--dry-run --prune-orphans`
first.

## Exit codes

| Code | Stable name             | Meaning                                  |
| ---- | ----------------------- | ---------------------------------------- |
| 0    | `SUCCESS`               | Success, including partial results       |
| 2    | `CONFIG_ERROR`          | Missing or invalid argument              |
| 3    | `RUNTIME_UNSUPPORTED`   | Unknown runtime id                       |
| 4    | `INSPECTION_FAILED`     | Unexpected error during inspection       |
| 5    | `CONSENT_REQUIRED`      | Read outside the project without consent |
| 6    | `SNAPSHOT_STORE_FAILED` | I/O failure reading or writing `~/.pfl/` |
