# Security review — M9 registry unification and kind typing (#92, #131)

- Date: 2026-09-18
- Reviewer: independent adversarial review (Claude Code CLI; the codex reviewer
  was rate-limited) plus maintainer disposition.
- Trigger: `src/runtime/claude-code/paths.ts` and `src/runtime/codex/paths.ts`
  changed (both are trust-boundary trigger paths).
- Result: no trust-boundary impact; review findings were test-coverage and
  documentation gaps, all remediated

## What changed

Issue #92 collapses the three parallel registry records (`ADAPTERS`, `CONSENT`,
`RUNTIME_NAMES`) into one `REGISTRY` entry per runtime carrying the adapter
factory, display name, and consent groups together, so an incomplete
registration is a compile error rather than a runtime failure.

Issue #131 replaces the `kind: string` on each adapter's element-builder helpers
with that adapter's own type: the known kinds, an explicit fallback
(`settings` / `config`), and an explicit `unknown`. A typo at a known-kind call
site is now a compile error rather than a silently different `ElementId`.

## Trust-boundary check

- **No read path changes.** The edits are type signatures, the registry table,
  and the two adapter path modules' exported types. No read, write, or delete is
  added or reordered.
- **Persisted kinds are unchanged.** The fallback values (`settings`, `config`)
  and `unknown` are exactly what the call sites already passed; the arrays and
  unions only name them. Element ids are therefore unchanged, and the existing
  suite passes without modification.
- **Registration stays internal.** The unified registry is not exported in
  `package.json` `exports` (the CLI-and-schema-only contract).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                      | Disposition                                                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | The registry doc claimed an incomplete _registration_ is a compile error; it is an incomplete _entry_ that is, while a missing entry surfaces at runtime     | Fixed: the doc says "entry", and notes that `registry.test.ts` guards the key set                                                               |
| 2   | Medium   | No test falsified the kind tightening; the positive suite only proves valid code compiles                                                                    | Fixed: a `@ts-expect-error` case in each adapter asserts a typo'd kind does not compile, and would itself fail if the union widened to `string` |
| 3   | Low      | `unsupportedElement` hardcoded the `'unknown'` literal while the new `UNKNOWN_ELEMENT_KIND` constant was otherwise unused — a second source of truth         | Fixed: it references the constant                                                                                                               |
| 4   | Low      | The codex path module lacked the "shared boundary still takes `string`" caveat the Claude one carries                                                        | Fixed                                                                                                                                           |
| 5   | Info     | The claim "a typo at a known-kind call site is a compile error" holds for the builder helpers; `grep "kind: string"` finds none in production `src/runtime/` | Confirmed, no action                                                                                                                            |

The review also confirmed there is no fourth parallel record keyed by runtime id
outside the registry, and that the fallback (`settings`/`config`) and `unknown`
classification behavior is unchanged (a pre-existing, separately tracked concern
for #91).

No finding was accepted as a risk.

## Verification

- Full gate green: `test` (57 files, 501 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
