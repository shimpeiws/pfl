# The `--json` document contract (v1.0)

- Status: frozen for v1.0
- Issue: #80
- Design references: `pfl-roadmap-v1.0.md` M8; `pfl-design-v0.1.md` §2.2 (principle 8), §19 (display vs persistence)
- Implementation: `src/cli/document.ts`, `src/index.ts`

`--json` is a contract a program can depend on: one document per run, a common
envelope, a defined failure shape, and stated compatibility rules. This document
is the contract, written out. It is described nowhere else.

It covers every command that produces output — `inspect`, `report`, `list`,
`show`, `graph`, `snapshots`, `diff`, and `gc` (the last implemented under
issue #87).

## One document per run

Under `--json`, **stdout carries exactly one JSON object and nothing else**. A
consumer parses the whole of stdout; it never has to split lines or skip
progress output first.

Every log line, progress message, and human-readable warning goes to **stderr**.
The stderr stream is not part of the contract: it is for a human watching the
run, and a command may or may not echo its document `diagnostics` there.

## Envelope

Every document — success or failure — has the same six fields. Only `data`
varies by command.

| Field | Type | Meaning |
| --- | --- | --- |
| `pflVersion` | string | The package version that produced the document. |
| `command` | string | The command name, e.g. `report`. |
| `ok` | boolean | True whenever the command did its job, partial results included; false exactly when the exit code is non-zero. |
| `completeness` | `"complete" \| "partial" \| "unknown"` | The completeness of the harness that was observed. |
| `diagnostics` | `Diagnostic[]` | Diagnostics surfaced by the run, in emission order. |
| `data` | object | Command-specific payload (see below). |

`ok` and `completeness` answer different questions and are not redundant. A run
that skipped every element against a resource limit is `ok: true` with
`completeness: "partial"`: best-effort completion is normal operation. A run
that failed to read the store is `ok: false`. A consumer that needs to react to
a partial harness checks `completeness`, not `ok`.

Commands that do not observe a single harness report `completeness: "unknown"`:
`snapshots` and `gc`. `diff` observes two, and reports `"partial"` if either side
is partial, `"complete"` only if both are complete, and `"unknown"` otherwise.

### `diagnostics`

`diagnostics` uses the same shape as the persisted form, so one schema serves
the document and a stored snapshot:

```json
{ "severity": "warning", "code": "unreadable-snapshot", "message": "…", "path": "~/.pfl/…" }
```

- `severity` is `"info"`, `"warning"`, or `"error"`.
- `code` is a **stable identifier** — match on it.
- `message` is free text and is **not** stable — do not match on it.
- `path` is optional, and is redacted the same way persisted paths are. A store
  diagnostic's `path` is store-relative and names the artifact class
  (`snapshots/…`, `observations/…`, `interpretations/…`).

The stable codes a consumer of the frozen contract may match on:

| Code | Meaning |
| --- | --- |
| `unsupported-snapshot-schema` | An artifact's `schemaVersion` is not supported; its message names the version found and the versions supported. |
| `invalid-snapshot` | An artifact is malformed: invalid JSON, or contents of the wrong shape. |
| `unreadable-snapshot` / `unreadable-observation` / `unreadable-interpretation` | A scan skipped an artifact it could not read: the store guard refused it (symlink, hardlink, non-regular, or over the size limit), or it failed to deserialize for another reason. |

Harness diagnostics (for example `runtime-version-unverified`) keep their own
codes and are command-specific. An artifact diagnostic in a failure document is
`severity: "error"`; the same condition found by a scan is `severity: "warning"`,
because the scan skips the artifact and continues.

## Partial results and exit codes

`completeness: "partial"` exits **0**. Best-effort completion is normal
operation; an unreadable file in a user's harness is not a failure of the run.
The frozen exit-code set gains no new members for partial results.

| Exit | Stable name | Meaning |
| --- | --- | --- |
| 0 | `SUCCESS` | Success, including partial results. |
| 2 | `CONFIG_ERROR` | A missing or invalid argument. |
| 3 | `RUNTIME_UNSUPPORTED` | The requested runtime id is unknown. |
| 4 | `INSPECTION_FAILED` | An unexpected error during inspection. |
| 5 | `CONSENT_REQUIRED` | A read outside the project needs consent and none was given. |
| 6 | `SNAPSHOT_STORE_FAILED` | Writing or reading `~/.pfl/` failed. |

## Failure shape

**Every exit emits the envelope, including failures.** A non-zero exit sets
`ok: false` and puts an `error` object in `data`:

```json
{
  "pflVersion": "0.1.1",
  "command": "inspect",
  "ok": false,
  "completeness": "unknown",
  "diagnostics": [],
  "data": { "error": { "code": "RUNTIME_UNSUPPORTED", "message": "unknown runtime: bogus" } }
}
```

`code` is the stable exit-code **name** from the table above, never its number.
`message` is free text.

A `PflError` may add structured context beside `error`. Consent absence is the
same shape, exiting 5 with the missing scope keys in `missingScopes`:

```json
{
  "ok": false,
  "data": {
    "error": { "code": "CONSENT_REQUIRED", "message": "reading outside the project requires consent for claude-code:user; …" },
    "missingScopes": ["claude-code:user"]
  }
}
```

So a caller acts on the document rather than parsing prose from stderr.

A failure may also carry `diagnostics` when its cause is a recorded condition
rather than a bare error. An artifact whose schema this binary does not support
is the v1.0 case: a direct read of it fails with exit 2 (`CONFIG_ERROR`) and a
diagnostic whose `code` is `unsupported-snapshot-schema` and whose `message`
names the version found and the versions supported, instead of a store failure.
A malformed artifact is the same shape with `invalid-snapshot`. A scan
(`snapshots`) skips such an artifact and succeeds with the diagnostic.

Argument errors are the same envelope, even though they are rejected before the
command runs: an unknown option or a missing required argument exits 2 with
`CONFIG_ERROR`, so a `--json` run never falls back to a stack trace. An unknown
command is the same — `pfl bogus` exits 2 rather than doing nothing. With no
command at all, `pfl` prints help and exits 0, while `pfl --json` has no command
to document and exits 2 with `CONFIG_ERROR`.

`--help` and `--version` are meta-options, not command runs: they print to
stdout and exit 0 even alongside `--json`, and are outside this contract.

## Command `data` shapes

Only `data` varies. Each shape below is the payload once, not repeated per run.

### `inspect`

```text
{
  runtime, runtimeVersion, runtimeCompatibility,
  project,
  store,
  observed: { snapshotId, elements, opaqueLayers, completeness },
  resolved: { snapshotId, effective, conditional, shadowed, confidence }
}
```

`store` is the home-redacted project directory under `~/.pfl/`, e.g.
`~/.pfl/projects/git-0f214d60555919a5`. It tells the user where artifacts were
written. A field addition to `data` is minor per the Compatibility section.

Observed and resolved diagnostics travel in the envelope's `diagnostics`, not
nested under `data`.

### `report`

```text
{
  runtime, runtimeName,
  project: { id, displayName },
  observedSnapshotId, resolvedSnapshotId,
  confidence,
  stats, findings,
  interpretation: { classifierVersion, origin }
}
```

### `list`

```text
{ runtime, count, total, elements: [{ id, path?, kind, origin, status, facets }], interpretation: { classifierVersion, origin } }
```

`elements` is ordered by `id`. `count` is the number of returned elements;
`total` is how many elements matched the filters before `--limit` truncated
the list, so `total` >= `count` always. `path` is the redacted source path
(absent for elements without one); human output strips the trailing `SKILL.md`
segment to show the skill directory name. `path` is an additive field added in
#167; `total` is an additive field added in #178.

### `show`

```text
{ runtime, observed, resolved, interpretation, relations, findings, interpretationProvenance: { classifierVersion, origin } }
```

`resolved` and `interpretation` are `null` when the element has no such layer.
`interpretationProvenance` is named apart from `interpretation`, which this
command already uses for the element's interpretation.

### `graph`

```text
{ observedSnapshotId, resolvedSnapshotId, nodes, edges, runtime, interpretation: { classifierVersion, origin } }
```

`nodes` is ordered by `id`; `edges` carry `{ type, from, to }`.

`runtime` on `list`, `show`, and `graph` is the runtime id of the snapshot
that answered, so a consumer can assert which runtime's run `latest` selected
under `--runtime` (#180, additive). `report` and `diff` already carry it.

### `snapshots`

```text
{ project, runs: [{ observedId, resolvedId, interpretationId, capturedAt, runtime, completeness }] }
```

`runs` is newest first. `interpretationId` is `null` when the run has no stored
interpretation (a pre-v1.0 run, or an interrupted `inspect`).

### `diff`

```text
{
  runtime,
  observedSnapshotIdA, observedSnapshotIdB,
  resolvedSnapshotIdA, resolvedSnapshotIdB,
  structural, effective, facetDeltas,
  relations: { added: [{ type, from, to }], removed: [{ type, from, to }] },
  findings: { added: [...], removed: [...] },
  versionNotes,
  interpretation: { a: { classifierVersion, origin }, b: { classifierVersion, origin } }
}
```

Both sides are diffed. When the two sides' interpretations came from different
classifier versions the difference is named in `versionNotes`, exactly as a
runtime-version or resolution-semantics difference is. `relations` and
`findings` are ordered as the "Array order" section states.

### Interpretation provenance

The read commands report `interpretation: { classifierVersion, origin }` —
`show` calls it `interpretationProvenance`, and `diff` reports each side's.
`classifierVersion` is the classifier that produced the interpretation; `origin`
is `stored` or `recomputed`. Since v1.0 `inspect` persists the interpretation, so
a report on a fixed snapshot reproduces; a run with no stored interpretation (a
pre-v1.0 snapshot, or an interrupted `inspect`) is recomputed, and the document
says so. `origin` describes the run's stored state, not its age. Absence of a
stored interpretation is never an error; a stored interpretation this binary
cannot interpret is not absence and fails the read like any other uninterpretable
artifact.

### `gc`

The envelope applies unchanged. `data` lists what was or would be reclaimed,
with `--dry-run` and `--keep <n>` deciding what that is:

```text
{
  dryRun, keep,
  retained:  [{ observedId, resolvedId: string|null, interpretationId: string|null }],
  reclaimed: [{ observedId, resolvedId: string|null, interpretationId: string|null }],
  orphans:   [{ id, path, reason }],
  reclaimedOrphans: [{ id, path, reason }],
  unreferenced: [{ id, path, reason }]
}
```

`retained` is the runs kept (newest first; the run named by `latest` is always
among them). `reclaimed` is the runs deleted — or, under `--dry-run`, the runs
that would be. A run is reclaimed as a whole: its observed snapshot, resolved
snapshot, and interpretation together. A run that cannot be deleted as a whole
(an observation with no resolved snapshot) is reported and left intact.

`orphans` are histories the index references whose every project root is gone.
They are deleted only with `--prune-orphans` and never under `--dry-run`;
`reclaimedOrphans` is the subset actually deleted. `unreferenced` are store
directories the index does not reference — their root is unknown, so they are
reported and never deleted. An artifact that cannot be attributed to a run is
reported and never deleted; an artifact that belongs to a reclaimed run is
deleted with it. `snapshots` and `gc` report `completeness: "unknown"`.

## Redaction

The document is a display channel, so its text passes the same policy as other
output. `diagnostics` and error messages are redacted at the export level, and
the file paths a command emits — `show`'s element, `graph`'s node paths,
`list`'s `path` — are re-redacted at the boundary rather than trusted from the
artifact. Every other `data` field is a structural fact, or a value that passed the
allowlist and the redaction layer when the snapshot was persisted; the document
layer does not re-derive those.

## Array order

Array order is part of the contract only where stated here:

- **Elements are ordered by `id`** — `list.data.elements`, `graph.data.nodes`.
- **Diagnostics are in emission order** — `diagnostics`.
- **Diff relations** are ordered by the element ids they join (`from`, then
  `to`), then `type`; **diff findings** by `rule`, then cited element ids, then
  message.
- **`snapshots.data.runs`** is newest first.

Every other array's order is an implementation detail a consumer must not rely
on.

## Compatibility

- **Readers ignore unknown fields.** A consumer written against this contract
  keeps working when a newer `pfl` adds a field.
- **Adding a field is a minor change. Removing one, renaming it, or changing its
  type is a major change.**
- This governs the CLI document only. **The on-disk artifacts are a separate,
  stricter contract**: any change to the persisted shape bumps
  `SNAPSHOT_SCHEMA_VERSION`, including an addition, because a reader of a stored
  snapshot must not guess. The two contracts are deliberately not unified.
