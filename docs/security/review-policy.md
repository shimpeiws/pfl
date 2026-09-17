# Security review policy

`pfl` reads untrusted harness files from cloned repositories. Any change that
touches a trust boundary needs a security review before it merges. This document
states which changes those are, how the review is required, and where its record
lives.

## Trigger points

A pull request touches a trust boundary when it changes any of these paths, or
anything they import that changes their behaviour:

- `src/discovery/walk.ts`
- `src/discovery/project-identity.ts`
- `src/discovery/consent.ts`
- `src/discovery/metadata.ts`
- `src/util/fs.ts`
- `src/limits.ts`
- `src/redact/**`
- `src/snapshot/store.ts`
- `src/runtime/*/paths.ts`
- `src/runtime/*/consent.ts`
- `src/runtime/*/detect.ts`

Adding a runtime adapter is a trust-boundary change in itself: a new adapter is a
new read surface, and it also extends `docs/security/read-paths.md`.

## How the review is required

The `.github/workflows/security-review.yml` job — the **Security review** check —
is a **required status check on the protected branch**. It runs on every pull
request and decides for itself whether the diff touches a trust boundary,
reporting success immediately when it does not. When the diff does touch one, the
check requires a review record under `docs/security/reviews/` in the same pull
request, or the `security-reviewed` label; otherwise it fails.

Selecting it by path filter was rejected: a required check that a path filter can
skip is absent exactly when a file outside the filter turns out to matter. A
documented convention was also rejected: a solo-maintained repository is exactly
where a convention is easiest to skip.

The review is performed with the `.claude/agents/security-auditor.md` agent,
which is written explicitly against the design invariants (design doc §19;
roadmap §3.1, §3.2), not against a generic security checklist.

## Automated scans

Alongside the review, CI runs CodeQL (`security-extended`), Semgrep, and Gitleaks
on pull requests, and Dependabot opens weekly dependency updates. A scan finding
is triaged like a review finding: remediated, or recorded as an accepted risk.

## Record keeping

- `docs/security/reviews/` holds one record per review, named
  `YYYY-MM-DD-<short-subject>.md`. A record states the diff reviewed, the
  invariants checked, the findings, and the disposition of each finding.
- `docs/security/accepted-risks.md` is the register of risks that were accepted
  rather than fixed. A finding is either remediated or recorded there; none is
  left silently unaddressed.
- `docs/security/read-paths.md` is the read-path inventory the review checks
  against. A new read path is a review trigger even when no listed file changes.
- `docs/security/audits/` holds release-candidate audit logs. Each log tracks the
  milestone's findings across audits so a later audit continues the same rows
  rather than re-deriving them.

## Changing the rules

Introducing a limit, changing a limit value, or reopening the symlink posture
requires a security review under this policy and an update to
`docs/design/adr/0002-security-hardening.md`.
