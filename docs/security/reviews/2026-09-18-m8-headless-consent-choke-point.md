# Security review — M8 headless consent and the consent choke point (#81, #85)

- Date: 2026-09-18
- Reviewer: independent adversarial review plus a maintainer self-review against
  the design invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/discovery/consent.ts` and `src/runtime/*/consent.ts` changed.
- Result: pending the adversarial round

## What changed

Issue #81 splits consent into `user` and `install` scopes, makes the request and
grant per scope, and adds a repeatable `--allow-scope <runtime>:<scope>` flag
that grants for the current run only. Issue #85 routes every outside-the-project
read decision through one choke point (`src/discovery/gate.ts`) and adds a test
over the inventory that a closed policy serves no out-of-project element.

## Trust-boundary check

- **The boundary is narrower, not wider.** `AccessPolicy` now carries `user` and
  `install` instead of one `allowOutsideProject`. Detection reads only under
  `install`, the user harness and the external-gated reads only under `user`.
  `allowsOutsideProject` (external `.git`) is true when either is granted, the
  same condition as before.
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

To be completed after the adversarial review.

## Verification

- Full gate green: `test` (56 files, 484 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
