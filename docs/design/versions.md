# Version knobs (v1.0)

- Status: frozen for v1.0
- Issue: #84
- Design references: `pfl-design-v0.1.md` §15, §17, §21; `pfl-roadmap-v1.0.md` M8
- ADR: `adr/0001-snapshot-serialization-and-ids.md`

`pfl` carries four version-like values. They are independent: none derives from
another, and the package version is not a compatibility signal for any of the
three stored ones. This document states what each governs.

| Value | Constant | Governs | Feeds a digest | Diff-visible | Persisted | Changes when |
| --- | --- | --- | --- | --- | --- | --- |
| Package version | `package.json` `version` | What was installed | No | No | In `--json` `pflVersion` | A release, by semver |
| Snapshot schema | `SNAPSHOT_SCHEMA_VERSION` | On-disk readability of every stored artifact | No | No | `schemaVersion` on each artifact | The persisted shape changes |
| Resolution semantics | `RESOLUTION_SEMANTICS_VERSION` | How observed facts become resolved facts | Yes (`resolvedSnapshot` digest) | Yes (`versionNotes`) | `resolution.semanticsVersion` | The derivation or relation rules change |
| Classifier | `CLASSIFIER_VERSION` | How resolved facts become the interpretation | No | Yes (`versionNotes`) | `interpretation.classifier.version` | The facet table or a finding rule changes |

## Snapshot schema version

`SNAPSHOT_SCHEMA_VERSION` governs on-disk readability **alone**. An artifact
whose `schemaVersion` is not in `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS` is refused
rather than guessed (observe-don't-infer): a scan skips it with a diagnostic, and
a direct read of it fails with a diagnostic naming the version found and the
versions supported, exit 2 rather than a store failure (ADR 0001; #82).

The on-disk artifacts are a **stricter contract** than the CLI document: any
change to the persisted shape bumps this value, including an addition, because a
stored snapshot must not be guessed at. The CLI `--json` document is the
opposite — readers ignore unknown fields and additions are minor changes
(`pfl-json-contract.md`). The two are deliberately not unified.

## Resolution semantics version

`RESOLUTION_SEMANTICS_VERSION` feeds `resolvedSnapshotDigest`, so the same
harness content resolved under different semantics is a different resolved
snapshot. It is persisted on the resolved snapshot and reported in a diff's
`versionNotes` when the two sides differ. Bump it when the derivation or the
relation rules change.

## Classifier version

`CLASSIFIER_VERSION` feeds **no** digest: a classifier change does not invalidate
a stored snapshot. It is persisted **with the interpretation** (`inspect` writes
the interpretation since v1.0, #84), so a report states which classifier produced
it. Bump it when a facet mapping or a finding rule changes.

## Reproducibility

Because the classifier version is stored with the interpretation, a report
reproduces on a fixed snapshot: the read commands use the stored interpretation
and report `interpretation: { classifierVersion, origin }` with `origin` of
`stored`. A snapshot captured before v1.0 carries no interpretation; it is
recomputed with the current classifier and the document reports `origin` of
`recomputed`, so a consumer can tell a reproduced report from a recomputed one.
Absence of a stored interpretation is never an error.
