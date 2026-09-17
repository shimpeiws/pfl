# Security review — M8 project index and `pfl gc` (#86, #87)

- Date: 2026-09-18
- Reviewer: independent adversarial review plus a maintainer self-review against
  the design invariants (design doc §19; roadmap §3.1, §3.2)
- Trigger: `src/snapshot/store.ts` and `src/discovery/project-identity.ts`
  changed; the store gains its first deletion path.
- Result: one data-loss class and several smaller issues found and remediated;
  five residual risks recorded as accepted (A4–A8)

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
  three artifacts together). An artifact that cannot be attributed to a run — an
  observation with no resolved snapshot, or a file no run references — is
  reported and never deleted; an artifact that belongs to a reclaimed run is
  deleted with it. `--dry-run` deletes nothing. `--prune-orphans` removes a
  project directory recursively, and only for an id the index references whose
  every root is gone; a directory the index does not reference is reported and
  never deleted.
- **Fail closed.** A corrupt or unsupported-version index is a store failure
  (exit 6) rather than a rebuild that could re-mint a stranded history.
- **The index is not the snapshot schema.** It is mutable store metadata with
  its own version, outside `SNAPSHOT_SCHEMA_VERSION`, so introducing it neither
  bumps the snapshot schema nor invalidates a stored snapshot.
- **Immutability preserved.** Adoption never moves or rewrites a directory; the
  index only points at it. `gc` removes artifacts; it never edits one.

## Findings and disposition

The adversarial review found a data-loss class and several smaller issues. All
were remediated in this pull request:

1. **An unreferenced directory was treated as an orphan and `--prune-orphans`
   deleted it.** On the first v1.0 run the index is empty, so a real history
   that had not been adopted yet had no root recorded and was destroyed by a
   command run for a different project. Fixed: an orphan is now a directory the
   index references whose every root is gone; a directory the index does not
   reference is reported as `unreferenced` and never deleted. A dry run with
   `--prune-orphans` still deletes nothing, and both are tested.
2. **`planRetention` could drop or reorder the `latest` run.** The swap rebuilt
   the list out of order and only handled a latest run already in the reclaimed
   tail. Fixed: retention is a set that always includes the run named by
   `latest`, rebuilt in snapshot order; a dangling pointer is ignored.
3. **Deletion paths were built from unvalidated ids.** Index ids and an
   artifact's `snapshotId` (which the shape predicate accepts as any string)
   became path segments. Fixed: the index refuses an id that is not a safe
   segment (`isSafeSegment`), and `reclaimRun` builds every path through
   `artifactFilePath`, which asserts it. Both are tested.
4. **Read commands wrote the index.** `report`/`list`/`show`/`graph`/`diff`/
   `snapshots` now resolve the id with `{ write: false }`, so a read computes
   the same id an `inspect` would persist without mutating the store.
5. **`gc` did not print diagnostics in text mode**, so an unparseable artifact
   or a declined adoption was invisible without `--json`. Fixed: `runGc` logs
   the diagnostics before the summary.
6. **`--dry-run --prune-orphans` mislabeled its output and the data could not
   say whether orphans were deleted.** Fixed: `orphansReclaimed` in the
   document and "would reclaim" wording; tested.
7. **A corrupt index gave a pathless message, was written without `fsync`, and
   was a read-modify-write that could lose a concurrent entry.** Fixed: the
   message names the file and how to recover, the temp file is synced before
   the rename, and the entry is merged into a fresh read before writing. A lock
   remains out of scope for #86.
8. **A value-less `--keep` became `1`.** The parser passes `true`, which
   `Number(true)` turned into 1 (keep only latest). Fixed: it is refused.
9. **`mostRecentLatest` used `stat`, following a symlinked `latest`,** contrary
   to the inventory. Fixed: `lstat`.
10. **A value-less `--keep` could still mean 1.** `--no-keep` arrives as
    `false` and a whitespace string coerces to 0, so `Number(...)` would have
    reclaimed every run but the latest. Fixed: `parseKeep` refuses a boolean or
    blank value and requires a non-negative integer.
11. **An unreadable root was treated as gone.** `access` failure of any kind
    (for example a permission error) made a live project look orphaned and thus
    deletable. Fixed: only `ENOENT`/`ENOTDIR` means gone; anything else is
    `unknown` and treated as present. `--prune-orphans` also catches a per-orphan
    failure instead of aborting mid-sweep.
12. **A partial reclamation could leave a run's base without its dependents.**
    Deletion now runs interpretation → resolved → observed and stops at the first
    failure, so a resolved snapshot is never left without its interpretation, and
    a run is reported as reclaimed only when every artifact is gone.
13. **Two unseen clones could both claim the same legacy id** when run
    concurrently, then share one directory and have each other's runs reclaimed.
    The write path now re-reads the index and, if another root took the chosen
    id, falls back to this root's own id. A lock remains out of scope for #86.
14. **`gc` claimed or adopted histories** by writing the index. Fixed: it
    resolves with `{ write: false }`, like the read commands.
15. **Retention treated `keep` as a budget that `latest` consumes**, so
    `--keep 1` with an older `latest` deleted the newest run. Fixed: the newest
    `keep` runs are retained _and_ the run named by `latest` is added.
16. **The index accepted a non-absolute root**, which would be resolved against
    the working directory when checking whether an orphan's root exists. Fixed:
    a root must be absolute.
17. **A run with no resolved snapshot was half-deleted and reported as
    reclaimed.** Removing only its observation hid the remaining artifacts from
    every future scan. Fixed: such a run is left whole and reported as
    `unreclaimable-run`, in a dry run too, and is excluded from the retention
    budget so an incomplete run cannot displace reclaimable history. The gc
    summary and `reclaimedOrphans` now list what this run actually deleted
    rather than what it planned.
18. **A `gc` deletion diagnostic carried an absolute path.** Fixed: the
    `reclaim-failed` diagnostic uses a store-relative label, so it does not
    depend on the export redaction to avoid naming the account.

## Accepted residuals

A4 (no index lock), A5 (a corrupt index fails closed with no rebuild command),
A6 (a partial `gc` failure is a diagnostic, exit 0), A7 (an interrupted
`inspect` leaves a small uncollectable observation), and A8 (an unavailable root
looks gone, so `--prune-orphans` can reclaim it) are recorded in
`accepted-risks.md` with their reopening conditions.

The comment that a path-derived sibling is "reported by `pfl gc` as reclaimable"
was corrected: after the first fix it is reported as unreferenced and never
deleted automatically, because its root is unknown.

## Verification

- Full gate green: `test` (55 files, 479 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- New tests: retention keeps the newest and the latest (including a dangling
  pointer); a dry run deletes nothing; an unparseable artifact is kept and
  reported while the rest of its run is reclaimed; a root-gone history is
  reclaimed but an unreferenced one never is; a corrupt, wrong-version, or
  unsafe index fails closed with the path in the message; a read-only
  resolution writes no index; the CLI `gc` end to end.
