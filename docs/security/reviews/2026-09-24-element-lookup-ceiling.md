# Security review: bounded cross-run element lookup for unknown ids (issue #168)

**Date:** 2026-09-24
**Reviewer:** Devin (issue agent), following `.claude/agents/security-auditor.md`
**Diff:** `src/limits.ts`, `src/cli/show.ts`, `src/cli/read.ts`,
`src/cli/show.test.ts`, `test/e2e/cli.test.ts`, `skills/pfl/references/commands.md`

## What changed

`pfl show <id>` previously failed a missing id with a bare
`unknown element id`. It now:

1. Rejects malformed ids (`el_` + 16 lowercase hex) as "not an element id".
2. Scans the project's other stored runs — newest-first, capped by the new
   `MAX_ELEMENT_LOOKUP_RUNS = 20` ceiling in `src/limits.ts` — reading one
   observed artifact per candidate until the id is found, then names the run
   (`obs_…` id, runtime, capture date) and the `--snapshot`/`--runtime` to
   reach it.
3. Points at `pfl list` / `pfl snapshots` when the id is in no scanned run.

`src/cli/read.ts` additionally exports `throwOnStoreFailure` (unchanged
behavior) so the lookup propagates `snapshot-store-unreadable` as exit 6
instead of masking it as "id not found" (exit 2), and the `unknown snapshot`
message now suggests `pfl snapshots`.

## Invariants checked

| Invariant                                  | Assessment                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only**                              | No writes added; the lookup only reads stored artifacts.                                                                                                                                                                                                             |
| **No execution**                           | No execution added.                                                                                                                                                                                                                                                  |
| **No symlink traversal**                   | All reads go through `readArtifact`/`readObservedSnapshot`, which enforce the store boundary and `MAX_ARTIFACT_BYTES`.                                                                                                                                               |
| **Consent boundary**                       | The lookup reads only `~/.pfl` — `pfl`'s own store, which read commands already access unconditionally. No new harness or out-of-store read.                                                                                                                         |
| **No persistence of raw content**          | Nothing persisted. The error text carries only element ids, run ids, runtime ids, and ISO dates — digests and safe metadata, never file content.                                                                                                                     |
| **Redaction**                              | No path is printed in the new messages; run ids and dates are not redactable content. `throwOnStoreFailure` propagates the store's own diagnostic message, which is already path-redacted at emission.                                                               |
| **Best effort, never silently incomplete** | A run whose observed artifact fails to re-read during the lookup was already reported by `listRuns` diagnostics; it is skipped, and the diagnostics travel in the thrown error's context. A scan truncated by the ceiling is named as such in the not-found message. |
| **Resource ceilings**                      | The lookup is bounded by `MAX_ELEMENT_LOOKUP_RUNS` (≤ 20 artifact reads) plus the store scan's own existing bounds.                                                                                                                                                  |

## Findings

| #   | Severity | Finding                                                                                                                              | Disposition                                                                                                                                  |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Info     | A hostile or corrupted store could make the lookup read up to 20 observed artifacts (each ≤ `MAX_ARTIFACT_BYTES`) per failed `show`. | **Accepted.** Bounded, read-only, local store only; the ceiling exists precisely so a large store cannot turn a typo into an unbounded walk. |
| 2   | Info     | `throwOnStoreFailure` is now exported from `read.ts` for reuse by `show.ts`.                                                         | **Accepted.** Same failure-propagation semantics as the existing read path; exporting does not widen behavior.                               |

## Decision

No unresolved findings. The change adds one bounded, store-local read path for
diagnostics purposes and propagates store failures with the reserved exit code.

## Verification

- `pnpm test` — 634 passed, including the new unit tests (malformed id,
  cross-run hit with and without `--runtime`, absent-everywhere) and the e2e
  exit-2 cases.
- `pnpm run build` / `check` / `format` / `knip` — clean.
