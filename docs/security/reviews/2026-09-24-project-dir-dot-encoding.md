# Security review: Claude Code project-dir encoding of dots (issue #177)

**Date:** 2026-09-24
**Reviewer:** Devin (issue agent), following `.claude/agents/security-auditor.md`
**Diff:** `src/runtime/claude-code/paths.ts`, `src/redact/output.ts`,
`src/runtime/claude-code/discovery.test.ts`, `src/redact/output.test.ts`

## What changed

`encodeProjectDir` now maps `.` to `-` in addition to `/`, matching Claude
Code's real per-project directory naming (verified on a live
`~/.claude/projects/` listing: `/Users/shin/.claude` → `-Users-shin--claude`).
The memory walk under `~/.claude/projects/<encoded>/memory` now resolves for
project roots that contain dots.

`src/redact/output.ts` previously duplicated the encoding for the
encoded-home segment with a slash-only copy. It now calls `encodeProjectDir`,
so the redaction needle and the discovery path can no longer drift apart —
the drift being exactly what produced this bug. For a dotted home
(`/Users/john.doe`), the encoded segment `-Users-john-doe` is now correctly
replaced by `~`; before this change it would have survived redaction once the
encoder was fixed.

## Invariants checked

| Invariant                                  | Assessment                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only**                              | No writes added.                                                                                                                                                        |
| **No execution**                           | No execution added.                                                                                                                                                     |
| **No symlink traversal**                   | Unchanged; the diff alters only which directory name the existing consent-gated walk targets. The walk's own guards are untouched.                                      |
| **Consent boundary**                       | The memory walk was already inventoried as a user-scope read (`docs/security/read-paths.md`, `discovery.ts` walk of `~/.claude/<dirs>/**`). No new out-of-project read. |
| **No persistence of raw content**          | No new persisted or displayed field; the change alters a path computation and a redaction needle.                                                                       |
| **Redaction**                              | Strengthened: a dotted account name is now stripped from encoded path segments, where the slash-only copy would have leaked it.                                         |
| **Best effort, never silently incomplete** | Unchanged; an unresolvable memory dir still yields a `path-not-found` diagnostic.                                                                                       |

## Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                           | Disposition                                                                                                                                                                                               |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Info     | `redact/output.ts` is a generic layer importing a Claude Code adapter constant (`encodeProjectDir`). The encoded-home redaction it performs is already Claude-Code-specific by design (see its doc comment); the import makes the pre-existing coupling explicit rather than new. | **Accepted.** `paths.ts` is a leaf module with no imports, so no cycle is introduced. Moving the constant to a neutral module would obscure that the encoding is a Claude Code runtime detail.            |
| 2   | Info     | Claude Code's encoding may map characters beyond `/` and `.` (e.g. `_`); the verified evidence covers only those two. If the runtime encodes more, both call sites now share the same incomplete mapping.                                                                         | **Accepted.** Only `/` and `.` are verified against the real layout; guessing further would violate "do not infer more than can be supported". Sharing one function means a future correction lands once. |
| 3   | Info     | Over-redaction: a path segment that happens to equal the encoded home but is not the home (e.g. a directory literally named `-Users-john-doe` elsewhere) is replaced by `~`.                                                                                                      | **Accepted.** Same trade-off the boundary check already makes for the raw home; a false positive hides a path, it never leaks one.                                                                        |

## Decision

No unresolved findings. The change restores a declared, consent-gated read
path and strengthens redaction for dotted account names; it is consistent
with the security model and the read-path inventory.

## Verification

- `pnpm test` — 616 passed (includes the new dotted-root discovery test, the
  real-world encoding pin `-Users-shin--claude`, and the dotted-home
  redaction regression test; each fails if the fix is reverted).
- `pnpm run build` / `check` / `format` / `knip` — clean.
