# Security review: duplicate-name diagnostic aggregation and marketplace suppression (issue #183)

**Date:** 2026-09-24
**Reviewer:** Devin (issue agent), following `.claude/agents/security-auditor.md`
**Diff:** `src/discovery/duplicate-names.ts`, `src/runtime/claude-code/paths.ts`,
`src/runtime/claude-code/discovery.ts`, `src/runtime/claude-code/resolve.ts`,
`src/runtime/codex/discovery.ts`, `src/runtime/opencode/discovery.ts`,
`src/runtime/claude-code/discovery.test.ts`, `test/golden/inspect.json`

## What changed

`duplicate-element-name` diagnostics were emitted once per colliding name; a
large plugin marketplace produced ~200 warnings that drowned the handful that
mattered. The change:

1. Adds `duplicateNameDiagnostics()` to `duplicate-names.ts`: adapters build a
   list of `DuplicateCollision`s, and the shared emitter emits one diagnostic
   per (kind, pluginOnly, note) bucket — verbatim for a single collision, a
   count plus a bounded 3-name sample (`DUPLICATE_SAMPLE_LIMIT`) beyond that.
2. Claude Code: entries under `~/.claude/plugins/marketplaces/` are filtered
   out before grouping. Catalog clones are never loaded by the runtime (#176),
   so they are not a competing definition; a cache-vs-catalog duplicate is
   suppressed while genuine collisions stay visible.
3. The marketplace path predicate moved to `paths.ts`
   (`USER_MARKETPLACES_PREFIX`, `isMarketplaceCatalogPath`) so discovery and
   resolution share it.
4. Codex and OpenCode adopt the same aggregation; OpenCode's ad-hoc grouping
   was replaced by the shared `duplicateNameGroups`.

## Invariants checked

| Invariant                                  | Assessment                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Read-only**                              | No writes added; the change is pure post-processing of already-collected elements.                                                                                                               |
| **No execution**                           | No execution added.                                                                                                                                                                              |
| **No symlink traversal**                   | No new filesystem reads.                                                                                                                                                                         |
| **Consent boundary**                       | The marketplace filter consults element display paths already collected under the existing user-scope consent; no new read surface.                                                              |
| **No persistence of raw content**          | Diagnostics carry paths and names exactly as before — aggregation bounds the _number_ of paths per diagnostic (≤ 3 samples) rather than expanding it.                                            |
| **Redaction**                              | Diagnostic messages/paths pass through the same `redactDiagnostic` boundary as before; the aggregated message embeds display paths the redaction layer already knows how to shrink (#179 fixed). |
| **Best effort, never silently incomplete** | Aggregation loses no information class: the count reports the full bucket size and the sample names the first entries; the full collision list remains derivable from `list`/`--explain` output. |
| **Resource ceilings**                      | The sample is bounded by `DUPLICATE_SAMPLE_LIMIT`; the collision list is bounded by the number of observed elements.                                                                             |

## Findings

| #   | Severity | Finding                                                                                                                                          | Disposition                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | Info     | Marketplace suppression is keyed on the display-path prefix `~/.claude/plugins/marketplaces/`, consistent with the resolution-side rule in #176. | **Accepted.** One shared predicate in `paths.ts` is the single source for both layers.           |
| 2   | Info     | A bucket's `path` field carries the first sampled entry only; remaining paths live inside the message text.                                      | **Accepted.** Same shape as before (path = first entry); the message carries the bounded sample. |

## Decision

No unresolved findings. The change only rewrites how already-collected facts
are reported; suppression is confined to elements the resolution layer already
treats as never-loaded.

## Verification

- `pnpm test` — 625 passed, including new discovery tests (aggregation with a
  bounded sample; marketplace clones not treated as competing definitions).
- `pnpm run build` / `check` / `format` / `knip` — clean.
- Golden `inspect.json` regenerated: the marketplace-vs-cache `x` duplicate is
  now suppressed.
