# Security review — M8 schema-version handling and interpretation persistence (#82, #84)

- Date: 2026-09-18
- Reviewer: independent adversarial review (`codex exec -s read-only` and the
  Claude Code CLI, several rounds against the diff) plus a maintainer
  self-review against the design invariants (design doc §19; roadmap §3.1,
  §3.2)
- Trigger: `src/snapshot/store.ts` changed (artifact read handling, the
  interpretation artifact, the run summary, and the `latest` pointer). No other
  trigger path is in the diff.
- Result: no trust-boundary impact found; no accepted risks added

## What changed

Issue #82 unifies how the two read paths treat an artifact this binary cannot
interpret. `readArtifact` no longer converts `UnsupportedSchemaVersionError`, a
validation failure, or `InvalidSnapshotError` into `PflError(6)`; all three
become exit 2 with a diagnostic that names the version found and the versions
supported. `listRuns` records the same diagnostic and continues.

Issue #84 makes `inspect` persist the Derived Interpretation under
`interpretations/<resolvedSnapshotId>.json` and point `latest` at it; read
commands use the stored copy and report `{ classifierVersion, origin }`.

## Trust-boundary check

- **No new read path.** No file outside `~/.pfl/` is read; no path constant, no
  adapter path, and no consent-scoped location is added.
  `docs/security/read-paths.md` needs no new row. The `store.ts` reads are the
  same guarded reads (`readTextFileGuarded` with the symlink, hardlink,
  non-regular, and size guards); the new interpretation read uses the identical
  guard and only adds a deterministic key (the resolved snapshot id) to the
  artifact path, which `assertSafeSegment` validates.
- **Fail closed is preserved and extended.** An unrecognised schema version, a
  malformed artifact, and a validation failure now refuse with a diagnostic
  rather than a bare store error. A stored interpretation this binary cannot
  interpret is not treated as absence. The store path itself is unchanged; only
  the classification of the failure moves from exit 6 to exit 2.
- **`PflErrorContext` stays closed.** One field, `diagnostics`, is added. It is
  copied explicitly into the failure document and export-redacted; no free-form
  bag reaches stdout.
- **Persistence is unchanged in kind.** The interpretation artifact is written
  through the same `writeArtifact` temp-to-`link()` path, with the same modes
  and the same immutability (an existing id is a conflict). It holds the same
  allowlisted, redacted interpretation the process already computed.
- **No execution surface.** No spawn, eval, dynamic import, or VM use is added.

## Invariants checked

Read-only; no execution; no new read path; consent boundary untouched; symlink,
hardlink, non-regular, and size guards unchanged; deny-by-default persistence
unchanged; snapshots immutable; unknown states fail closed; every new output
field passes the redaction layer at the export boundary.

## Findings and disposition

Several review rounds found and closed six consistency gaps; all were
remediated in this pull request:

1. A well-formed envelope whose contents failed validation still exited 6.
   Fixed: the validation failure is the same `invalid-snapshot` diagnostic as
   malformed JSON, exit 2.
2. A corrupt stored interpretation was recomputed with a success exit. Fixed:
   only genuine absence (a pre-v1.0 run) is recomputed; a corrupt or unsupported
   artifact fails closed with its diagnostic.
3. A named read resolved the run through the `listRuns` scan, which swallowed an
   unreadable interpretation and presented it as absence. Fixed: an
   interpretation is stored and read by `interpretations/<resolvedSnapshotId>.json`,
   so the run-to-interpretation mapping is a path, not a scan; the scan also
   refuses an artifact whose file name disagrees with its payload.
4. `isInterpretation` validated only the top-level shape, so a structurally
   malformed interpretation (a null element, a missing `classifier.version`)
   passed validation and crashed a reader with a `TypeError` instead of the
   `invalid-snapshot` diagnostic. Fixed: the predicate validates each element,
   the stats, and each finding, while still tolerating an unknown future facet
   or rule.
5. Store diagnostics carried a bare file name, so `res_x.json` could name either
   the snapshot or the interpretation for the same resolved id, and a named
   read's "could not read" message could attribute the wrong cause. Fixed:
   diagnostic paths are store-relative and class-qualified
   (`snapshots/…`, `observations/…`, `interpretations/…`), and the named-read
   selection matches the qualified path. A scan's diagnostics describe the scan,
   so consumers match by `code`, not position.

6. Direct reads still labelled their diagnostics with a bare file name while
   scans used a class-qualified one, so `res_x.json` could mean a snapshot or an
   interpretation depending on the path taken. Fixed: `readArtifact`,
   `readArtifactIfPresent`, and their parse/guard helpers now take the artifact
   class and emit `snapshots/…`, `observations/…`, or `interpretations/…`; tests
   assert the path.

A guard refusal (symlink, hardlink, non-regular, over the size limit) remains a
store failure, exit 6, unlike an uninterpretable artifact; the README and ADR
now state that split explicitly.

## Persisted interpretation content

Storing the interpretation is a new persistence write, so its fields were
checked against the deny-by-default invariant. The artifact holds only ids,
`schemaVersion`, the classifier id and version, per-element facets, confidence,
and `reason`, the numeric stats, and findings. Every `reason` and every finding
message is a fixed template built from counts, enum values, or a structural key
name (`classifier.ts`, `findings.ts`); none interpolates instruction, memory, or
knowledge content, and none carries a path or a secret. The interpretation is
therefore already within the allowlist and needs no separate redaction pass at
persistence.

The claim is enforced rather than only inspected: a security-invariant test
resolves both fixtures, reads the stored interpretation, and asserts every
`reason` and finding message contains no path separator, home sentinel, or
secret sentinel, with a positive control that the set is non-empty. A future
template that interpolated a path would fail it.

No finding was accepted as a risk.

## Verification

- Full gate green: `test` (53 files, 461 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- New tests: a schema-2 snapshot read directly exits 2 with
  `unsupported-snapshot-schema` and names the versions; a validation failure and
  malformed JSON exit 2 with `invalid-snapshot`; a scan skips and diagnoses; the
  report is proven to read the stored payload (its classifier version is mutated
  and returned); absence recomputes; a corrupt, unsupported-schema, or misnamed
  interpretation fails closed on both the latest and named-read paths.
