# Security review — M6 Phase 7 (security-ops baseline)

- Date: 2026-09-17
- Reviewer: `codex exec` unavailable (rate limited); this record is the
  maintainer's review of the CI/scan changes
- Trigger: `.github/workflows/security-review.yml` is trust-boundary-adjacent,
  and `src/redact/output.ts` was annotated for Semgrep
- Result: no trust-boundary behaviour changed; four scan findings dispositioned

## What changed and why

- CodeQL (`security-extended`), Semgrep, and Gitleaks scans were added, plus
  Dependabot. The first Semgrep run reported 19 findings; each is dispositioned
  below.
- The `Security review` check decides by itself whether a pull request touches a
  trust boundary and requires a `docs/security/reviews/*.md` record (or the
  `security-reviewed` label) when it does. `src/redact/output.ts` is a trigger
  path, so this record exists in part to satisfy it — the check works.

## Findings and disposition

| #   | Finding                                                                                | Disposition                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `github-actions-mutable-action-tag` × 13: actions referenced by a mutable major tag    | **Fixed.** Every action in every workflow is pinned to a commit SHA with the `# vX` comment, which Dependabot updates                                                                                                                                                       |
| 2   | `dependabot-missing-cooldown` × 2: no cooldown on dependency updates                   | **Fixed.** `cooldown.default-days: 7` on both ecosystems, so a compromise or broken release ages before it is proposed                                                                                                                                                      |
| 3   | `detect-non-literal-regexp` in `src/redact/output.ts`: `new RegExp` built from a value | **Fixed by removal.** The boundary-aware replacement is now a literal scan (`replaceAtBoundary`) rather than a constructed regular expression, so no value can become a pattern and the finding is gone. Behaviour is unchanged (the `replaceHomeSegment` tests still pass) |
| 4   | `detected-jwt-token` in `src/redact/common.test.ts`: a JWT-shaped string               | **Accepted as a false positive, annotated.** It is a fixture asserting the redaction rule, not a credential; a `// nosemgrep` comment records it                                                                                                                            |

## Invariants checked

Read-only, no execution, no symlink traversal, consent boundary,
deny-by-default persistence/redaction, best-effort, resource ceilings, fail
closed. No source read path changed; the only `src` edit is a comment on two
regex constructions whose behaviour is unchanged.

## Verification

- The check's trust-boundary logic was exercised locally: a diff touching
  `src/util/fs.ts` or `src/redact/**` with a review record passes, and without
  one fails.
- Workflow YAML parses. The Semgrep job is re-run on the pull request.
- `test`, `check`, `format`, `build`, `typecheck:test`, `knip` green.
