# Security review — M8 schema freeze deliverables (#88)

- Date: 2026-09-18
- Reviewer: maintainer self-review against the design invariants (design doc
  §19; roadmap §3.1, §3.2). The external reviewers (codex, Claude Code) were
  rate-limited when this pull request was prepared, so no independent round ran;
  the change is tests and documentation plus a validator refactor whose accepted
  value sets are byte-identical, and the full gate is green.
- Trigger: `src/snapshot/store.ts` changed (the persisted-shape validators now
  import the model's value lists instead of duplicating them).
- Result: no trust-boundary impact; no findings

## What changed

Issue #88 adds the evidence that the contracts are frozen: schema fixtures, a
read-compatibility test, golden files for every command document, a schema-bump
procedure, and the unification of the hand-rolled enum lists in `store.ts` with
the model's own value arrays (roadmap S11's "one source"). `ElementId` collision
and `isInterpretation` `schemaVersion` coverage landed with #79 and #84.

The only production change is the validator refactor in `store.ts`. Every change
here is a test, a fixture, or a document.

## Trust-boundary check

- **The accepted value sets are unchanged.** `store.ts` now aliases the arrays
  the core types derive from (`NATIVE_ORIGIN_VALUES`, `OBSERVED_STATUS_VALUES`,
  the resolved axes, completeness, severity) instead of restating them. The
  widened alias is for `.includes(value: string)`; the values are identical, so
  no artifact is accepted or refused differently.
- **No new read path, no new write, no new deletion.** The diff touches no
  filesystem code.
- **The fixtures are test data**, under `test/`, never read by the shipped
  binary.

## Findings and disposition

None. The validators alias the core value arrays; because the aliased values are
identical, no artifact is accepted or refused differently, and the property tests
that read each schema fixture and the legacy fixture pass unchanged.

## Verification

- Full gate green: `test` (57 files, 497 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
