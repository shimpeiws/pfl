# Security review — caller-declared source-project provenance (#217)

- Date: 2026-09-28
- Reviewer: Devin (agent), against the `issue-217-agent` diff; findings iterated
  over seven rounds of external manifest review (opencode / deepseek-v4.1-flash)
  plus targeted re-verification of each fix
- Trigger: changes under `src/redact/**` (`src/redact/output.ts`,
  `output.test.ts`), `src/snapshot/store.ts`, and `src/discovery/**`
  (`src/discovery/source-project.ts`, a new read path), all trust-boundary
  paths; `docs/security/read-paths.md` gains an entry
- Result: nine reported findings remediated in the pull request; no finding
  left unaddressed and none entered `accepted-risks.md`

## Scope and rationale

`pfl inspect` gains a caller-declared identity channel: yuurei writes a
versioned contract (`source-project.json`) into the observed cell and exposes
its path via `YUUREI_SOURCE_PROJECT_FILE`, with `YUUREI_SOURCE_PROJECT_ID` as
a cross-check copy of `source_project.id`. The declaration is persisted on
the observed snapshot as `provenance.sourceProject` (schema 2 → 3) and echoed
by `inspect`/`export` documents and the human-facing `inspect` summary.

The trust surface is the same shape as `--cell-id` (#212) plus one real read:
the contract file is caller-supplied content consumed before persistence, so
the questions are (a) can hostile file contents reach a persisted artifact or
a document, (b) can a stored artifact carry what the write path refused, and
(c) does the file read widen the filesystem surface.

`YUUREI_SOURCE_PROJECT_FILE` resolves to a caller-named path — by design it
may live outside the inspected root (the cell is a temp workspace). The read
goes through `readTextFileGuarded`: leaf is a regular file, no symlink or
hardlink, size capped by `MAX_PARSE_BYTES`. Ancestor components are the
trusted caller's own directory layout and are intentionally not inspected.
`docs/security/read-paths.md` records the new path.

Persistence is a closed allowlist — `{ id, kind, remote?, issuer,
contractVersion, head? }` — so the contract's host `source` path is never
stored. `id` is bound to `git|path-<hex16>` and its prefix must agree with
`kind`; `remote` is rejected on a `local-path` identity; `contractVersion`
must equal the one supported value. Asserted free text (`issuer`, `remote`,
`head`) is length-bounded, free of control/format characters
(`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`), and passes persistence redaction before
storage — with the bound re-checked _after_ redaction, since masking can grow
a value past the reader's limit. The snapshot reader holds the identical
rules, so an artifact written around the CLI cannot smuggle any of it back
in. Documents re-assert redaction at the inspect/export boundary, and a field
whose re-redacted form exceeds the bound is masked to `[redacted]` — that
state is only reachable by bypassing the writer, so masking stays
fail-closed.

## Findings and disposition

All findings came out of the manifest-matched external review; each was
closed by a regression test that went red then green.

| #   | Finding                                                                                                              | Disposition                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Reader tolerated unknown `sourceProject` keys, re-admitting the host `source` path into export                       | Fixed — closed allowlist in `isAssertedSourceProject`; tampered-artifact tests                           |
| 2   | `id` prefix could contradict `kind` (`path-…` with `git-remote`)                                                     | Fixed — shared `SOURCE_PROJECT_ID_PREFIXES` checked by parser and reader                                 |
| 3   | Asserted strings persisted without redaction; credential-shaped values passed through                                | Fixed — `redactFreeText`/`redactPath` at persistence plus `redactSourceProject` at the document boundary |
| 4   | Reader accepted any numeric `contractVersion`                                                                        | Fixed — shared `SOURCE_PROJECT_CONTRACT_VERSION` pinned on read                                          |
| 5   | Raw `YUUREI_SOURCE_PROJECT_ID` echoed into the mismatch diagnostic                                                   | Fixed — diagnostic names the env var and the validated contract id only                                  |
| 6   | Post-redaction overflow could write an artifact the reader rejects                                                   | Fixed — bounds re-checked on the redacted value; over-bound declarations refused                         |
| 7   | Boundary re-redaction could emit an over-bound field                                                                 | Fixed — over-bound re-redacted field masked to `[redacted]`                                              |
| 8   | Mismatch diagnostics carried no contract `path`                                                                      | Fixed — `diagnostic.path` set; the existing `redactDiagnostic` channel handles it                        |
| 9   | Asserted strings bounded by length only — control chars (Cc) and format chars (Cf/Zl/Zp) could reach terminal output | Fixed — `SOURCE_PROJECT_CONTROL_CHARS_PATTERN` enforced at write and read                                |

## Assessment

| #   | Question                                                     | Answer                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can a hostile contract file reach a persisted artifact?      | No. Non-JSON, wrong version, malformed ids/kinds, out-of-bounds or control/format-char strings, and self-contradictory declarations (`cell_id`/`id`/`kind`/`remote` disagreements) are all refused with a warning diagnostic; nothing is recorded. |
| 2   | Can a written-around artifact carry what the writer refused? | No. `isAssertedSourceProject` is a closed allowlist holding the same bounds; violations fail `isObservedSnapshot` and read as `invalid-snapshot`.                                                                                                  |
| 3   | Does the file read widen the filesystem surface?             | Minimally and deliberately: one caller-named path, leaf-verified, size-capped. No directory walk, no host `.git` reads, no consent bypass (the caller's env is the consent channel). Recorded in `read-paths.md`.                                  |
| 4   | Can caller text inject diagnostics or output?                | No. Unvalidated env/contract values never enter diagnostic messages; `diagnostic.path` goes through `redactDiagnostic`. Persisted strings are redacted at write and re-redacted at the document boundary.                                          |
| 5   | Does `sourceProject` corrupt observed identity or digests?   | No. Provenance attaches after `assembleObservedSnapshot`; `project.id`, `snapshotId`, and `digests.observed` are untouched. `data.project.id` stays cell-local and `snapshot.sourceProject` is a separate asserted lane.                           |
| 6   | Is the asserted-vs-observed boundary kept honest?            | Yes. pfl never re-derives or verifies the claim, never substitutes a temp-workspace identity — `null` means unknown. Legacy schema 1/2 artifacts read with the field absent.                                                                       |

## Verification

- Falsifiability: each finding was first reproduced red (e.g. a tampered
  artifact reintroducing `source` exported it; `path-`/`git-remote`
  disagreement persisted; an over-bound issuer post-redaction read back
  unreadable) before the fix turned it green.
- Full gate green: `pnpm test` (732), `check`, `format`, `build`, `knip`,
  lefthook pre-commit.
- Impact manifest validated by `check-manifest.py` (48 changed files, 1:1
  with the diff); findings ledger at
  `~/.agents/review-loop/pfl-issue-217-4d8e6357/issue-217-agent/findings.json`.
