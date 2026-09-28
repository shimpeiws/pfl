# ADR 0005 — Caller-declared source-project identity on the observed snapshot

- Status: accepted
- Date: 2026-09-28
- Issue: #217
- Design references: §12.1, §13.1; `schema-bump-procedure.md`;
  `pfl-json-contract.md`; ADR 0004; yuurei `docs/contract.md`
  (`seed.source_project`, "Source-project declaration")

## Context

yuurei prepares each run in a fresh temporary cell without `.git`. pfl inside
that cell derives `project.id` from the cell's workspace path, so two real
observations of the *same* source project carry different project ids — and
Gatefold v0.9 rejects an A/B pair whose exports disagree on identity
(gatefold #76, gatefold PR #81). The cell-local id is correct as an observed
fact; what is missing is the caller's claim about which source project the
cell was seeded from.

yuurei #214 ships the declaration: a versioned contract file
`<cell>/source-project.json` — `{ "version": 1, "issuer": "yuurei", "cell_id",
"source_project": { "id", "kind", "remote"?, "source", "head" } }` — at the
cell root, exposed to the pfl process as `YUUREI_SOURCE_PROJECT_FILE` (the
path) and `YUUREI_SOURCE_PROJECT_ID` (the id, redundant). The declared `id`
uses pfl's own derivation (`git-<hex16>` over the normalized remote, else
`path-<hex16>` over the canonical source root), so a host-side inspection and
a prepared-cell observation of one project can name the same identity.

Two channels were considered:

- **Environment-declared contract file (chosen).** The file is the versioned,
  structured channel yuurei already emits, and an env var pointing at it keeps
  the hand-off inside the invocation without widening pfl's discovery scope.
- **A CLI flag such as `--source-project-id <id>`.** Equivalent in trust terms
  — both are caller assertions — but would carry the id alone without its
  provenance (`kind`, `remote`, `issuer`, `head`), and the shipped yuurei
  contract already speaks the file channel. A flag remains a possible later
  addition for non-yuurei callers.

## Decisions

### 1. `inspect` records the declaration as `provenance.sourceProject`

`pfl inspect` resolves the contract before discovery via
`resolveSourceProjectDeclaration` and, when valid, records
`{ id, kind, remote?, issuer, contractVersion, head? }` on the observed
snapshot's `provenance` — beside `cellId`, attached after assembly by
`withObservationProvenance` the same way (#212). The contract's `source`
field, a host filesystem path, is tolerated in the input but never
validated or persisted (deny-by-default). The declaration does not touch
`project.id`, `snapshotId`, or `digests.observed`.

Caller-asserted strings are untrusted input: `issuer`, `remote`, and `head`
pass the same redaction layer as observed text before persistence (`remote`
gets the free-text treatment `project.remote` gets; `head` is digest-shaped,
so it skips only the high-entropy catch-all that would destroy a commit sha).
At read time `sourceProject` is a closed allowlist — a snapshot whose
`sourceProject` carries keys outside the persisted set (e.g. `source`) is
invalid, so a written-around artifact cannot smuggle a host path back into
`inspect`/`export` output. And because write-path redaction can be bypassed
by writing the artifact directly, `inspect`/`export` re-assert the same
redaction over `remote`/`issuer`/`head` at the document boundary — the
stance `redactElementSource` already takes for element paths. The reader
also pins `contractVersion` to the one supported value, so a written-around
artifact cannot claim a version this codebase never wrote.

### 2. The contract file is authoritative and fail-closed

`YUUREI_SOURCE_PROJECT_FILE` names the declaration; a lone
`YUUREI_SOURCE_PROJECT_ID` without the file is an *incomplete* declaration —
diagnostic, nothing recorded — because half a provenance record is worse than
none. The file is read through the same guarded read as other untrusted
inputs: bounded size, regular file only, no symlink or hardlink. A contract
that is missing, unreadable, non-JSON, an unsupported `version`, malformed
(`id` not `git|path-<hex16>`, `kind` outside the enum, `cell_id` outside
`CELL_ID_PATTERN`, or out-of-bounds strings — over the length bound or
carrying control/formatting characters) is not recorded; the inspect run
reports a `source-project-declaration-*` warning diagnostic and proceeds.

Consistency checks gate recording: the contract's `cell_id` must equal
`--cell-id` when the flag is given, `YUUREI_SOURCE_PROJECT_ID`, when set,
must equal `source_project.id`, `id`'s `git-`/`path-` prefix must agree
with `kind`, and `remote` — the remote a `git-remote` derivation used — must
be absent on a `local-path` identity. A disagreement means the caller's
assertion is self-contradictory — the comparison identity is the
load-bearing value, so the whole declaration is rejected rather than
partially trusted. The snapshot reader holds the same checks.

A declaration diagnostic is a failure of the *caller's contract*, not a gap in
the observed harness: it lands on the inspect outcome's diagnostics and is not
persisted on the snapshot, so it never moves `completeness` to `partial`.

### 3. `export` projects it as `snapshot.sourceProject`, `null` when absent

The exported document carries the stored declaration at
`data.snapshot.sourceProject`, beside `cellId` — the caller-asserted lane —
while `data.project` remains purely observed. `null` means unknown: standalone
runs, rejected declarations, and artifacts written before schema 3. pfl does
not substitute the cell-local path or any other value, matching yuurei's
contract: "no declared identity" is explicit. `export` does not re-read the
environment; it projects what the snapshot recorded.

## Consequences

- Two real-cell inspections of one source project export the same
  `snapshot.sourceProject.id` while keeping distinct `project.id`,
  `observedSnapshotId`, and `cellId` — the pair Gatefold needs.
- The persisted shape change bumps `SNAPSHOT_SCHEMA_VERSION` to `"3"` per the
  procedure; schemas `"1"` and `"2"` stay readable, their absent field reads
  as `null`.
- pfl still never reads host Git metadata to reconstruct a source identity;
  every byte of the declaration is caller-supplied and recorded as such.
- A consumer must not treat `sourceProject.id` as evidence of what was
  observed — it is evidence of what the caller *claimed* the cell was seeded
  from.
