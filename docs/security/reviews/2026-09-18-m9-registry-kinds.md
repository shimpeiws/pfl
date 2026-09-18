# Security review — M9 registry unification and kind typing (#92, #131)

- Date: 2026-09-18
- Reviewer: pending the adversarial round
- Trigger: `src/runtime/claude-code/paths.ts` and `src/runtime/codex/paths.ts`
  changed (both are trust-boundary trigger paths).
- Result: pending

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

To be completed after the adversarial review.

## Verification

- Full gate green: `test` (57 files, 501 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
