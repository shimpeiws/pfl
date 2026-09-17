# Security review — M8 `--json` document contract (issue #80)

- Date: 2026-09-18
- Reviewer: independent adversarial review (`codex exec -s read-only`, three
  rounds against the diff) plus a maintainer self-review against the design
  invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/discovery/consent.ts` changed (the `CONSENT_REQUIRED` error now
  carries structured context). No other trigger path is in the diff.
- Result: no trust-boundary impact found; 1 low-severity follow-up recorded, no
  remediated findings

## What changed

Issue #80 makes `--json` a document contract: one JSON object per run on stdout,
a common envelope, a failure envelope on every non-zero exit, and stated
compatibility rules. The trust-boundary-relevant edit is small and local:
`resolveAccessPolicy` still fails closed exactly as before, but the
`CONSENT_REQUIRED` error it throws now carries `{ missingScopes: [key] }`, and
the failure document copies that key into `data.missingScopes` so a caller acts
on the document instead of parsing stderr prose. Everything else is output
plumbing (`src/cli/**`, `src/index.ts`, `src/util/logger.ts`), tests, and
documentation.

## Trust-boundary check

- **Consent decision unchanged.** The branch that throws is the same
  non-interactive, no-grant branch as before; an existing grant still returns
  before the interactivity check, and a missing grant still fails closed. No
  read is added, removed, reordered, or made conditional on new state.
- **`missingScopes` is not attacker-influenced.** Its value is
  `consentScopeKey(request.runtimeId, request.scope)` = `` `${runtimeId}:${scope}` ``.
  `runtimeId` comes from the registered adapter and `scope` from
  `getConsentRequest` (currently the fixed `user` scope); neither is derived from
  a file, an argument, or the environment. The single producer is
  `resolveAccessPolicy`.
- **No new read path.** The diff introduces no filesystem access and adds
  nothing to `docs/security/read-paths.md`. `src/snapshot/store.ts`,
  `src/util/fs.ts`, `src/limits.ts`, `src/redact/**`, and the adapters'
  `paths.ts`/`consent.ts`/`detect.ts` are untouched.
- **Redaction on the new output channel.** The failure document's `error.message`
  and `missingScopes` are redacted at the `export` level; `diagnostics` are
  redacted with `redactDiagnostic`. `show`'s element and `graph`'s node paths are
  re-redacted at the export boundary rather than trusted from the artifact, which
  strictly reduces what a stored snapshot can expose.

## Invariants checked

Read-only; no execution or dynamic loading; no new read path; consent boundary
and fail-closed behaviour unchanged; deny-by-default persistence unchanged;
every displayed field passes the allowlist or the redaction layer; the failure
shape cannot carry arbitrary unredacted data.

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                                         | Disposition                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Low      | `PflErrorContext.missingScopes` is typed `readonly string[]`; the `runtime:scope` shape is not enforced by the type or a runtime validation. A future producer could place an arbitrary string there, which would then be redacted but emitted. | **Accepted, recorded as a follow-up.** The only producer is `resolveAccessPolicy`, whose value is built from the fixed runtime id and scope constants, so nothing attacker-influenced can reach it today. The closed context type already prevents any other field, and the value is export-redacted. Revisit if the scope taxonomy (#81) adds more producers. |

## Dismissed (checked and fine)

- **Fail-closed preserved.** The non-interactive, no-grant path still throws
  `CONSENT_REQUIRED` (exit 5); it merely also emits the envelope.
- **No consent bypass.** The new `--json`/parser-error handling adds no path that
  reaches discovery without `resolveAccessPolicy`; project identity is still
  resolved only after consent, and `allowExternalGit` is still derived from the
  resolved grant.
- **`PflErrorContext` is closed.** `buildErrorDocument` copies `missingScopes`
  explicitly and nothing else, so no unredacted free-form field can reach stdout.
- **Path re-redaction cannot over-mask structural data.** `redactElementSource`
  and `redactPath` use the path rules (home prefix plus token/secret rules), not
  the high-entropy heuristic, so ids and digests are untouched; a regression test
  stores a raw home path and asserts it does not reach the document.
- **No persistence change.** `SNAPSHOT_SCHEMA_VERSION` and the stored artifacts
  are untouched; the document contract is deliberately separate.
- **No execution surface.** The CLI still never spawns or evaluates anything;
  the argument-parser handling only formats an error.

## Follow-up (out of scope)

- Enforce the `runtime:scope` shape of `missingScopes` (type or runtime check)
  when headless consent and the split scopes land (#81).

## Verification

- Three rounds of independent adversarial review (`codex exec -s read-only`)
  against the diff; the trust-boundary-relevant edit was confirmed to add no read
  and to leave the consent decision unchanged. Their two critical findings
  (uncaught parser errors; unknown/no-command exit 0) and one warning (success
  `data` not re-redacted at the export boundary) were remediated.
- Full gate green: `test` (51 files, 442 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- Manual runs against the built CLI: `report --json` failure envelope (exit 2),
  `inspect`/`report --json` success envelope (one object, diagnostics inside),
  consent-missing failure envelope (exit 5 with `missingScopes`), parser error,
  unknown command, and no-command help.
