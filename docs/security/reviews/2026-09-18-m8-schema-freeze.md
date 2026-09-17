# Security review — M8 schema freeze deliverables (#88)

- Date: 2026-09-18
- Reviewer: independent adversarial review plus a maintainer self-review against
  the design invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/snapshot/store.ts` changed (the persisted-shape validators now
  import the model's value lists instead of duplicating them).
- Result: pending the adversarial round

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

To be completed after the adversarial review.

## Verification

- Full gate green: `test` (57 files, 497 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
