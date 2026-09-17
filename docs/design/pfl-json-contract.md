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
- `path` is optional, and is redacted the same way persisted paths are.

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
  observed: { snapshotId, elements, opaqueLayers, completeness },
  resolved: { snapshotId, effective, conditional, shadowed, confidence }
}
```

Observed and resolved diagnostics travel in the envelope's `diagnostics`, not
nested under `data`.

### `report`

```text
{
  runtime, runtimeName,
  project: { id, displayName },
  observedSnapshotId, resolvedSnapshotId,
  confidence,
  stats, findings
}
```

### `list`

```text
{ count, elements: [{ id, kind, origin, status, facets }] }
```

`elements` is ordered by `id`.

### `show`

```text
{ observed, resolved, interpretation, relations, findings }
```

`resolved` and `interpretation` are `null` when the element has no such layer.

### `graph`

```text
{ observedSnapshotId, resolvedSnapshotId, nodes, edges }
```

`nodes` is ordered by `id`; `edges` carry `{ type, from, to }`.

### `snapshots`

```text
{ project, runs: [{ observedId, resolvedId, capturedAt, runtime, completeness }] }
```

`runs` is newest first.

### `diff`

```text
{
  runtime,
  observedSnapshotIdA, observedSnapshotIdB,
  resolvedSnapshotIdA, resolvedSnapshotIdB,
  structural, effective, facetDeltas,
  relations: { added: [{ type, from, to }], removed: [{ type, from, to }] },
  findings: { added: [...], removed: [...] },
  versionNotes
}
```

Both sides are diffed. When the two sides' interpretations came from different
classifier versions the difference is named in `versionNotes`, exactly as a
runtime-version or resolution-semantics difference is. `relations` and
`findings` are ordered as the "Array order" section states.

### `gc` (implemented under issue #87)

The envelope applies unchanged. `data` lists what was or would be reclaimed,
with `--dry-run` and `--keep <n>` deciding what that is:

```text
{ dryRun, keep, retained: [...], reclaimed: [...], orphans: [...] }
```

The exact id fields land with #87; the envelope and the failure shape above are
fixed here.

## Redaction

The document is a display channel, so its text passes the same policy as other
output. `diagnostics` and error messages are redacted at the export level, and
the file paths a command emits — `show`'s element, `graph`'s node paths — are
re-redacted at the boundary rather than trusted from the artifact. Every other
`data` field is a structural fact, or a value that passed the allowlist and the
redaction layer when the snapshot was persisted; the document layer does not
re-derive those.

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
