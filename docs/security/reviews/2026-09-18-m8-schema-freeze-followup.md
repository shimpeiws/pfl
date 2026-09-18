# Security review — M8 schema-freeze follow-up (#88)

- Date: 2026-09-18
- Reviewer: independent review by a separate OpenCode process (`opencode run
--agent plan`, two rounds) plus maintainer disposition. (The codex and Claude
  reviewers were rate-limited.)
- Trigger: `src/snapshot/store.ts` changed (two more closed vocabularies are
  single-sourced).
- Result: no trust-boundary impact; the review's findings were completeness gaps
  in the freeze evidence, all remediated here. The second round found that the
  first `inspect` golden was macOS-path-specific and would have failed on the
  ubuntu CI runner.

## What changed

The freeze evidence from #88 had three gaps the separate review found:

1. `inspect` had no golden file, though the `--json` contract covers it. Added,
   with the fixture's temp paths and random ids normalized so it is stable
   across runs.
2. The "stored snapshot golden" only checked serialize→parse→serialize
   idempotency; it did not pin the producer. The fixtures are now the real
   assemblers' output (kept canonical, excluded from the formatter), and the
   test rebuilds the observed, resolved, and interpretation artifacts through
   `assembleObservedSnapshot` / `assembleResolvedSnapshot` / `classify` +
   `deriveFindings` and asserts the exact canonical bytes against the fixtures,
   so the fixture is itself the golden.
3. The enum single-sourcing missed two closed vocabularies: the classification
   confidence and the resolution confidence. Both are now arrays in the core
   modules, and `store.ts` aliases them like the rest.

The `legacy` read-compatibility test is renamed to what it actually exercises
(tolerance of an older artifact shape), the unused `index.json` fixture is now
read by a test, and the bump procedure's paths and future-version note are
corrected.

## Trust-boundary check

- **Accepted value sets unchanged.** The two new validators accept exactly
  `high|medium|unknown` and `verified|unverified-runtime-version`, which is what
  the inline code accepted; the arrays are the source the core types derive from.
- **No new read path, write, or deletion.** The production change is the two
  aliases.
- **The new goldens carry no account or temp path**: an inspect document built
  from a fixture is normalized (package version, snapshot ids, fixture home,
  root, base, and the runtime's encoded base), and the suite is verified to
  reproduce on repeated runs.

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                        | Disposition                                                                                                                      |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | `inspect` `--json` document was not frozen                                                                                                                     | Fixed: golden added                                                                                                              |
| 2   | Medium   | The persisted-shape golden proved only serializer idempotency, not the producer's output                                                                       | Fixed: the fixtures are now the assembler's output, and a test rebuilds them through the assemblers and compares bytes           |
| 3   | Low      | Two closed vocabularies were still hand-written in the validator                                                                                               | Fixed: single-sourced                                                                                                            |
| 4   | Low      | Read-compat test name overstated what it exercises                                                                                                             | Fixed: renamed                                                                                                                   |
| 5   | Low      | Unused `index.json` fixture                                                                                                                                    | Fixed: read by a test                                                                                                            |
| 6   | High     | The first `inspect` golden baked the macOS realpath (`/var` → `/private/var`) into the runtime's encoded memory path, so it would fail on the ubuntu CI runner | Fixed: the canonical (realpath) project root and its runtime-encoded form are normalized, making the golden platform-independent |
| 7   | Low      | Snapshot-id masking applied to every command, hiding id-wiring regressions                                                                                     | Fixed: masking is limited to `inspect`, which generates fresh ids                                                                |

No finding was accepted as a risk.

## Verification

- Full gate green: `test` (57 files, 499 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- The golden suite passes repeatedly with different temp paths; the `inspect`
  golden contains no absolute or macOS-specific path, so it is
  platform-independent. The producer test rebuilds the representative observed,
  resolved, and interpretation artifacts through the real assemblers and asserts
  the exact canonical bytes against the fixtures.
