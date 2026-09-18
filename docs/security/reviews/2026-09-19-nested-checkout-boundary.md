# Security review: nested checkout boundary pruning (issue #162)

**Date:** 2026-09-19
**Reviewer:** security-auditor agent
**Diff:** `src/discovery/walk.ts`, `src/runtime/claude-code/discovery.ts`,
`src/runtime/codex/discovery.ts`, `src/runtime/opencode/discovery.ts`

## What changed

The project instruction walk now treats directories that contain a `.git` entry
(a linked worktree, a nested clone, or a submodule) as distinct working trees.
When `pruneNestedCheckouts: true`, such a directory is neither recorded nor
descended into; an `info`-level `nested-checkout-not-walked` diagnostic is
emitted. The option is opt-in; only project instruction walks enable it.

A new `lstat` of `<dir>/.git` is performed for each child directory when the
option is set. The `lstat` never follows symlinks, so a symlinked `.git` is also
a boundary.

## Invariants checked

| Invariant                                  | Assessment                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only**                              | No write operations added.                                                                                                                   |
| **No execution**                           | No execution added.                                                                                                                          |
| **No symlink traversal**                   | `lstat` does not follow symlinks. A symlinked `.git` entry is treated as a boundary (conservative).                                          |
| **Consent boundary**                       | The new `lstat` is project-implicit (inside the project root). No out-of-project read added.                                                 |
| **No persistence of raw content**          | The diagnostic carries only the relative path; no content is read.                                                                           |
| **Best effort, never silently incomplete** | The pruned boundary is recorded as an `info` diagnostic.                                                                                     |
| **Completeness**                           | `info` severity does not downgrade `completenessOf` (only `warning`/`error` do), so a project with pruned nested checkouts stays `complete`. |

## Findings

| #   | Severity | Finding                                                                                                                                      | Disposition                                                                                                                                                                  |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Info     | The `.git` entry detection uses `lstat` on `<dir>/.git`. A hostile project could place a large or slow-to-stat `.git` symlink.               | **Accepted.** The `lstat` is bounded by `MAX_WALK_ENTRIES` and the same budget already charges every directory entry. A symlinked `.git` is refused before any content read. |
| 2   | Info     | The option is opt-in; a future walk call site that should prune nested checkouts but does not set the option would silently miss boundaries. | **Accepted.** Plugin and skill directories are legitimately git repositories. The option is documented and set on the three project instruction walks.                       |

## Decision

No unresolved findings. The change is consistent with the security model and
the read-path inventory.
