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
pfl report [--snapshot <id>] [--runtime <id>] [--json]
```

Interprets the latest (or named) snapshot. Summary: effective element count,
shadowed count, conditional count, opaque layers, semantic facets.

## `list`

```sh
pfl list [--snapshot <id>] [--runtime <id>] [--facet <f>] [--origin <o>] [--status <s>] [--json]
```

Valid facets: `instructions`, `knowledge`, `memory`, `actions`, `delegation`,
`controls`.

Valid origins: `project`, `user`, `managed`, `plugin`, `builtin`, `unknown`.

Valid statuses: `effective`, `shadowed`, `conditional`, `unresolved`, `unknown`.

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
pfl diff [snapshot-a] [snapshot-b] [--runtime <id>] [--json]
```

Compares two snapshots structurally (added / removed / changed elements),
by effective state (newly effective / no longer effective / activation changed),
and by semantic facet delta. The second operand defaults to `latest`. With no
operands the pair is previous vs latest within one runtime — `latest` resolves
first (scoped by `--runtime` when given), then the newest other run of the same
runtime becomes `snapshot-a`. A runtime with only one stored run fails with
exit 2.

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

Lists stored snapshots for the current project, newest first.

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
