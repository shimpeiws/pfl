# Security review: partial-cause surfacing and `report --explain` (issue #169)

**Date:** 2026-09-24
**Reviewer:** Devin (issue agent), following `.claude/agents/security-auditor.md`
**Diff:** `src/discovery/assemble.ts`, `src/snapshot/store.ts`,
`src/cli/report.ts`, `src/cli/snapshots.ts`, `src/cli/show.ts`, `src/index.ts`,
`src/cli/report.test.ts`, `test/e2e/cli.test.ts`, `test/golden/snapshots.json`,
`skills/pfl/references/commands.md`, `skills/pfl/references/json-contract.md`

## What changed

A `partial` snapshot used to print only `⚠ scan completeness: partial`. The
change surfaces _why_:

1. `partialCauses()` in `assemble.ts` is the canonical extraction under
   `completenessOf` — elements with status `unreadable`/`unsupported`/
   `skipped`, and diagnostics at `warning`/`error`.
2. `listRuns` (`src/snapshot/store.ts`) attaches `partialCauses` counts to each
   `StoredRunSummary` when the run is `partial`, so `pfl snapshots` prints a
   parenthesized cause summary and `--json` carries the counts.
3. `pfl report` lists the offending elements and summarizes warning/error
   diagnostics (verbatim ≤ 5, grouped by severity+code beyond that); the new
   `--explain` flag dumps the stored observed diagnostics in full, including
   `info`, as `data.explanation` in JSON.
4. `pfl show` prints an element's stored `reason` when present.

## Invariants checked

| Invariant                                  | Assessment                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Read-only**                              | No writes added; `listRuns` already read every observed artifact to build its summaries — the counts are computed from data already in memory.                                                                                                                                                                                                               |
| **No execution**                           | No execution added.                                                                                                                                                                                                                                                                                                                                          |
| **No symlink traversal**                   | No new filesystem reads at all; everything renders stored artifacts.                                                                                                                                                                                                                                                                                         |
| **Consent boundary**                       | Output-only change over the `~/.pfl` store, which read commands already access unconditionally.                                                                                                                                                                                                                                                              |
| **No persistence of raw content**          | Nothing persisted. `StoredRunSummary.partialCauses` is counts only — never persisted, computed at read time.                                                                                                                                                                                                                                                 |
| **Redaction**                              | JSON `--explain` maps every diagnostic through `redactDiagnostic(..., 'export', { home })` and element paths through `redactPath`. Human output goes through `redactingLogger` (`redactFreeText` on every message), the same channel existing warnings already use. `show`'s `reason` is a fixed enum-like token (`symlink-not-followed`, …), not free text. |
| **Best effort, never silently incomplete** | This is the point of the change: partial causes are surfaced rather than hidden.                                                                                                                                                                                                                                                                             |
| **Resource ceilings**                      | No new reads; rendering is bounded by the stored artifact sizes already enforced at write/read (`MAX_ARTIFACT_BYTES`).                                                                                                                                                                                                                                       |

## Findings

| #   | Severity | Finding                                                                                                                                     | Disposition                                                                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Info     | `--explain` intentionally widens output: it emits the full stored diagnostics array (all severities) rather than only warning/error causes. | **Accepted.** Diagnostics are already path-redacted at emission and re-redacted at the output boundary here; the array is bounded by the artifact's own limits. |
| 2   | Info     | `store.ts` now imports `partialCauses` from `discovery/assemble.ts` — a new upward dependency from the snapshot layer.                      | **Accepted.** The function is pure over `ObservedElement`/`Diagnostic`; no cycle exists (assemble does not import `snapshot/store`).                            |

## Decision

No unresolved findings. The change renders already-stored, already-redacted
data; the only new surface (`--explain`) reuses the existing export redaction
path.

## Verification

- `pnpm test` — 626 passed, including the new unit tests (partial-cause human
  output, `--explain` JSON shape, absence without the flag) and the e2e case
  over the real CLI.
- `pnpm run build` / `check` / `format` / `knip` — clean.
- Golden `snapshots.json` regenerated to capture the additive `partialCauses`
  field.
