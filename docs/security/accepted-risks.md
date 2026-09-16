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
