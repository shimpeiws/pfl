# JSON document contract (v1.0)

Every output-producing command accepts `--json` and writes exactly one JSON
object to stdout. All logs and progress go to stderr.

## Envelope

Every document — success or failure — has the same six fields. Only `data`
varies by command.

| Field          | Type                                   | Meaning                                                                                                    |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pflVersion`   | string                                 | Package version                                                                                            |
| `command`      | string                                 | Command name, e.g. `report`                                                                                |
| `ok`           | boolean                                | True when the command did its job (partial results included); false exactly when the exit code is non-zero |
| `completeness` | `"complete" \| "partial" \| "unknown"` | Harness completeness observed by the run                                                                   |
| `diagnostics`  | `Diagnostic[]`                         | Diagnostics in emission order                                                                              |
| `data`         | object                                 | Command-specific payload                                                                                   |

A consumer that needs to react to a partial harness checks `completeness`,
not `ok`.

## Diagnostics

```json
{ "severity": "warning", "code": "unreadable-snapshot", "message": "…", "path": "~/.pfl/…" }
```

- `severity`: `"info"`, `"warning"`, or `"error"`.
- `code`: stable identifier — match on it.
- `message`: free text — do not match on it.
- `path`: optional, redacted.

Stable diagnostic codes: `unsupported-snapshot-schema`, `invalid-snapshot`,
`unreadable-snapshot`, `unreadable-observation`, `unreadable-interpretation`.

## Failure shape

Non-zero exit emits the envelope with `ok: false` and `data.error`:

```json
{
  "pflVersion": "1.0.0",
  "command": "inspect",
  "ok": false,
  "completeness": "unknown",
  "diagnostics": [],
  "data": {
    "error": { "code": "RUNTIME_UNSUPPORTED", "message": "unknown runtime: bogus" }
  }
}
```

`error.code` is the stable exit-code name (not its number). Consent failures
add `missingScopes`:

```json
{
  "ok": false,
  "data": {
    "error": { "code": "CONSENT_REQUIRED", "message": "…" },
    "missingScopes": ["claude-code:user"]
  }
}
```

## Command data shapes

### inspect

```json
{
  "runtime": "claude-code",
  "runtimeVersion": "...",
  "runtimeCompatibility": "...",
  "project": { "id": "...", "displayName": "..." },
  "observed": {
    "snapshotId": "obs_…",
    "elements": 4,
    "opaqueLayers": 1,
    "completeness": "complete"
  },
  "resolved": {
    "snapshotId": "res_…",
    "effective": 4,
    "conditional": 0,
    "shadowed": 0,
    "confidence": "…"
  }
}
```

### report

```json
{
  "runtime": "claude-code",
  "runtimeName": "Claude Code",
  "project": { "id": "...", "displayName": "..." },
  "observedSnapshotId": "obs_…",
  "resolvedSnapshotId": "res_…",
  "confidence": "…",
  "stats": { "…" },
  "findings": [
    {
      "rule": "shadowed-element",
      "message": "…",
      "elementIds": ["el_…"],
      "elements": [
        { "id": "el_…", "path": ".claude/settings.json#permissions", "kind": "permissions" }
      ]
    }
  ],
  "interpretation": { "classifierVersion": "…", "origin": "stored" }
}
```

`findings[].elements` resolves each cited `elementId` to its redacted source
`path` and `kind`, so readers do not need a `pfl show` call per id. `path` is
absent when the element has no source path; both are absent when the cited id
is not in the observed snapshot.

### list

```json
{
  "runtime": "claude-code",
  "count": 4,
  "total": 4,
  "elements": [
    {
      "id": "el_…",
      "kind": "instructions",
      "origin": "project",
      "status": "effective",
      "facets": ["instructions"]
    }
  ],
  "interpretation": { "classifierVersion": "…", "origin": "stored" }
}
```

Elements ordered by `id`. `count` is the number of returned elements; `total`
is how many elements matched before `--limit` truncated the list.

### show

```json
{
  "runtime": "claude-code",
  "observed": { "…" },
  "resolved": { "…" },
  "interpretation": { "…" },
  "relations": [],
  "findings": [],
  "interpretationProvenance": { "classifierVersion": "…", "origin": "stored" }
}
```

### graph

```json
{
  "observedSnapshotId": "obs_…",
  "resolvedSnapshotId": "res_…",
  "nodes": [],
  "edges": [],
  "runtime": "claude-code",
  "interpretation": { "classifierVersion": "…", "origin": "stored" }
}
```

Nodes ordered by `id`. Edges carry `{ type, from, to }`. With `--origin` /
`--facet` / `--kind` / `--status` filters the shape is identical — `nodes` and
`edges` simply shrink to the filtered set (#161).

### snapshots

```json
{
  "project": "…",
  "runs": [
    {
      "observedId": "obs_…",
      "resolvedId": "res_…",
      "interpretationId": null,
      "capturedAt": "…",
      "runtime": "…",
      "completeness": "…"
    }
  ]
}
```

Runs newest first.

### diff

```json
{
  "runtime": "claude-code",
  "observedSnapshotIdA": "obs_…", "observedSnapshotIdB": "obs_…",
  "resolvedSnapshotIdA": "res_…", "resolvedSnapshotIdB": "res_…",
  "structural": { "added": [], "removed": [], "changed": [] },
  "effective": { "newlyEffective": [], "noLongerEffective": [], "activationChanged": [] },
  "facetDeltas": {},
  "relations": { "added": [], "removed": [] },
  "findings": { "added": [], "removed": [] },
  "versionNotes": null,
  "interpretation": { "a": { "…" }, "b": { "…" } }
}
```

### gc

```json
{
  "dryRun": true,
  "keep": 20,
  "retained": [],
  "reclaimed": [],
  "orphans": [],
  "reclaimedOrphans": [],
  "unreferenced": []
}
```

## Array order

- Elements ordered by `id`.
- Diagnostics in emission order.
- Diff relations by `from`, `to`, then `type`; diff findings by `rule`, then
  element ids.
- `snapshots` runs newest first.

## Compatibility

Readers ignore unknown fields. Adding a field is a minor change. Removing,
renaming, or changing a field type is a major change.
