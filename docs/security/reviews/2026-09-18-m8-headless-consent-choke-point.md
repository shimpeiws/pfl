# Security review — M8 headless consent and the consent choke point (#81, #85)

- Date: 2026-09-18
- Reviewer: independent adversarial review plus a maintainer self-review against
  the design invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/discovery/consent.ts` and `src/runtime/*/consent.ts` changed.
- Result: one boundary-widening defect and several smaller issues found and
  remediated; no accepted risks added

## What changed

Issue #81 splits consent into `user` and `install` scopes, makes the request and
grant per scope, and adds a repeatable `--allow-scope <runtime>:<scope>` flag
that grants for the current run only. Issue #85 routes every outside-the-project
read decision through one choke point (`src/discovery/gate.ts`) and adds a test
over the inventory that a closed policy serves no out-of-project element.

## Trust-boundary check

- **The boundary is narrower, not wider.** `AccessPolicy` now carries `user` and
  `install` instead of one `allowOutsideProject`. Detection reads only under
  `install`, the user harness and the external-gated reads only under `user`, and
  the project-identity read of a `.git` file's `gitdir:` only under `user` — an
  install-only run gains no read it was never asked about (this was a review
  finding; the first draft allowed either grant).
- **The current-run grant cannot widen persisted consent.** `--allow-scope` is
  honored before any store read and never calls `grantConsent`; a test asserts no
  `permissions.json` is written. Interactive answers still persist, as before.
- **Fail closed is preserved.** A non-interactive run without the user scope
  exits 5 with the missing key; without the install scope it proceeds with the
  `unknown` detection state and a diagnostic, which is the behavior the roadmap
  specifies.
- **The absence of a grant is recorded.** A closed user scope adds a
  `consent-not-granted` diagnostic instead of presenting an empty harness.
- **No new read path.** The scopes map onto the existing inventory
  (`docs/security/read-paths.md`); the prompt groups are the same locations,
  regrouped by scope.

## Findings and disposition

The adversarial review found one boundary widening and several smaller issues;
all were remediated in this pull request:

1. **An install-only run could read external `.git` references.**
   `allowsOutsideProject` was `user || install`, so granting only the install
   scope enabled a project-identity read outside the project that the user scope
   had not authorised. Fixed: it requires `user`, and a `gitdir:` outside the
   root is no longer followed for an install-only run. The security record's
   "same condition as before" claim was corrected.
2. **The adapter `detect()` gate bypassed the choke point**, checking
   `access.install` directly rather than `grants`. Fixed: both adapters go
   through `grants`, so the scope-to-field mapping lives in one place.
3. **The install gate was not pinned by a test.** A `{ user: false, install:
true }` case now asserts the version is detected while no user element
   appears; it also pins finding 1.
4. **`consent-not-granted` was shared by both scopes**, so a consumer could not
   tell which scope was refused. Fixed: the codes are
   `consent-not-granted:user` and `consent-not-granted:install`.
5. **The choke-point test's out-of-project filter missed the managed scope**,
   which is an absolute system path. Fixed: a path that is absolute is flagged
   too. The test also injects an empty managed base, so it never reads the real
   `/Library`.

No finding was accepted as a risk.

## Verification

- Full gate green: `test` (56 files, 486 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- New tests: `--allow-scope claude-code:user` succeeds headlessly and writes no
  `permissions.json`; install-only exits 5 with `claude-code:user` missing; a
  closed policy serves no out-of-project element and no version with both
  skip diagnostics; install-only detects the version with no user element; the
  user scope serves the harness with no version.
