# Accepted risks

Risks that were dispositioned as **accepted** rather than fixed. Each entry
states the risk, why it is accepted, and what would reopen it. A finding that is
absent from both this register and the code as a fix is a defect.

## A1 — TOCTOU between `lstat` and `readFile` (roadmap S9)

- **Risk:** a file can be replaced between the `lstat` check and the subsequent
  read, so `pfl` can read a path whose type or link status changed after it was
  checked.
- **Why accepted:** exploitation requires a local attacker winning a
  sub-millisecond race. The payoff is a digest and a byte count — content is
  never persisted for walked files, and the settings reads that parse content
  read the file they checked. The one place where the race mattered — the
  settings read that had no check to race — is removed by the S1 fix.
- **Reopens if:** `pfl` begins persisting content, or a read path is added that
  takes a security decision from the checked type.
- **Recorded:** 2026-09-16 (M6 Phase 0).

## A2 — `permissions.json` is tamperable by the same uid (roadmap S10 residual)

- **Risk:** anything running as the same user can modify
  `~/.pfl/permissions.json` and widen the recorded grants.
- **Why accepted:** a same-uid process can read the harness directly, so
  integrity protection on the consent file would not raise the bar. M6 still
  applies the store's `chmod` re-assertion and `try`/`finally` temp-file cleanup
  to the consent writer; the residual is the tamperability itself, not the
  weaker write path.
- **Reopens if:** `pfl` supports multi-user or elevated execution where a
  same-uid assumption no longer holds.
- **Recorded:** 2026-09-16 (M6 Phase 0).

## A3 — A user grant for one runtime enables Git-metadata reads for all (roadmap S5)

- **Risk:** the read commands (`report`, `list`, `show`, `graph`, `diff`,
  `snapshots`) are runtime-agnostic — a project id is shared across runtimes —
  so they gate out-of-project Git metadata on `hasAnyUserConsent`, which is true
  when _any_ runtime holds a `*:user` grant. A user who granted `claude-code`
  therefore lets a read command follow a `.git` file's `gitdir:` even in a
  Codex-only checkout.
- **Why accepted:** consent is a statement that `pfl` may read outside the
  project; the runtime scope selects which harness files are read, not the
  runtime-independent Git metadata that establishes project identity. Gating it
  per runtime would require the runtime before the project id is known, which is
  circular without the store's root index. M6 fixes the pre-consent read (S5);
  M8's scope taxonomy and root index give read commands a runtime-specific
  context and remove the approximation.
- **Reopens if:** M8 lands, or a read command gains a runtime argument.
- **Recorded:** 2026-09-17 (M6 Phase 4).

## A4 — The project index has no lock (roadmap #86)

- **Risk:** `~/.pfl/index.json` is read-modify-write, so two `pfl` processes
  indexing different projects at the same moment can lose one another's entry
  (last write wins). The write path re-reads and merges, and falls back to a
  root-scoped id if another root claimed the chosen one, which narrows the
  window but does not close it.
- **Why accepted:** the tool is single-user and the commands are short-lived; a
  lost entry re-mints the root's id on the next run, and a directory another
  root claimed is left for `pfl gc --prune-orphans`. A cross-process lock is
  design work the roadmap leaves out of #86.
- **Reopens if:** concurrent first runs become a real workflow, or the index
  gains state that a lost write cannot rebuild.
- **Recorded:** 2026-09-18 (M8 #86).

## A5 — A corrupt index fails closed with no rebuild command (roadmap #86)

- **Risk:** a corrupt or unsupported-version `~/.pfl/index.json` makes every
  command exit 6 rather than rebuild, because re-deriving ids could strand a
  history.
- **Why accepted:** failing closed is safer than guessing; the message names the
  file and tells the user to move it aside, after which the next run rebuilds
  the index and adopts existing histories. Corruption is not reachable by a
  hostile clone, only by a same-uid process or a disk fault, both already outside
  the threat model.
- **Reopens if:** corruption is observed in practice, or an automated recovery
  can be made safe.
- **Recorded:** 2026-09-18 (M8 #86).

## A6 — `pfl gc` reports a partial failure as a diagnostic, exit 0 (roadmap #87)

- **Risk:** if one artifact cannot be removed (for example `EACCES`), `gc` keeps
  going and exits 0, so a script cannot distinguish a full success from a partial
  one by exit code alone.
- **Why accepted:** `gc` is best-effort like every other command, and the failed
  artifact is recorded in `diagnostics` (and omitted from `reclaimed`) so it is
  never silently incomplete. Throwing would discard the report of what was
  already reclaimed.
- **Reopens if:** a caller needs to gate on complete reclamation; it can then
  fail on a `reclaim-failed` diagnostic.
- **Recorded:** 2026-09-18 (M8 #87).

## A7 — An interrupted `inspect` leaves an uncollectable observation (roadmap #87)

- **Risk:** `inspect` writes the observed snapshot before the resolved one, so
  an interruption leaves an observation with no resolved snapshot. `gc` cannot
  reclaim it as a run, so it stays and is reported on every run. It is excluded
  from the retention budget, so it does not displace reclaimable history.
- **Why accepted:** deleting the observation would leave any later-resolved
  artifacts unattributable, and the run could still be completed. The residual
  is a small, visible, bounded leak rather than a data-loss risk.
- **Reopens if:** a repair path (for example `--prune-incomplete`) is added, or
  the leak grows without bound in practice.
- **Recorded:** 2026-09-18 (M8 #87).

## A8 — An unavailable root looks gone, so `--prune-orphans` can reclaim it (roadmap #87)

- **Risk:** a project on a removable or network volume whose mount is absent
  makes every one of its roots `ENOENT`, so `gc --prune-orphans` treats its
  history as orphaned and deletes it.
- **Why accepted:** the snapshot is derived data, `--prune-orphans` is opt-in,
  and the README tells the user to dry-run it first. Distinguishing "unmounted"
  from "deleted" would need a mount/volume check that is not portable across
  POSIX filesystems.
- **Reopens if:** `gc` gains a scheduled or non-interactive mode, or a root can
  be shown to be a mount point.
- **Recorded:** 2026-09-18 (M8 #87).
