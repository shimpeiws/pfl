# Security review — M8 project index and `pfl gc` (#86, #87)

- Date: 2026-09-18
- Reviewer: independent adversarial review plus a maintainer self-review against
  the design invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/snapshot/store.ts` and `src/discovery/project-identity.ts`
  changed; the store gains its first deletion path.
- Result: pending the adversarial round

## What changed

Issue #86 adds a project index under `~/.pfl/index.json` that maps a canonical
project root to the id its snapshots live under. The id is assigned once and the
index is consulted before deriving a new one, so a remote change no longer
strands a history; a v0.1 history is adopted, exclusively, when unclaimed.

Issue #87 adds `pfl gc`, which reclaims runs past a per-project retention count
and, under `--prune-orphans`, orphaned project directories. It is the only code
in `pfl` that deletes.

## Trust-boundary check

- **New reads stay inside the store.** The index is `~/.pfl/index.json`, read
  through the same guarded read (`readTextFileGuarded`) as other store metadata;
  the project-directory listing is a `readdir` of `~/.pfl/projects` with an
  `lstat` leaf check. Nothing outside `~/.pfl/` is read by either.
- **No traversal.** Project ids pass `SAFE_SEGMENT` before becoming a path
  segment; the index's roots are only compared and used for `access`, never for a
  store path.
- **Deletion is bounded and explicit.** `pfl gc` deletes only under
  `~/.pfl/projects/<validated id>/`, only files it constructs from a run's
  observed/resolved ids and its interpretation key, and only whole runs (the
  three artifacts together). An artifact that cannot be parsed is reported as a
  diagnostic and never deleted; `--dry-run` deletes nothing. `--prune-orphans`
  removes a project directory recursively, and only for an id that is either
  unindexed or whose every root is gone.
- **Fail closed.** A corrupt or unsupported-version index is a store failure
  (exit 6) rather than a rebuild that could re-mint a stranded history.
- **The index is not the snapshot schema.** It is mutable store metadata with
  its own version, outside `SNAPSHOT_SCHEMA_VERSION`, so introducing it neither
  bumps the snapshot schema nor invalidates a stored snapshot.
- **Immutability preserved.** Adoption never moves or rewrites a directory; the
  index only points at it. `gc` removes artifacts; it never edits one.

## Findings and disposition

To be completed after the adversarial review.

## Verification

- Full gate green: `test` (55 files, 471 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
