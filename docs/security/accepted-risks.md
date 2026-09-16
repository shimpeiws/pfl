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
