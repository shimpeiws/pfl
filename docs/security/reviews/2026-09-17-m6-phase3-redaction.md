# Security review — M6 Phase 3 (redaction across output and persistence)

- Date: 2026-09-17
- Reviewer: `codex exec` (independent model), against the Phase 3 diff
- Trigger: changes under `src/redact/**` and `src/discovery/assemble.ts`, both
  trust-boundary paths
- Result: S6/S8 initially judged incomplete — 2 P1 and 1 P2 findings plus two
  test-strength gaps, all remediated in the same change

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                         | Disposition                                                                                                                                                                           |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1       | The output/persistence layer used only `COMMON_REDACTION_RULES`; runtime-specific shapes (`sess-…`, `sk-ant-…`) were not masked in `source.path` or diagnostics | **Fixed.** Rules moved to `src/redact/rules.ts` as `ALL_REDACTION_RULES` (common + every runtime); `redactPath` / `redactFreeText` compose them                                       |
| 2   | P1       | `ResolvedSnapshot.diagnostics` were persisted unredacted                                                                                                        | **Fixed.** `assembleResolvedSnapshot` takes `home` and redacts its diagnostics at `persistence`; `resolveHarness` and each adapter thread `home` through                              |
| 3   | P2       | `redactHomePath` replaced any substring, so `/Users/alice2` became `~2` for home `/Users/alice`                                                                 | **Fixed.** The replacement is boundary-aware (a separator or end of string must follow)                                                                                               |
| 4   | Test gap | The display integration test passed even with the logger wrapper removed, because the fixture reads already-redacted snapshots                                  | **Fixed.** A test symlinks the observations directory so `listRuns` emits a read-time diagnostic whose path is under the home directory; removing the wrapper turns it red (verified) |
| 5   | Test gap | `redactingLogger`'s unit test only checked a top-level `data.path`, while the comment claimed "every string `path`"                                             | **Fixed.** The comment now states the actual contract (top-level `path`; nested payloads are already redacted at persistence)                                                         |

## Verification

- Falsifiability: reverting the logger wrapper in `runSnapshots` turns the
  read-time diagnostic test red; reverting persistence redaction turns the
  persisted-snapshot property test red.
- Full gate green: `test` (287), `check`, `format`, `build`, `typecheck:test`,
  `knip`.
